// The held-views conformance runner (SPEC-18 proposal §4.6, "Held views"). It runs
// `vectors/store/views.json` against a store and a witness's view holder. `vectors/store/README.md`
// §11 is the normative text; this file follows it and must not accept anything the text does not.

import { compareUtf8 } from "../delta/cbor.js";
import { SchemaRegistry } from "../schema/schema.js";
import { parseTerm } from "../syntax/term-json.js";
import type { Position } from "../storage/follow.js";
import {
  Run,
  StoreConformanceError,
  missing,
  type StoreConformanceFailure,
} from "../storage/store-conformance.js";
import type {
  StoreVectorStep,
  VectorHeader,
  VectorPushdown,
  VectorRequirement,
} from "../storage/store-vector-format.js";
import {
  StoreError,
  type ChangePage,
  type ChangeRetention,
  type Entity,
  type Id,
  type PeerStore,
  type Snapshot,
  type Store,
} from "../storage/store.js";
import { UnanchoredTermError } from "./store-read.js";
import type { Refresh, ViewProgram, ViewRead } from "./store-views.js";

export const STORE_VIEWS_FORMAT = "rhizomatic-store-views/1";

/** A program of the document: a term, and perhaps a selection in pushdown form. */
export type ViewsProgram = {
  readonly name: string;
  readonly term: unknown;
  /** Absent: no selection. `excludeIds` holds corpus names. */
  readonly selection?: VectorPushdown;
};
export type ViewsKey = { readonly program: string; readonly root: string };
export type RegisterStep = {
  readonly op: "register";
  readonly program: string;
  readonly epoch?: string;
  /** Present: the program is not anchored, and registering it is refused with this reason. */
  readonly expect?: { readonly reason: string };
};
export type HoldStep = {
  readonly op: "hold";
  readonly program: string;
  readonly root: string;
  readonly now: number;
  readonly expect: {
    readonly bytes: string;
    /** Absent for a program with a selection: a holder may read such a view more often. */
    readonly from?: "held" | "read";
    readonly position: string;
    readonly expiresAt: number | null;
    readonly nextBoundary: number | null;
    /** The views of programs without a selection that the hold's pass reads again. */
    readonly reread: readonly ViewsKey[];
  };
};
export type RefreshStep = {
  readonly op: "refresh";
  readonly now: number;
  readonly expect: {
    readonly position: string;
    /** The views of programs without a selection that the refresh reads again. */
    readonly reread: readonly ViewsKey[];
    readonly changed: readonly (ViewsKey & { readonly before: string; readonly after: string })[];
    readonly resynced: boolean;
    readonly nextBoundary: number | null;
  };
};
export type DropStep = {
  readonly op: "drop";
  readonly program: string;
  readonly root: string;
  readonly expect: { readonly nextBoundary: number | null };
};
export type SetEpochStep = {
  readonly op: "setEpoch";
  readonly program: string;
  readonly epoch: string;
};
export type ViewsCaseStep =
  | StoreVectorStep
  | RegisterStep
  | HoldStep
  | RefreshStep
  | DropStep
  | SetEpochStep;
export type StoreViewsCase = {
  readonly name: string;
  readonly note: string;
  readonly spec: string;
  readonly requires: readonly VectorRequirement[];
  readonly store?: ViewsStoreRequest;
  /** The holder: over a handle of this peer, made after the setup. */
  readonly views: { readonly peer: string; readonly maxViews?: number };
  readonly steps: readonly ViewsCaseStep[];
};
export type StoreViewsDocument = VectorHeader & {
  readonly format: typeof STORE_VIEWS_FORMAT;
  readonly schemas: readonly {
    readonly name: string;
    readonly alg: number;
    readonly body: unknown;
  }[];
  readonly programs: readonly ViewsProgram[];
  /** Run at the start of every case, on its new store. */
  readonly setup: readonly StoreVectorStep[];
  readonly cases: readonly StoreViewsCase[];
};

/** What a case asks of the store it runs on. Absent fields: as the run builds it. */
export type ViewsStoreRequest = {
  readonly changeRetention?: Exclude<ChangeRetention, "none">;
  readonly changePageSize?: number;
};

/** A witness's holder of views: TypeScript's `StoreViews`, or a wrong one for the rails. */
export interface ViewHolder {
  register(name: string, program: ViewProgram): void;
  setEpoch(name: string, epoch: string): Promise<void>;
  hold(name: string, root: Entity, now: number): Promise<ViewRead>;
  refresh(now: number): Promise<Refresh>;
  drop(name: string, root: Entity): Promise<void>;
  readonly nextBoundary: number | null;
}

/** Makes a holder over a peer handle. TypeScript: `new StoreViews(peer, options)`. */
export interface ViewWitness {
  create(peer: PeerStore, options: { readonly maxViews?: number }): ViewHolder;
}

export type ViewsConformanceReport = {
  readonly passed: readonly string[];
  readonly skipped: readonly { readonly name: string; readonly missing: string }[];
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const show = (ids: readonly string[]): string => `[${ids.map((id) => id.slice(0, 12)).join(" ")}]`;
const keyText = (k: ViewsKey): string => `${k.program}@${k.root}`;
const keysText = (keys: readonly ViewsKey[]): string => `[${keys.map(keyText).join(" ")}]`;
const keyOf = (program: string, root: string): string => JSON.stringify([program, root]);
const byKey = (a: ViewsKey, b: ViewsKey): number =>
  compareUtf8(a.program, b.program) || compareUtf8(a.root, b.root);

/** One store call, as the runner saw it. */
type Call =
  | { readonly op: "read"; revision: number; history: string }
  | {
      readonly op: "changes";
      readonly from: number;
      readonly to: number | undefined;
      page?: ChangePage;
    }
  | { readonly op: "get"; readonly ids: readonly Id[] }
  | { readonly op: string };

function callText(call: Call): string {
  if ("revision" in call) return "read";
  if ("from" in call) return `changes(${call.from}, ${call.to ?? "none"})`;
  if ("ids" in call) return `${call.op} ${show(call.ids)}`;
  return call.op;
}

type Sink = { log: Call[] };

/** A peer handle that writes every call made through it, and through its snapshots, to the sink. */
function logged(peer: PeerStore, sink: Sink): PeerStore {
  const note = (op: string) => sink.log.push({ op });
  const snapshotOf = (snapshot: Snapshot): Snapshot => ({
    revision: snapshot.revision,
    history: snapshot.history,
    head: snapshot.head,
    count: snapshot.count,
    get: (ids) => (sink.log.push({ op: "get", ids: [...ids] }), snapshot.get(ids)),
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
      const call = { op: "read" as const, revision: -1, history: "" };
      sink.log.push(call);
      const snapshot = await peer.read();
      call.revision = snapshot.revision;
      call.history = snapshot.history;
      return snapshotOf(snapshot);
    },
    append: (batch) => (note("append"), peer.append(batch)),
    purge: (ids) => (note("purge"), peer.purge(ids)),
    changes: async (from, to) => {
      const call: Call & { page?: ChangePage } = { op: "changes", from, to };
      sink.log.push(call);
      const page = await peer.changes(from, to);
      call.page = page;
      return page;
    },
  };
}

/** One case: the setup, the holder and its steps, on one new store (README §11.1). */
class ViewsRun {
  private readonly programs = new Map<string, ViewsProgram>();
  private readonly registered = new Set<string>();
  private readonly registry: SchemaRegistry;
  /** The held views, least recently held or asked first, as the runner predicts them. */
  private readonly held = new Map<string, ViewsKey>();
  /** Where the holder's last pass stood. */
  private processed: Position | undefined;
  private holder!: ViewHolder;
  private readonly sink: Sink = { log: [] };
  private owner!: string;
  private handle!: string;
  private maxViews = Number.POSITIVE_INFINITY;

  constructor(
    private readonly run: Run,
    private readonly witness: ViewWitness,
    vectors: StoreViewsDocument,
  ) {
    for (const program of vectors.programs) {
      check(!this.programs.has(program.name), `the vector names program ${program.name} twice`);
      this.programs.set(program.name, program);
    }
    this.registry = SchemaRegistry.build(
      vectors.schemas.map((s) => ({ name: s.name, alg: s.alg, body: parseTerm(s.body) })),
    );
  }

  start(views: StoreViewsCase["views"]): void {
    this.handle = views.peer;
    this.owner = this.run.ownerOf(views.peer);
    if (views.maxViews !== undefined) this.maxViews = views.maxViews;
    this.holder = this.witness.create(
      logged(this.run.peer(views.peer), this.sink),
      views.maxViews === undefined ? {} : { maxViews: views.maxViews },
    );
    this.quiet("making the holder");
  }

  private program(name: string): ViewsProgram {
    const program = this.programs.get(name);
    check(program !== undefined, `the vector names an unknown program ${name}`);
    return program;
  }
  private selected(name: string): boolean {
    return this.program(name).selection !== undefined;
  }

  /** A step that makes no store call. */
  private quiet(what: string): void {
    const call = this.sink.log[0];
    this.sink.log = [];
    check(
      call === undefined,
      `${what} made the call ${callText(call ?? { op: "" })}; it makes no store call`,
    );
  }

  register(step: RegisterStep): void {
    const program = this.program(step.program);
    const selection = program.selection;
    let refused: string | undefined;
    try {
      this.holder.register(step.program, {
        term: parseTerm(program.term),
        registry: this.registry,
        ...(selection === undefined
          ? {}
          : {
              selection: {
                pushdown: {
                  ...selection,
                  ...(selection.excludeIds === undefined
                    ? {}
                    : { excludeIds: this.run.ids(selection.excludeIds) }),
                },
              },
            }),
        ...(step.epoch === undefined ? {} : { epoch: step.epoch }),
      });
    } catch (error) {
      if (!(error instanceof UnanchoredTermError)) throw error;
      refused = error.reason;
    }
    this.quiet("register");
    if (step.expect === undefined) {
      check(refused === undefined, `register of ${step.program} was refused: ${refused}`);
      this.registered.add(step.program);
    } else
      check(
        refused === step.expect.reason,
        refused === undefined
          ? `register of ${step.program} answered, expected the refusal ${step.expect.reason}`
          : `register refused ${refused}, expected ${step.expect.reason}`,
      );
  }

  async setEpoch(step: SetEpochStep): Promise<void> {
    this.program(step.program);
    await this.holder.setEpoch(step.program, step.epoch);
    this.quiet("setEpoch");
  }

  async drop(step: DropStep): Promise<void> {
    this.program(step.program);
    await this.holder.drop(step.program, step.root);
    this.quiet("drop");
    this.held.delete(keyOf(step.program, step.root));
    this.boundary(step.expect.nextBoundary);
  }

  private boundary(want: number | null): void {
    const got = this.holder.nextBoundary;
    check(got === want, `the next boundary is ${got}, expected ${want}`);
  }

  /**
   * What the runner expects of a pass: whether it must resync because the holder's position lies
   * below the retention floor of the runner's model (README §11.3).
   */
  private belowFloor(): boolean {
    const model = this.run.model(this.owner);
    check(model !== undefined, "a views step on a store that serves no feed");
    return (
      this.held.size > 0 &&
      this.processed !== undefined &&
      this.processed.history === this.run.peer(this.handle).history &&
      this.processed.revision < model.floor
    );
  }

  private stands(position: Position, name: string, op: string): void {
    const want = this.run.resolve({ revision: name }, this.handle);
    check(
      position.history === this.run.peer(this.handle).history,
      `${op} answered another history`,
    );
    check(position.revision === want, `${op} stands at ${position.revision}, expected ${want}`);
  }

  async hold(step: HoldStep): Promise<void> {
    check(
      this.registered.has(step.program),
      `the vector holds ${step.program} before registering it`,
    );
    const resync = this.belowFloor();
    const key = keyOf(step.program, step.root);
    const fresh = !this.held.has(key);
    const heldBefore = [...this.held.values()];
    this.sink.log = [];
    let answer: ViewRead;
    try {
      answer = await this.holder.hold(step.program, step.root, step.now);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      throw new Error(`hold refused with ${error.code}: ${error.message}`);
    }
    const what = `hold of ${step.program} at ${step.root}`;
    check(answer.bytes === step.expect.bytes, `${what} answered other bytes`);
    const from = resync && !fresh ? "read" : step.expect.from;
    if (from !== undefined)
      check(answer.from === from, `${what} answered from ${answer.from}, expected ${from}`);
    this.stands(answer.position, step.expect.position, "hold");
    check(
      answer.expiresAt === step.expect.expiresAt,
      `${what} reports expiresAt ${answer.expiresAt}, expected ${step.expect.expiresAt}`,
    );
    const reread = resync ? heldBefore : step.expect.reread;
    this.walk(
      "hold",
      heldBefore,
      fresh ? [...reread, { program: step.program, root: step.root }] : reread,
    );
    if (fresh && this.held.size >= this.maxViews) this.held.delete(this.held.keys().next().value!);
    this.held.delete(key);
    this.held.set(key, { program: step.program, root: step.root });
    this.processed = answer.position;
    this.boundary(step.expect.nextBoundary);
  }

  async refresh(step: RefreshStep): Promise<void> {
    const resync = this.belowFloor();
    const heldBefore = [...this.held.values()];
    this.sink.log = [];
    let answer: Refresh;
    try {
      answer = await this.holder.refresh(step.now);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      throw new Error(`refresh refused with ${error.code}: ${error.message}`);
    }
    const { expect } = step;
    this.stands(answer.position, expect.position, "refresh");
    const resynced = expect.resynced || resync;
    check(
      answer.resynced === resynced,
      `refresh resynced ${answer.resynced}, expected ${resynced}`,
    );
    const plain = (keys: readonly ViewsKey[]) =>
      keys.filter((k) => !this.selected(k.program)).sort(byKey);
    const want = resync ? plain(heldBefore) : plain(expect.reread);
    const got = plain(answer.reread.map((k) => ({ program: k.name, root: k.root })));
    check(
      keysText(got) === keysText(want),
      `refresh re-read ${keysText(got)}, expected ${keysText(want)}`,
    );
    const changed = answer.changed.map((c) => ({ program: c.name, root: c.root }));
    check(
      keysText(changed) === keysText(expect.changed),
      `refresh changed ${keysText(changed)}, expected ${keysText(expect.changed)}`,
    );
    answer.changed.forEach((c, i) =>
      check(
        c.before === expect.changed[i]!.before && c.after === expect.changed[i]!.after,
        `refresh reports the change of ${c.name} at ${c.root} with other bytes`,
      ),
    );
    this.walk("refresh", heldBefore, resync ? heldBefore : expect.reread);
    this.processed = answer.position;
    this.boundary(expect.nextBoundary);
  }

  /**
   * README §11.4, "The calls", for one pass: one `read`; when views were held and the snapshot
   * has the pass's history and a revision r′ past its position, `changes(at, r′)` page by page
   * with that explicit `to`, and after each ok page that adds ids one `get` of them; then only
   * `scope`, `targets` and `negators` (the reads, on the same snapshot), at least one `scope`
   * when a read is due; then the release of the snapshot, and nothing else.
   */
  private walk(op: string, heldBefore: readonly ViewsKey[], reads: readonly ViewsKey[]): void {
    const log = this.sink.log;
    let i = 0;
    const next = (want: string): Call => {
      const call = log[i++];
      check(call !== undefined, `${op} made no call where the contract asks for ${want}`);
      check(
        callText(call) === want,
        `${op} made the call ${callText(call)} where the contract asks for ${want}`,
      );
      return call;
    };
    const read = next("read") as { revision: number; history: string };
    const at = this.processed;
    if (heldBefore.length > 0 && at !== undefined && read.history === at.history)
      for (let from = at.revision; from < read.revision; ) {
        const { page } = next(`changes(${from}, ${read.revision})`) as { page?: ChangePage };
        if (page === undefined || page.status !== "ok") break;
        const ids = [...new Set(page.records.flatMap((r) => r.added))].sort(compareUtf8);
        if (ids.length > 0) next(`get ${show(ids)}`);
        if (page.through <= from) break;
        from = page.through;
      }
    // Only the reads remain: no read is due when none is expected and no view of a program with
    // a selection (which a holder may read more often) is held.
    const free = heldBefore.some((k) => this.selected(k.program));
    const due = reads.length > 0;
    let scopes = 0;
    for (;;) {
      const call = log[i];
      const text = call === undefined ? undefined : callText(call);
      if ((due || free) && (text === "scope" || text === "targets" || text === "negators")) {
        if (text === "scope") scopes += 1;
        i += 1;
        continue;
      }
      if (due && scopes === 0) next("scope");
      next("release");
      break;
    }
    const extra = log[i];
    check(
      extra === undefined,
      `${op} made the call ${callText(extra ?? { op: "" })} after its last call`,
    );
    this.sink.log = [];
  }
}

/**
 * Runs `views.json` against the stores `factory` makes and a witness's holder. Each case gets a
 * new store; `factory` receives what the case asks of it and answers undefined when it cannot
 * build such a store, which skips the case. Throws `StoreConformanceError`, listing every
 * failure, when anything fails.
 */
export async function runViewsConformance(
  factory: (request: ViewsStoreRequest) => Promise<Store | undefined>,
  witness: ViewWitness,
  vectors: StoreViewsDocument,
): Promise<ViewsConformanceReport> {
  check(vectors.format === STORE_VIEWS_FORMAT, "unknown store views format");
  const passed: string[] = [];
  const skipped: { name: string; missing: string }[] = [];
  const failures: StoreConformanceFailure[] = [];
  const text = (error: unknown): string =>
    error instanceof StoreError
      ? `refused with ${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

  for (const c of vectors.cases) {
    const name = `views/${c.name}`;
    const store = await factory(c.store ?? {});
    if (store === undefined) {
      skipped.push({ name, missing: "store" });
      continue;
    }
    try {
      const lacks = missing(store, c.requires);
      if (lacks !== undefined) {
        skipped.push({ name, missing: lacks });
        continue;
      }
      const run = new Run(store, vectors);
      const views = new ViewsRun(run, witness, vectors);
      for (const [i, step] of vectors.setup.entries()) {
        try {
          await run.step(step);
          await run.checkFeeds();
        } catch (error) {
          throw new Error(`setup step ${i} (${step.op}): ${text(error)}`);
        }
      }
      views.start(c.views);
      for (const [i, step] of c.steps.entries()) {
        try {
          if (step.op === "register") views.register(step);
          else if (step.op === "hold") await views.hold(step);
          else if (step.op === "refresh") await views.refresh(step);
          else if (step.op === "drop") await views.drop(step);
          else if (step.op === "setEpoch") await views.setEpoch(step);
          else await run.step(step);
          await run.checkFeeds();
        } catch (error) {
          throw new Error(`step ${i} (${step.op}): ${text(error)}`);
        }
      }
      passed.push(name);
    } catch (error) {
      failures.push({ name, message: text(error) });
    } finally {
      await store.close();
    }
  }

  if (failures.length > 0) throw new StoreConformanceError(failures);
  return { passed, skipped };
}
