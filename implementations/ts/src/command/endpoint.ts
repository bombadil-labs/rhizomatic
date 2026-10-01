// SPEC-15 orchestration: boot explicitly grants effects; signed descriptions never self-install.
import { array, encode, map, tstr, bstr, float, type CborValue } from "../delta/cbor.js";
import { authorForSeed, signClaims } from "../delta/sign.js";
import { claimsToJson } from "../delta/json-profile.js";
import { canonicalBytes } from "../delta/delta.js";
import { DeltaSet } from "../delta/set.js";
import type { Claims, Delta, Target } from "../delta/types.js";
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
  commandBytes,
  decodeBindings,
  isCommandId,
  isCommandKey,
  parseCommandDelta,
  readConfiguration,
  readOperation,
  readRequestArguments,
  readRequestCommon,
  verifyCommandAppearance,
  commandDescriptionClaims,
  type CommandFields,
} from "../command-data/codec.js";
import { readCommandDefinition } from "../schema-load/command-definitions.js";
import { validateCommandProgram, CommandProgramError } from "../schema/command-program.js";
import { evalTerm } from "../resolve/eval.js";
import { bindReadingVariables } from "../syntax/bind-reading.js";
import { resolveView, viewCanonicalHex } from "../resolve-kernel/resolution.js";
import {
  lowerPrincipalTerm,
  lowerPrincipalRegistry,
  principalResolver,
} from "../principal/term.js";
export class CommandTransportError extends Error {}
/** One governing author and an explicit signing capability; no seed retrieval port. */
export interface CommandSigner {
  readonly author: string;
  sign(claims: Claims): Delta;
}
interface CommandBootInputs {
  readonly configuration: Delta;
  readonly declarations: readonly Delta[];
  readonly store: DurableOrdinaryJournalStore;
  readonly clock: () => number;
  readonly diagnostic: (fault: unknown) => void;
}
export type CommandBoot = CommandBootInputs &
  (
    | { readonly seed: string; readonly signer?: never }
    | { readonly seed?: never; readonly signer: CommandSigner }
  );
const valid = (delta: Delta, at: number): boolean =>
  delta.claims.validFrom <= at &&
  (delta.claims.validUntil === undefined || at < delta.claims.validUntil);
const text = (value: string): readonly Target[] => [{ kind: "primitive", value }];
const reference = (id: string): readonly Target[] => [{ kind: "delta", deltaRef: { delta: id } }];
export class CommandEndpoint {
  private tail: Promise<void> = Promise.resolve();
  private readonly receiver: string;
  private readonly signer: CommandSigner;
  private readonly configuration: Delta;
  private readonly config: CommandFields;
  private readonly operations: ReadonlyMap<string, { delta: Delta; kind: "retain" | "evaluate" }>;
  private constructor(private readonly boot: CommandBoot) {
    if ((boot.seed !== undefined) === (boot.signer !== undefined))
      throw new Error("select exactly one command signing capability");
    if (boot.signer !== undefined) {
      const { author, sign } = boot.signer;
      if (!isCommandKey(author) || typeof sign !== "function")
        throw new Error("invalid command signing capability");
      this.signer = { author, sign: sign.bind(boot.signer) };
    } else {
      const seed = boot.seed!;
      this.signer = { author: authorForSeed(seed), sign: (claims) => signClaims(claims, seed) };
    }
    this.receiver = this.signer.author;
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
    const claims = commandDescriptionClaims(this.receiver, at, "outcome/1", {
      receiver: [{ kind: "entity", entity: { id: this.receiver } }],
      configuration: reference(this.configuration.id),
      request: reference(entryId),
      status: text(status),
      result: [{ kind: "bytes", mime: "application/cbor", value: encode(body) }],
    });
    const expected = JSON.stringify(claimsToJson(claims));
    const signed = structuredClone(this.signer.sign(structuredClone(claims)));
    verifyCommandAppearance(signed);
    if (JSON.stringify(claimsToJson(signed.claims)) !== expected)
      throw new Error("response signing capability returned invalid testimony");
    return signed;
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
        if (d.sig !== undefined && (d.sig.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(d.sig)))
          throw new Error("signature bytes");
        size += canonicalBytes(d.claims).length + (d.sig?.length ?? 0) / 2;
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
    const supplied = new Map<string, Delta>();
    for (const delta of deltas) {
      const previous = supplied.get(delta.id);
      if (!previous || delta.sig! < previous.sig!) supplied.set(delta.id, delta);
    }
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
      const sourceKind = commandText(fields, "source");
      let source: DeltaSet, head: string | undefined;
      if (sourceKind === "catalog") source = this.catalog();
      else {
        const captured = await captureOrdinaryJournalSource(
          this.boot.store,
          this.receiver,
          this.boot.diagnostic,
        );
        if (captured.status !== "captured") return refuse(captured.status);
        source = captured.source;
        head = captured.head;
      }
      if (
        (fields["expected-head"] && commandText(fields, "expected-head") !== head) ||
        (fields["expected-digest"] && commandText(fields, "expected-digest") !== source.digest())
      )
        return refuse("precondition-failed");
      const evaluationAt = commandNumber(fields, "at"),
        interpretation = commandText(fields, "interpretation");
      let definitions;
      try {
        definitions = [...new Set(named)]
          .sort()
          .map((id) => readCommandDefinition(supplied.get(id)!, evaluationAt));
      } catch {
        return refuse("invalid-definition");
      }
      if (
        definitions.find((d) => d.id === commandRef(fields, "hyperschema"))?.kind !== "hyper" ||
        definitions.find((d) => d.id === commandRef(fields, "schema"))?.kind !== "reading"
      )
        return refuse("invalid-definition");
      let selected;
      const bindings = new Map(Object.entries(decodeBindings(commandBytes(fields, "bindings"))));
      try {
        selected = validateCommandProgram(
          definitions,
          commandRef(fields, "hyperschema"),
          commandRef(fields, "schema"),
          commandText(fields, "hyperschema-pin"),
          commandText(fields, "schema-pin"),
          bindings,
          interpretation !== "core/1",
        );
      } catch (fault) {
        if (fault instanceof CommandProgramError) return refuse(fault.code);
        throw fault;
      }
      let value;
      try {
        let term = selected.hyper.body,
          reading = selected.reading,
          registry = selected.registry;
        if (interpretation !== "core/1") {
          const resolver = principalResolver(
            interpretation === "principal-sameAuthor/1" ? "sameAuthor" : "rootOrSameAuthor",
          );
          term = lowerPrincipalTerm(term, source, evaluationAt, resolver);
          const wrapper = lowerPrincipalTerm(
            { kind: "resolve", schema: reading, of: { kind: "input" } },
            source,
            evaluationAt,
            resolver,
          );
          if (wrapper.kind !== "resolve") throw new Error("reading lowering failed");
          reading = wrapper.schema;
          registry = lowerPrincipalRegistry(registry, source, evaluationAt, resolver);
        }
        const gathered = evalTerm(
          term,
          source,
          evaluationAt,
          commandEntity(fields, "root"),
          registry,
          bindings,
        );
        if (gathered.sort !== "hview") throw new Error("gather did not return a hyperview");
        value = viewCanonicalHex(
          resolveView(bindReadingVariables(reading, bindings), gathered.hview),
        );
      } catch {
        return refuse("invalid-program");
      }
      return this.outcome(
        entryId,
        at,
        "completed",
        map([
          ["kind", tstr("evaluate")],
          ["source", tstr(sourceKind)],
          ["digest", tstr(source.digest())],
          ["definitionDigest", tstr(DeltaSet.from(named.map((id) => supplied.get(id)!)).digest())],
          ["at", float(evaluationAt)],
          ["interpretation", tstr(interpretation)],
          ["hyperschemaPin", tstr(commandText(fields, "hyperschema-pin"))],
          ["schemaPin", tstr(commandText(fields, "schema-pin"))],
          ["value", bstr(Uint8Array.from(value.match(/../g)!.map((h) => Number.parseInt(h, 16))))],
          ...(head === undefined ? [] : [["head", tstr(head)] as const]),
        ]),
      );
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
