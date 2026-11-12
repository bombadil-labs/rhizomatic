// The store conformance runner (SPEC-18 proposal §8). It runs the shared store vectors against
// any implementation of the store interface. `vectors/store/README.md` specifies the documents;
// this file follows that text and must not accept anything the text does not.

import { compareUtf8 } from "../delta/cbor.js";
import { computeId } from "../delta/delta.js";
import { parseClaims } from "../delta/json-profile.js";
import type { Delta } from "../delta/types.js";
import type { ArrivalRecord } from "./arrival-record.js";
import {
  PURGE_BOUNDARY,
  StoreError,
  type AppliedPushdown,
  type PeerStore,
  type Pushdown,
  type Snapshot,
  type Store,
  type VerifiedDelta,
} from "./store.js";
import {
  PUSHDOWN_FIELDS,
  STORE_SCOPE_FORMAT,
  STORE_SCRIPTS_FORMAT,
  passesSelection,
  scopeOver,
  type PushdownField,
  type StoreScopeCase,
  type StoreVectorStep,
  type StoreVectors,
  type VectorHeader,
  type VectorPushdown,
  type VectorRefusal,
  type VectorRequirement,
} from "./store-vector-format.js";
import { storeVectors } from "./store-vectors.js";

export type StoreConformanceFailure = { readonly name: string; readonly message: string };
export type StoreConformanceReport = {
  /** Scripts and scope cases that ran and passed. */
  readonly passed: readonly string[];
  /** Scripts that did not run because the store's profile lacks what they need. */
  readonly skipped: readonly { readonly name: string; readonly missing: VectorRequirement }[];
};

export class StoreConformanceError extends Error {
  readonly failures: readonly StoreConformanceFailure[];
  constructor(failures: readonly StoreConformanceFailure[]) {
    super(
      `store conformance: ${failures.length} failed\n` +
        failures.map((f) => `  ${f.name}: ${f.message}`).join("\n"),
    );
    this.name = "StoreConformanceError";
    this.failures = failures;
  }
}

const key = (fields: readonly PushdownField[]): string =>
  PUSHDOWN_FIELDS.filter((f) => fields.includes(f)).join(",");
const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const show = (ids: readonly string[]): string => `[${ids.map((id) => id.slice(0, 12)).join(" ")}]`;

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const codes = (refusal: VectorRefusal): readonly string[] =>
  typeof refusal === "string" ? [refusal] : refusal;

/** The outcome must be a refusal with one of the codes the vector lists. */
function refused(outcome: { value: unknown } | { error: string }, refusal: VectorRefusal): void {
  const allowed = codes(refusal);
  check("error" in outcome, `expected a refusal: ${allowed.join(" or ")}`);
  check(
    allowed.includes(outcome.error),
    `refused with ${outcome.error}, expected ${allowed.join(" or ")}`,
  );
}

/** Runs `action`; returns the store error code it refused with, or its value. */
async function attempt<T>(action: () => Promise<T>): Promise<{ value: T } | { error: string }> {
  try {
    return { value: await action() };
  } catch (error) {
    if (error instanceof StoreError) return { error: error.code };
    throw error;
  }
}

class Run {
  private readonly corpus = new Map<string, Delta>();
  /** Peer handles by handle name, and the peer name each belongs to. */
  private readonly peers = new Map<string, PeerStore>();
  private readonly owners = new Map<string, string>();
  private readonly snapshots = new Map<string, { peer: string; snapshot: Snapshot }>();
  /** What each peer holds, with the arrival it was first admitted under. */
  readonly holdings = new Map<string, Map<string, VerifiedDelta>>();
  readonly reference: boolean;

  constructor(
    readonly store: Store,
    private readonly header: VectorHeader,
  ) {
    for (const entry of header.deltas) {
      const claims = parseClaims(entry.claims);
      // A forged entry pairs claims with another delta's id on purpose; only the others must
      // recompute.
      if (entry.forged !== true)
        check(computeId(claims) === entry.id, `vector delta ${entry.name}: id does not recompute`);
      this.corpus.set(
        entry.name,
        entry.sig === undefined
          ? { id: entry.id, claims }
          : { id: entry.id, claims, sig: entry.sig },
      );
    }
    this.reference = store.profile.formatVersion === header.reference.formatVersion;
  }

  delta(name: string): Delta {
    const delta = this.corpus.get(name);
    check(delta !== undefined, `the vector names an unknown delta ${name}`);
    return delta;
  }
  ids(names: readonly string[]): string[] {
    return names.map((name) => this.delta(name).id);
  }
  peerId(name: string): string {
    const id = this.header.peers[name];
    check(id !== undefined, `the vector names an unknown peer ${name}`);
    return id;
  }
  peer(name: string): PeerStore {
    const peer = this.peers.get(name);
    check(peer !== undefined, `the vector uses peer ${name} before creating it`);
    return peer;
  }
  /** The bookkeeping of the peer a handle belongs to. */
  held(handle: string): Map<string, VerifiedDelta> {
    return this.holdings.get(this.owners.get(handle)!)!;
  }
  snapshot(name: string): { peer: string; snapshot: Snapshot } {
    const snapshot = this.snapshots.get(name);
    check(snapshot !== undefined, `the vector uses snapshot ${name} before reading it`);
    return snapshot;
  }
  pushdown(vector: VectorPushdown, fields: readonly PushdownField[]): Pushdown {
    return {
      ...(fields.includes("timestampAtMost") && vector.timestampAtMost !== undefined
        ? { timestampAtMost: vector.timestampAtMost }
        : {}),
      ...(fields.includes("arrivalAtMost") && vector.arrivalAtMost !== undefined
        ? { arrivalAtMost: vector.arrivalAtMost }
        : {}),
      ...(fields.includes("excludeIds") && vector.excludeIds !== undefined
        ? { excludeIds: this.ids(vector.excludeIds) }
        : {}),
    };
  }

  private async revision(peer: string): Promise<number> {
    const snapshot = await this.peer(peer).read();
    const revision = snapshot.revision;
    snapshot.release();
    return revision;
  }

  /** A returned delta must be the named appearance: id, signature and claims. */
  matches(actual: Delta, name: string): void {
    const expected = this.delta(name);
    check(actual.id === expected.id, `expected delta ${name}, got id ${actual.id.slice(0, 12)}`);
    check(actual.sig === expected.sig, `delta ${name}: the signature differs`);
    check(computeId(actual.claims) === expected.id, `delta ${name}: the claims differ`);
  }

  /** An arrival record a store returns must be the one this peer admitted the id under. */
  sameArrival(peer: string, got: ArrivalRecord): void {
    const arrival = this.holdings.get(peer)?.get(got.id)?.arrival;
    check(arrival !== undefined, `the store answered for ${got.id.slice(0, 12)}, not held`);
    check(
      got.at === arrival.at &&
        got.sequence === arrival.sequence &&
        got.transfer === arrival.transfer &&
        got.sender === arrival.sender,
      `${got.id.slice(0, 12)} carries another arrival record`,
    );
  }

  /** Scope members must be ascending, distinct, held, and carry this peer's own arrival. */
  members(peer: string, deltas: readonly VerifiedDelta[]): string[] {
    const ids = deltas.map((entry) => entry.delta.id);
    check(
      ids.every((id, i) => i === 0 || compareUtf8(ids[i - 1]!, id) < 0),
      "scope members are not ascending and distinct",
    );
    for (const entry of deltas) {
      check(computeId(entry.delta.claims) === entry.delta.id, "a scope member's claims differ");
      check(entry.arrival.id === entry.delta.id, "a scope member carries another id's arrival");
      this.sameArrival(peer, entry.arrival);
      check(
        entry.delta.sig === this.holdings.get(peer)!.get(entry.delta.id)!.delta.sig,
        "a scope member carries another appearance's signature",
      );
    }
    return ids;
  }

  applied(result: AppliedPushdown, requested: Pushdown): PushdownField[] {
    const applied = PUSHDOWN_FIELDS.filter((field) => result[field]);
    for (const field of PUSHDOWN_FIELDS) {
      const asked = requested[field] !== undefined;
      check(asked || !result[field], `applied reports ${field}, which was not requested`);
      if (this.reference)
        check(
          result[field] === (asked && this.store.profile.pushdown[field]),
          `the reference store must apply ${field} exactly when its profile says so`,
        );
    }
    return applied;
  }

  // The store is asked first and the answer is judged afterwards, so a store that answers
  // where it must refuse fails for that, whatever it answered.
  private async query<T>(
    snapshotName: string,
    expect: { readonly error?: VectorRefusal; readonly orError?: "snapshot-moved" },
    ask: (snapshot: Snapshot) => Promise<T>,
    judge: (answer: T, peer: string) => void,
  ): Promise<void> {
    const { peer, snapshot } = this.snapshot(snapshotName);
    const outcome = await attempt(() => ask(snapshot));
    if (expect.error !== undefined) refused(outcome, expect.error);
    else if ("value" in outcome) judge(outcome.value, peer);
    else
      check(
        outcome.error === expect.orError,
        `the query refused with ${outcome.error}, and ${
          expect.orError === undefined
            ? "it must answer"
            : `only ${expect.orError} or an answer conforms`
        }`,
      );
  }

  async step(step: StoreVectorStep): Promise<void> {
    switch (step.op) {
      case "createPeer": {
        const outcome = await attempt(() =>
          this.store.createPeer(this.peerId(step.peer), { erasure: step.erasure }),
        );
        const created =
          "status" in step.expect ||
          (step.expect.unlessStoreErasure !== undefined &&
            step.expect.unlessStoreErasure === this.store.profile.capabilities.erasure);
        if (created) {
          check("value" in outcome, "expected the peer to be created");
          check(outcome.value.erasure.posture === step.erasure, "the peer's posture differs");
          check(
            outcome.value.erasure.storeClass === this.store.profile.capabilities.erasure,
            "the peer did not record its store's erasure class",
          );
          this.peers.set(step.peer, outcome.value);
          this.owners.set(step.peer, step.peer);
          this.holdings.set(step.peer, new Map());
        } else if ("error" in step.expect) refused(outcome, step.expect.error);
        return;
      }
      case "openPeer": {
        const outcome = await attempt(() => this.store.peer(this.peerId(step.peer)));
        if ("error" in step.expect) return refused(outcome, step.expect.error);
        check("value" in outcome, "expected the peer to open");
        check(outcome.value.erasure.posture === step.expect.posture, "the posture differs");
        // With `handle`, the earlier handle stays in use under the peer's own name.
        this.peers.set(step.handle ?? step.peer, outcome.value);
        this.owners.set(step.handle ?? step.peer, step.peer);
        return;
      }
      case "append": {
        const before = await this.revision(step.peer);
        const added = step.added.map(({ delta, arrival }) => {
          const { id, ...rest } = arrival;
          return {
            delta: this.delta(delta),
            arrival: { id: this.delta(id ?? delta).id, ...rest },
          };
        });
        const frame = step.frame === null ? null : hexToBytes(step.frame);
        const outcome = await attempt(() =>
          this.peer(step.peer).append({
            expectedHead: step.expectedHead,
            nextHead: step.nextHead,
            frame,
            added,
          }),
        );
        const after = await this.revision(step.peer);
        if ("error" in step.expect) {
          refused(outcome, step.expect.error);
          check(after === before, "a refused append moved the revision");
          return;
        }
        check("value" in outcome, `the append refused`);
        const result = outcome.value;
        check(result.status === step.expect.status, `the append answered ${result.status}`);
        if (result.status !== "committed" || step.expect.status !== "committed") {
          check(after === before, "an append that did not commit moved the revision");
          return;
        }
        const names = step.expect.added;
        check(
          same(result.added, this.ids(names)),
          `added ${show(result.added)}, expected ${show(this.ids(names))}`,
        );
        check(result.revision === after, "the append result's revision is not the peer's");
        check(
          step.expect.revisionAdvanced ? after > before : after === before,
          `the revision ${step.expect.revisionAdvanced ? "did not advance" : "advanced"}`,
        );
        const held = this.held(step.peer);
        for (const entry of added)
          if (result.added.includes(entry.delta.id) && !held.has(entry.delta.id))
            held.set(entry.delta.id, entry);
        return;
      }
      case "purge": {
        const before = await this.revision(step.peer);
        const purged = await attempt(() => this.peer(step.peer).purge(this.ids(step.ids)));
        check(
          "value" in purged,
          `the purge refused${"error" in purged ? ` with ${purged.error}` : ""}`,
        );
        const report = purged.value;
        const after = await this.revision(step.peer);
        const expected = step.expect.targets.map((t) => `${this.delta(t.delta).id} ${t.outcome}`);
        const actual = report.targets.map((t) => `${t.id} ${t.outcome}`);
        check(same(actual, expected), `purge targets ${actual.join("; ")}`);
        check(report.revision === after, "the purge report's revision is not the peer's");
        check(
          step.expect.revisionAdvanced ? after > before : after === before,
          `the revision ${step.expect.revisionAdvanced ? "did not advance" : "advanced"}`,
        );
        check(report.boundary === PURGE_BOUNDARY, "the report does not state its boundary");
        const storeClass = this.store.profile.capabilities.erasure;
        check(storeClass !== "none", "a store with erasure class none answered a purge");
        // A store may claim less than a vector allows, never more: `unproven` is accepted
        // where `proven` is expected, and nothing else is exchanged.
        const expectedClaim = step.expect.claim[storeClass];
        check(
          report.claim === expectedClaim ||
            (expectedClaim === "proven" && report.claim === "unproven"),
          `the report claims ${report.claim}, expected ${expectedClaim} on a store of class ${storeClass}`,
        );
        const states: readonly string[] = ["absent", "owed", "unprovable"];
        check(
          report.surfaces.every((s) => states.includes(s.state)),
          "a surface reports an unknown state",
        );
        check(
          report.claim !== "proven" ||
            (report.surfaces.length > 0 && report.surfaces.every((s) => s.state === "absent")),
          "the report claims proven without surfaces that are all absent",
        );
        if (this.reference)
          check(
            same(
              report.surfaces.map((s) => `${s.surface} ${s.state}`),
              step.expect.referenceSurfaces.map((s) => `${s.surface} ${s.state}`),
            ),
            "the reference store's surfaces differ",
          );
        const held = this.held(step.peer);
        for (const target of report.targets) held.delete(target.id);
        return;
      }
      case "read":
        this.snapshots.set(step.snapshot, {
          peer: this.owners.get(step.peer) ?? step.peer,
          snapshot: await this.peer(step.peer).read(),
        });
        return;
      case "release":
        this.snapshot(step.snapshot).snapshot.release();
        return;
      case "head": {
        const { snapshot } = this.snapshot(step.snapshot);
        check(snapshot.head === step.expect.head, `the head is ${String(snapshot.head)}`);
        return;
      }
      case "get":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.get(this.ids(step.ids)),
          (deltas) => {
            const names = "deltas" in step.expect ? step.expect.deltas : [];
            check(
              same(
                deltas.map((d) => d.id),
                this.ids(names),
              ),
              `get answered ${show(deltas.map((d) => d.id))}, expected ${show(this.ids(names))}`,
            );
            deltas.forEach((delta, i) => this.matches(delta, names[i]!));
          },
        );
      case "targets":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.targets(step.entities),
          (ids) => {
            const expected = this.ids("ids" in step.expect ? step.expect.ids : []);
            check(same(ids, expected), `targets answered ${show(ids)}, expected ${show(expected)}`);
          },
        );
      case "negators":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.negators(this.ids(step.ids)),
          (ids) => {
            const expected = this.ids("ids" in step.expect ? step.expect.ids : []);
            check(
              same(ids, expected),
              `negators answered ${show(ids)}, expected ${show(expected)}`,
            );
          },
        );
      case "scope": {
        const pushdown =
          step.pushdown === undefined ? undefined : this.pushdown(step.pushdown, PUSHDOWN_FIELDS);
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) =>
            snapshot.scope({
              anchors: step.anchors,
              ...(pushdown === undefined ? {} : { pushdown }),
              ...(step.exclude === undefined ? {} : { exclude: this.ids(step.exclude) }),
            }),
          (result, peer) => {
            const ids = this.members(peer, result.deltas);
            const applied = this.applied(result.applied, pushdown ?? {});
            if (!("lower" in step.expect)) return;
            const lower = this.ids(step.expect.lower);
            const upper = new Set(this.ids(step.expect.upper));
            check(
              lower.every((id) => ids.includes(id)),
              `scope ${show(ids)} lacks a member of ${show(lower)}`,
            );
            check(
              ids.every((id) => upper.has(id)),
              `scope ${show(ids)} leaves the upper bound`,
            );
            const requested = PUSHDOWN_FIELDS.filter((f) => pushdown?.[f] !== undefined);
            if (this.reference && applied.length === requested.length)
              check(
                same(ids, lower),
                `the reference store answered ${show(ids)}, not ${show(lower)}`,
              );
          },
        );
      }
      case "count": {
        const { snapshot } = this.snapshot(step.snapshot);
        check(snapshot.count === step.expect.count, `the snapshot counts ${snapshot.count}`);
        return;
      }
      case "arrivals":
        return this.query(
          step.snapshot,
          step.expect,
          (snapshot) => snapshot.arrivals(this.ids(step.ids)),
          (arrivals, peer) => {
            const expected = this.ids("ids" in step.expect ? step.expect.ids : []);
            const ids = arrivals.map((arrival) => arrival.id);
            check(
              same(ids, expected),
              `arrivals answered ${show(ids)}, expected ${show(expected)}`,
            );
            for (const arrival of arrivals) this.sameArrival(peer, arrival);
          },
        );
      case "export": {
        const exporter = this.store.openAdmin().peer(this.peerId(step.peer));
        const outcome = await attempt(async () => {
          const ids: string[] = [];
          for await (const id of exporter.ids()) ids.push(id);
          const deltas: Delta[] = [];
          for await (const delta of exporter.deltas()) deltas.push(delta);
          return { ids, deltas };
        });
        if ("error" in step.expect) return refused(outcome, step.expect.error);
        check("value" in outcome, "the export refused");
        const names = step.expect.deltas;
        const { ids, deltas } = outcome.value;
        check(same(ids, this.ids(names)), `export ids ${show(ids)}`);
        check(deltas.length === ids.length, "export deltas and ids disagree");
        deltas.forEach((delta, i) => this.matches(delta, names[i]!));
        return;
      }
      case "exportStored": {
        const ids: string[] = [];
        for await (const id of this.store.openAdmin().storedIds()) ids.push(id);
        const expected = this.ids(step.expect.ids);
        check(same(ids, expected), `the store keeps ${show(ids)}, expected ${show(expected)}`);
        return;
      }
      case "exportPeers": {
        const peers: string[] = [];
        for await (const id of this.store.openAdmin().peers()) peers.push(id);
        const expected = step.expect.peers.map((name) => this.peerId(name));
        check(same(peers, expected), `the store lists peers ${peers.join(" ")}`);
        return;
      }
    }
  }

  async steps(steps: readonly StoreVectorStep[]): Promise<void> {
    for (const [i, step] of steps.entries()) {
      try {
        await this.step(step);
      } catch (error) {
        throw new Error(
          `step ${i} (${step.op}): ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  /** The trim lemma (§4.3) for one case, once per subset of its selection's fields. */
  async scopeCase(scopeCase: StoreScopeCase): Promise<void> {
    // `peer` is a handle name, as in `read`. The bookkeeping is the peer's it belongs to.
    const peer = this.owners.get(scopeCase.peer) ?? scopeCase.peer;
    const snapshot = await this.peer(scopeCase.peer).read();
    const entities = scopeCase.anchors.map((anchor) => anchor.entity);
    const byFields = new Map(scopeCase.scopes.map((s) => [key(s.fields), this.ids(s.ids)]));
    const present = PUSHDOWN_FIELDS.filter((field) => scopeCase.selection[field] !== undefined);
    const selection = this.pushdown(scopeCase.selection, PUSHDOWN_FIELDS);
    const exact = byFields.get(key(present));
    check(exact !== undefined, "the case lacks the scope under its whole selection");
    const heldIds = this.ids(scopeCase.held);
    const held: VerifiedDelta[] = (await snapshot.get(heldIds)).map((delta) => ({
      delta,
      arrival: this.holdings.get(peer)!.get(delta.id)!.arrival,
    }));
    check(held.length === new Set(heldIds).size, "the peer does not hold a delta the case holds");

    for (const entry of scopeCase.scopes) {
      const label = `pushdown {${key(entry.fields)}}`;
      const pushdown = this.pushdown(scopeCase.selection, entry.fields);
      const result = await snapshot.scope({
        anchors: scopeCase.anchors,
        ...(entry.fields.length === 0 ? {} : { pushdown }),
        exclude: heldIds,
      });
      const ids = this.members(peer, result.deltas);
      const applied = this.applied(result.applied, pushdown);
      const lower = this.ids(entry.ids).filter((id) => !heldIds.includes(id));
      const upper = byFields.get(key(applied));
      check(upper !== undefined, `${label}: the case lacks a scope for the applied fields`);
      check(
        lower.every((id) => ids.includes(id)),
        `${label}: scope ${show(ids)} lacks a member of ${show(lower)}`,
      );
      check(
        ids.every((id) => upper.includes(id)),
        `${label}: scope ${show(ids)} leaves S over the applied selection ${show(upper)}`,
      );
      if (this.reference) {
        const reference = upper.filter((id) => !heldIds.includes(id));
        check(same(ids, reference), `${label}: the reference store answered ${show(ids)}`);
      }
      const residual = present.filter((field) => !applied.includes(field));
      const trimmed = scopeOver(
        [
          ...result.deltas.filter((e) => passesSelection(e, selection, residual)),
          ...held.filter((e) => passesSelection(e, selection, present)),
        ],
        entities,
      );
      check(
        same(trimmed, exact),
        `${label}: the trimmed scope is ${show(trimmed)}, expected ${show(exact)}`,
      );
    }
    snapshot.release();
  }
}

function missing(
  store: Store,
  requires: readonly VectorRequirement[],
): VectorRequirement | undefined {
  return requires.find((requirement) =>
    requirement === "purge"
      ? store.profile.capabilities.erasure === "none"
      : store.profile.capabilities.journal,
  );
}

/**
 * Runs the shared store vectors against the stores `factory` makes. Each script, and the scope
 * document, gets a new empty store. Returns what passed and what the profile made it skip.
 * Throws `StoreConformanceError`, listing every failure, when anything fails.
 */
export async function runStoreConformance(
  factory: () => Promise<Store>,
  vectors: StoreVectors = storeVectors(),
): Promise<StoreConformanceReport> {
  const passed: string[] = [];
  const skipped: { name: string; missing: VectorRequirement }[] = [];
  const failures: StoreConformanceFailure[] = [];
  const guarded = async (name: string, body: () => Promise<void>): Promise<boolean> => {
    try {
      await body();
      return true;
    } catch (error) {
      failures.push({ name, message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  };
  check(vectors.scripts.format === STORE_SCRIPTS_FORMAT, "unknown store scripts format");
  check(vectors.scope.format === STORE_SCOPE_FORMAT, "unknown store scope format");

  for (const script of vectors.scripts.scripts) {
    const name = `scripts/${script.name}`;
    const store = await factory();
    const lacks = missing(store, script.requires);
    if (lacks !== undefined) skipped.push({ name, missing: lacks });
    else if (await guarded(name, () => new Run(store, vectors.scripts).steps(script.steps)))
      passed.push(name);
    await store.close();
  }

  const store = await factory();
  const run = new Run(store, vectors.scope);
  if (await guarded("scope/setup", () => run.steps(vectors.scope.setup)))
    for (const scopeCase of vectors.scope.cases) {
      const name = `scope/${scopeCase.name}`;
      if (await guarded(name, () => run.scopeCase(scopeCase))) passed.push(name);
    }
  await store.close();

  if (failures.length > 0) throw new StoreConformanceError(failures);
  return { passed, skipped };
}
