// SPEC-15 orchestration: boot explicitly grants effects; signed descriptions never self-install.
import { array, encode, map, tstr, type CborValue } from "../delta/cbor.js";
import { authorForSeed } from "../delta/sign.js";
import { canonicalBytes } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import type { Delta, Target } from "../delta/types.js";
import {
  OrdinaryJournalPeer,
  captureOrdinaryJournalSource,
  type DurableOrdinaryJournalStore,
} from "../federation/ordinary-journal-peer.js";
import {
  commandEntity,
  commandNumber,
  commandRef,
  commandText,
  isCommandId,
  parseCommandDelta,
  readConfiguration,
  readOperation,
  readRequestArguments,
  readRequestCommon,
  verifyCommandAppearance,
  writeCommandDescription,
  type CommandFields,
} from "../command-data/codec.js";
export class CommandTransportError extends Error {}
export interface CommandBoot {
  readonly seed: string;
  readonly configuration: Delta;
  readonly declarations: readonly Delta[];
  readonly store: DurableOrdinaryJournalStore;
  readonly clock: () => number;
  readonly diagnostic: (fault: unknown) => void;
}
const valid = (delta: Delta, at: number): boolean =>
  delta.claims.validFrom <= at &&
  (delta.claims.validUntil === undefined || at < delta.claims.validUntil);
const text = (value: string): readonly Target[] => [{ kind: "primitive", value }];
const reference = (id: string): readonly Target[] => [{ kind: "delta", deltaRef: { delta: id } }];
export class CommandEndpoint {
  private tail: Promise<void> = Promise.resolve();
  private readonly receiver: string;
  private readonly configuration: Delta;
  private readonly config: CommandFields;
  private readonly operations: ReadonlyMap<string, { delta: Delta; kind: "retain" | "evaluate" }>;
  private constructor(private readonly boot: CommandBoot) {
    this.receiver = authorForSeed(boot.seed);
    this.configuration = structuredClone(boot.configuration);
    verifyCommandAppearance(this.configuration);
    this.config = readConfiguration(this.configuration);
    if (
      this.configuration.claims.author !== this.receiver ||
      commandEntity(this.config, "receiver") !== this.receiver
    )
      throw new Error("invalid endpoint configuration authority");
    const declarations = boot.declarations.map((d) => structuredClone(d));
    const operations = new Map<string, { delta: Delta; kind: "retain" | "evaluate" }>();
    for (const delta of declarations) {
      verifyCommandAppearance(delta);
      if (delta.claims.author !== this.receiver) throw new Error("invalid operation authority");
      operations.set(delta.id, { delta, kind: readOperation(delta) });
    }
    const installed = (this.config.installed ?? []).map((t) =>
      t.kind === "delta" ? t.deltaRef.delta : "",
    );
    if (
      declarations.length !== 2 ||
      operations.size !== 2 ||
      new Set([...operations.values()].map((o) => o.kind)).size !== 2 ||
      installed.some((id) => !operations.has(id))
    )
      throw new Error("invalid installed operation set");
    this.operations = operations;
    this.boot = { ...boot, configuration: this.configuration, declarations };
  }
  static async boot(boot: CommandBoot): Promise<CommandEndpoint> {
    const endpoint = new CommandEndpoint(boot);
    const opened = await OrdinaryJournalPeer.open(boot.store, endpoint.receiver);
    if (opened.status !== "open") throw new Error(`endpoint boot: ${opened.status}`);
    return endpoint;
  }
  /** Snapshot untrusted debug appearances before any asynchronous host observation. */
  invoke(entryId: string, appearances: readonly unknown[]): Promise<Delta> {
    if (!isCommandId(entryId) || !Array.isArray(appearances))
      throw new CommandTransportError("invalid command transport framing");
    const appearanceCount = appearances.length;
    let stable: readonly unknown[];
    try {
      stable = structuredClone(appearances);
    } catch {
      stable = [null];
    }
    const attempt = this.tail.then(() => this.attempt(entryId, stable, appearanceCount));
    this.tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    return attempt;
  }
  private outcome(
    entryId: string,
    at: number,
    status: "completed" | "refused" | "indeterminate",
    body: CborValue,
  ): Delta {
    return writeCommandDescription(this.boot.seed, at, "outcome/1", {
      receiver: [{ kind: "entity", entity: { id: this.receiver } }],
      configuration: reference(this.configuration.id),
      request: reference(entryId),
      status: text(status),
      result: [{ kind: "bytes", mime: "application/cbor", value: encode(body) }],
    });
  }
  private async attempt(
    entryId: string,
    appearances: readonly unknown[],
    appearanceCount: number,
  ): Promise<Delta> {
    const at = this.boot.clock();
    if (!Number.isFinite(at)) throw new Error("invalid receiver clock observation");
    const refuse = (code: string) =>
      this.outcome(entryId, at, "refused", map([["code", tstr(code)]]));
    if (appearanceCount > commandNumber(this.config, "max-deltas")) return refuse("resource-limit");
    let deltas: Delta[];
    try {
      deltas = appearances.map(parseCommandDelta);
    } catch {
      return refuse("invalid-appearance");
    }
    let size = 0;
    try {
      for (const d of deltas) {
        if (d.sig === undefined || d.sig.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(d.sig))
          throw new Error("signature bytes");
        size += canonicalBytes(d.claims).length + d.sig.length / 2;
      }
    } catch {
      return refuse("invalid-appearance");
    }
    if (size > commandNumber(this.config, "max-bytes")) return refuse("resource-limit");
    try {
      deltas.forEach(verifyCommandAppearance);
    } catch {
      return refuse("invalid-appearance");
    }
    const supplied = new Map(deltas.map((d) => [d.id, d]));
    const entry = supplied.get(entryId);
    if (!entry) return refuse("entry-missing");
    let common: CommandFields;
    try {
      common = readRequestCommon(entry);
    } catch {
      return refuse("invalid-request");
    }
    if (!valid(entry, at)) return refuse("request-outside-validity");
    if (
      commandEntity(common, "receiver") !== this.receiver ||
      commandRef(common, "configuration") !== this.configuration.id ||
      !valid(this.configuration, at) ||
      [...this.operations.values()].some((o) => !valid(o.delta, at))
    )
      return refuse("configuration-mismatch");
    if (
      !(this.config.caller ?? []).some(
        (t) => t.kind === "primitive" && t.value === entry.claims.author,
      )
    )
      return refuse("unauthorized");
    const operation = this.operations.get(commandRef(common, "operation"));
    if (!operation) return refuse("unsupported-operation");
    let fields: CommandFields;
    try {
      fields = readRequestArguments(entry, operation.kind);
    } catch {
      return refuse("invalid-arguments");
    }
    const supportRoles =
      operation.kind === "retain" ? ["payload"] : ["hyperschema", "schema", "definition"];
    const named = supportRoles.flatMap((role) =>
      (fields[role] ?? []).map((t) => (t.kind === "delta" ? t.deltaRef.delta : "")),
    );
    if (named.some((id) => !supplied.has(id))) return refuse("missing-support");
    const reachable = new Set([entryId, ...named]);
    if ([...supplied.keys()].some((id) => !reachable.has(id))) return refuse("unexpected-support");
    let writeDispatched = false;
    const tracked = new Proxy(this.boot.store, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        if (key === "compareAndAppend")
          return (...args: Parameters<DurableOrdinaryJournalStore["compareAndAppend"]>) => {
            writeDispatched = true;
            return target.compareAndAppend(...args);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    if (operation.kind === "evaluate") {
      // M2 development endpoints explicitly refuse unfinished execution; no capability is advertised.
      return refuse("unsupported-operation");
    }
    const captured = await captureOrdinaryJournalSource(
      tracked,
      this.receiver,
      this.boot.diagnostic,
    );
    if (captured.status !== "captured") return refuse(captured.status);
    if (fields["expected-head"] && commandText(fields, "expected-head") !== captured.head)
      return refuse("precondition-failed");
    const payloads = named
      .map((id) => supplied.get(id)!)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let admission;
    try {
      admission = await captured.peer.admit({
        offered: payloads,
        origin: { kind: "unattributed" },
        arrivedAt: at,
        capacity: Math.max(0, commandNumber(this.config, "quota") - captured.state.quotaUsed),
        policyState: {},
        guards: [],
        isErasureCandidate: () => false,
        mode: "atomic",
      });
    } catch (fault) {
      this.boot.diagnostic(fault);
      if (!writeDispatched) throw fault;
      return this.outcome(
        entryId,
        at,
        "indeterminate",
        map([["code", tstr("commit-unconfirmed")]]),
      );
    }
    if (admission.status === "committed-unconfirmed") {
      this.boot.diagnostic(admission.fault);
      return this.outcome(
        entryId,
        at,
        "indeterminate",
        map([["code", tstr("commit-unconfirmed")]]),
      );
    }
    if (admission.status !== "committed")
      return refuse(admission.status === "conflict" ? "write-conflict" : "admission-rejected");
    const after = captured.peer.snapshot();
    const ids = (status: string) =>
      admission.outcomes
        .filter((o) => o.status === status)
        .map((o) => o.id)
        .sort();
    return this.outcome(
      entryId,
      at,
      "completed",
      map([
        ["kind", tstr("retain")],
        ["beforeHead", tstr(captured.head)],
        ["head", tstr(admission.head)],
        ["beforeDigest", tstr(captured.source.digest())],
        ["digest", tstr(after.base.admitted.digest())],
        ["admitted", array(ids("admitted").map(tstr))],
        ["duplicate", array(ids("duplicate").map(tstr))],
      ]),
    );
  }
  catalog(): DeltaSet {
    return DeltaSet.from(
      [this.configuration, ...[...this.operations.values()].map((o) => o.delta)].map((d) =>
        structuredClone(d),
      ),
    );
  }
}
