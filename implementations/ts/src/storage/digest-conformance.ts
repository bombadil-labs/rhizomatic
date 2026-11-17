// The digest conformance runner (SPEC-18 proposal §4.7.6; §4.13 readings 139 and 140). It runs
// `vectors/store/digest.json`: each tree against `digestOf`, and each store case against a new
// store. `vectors/store/README.md` §12 is the normative text; this file follows it and must not
// accept anything the text does not.

import { computeId } from "../delta/delta.js";
import { parseClaims } from "../delta/json-profile.js";
import type { Delta } from "../delta/types.js";
import { admissionOf } from "./admission.js";
import { digestOf, type DigestNode } from "./digest.js";
import {
  STORE_DIGEST_FORMAT,
  type DigestStep,
  type StoreDigestDocument,
} from "./digest-vectors.js";
import {
  StoreConformanceError,
  missing,
  type StoreConformanceFailure,
} from "./store-conformance.js";
import { StoreError, type PeerStore, type Snapshot, type Store } from "./store.js";

export type DigestConformanceReport = {
  readonly passed: readonly string[];
  /** Store cases that did not run: the profile lacks `digest`. */
  readonly skipped: readonly { readonly name: string; readonly missing: string }[];
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const same = (a: DigestNode, b: DigestNode): boolean => a.count === b.count && a.hash === b.hash;
const show = (node: DigestNode): string => `{count ${node.count}, hash ${node.hash.slice(0, 16)}}`;

class DigestRun {
  readonly #store: Store;
  readonly #deltas: ReadonlyMap<string, Delta>;
  readonly #peers = new Map<string, PeerStore>();
  readonly #snapshots = new Map<string, Snapshot>();
  #heads = 0;

  constructor(store: Store, deltas: ReadonlyMap<string, Delta>) {
    this.#store = store;
    this.#deltas = deltas;
  }

  async #peer(name: string): Promise<PeerStore> {
    let peer = this.#peers.get(name);
    if (peer === undefined) {
      peer = await this.#store.createPeer(name, { erasure: "unproven" });
      this.#peers.set(name, peer);
    }
    return peer;
  }

  #delta(name: string): Delta {
    const delta = this.#deltas.get(name);
    check(delta !== undefined, `the document names no delta ${name}`);
    return delta;
  }

  /** The snapshot a step names: a named one, or a new one of its peer. */
  async #snapshot(step: { peer?: string; snapshot?: string }): Promise<Snapshot> {
    if (step.snapshot !== undefined) {
      const snapshot = this.#snapshots.get(step.snapshot);
      check(snapshot !== undefined, `no snapshot named ${step.snapshot}`);
      return snapshot;
    }
    check(step.peer !== undefined, "the step names no peer and no snapshot");
    return (await this.#peer(step.peer)).read();
  }

  async step(step: DigestStep): Promise<void> {
    if (step.op === "append") {
      const peer = await this.#peer(step.peer);
      const snapshot = await peer.read();
      snapshot.release();
      const result = await peer.append(
        admissionOf(
          snapshot,
          step.deltas.map((name) => this.#delta(name)),
          {
            at: 1,
            sender: "digest-vectors",
            nextHead: `head-${++this.#heads}`,
          },
        ),
      );
      check(result.status === "committed", `the append answered ${result.status}`);
    } else if (step.op === "purge") {
      const peer = await this.#peer(step.peer);
      await peer.purge(step.deltas.map((name) => this.#delta(name).id));
    } else if (step.op === "read") {
      this.#snapshots.set(step.as, await (await this.#peer(step.peer)).read());
    } else if (step.op === "root") {
      const snapshot = await this.#snapshot(step);
      check(
        snapshot.root === step.expect.hash,
        `root is ${String(snapshot.root)}, expected ${step.expect.hash}`,
      );
      if (step.snapshot === undefined) {
        const top = await snapshot.digest("");
        check(same(top, step.expect), `digest("") is ${show(top)}, expected ${show(step.expect)}`);
        snapshot.release();
      }
    } else if (step.op === "digest") {
      const snapshot = await this.#snapshot(step);
      let answer: DigestNode | StoreError;
      try {
        answer = await snapshot.digest(step.prefix);
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
        answer = error;
      }
      if (step.snapshot === undefined) snapshot.release();
      if (step.error !== undefined)
        check(
          answer instanceof StoreError && answer.code === step.error,
          `digest(${JSON.stringify(step.prefix)}) answered ${answer instanceof StoreError ? `refusal ${answer.code}` : show(answer)}, expected a refusal ${step.error}`,
        );
      else {
        check(
          !(answer instanceof StoreError),
          `digest(${JSON.stringify(step.prefix)}) refused ${answer instanceof StoreError ? answer.code : ""}`,
        );
        check(
          same(answer, step.expect!),
          `digest(${JSON.stringify(step.prefix)}) is ${show(answer)}, expected ${show(step.expect!)}`,
        );
      }
    } else throw new Error(`unknown step ${(step as { op: unknown }).op as string}`);
  }
}

/**
 * Runs `digest.json`. Each tree checks `digestOf` at every node and probe. Each store case gets a
 * new store from `factory`; a store whose profile lacks `digest` skips it. Throws
 * `StoreConformanceError`, listing every failure, when anything fails.
 */
export async function runDigestConformance(
  factory: () => Promise<Store>,
  vectors: StoreDigestDocument,
): Promise<DigestConformanceReport> {
  if (vectors.format !== STORE_DIGEST_FORMAT)
    throw new StoreConformanceError([{ name: "digest", message: "unknown store digest format" }]);
  const passed: string[] = [];
  const skipped: { name: string; missing: string }[] = [];
  const failures: StoreConformanceFailure[] = [];
  const text = (error: unknown): string =>
    error instanceof StoreError
      ? `refused with ${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);

  for (const tree of vectors.trees) {
    const name = `trees/${tree.name}`;
    try {
      for (const node of [...tree.nodes, ...tree.probes]) {
        const answer = digestOf(tree.ids, node.prefix);
        check(
          same(answer, node),
          `the node at ${JSON.stringify(node.prefix)} is ${show(answer)}, expected ${show(node)}`,
        );
      }
      check(
        same(digestOf(tree.ids), tree.nodes[0] ?? digestOf([])),
        "the first node is not the root",
      );
      passed.push(name);
    } catch (error) {
      failures.push({ name, message: text(error) });
    }
  }

  const deltas = new Map<string, Delta>();
  try {
    for (const entry of vectors.deltas) {
      const claims = parseClaims(entry.claims);
      check(computeId(claims) === entry.id, `the id of delta ${entry.name} is not its claims' id`);
      deltas.set(entry.name, { id: entry.id, claims });
    }
  } catch (error) {
    throw new StoreConformanceError([{ name: "digest/deltas", message: text(error) }]);
  }

  for (const c of vectors.cases) {
    const name = `digest/${c.name}`;
    const store = await factory();
    try {
      const lacks = missing(store, c.requires);
      if (lacks !== undefined) {
        skipped.push({ name, missing: lacks });
        continue;
      }
      const run = new DigestRun(store, deltas);
      for (const [i, step] of c.steps.entries()) {
        try {
          await run.step(step);
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
