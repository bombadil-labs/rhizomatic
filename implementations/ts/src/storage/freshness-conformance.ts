// The freshness conformance runner (SPEC-18 proposal §4.6, "Freshness check"). It runs
// `vectors/store/freshness.json` against a store and a witness's three freshness functions:
// the capture, `touching` and `checkFresh`. `vectors/store/README.md` §9 is the normative text;
// this file follows it and must not accept anything the text does not.

import { compareUtf8 } from "../delta/cbor.js";
import type { Delta } from "../delta/types.js";
import {
  captureDefect,
  parseCapture,
  type Capture,
  type Freshness,
  type Touch,
} from "./freshness.js";
import {
  Run,
  StoreConformanceError,
  caseStore,
  missing,
  type StoreConformanceFailure,
} from "./store-conformance.js";
import {
  PUSHDOWN_FIELDS,
  STORE_FRESHNESS_FORMAT,
  type CaptureStep,
  type CheckStep,
  type StoreFreshnessDocument,
  type StoreTouchingCase,
  type VectorTouch,
  type VectorVerdict,
} from "./store-vector-format.js";
import {
  StoreError,
  StoreFaultError,
  type Anchor,
  type ChangePage,
  type ChangeRecord,
  type ChangeRetention,
  type Id,
  type PeerStore,
  type Pushdown,
  type Revision,
  type Snapshot,
  type Store,
} from "./store.js";

/** The three functions a witness offers for freshness. */
export interface FreshnessWitness {
  /**
   * A capture on `snapshot` of the scope of `anchors`, for a read with this selection (in
   * pushdown form) evaluated at `now`. TypeScript: `captureScope`.
   */
  capture(
    snapshot: Snapshot,
    anchors: readonly Anchor[],
    selection: Pushdown,
    now: number,
  ): Promise<Capture>;
  touching(
    capture: Capture,
    records: readonly ChangeRecord[],
    added: ReadonlyMap<Id, Delta>,
  ): Touch | null;
  checkFresh(peer: PeerStore, capture: Capture, now: number): Promise<Freshness>;
}

/** What a case asks of the store it runs on. Absent fields: as the run builds it. */
export type FreshnessStoreRequest = {
  readonly changeRetention?: Exclude<ChangeRetention, "none">;
};

export type FreshnessConformanceReport = {
  readonly passed: readonly string[];
  /** Cases that did not run: the profile lacks a requirement, or the factory cannot build the store. */
  readonly skipped: readonly { readonly name: string; readonly missing: string }[];
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const show = (ids: readonly string[]): string => `[${ids.map((id) => id.slice(0, 12)).join(" ")}]`;
const anchorText = (anchors: readonly Anchor[]): string =>
  `[${anchors.map((a) => `${String(a.kind)}:${String(a.entity)}`).join(" ")}]`;
const touchText = (touch: { revision: number; id: Id; reason: string } | null): string =>
  touch === null ? "none" : `${touch.revision} ${touch.id.slice(0, 12)} ${touch.reason}`;

/** One store call a check made, as the runner saw it. */
type Call =
  | { readonly op: "read"; readonly revision: Revision; readonly history: string }
  | {
      readonly op: "changes";
      readonly from: Revision;
      readonly to: Revision | undefined;
      readonly page: ChangePage | undefined;
    }
  | { readonly op: "get"; readonly ids: readonly Id[] }
  | { readonly op: string };

function callText(call: Call): string {
  if ("revision" in call) return "read";
  if ("from" in call) return `changes(${call.from}, ${call.to ?? "none"})`;
  if ("ids" in call) return `get ${show(call.ids)}`;
  return call.op;
}

const copyPage = (page: ChangePage): ChangePage =>
  page.status === "ok"
    ? {
        status: "ok",
        through: page.through,
        records: page.records.map((r) => ({
          revision: r.revision,
          head: r.head,
          added: [...r.added],
          removed: [...r.removed],
        })),
      }
    : { status: page.status, current: page.current };

/** A peer handle that writes every call made through it, and through its snapshots, to `log`. */
function logged(peer: PeerStore, log: Call[]): PeerStore {
  const note = (op: string) => log.push({ op });
  const snapshotOf = (snapshot: Snapshot): Snapshot => ({
    revision: snapshot.revision,
    history: snapshot.history,
    head: snapshot.head,
    count: snapshot.count,
    get: (ids) => (log.push({ op: "get", ids: [...ids] }), snapshot.get(ids)),
    arrivals: (ids) => (note("arrivals"), snapshot.arrivals(ids)),
    targets: (entities) => (note("targets"), snapshot.targets(entities)),
    negators: (ids) => (note("negators"), snapshot.negators(ids)),
    scope: (request) => (note("scope"), snapshot.scope(request)),
    release: () => (note("release"), snapshot.release()),
  });
  return {
    id: peer.id,
    history: peer.history,
    erasure: peer.erasure,
    read: async () => {
      // Written when the call is made, so a call that refuses is seen too.
      const call = { op: "read", revision: -1, history: "" };
      log.push(call);
      const snapshot = await peer.read();
      call.revision = snapshot.revision;
      call.history = snapshot.history;
      return snapshotOf(snapshot);
    },
    append: (batch) => (note("append"), peer.append(batch)),
    purge: (ids) => (note("purge"), peer.purge(ids)),
    changes: async (from, to) => {
      const call: { op: "changes"; from: number; to: number | undefined; page?: ChangePage } = {
        op: "changes",
        from,
        to,
      };
      log.push(call as Call);
      const page = await peer.changes(from, to);
      call.page = copyPage(page);
      return page;
    },
  };
}

/**
 * README §9.3, "The calls": one `read`; when its history is the capture's and its revision r′
 * is greater than the capture's,
 * `changes(c, r′)` and then from each `through`; one `get` of a page's added ids for each page
 * that names one; nothing after the page with the expected touch or a `resync-required`; then the
 * release of the snapshot, and nothing else.
 */
function checkCalls(log: readonly Call[], capture: Capture, touchAt: Revision | undefined): void {
  const from = capture.revision;
  let i = 0;
  const next = (want: string): Call => {
    const call = log[i++];
    check(call !== undefined, `checkFresh made no call where the contract asks for ${want}`);
    check(
      callText(call) === want,
      `checkFresh made the call ${callText(call)} where the contract asks for ${want}`,
    );
    return call;
  };
  const read = next("read") as { revision: Revision; history: string };
  const end = read.revision;
  if (read.history === capture.history && end > from)
    for (let at = from; ; ) {
      const { page } = next(`changes(${at}, ${end})`) as { page: ChangePage | undefined };
      if (page === undefined || page.status !== "ok") break;
      const ids = [...new Set(page.records.flatMap((r) => r.added))].sort(compareUtf8);
      if (ids.length > 0) next(`get ${show(ids)}`);
      if (touchAt !== undefined && page.records.some((r) => r.revision === touchAt)) break;
      if (page.through >= end || page.through <= at) break;
      at = page.through;
    }
  next("release");
  const extra = log[i];
  check(
    extra === undefined,
    `checkFresh made the call ${extra === undefined ? "" : callText(extra)} after its last call`,
  );
}

/** One case of `cases` (README §9.1): steps, captures and checks on one new store. */
class FreshnessRun {
  private readonly captures = new Map<string, { capture: Capture; owner: string }>();

  constructor(
    private readonly run: Run,
    private readonly witness: FreshnessWitness,
  ) {}

  private touch(touch: VectorTouch, handle: string): { revision: number; id: Id; reason: string } {
    return {
      revision: this.run.resolve({ revision: touch.revision }, handle),
      id: this.run.delta(touch.delta).id,
      reason: touch.reason,
    };
  }

  async capture(step: CaptureStep): Promise<void> {
    const owner = this.run.ownerOf(step.peer);
    const snapshot = await this.run.peer(step.peer).read();
    let capture: Capture;
    try {
      capture = await this.witness.capture(
        snapshot,
        step.anchors,
        this.run.pushdown(step.selection ?? {}, PUSHDOWN_FIELDS),
        step.now,
      );
    } finally {
      snapshot.release();
    }
    // The capture must be well formed: its lists in UTF-8 order, its window ordered.
    const defect = captureDefect(capture);
    check(defect === null, `the capture is malformed: ${defect ?? ""}`);
    check(capture.history === snapshot.history, "the capture's history is not its snapshot's");
    const revision = this.run.resolve({ revision: step.expect.revision }, step.peer);
    check(
      capture.revision === revision && revision === snapshot.revision,
      `the capture is of revision ${capture.revision}, expected ${revision}`,
    );
    check(
      anchorText(capture.anchors) === anchorText(step.expect.anchors),
      `the capture's anchors are ${anchorText(capture.anchors)}, expected ${anchorText(step.expect.anchors)}`,
    );
    const members = this.run.ids(step.expect.members);
    check(
      same(capture.members, members),
      `the capture's members are ${show(capture.members)}, expected ${show(members)}`,
    );
    check(
      capture.since === step.expect.since,
      `the capture's since is ${String(capture.since)}, expected ${String(step.expect.since)}`,
    );
    check(
      capture.expiresAt === step.expect.expiresAt,
      `the capture expires at ${String(capture.expiresAt)}, expected ${String(step.expect.expiresAt)}`,
    );
    check(!this.captures.has(step.as), `the vector names capture ${step.as} twice`);
    this.captures.set(step.as, { capture, owner });
  }

  async check(step: CheckStep): Promise<void> {
    const taken = this.captures.get(step.capture);
    check(taken !== undefined, `the vector uses capture ${step.capture} before taking it`);
    const { capture, owner } = taken;
    const checked = this.run.ownerOf(step.peer);
    const anotherPeer = checked !== owner;
    check(
      anotherPeer === (step.anotherPeer === true),
      anotherPeer
        ? `the vector checks capture ${step.capture} on another peer`
        : `the vector says capture ${step.capture} is checked on another peer, and it is not`,
    );
    check(typeof step.now === "number", "the vector's check has no now");
    const model = this.run.model(checked);
    check(model !== undefined, "a check step on a store that serves no feed");
    const revision = this.run.resolve({ revision: step.expect.revision }, step.peer);
    check(
      model.current === revision,
      `the vector checks at ${step.expect.revision}, and the peer is at ${model.current}`,
    );

    // A store that keeps fewer records than the document's answers resync-required below its
    // floor, whatever the document says about a feed that keeps every record.
    const belowFloor = !anotherPeer && capture.revision < model.floor;
    const expected: VectorVerdict = belowFloor
      ? { status: "resync-required" }
      : step.expect.verdict;
    const log: Call[] = [];
    const handle = logged(this.run.peer(step.peer), log);
    let verdict: Freshness;
    try {
      verdict = await this.witness.checkFresh(handle, capture, step.now);
    } catch (error) {
      if (error instanceof StoreFaultError)
        throw new Error(`the store broke ${error.rule}: ${error.message}`);
      if (!(error instanceof StoreError)) throw error;
      throw new Error(`checkFresh refused with ${error.code}: ${error.message}`);
    }
    check(
      verdict.status === expected.status,
      belowFloor
        ? `checkFresh answered ${verdict.status} for a capture below the retention floor ${model.floor}`
        : `checkFresh answered ${verdict.status}, expected ${expected.status}`,
    );
    let touchAt: Revision | undefined;
    if (verdict.status === "stale" && expected.status === "stale") {
      const want = this.touch(expected.touch, step.peer);
      check(
        touchText(verdict.touch) === touchText(want),
        `checkFresh reports the touch ${touchText(verdict.touch)}, expected ${touchText(want)}`,
      );
      touchAt = want.revision;
    }
    if (verdict.status === "not-yet" && expected.status === "not-yet")
      check(
        verdict.since === expected.since,
        `checkFresh reports not-yet since ${verdict.since}, expected ${expected.since}`,
      );
    if (verdict.status === "expired" && expected.status === "expired")
      check(
        verdict.expiresAt === expected.expiresAt,
        `checkFresh reports expiry at ${verdict.expiresAt}, expected ${expected.expiresAt}`,
      );
    if (verdict.status === "resync-required")
      check(
        verdict.current === model.current,
        `checkFresh reports resync-required with current ${verdict.current}, not the peer's revision ${model.current}`,
      );
    checkCalls(log, capture, touchAt);
    if (anotherPeer) return;

    // `touching` alone, over the runner's own records: every record since the capture, kept or
    // not, and the deltas of the added ids the peer still holds.
    const records = model.records
      .filter((r) => r.revision > capture.revision && r.revision <= revision)
      .map((r) => ({ ...r, added: [...r.added], removed: [...r.removed] }));
    const held = this.run.holdings.get(owner)!;
    const added = new Map<Id, Delta>();
    for (const record of records)
      for (const id of record.added) {
        const entry = held.get(id);
        if (entry !== undefined) added.set(id, entry.delta);
      }
    const got = this.witness.touching(capture, records, added);
    const want = step.expect.touching === null ? null : this.touch(step.expect.touching, step.peer);
    check(
      touchText(got) === touchText(want),
      `touching answered ${touchText(got)}, expected ${touchText(want)}`,
    );
  }
}

/** One case of `touching` (README §9.5): the pure function over records no store wrote. */
function touchingCase(run: Run, witness: FreshnessWitness, c: StoreTouchingCase): void {
  // Through the checking constructor: the document lists the members in UTF-8 order.
  const capture = parseCapture({
    history: "touching",
    revision: c.capture.revision,
    anchors: c.capture.anchors,
    members: run.ids(c.capture.members),
    since: null,
    expiresAt: null,
  });
  const records = c.records.map((r) => ({
    revision: r.revision,
    head: r.head,
    added: run.ids(r.added),
    removed: run.ids(r.removed),
  }));
  const added = new Map(c.held.map((name) => [run.delta(name).id, run.delta(name)]));
  const got = witness.touching(capture, records, added);
  const want =
    c.expect.touch === null
      ? null
      : {
          revision: c.expect.touch.revision,
          id: run.delta(c.expect.touch.delta).id,
          reason: c.expect.touch.reason,
        };
  check(
    touchText(got) === touchText(want),
    `touching answered ${touchText(got)}, expected ${touchText(want)}`,
  );
}

/**
 * Runs `freshness.json` against the stores `factory` makes and a witness's freshness functions.
 * Each case gets a new store, built with the case's checked `store` fields; `factory` answers
 * undefined when it cannot build such a store, which skips the case with the requirement
 * `store`. Any other failure of the factory fails the case. Throws `StoreConformanceError`,
 * listing every failure, when anything fails; a document of another format is one failure,
 * named `freshness`.
 */
export async function runFreshnessConformance(
  factory: (request: FreshnessStoreRequest) => Promise<Store | undefined>,
  witness: FreshnessWitness,
  vectors: StoreFreshnessDocument,
): Promise<FreshnessConformanceReport> {
  if (vectors.format !== STORE_FRESHNESS_FORMAT)
    throw new StoreConformanceError([
      { name: "freshness", message: "unknown store freshness format" },
    ]);
  const passed: string[] = [];
  const skipped: { name: string; missing: string }[] = [];
  const failures: StoreConformanceFailure[] = [];
  const text = (error: unknown): string =>
    error instanceof StoreError
      ? `refused with ${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  const guarded = async (name: string, body: () => Promise<void> | void): Promise<boolean> => {
    try {
      await body();
      return true;
    } catch (error) {
      failures.push({ name, message: text(error) });
      return false;
    }
  };
  const open = async (request: FreshnessStoreRequest): Promise<Store | undefined> => {
    try {
      return await factory(request);
    } catch (error) {
      throw new Error(`the factory did not open a store: ${text(error)}`);
    }
  };

  for (const c of vectors.cases) {
    const name = `freshness/${c.name}`;
    let store: Store | undefined;
    if (
      !(await guarded(
        name,
        async () => void (store = await open(caseStore(c.store, ["changeRetention"]))),
      ))
    )
      continue;
    if (store === undefined) {
      skipped.push({ name, missing: "store" });
      continue;
    }
    const opened: Store = store;
    let lacks: string | undefined;
    if (await guarded(name, () => void (lacks = missing(opened, c.requires)))) {
      if (lacks !== undefined) skipped.push({ name, missing: lacks });
      else {
        const run = new Run(opened, vectors);
        const fresh = new FreshnessRun(run, witness);
        const ran = await guarded(name, async () => {
          for (const [i, step] of c.steps.entries()) {
            try {
              if (step.op === "capture") await fresh.capture(step);
              else if (step.op === "check") await fresh.check(step);
              else await run.step(step);
              await run.checkFeeds();
            } catch (error) {
              throw new Error(`step ${i} (${step.op}): ${text(error)}`);
            }
          }
        });
        if (ran) passed.push(name);
      }
    }
    await opened.close();
  }

  let store: Store | undefined;
  if (await guarded("touching", async () => void (store = await open({})))) {
    const opened = store;
    if (opened !== undefined) {
      const run = new Run(opened, vectors);
      for (const c of vectors.touching) {
        const name = `touching/${c.name}`;
        if (await guarded(name, () => touchingCase(run, witness, c))) passed.push(name);
      }
      await opened.close();
    } else
      for (const c of vectors.touching)
        skipped.push({ name: `touching/${c.name}`, missing: "store" });
  }

  if (failures.length > 0) throw new StoreConformanceError(failures);
  return { passed, skipped };
}
