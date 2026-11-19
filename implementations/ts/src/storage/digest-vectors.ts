// The digest vectors (SPEC-18 proposal §4.7.6; §4.13 readings 139 and 140), as data.
// `tools/gen-store-digest-vectors.ts` writes this document to `vectors/store/digest.json`; the
// format is specified in `vectors/store/README.md` §12.
//
// Expectations come from `digestOf` over a plain list of the ids each peer holds, never from a
// store. The deltas are found by search: each case needs many ids that share a long prefix, so
// that a node splits at 17 ids and merges back at 16 several digits deep.

import { compareUtf8 } from "../delta/cbor.js";
import { claimsToJson } from "../delta/json-profile.js";
import { makeDelta } from "../delta/set.js";
import type { Delta } from "../delta/types.js";
import { VOCAB_PREFIX } from "../delta/vocab.js";
import { digestOf, digestRows, type DigestNode } from "./digest.js";
import { MEMORY_STORE_FORMAT } from "./memory-store.js";
import type { StoreErrorCode } from "./store.js";
import type { VectorDelta } from "./store-vector-format.js";
import { PEERS } from "./store-vectors.js";

export const STORE_DIGEST_FORMAT = "rhizomatic-store-digest/1";

/** One tree of the hash construction alone: a set of ids and every node a store keeps for it. */
export type DigestTreeCase = {
  readonly name: string;
  readonly ids: readonly string[];
  /** The rows of `digestRows`, ascending by prefix, without the leaves' ids. */
  readonly nodes: readonly ({ readonly prefix: string } & DigestNode)[];
  /** Prefixes with no row: below a leaf, or a child of a node that holds no id. */
  readonly probes: readonly ({ readonly prefix: string } & DigestNode)[];
};

export type DigestStep =
  | { readonly op: "append"; readonly peer: string; readonly deltas: readonly string[] }
  | { readonly op: "purge"; readonly peer: string; readonly deltas: readonly string[] }
  | { readonly op: "read"; readonly peer: string; readonly as: string }
  | {
      readonly op: "root";
      readonly peer?: string;
      readonly snapshot?: string;
      readonly expect: DigestNode;
    }
  | {
      readonly op: "digest";
      readonly peer?: string;
      readonly snapshot?: string;
      readonly prefix: string;
      readonly expect?: DigestNode;
      readonly error?: StoreErrorCode;
    };

export type DigestStoreCase = {
  readonly name: string;
  readonly spec: string;
  readonly requires: readonly "digest"[];
  readonly steps: readonly DigestStep[];
};

export type StoreDigestDocument = {
  readonly format: typeof STORE_DIGEST_FORMAT;
  readonly note: string;
  readonly reference: { readonly formatVersion: string };
  readonly hash: { readonly leafTag: string; readonly nodeTag: string; readonly empty: string };
  readonly trees: readonly DigestTreeCase[];
  readonly peers: Readonly<Record<string, string>>;
  readonly deltas: readonly VectorDelta[];
  readonly cases: readonly DigestStoreCase[];
};

const AUTHOR = "did:key:zDigest";

/**
 * Deltas whose ids start with `prefix`, found by trying timestamps from `from` up. Each is a fact
 * about one entity. The search is deterministic.
 */
function grind(prefix: string, count: number, from: number): Delta[] {
  const found: Delta[] = [];
  for (let t = from; found.length < count; t++) {
    const delta = makeDelta({
      timestamp: t,
      validFrom: 0,
      author: AUTHOR,
      pointers: [{ role: "about", target: { kind: "entity", entity: { id: `digest:${t}` } } }],
    });
    if (delta.id.startsWith(prefix)) found.push(delta);
  }
  return found;
}

/** A made-up content address: `1e20`, then `head`, then `n` in hex, padded to 64 digits. */
const made = (head: string, n: number): string =>
  `1e20${head}${n.toString(16).padStart(64 - head.length, "0")}`;

function tree(name: string, ids: readonly string[]): DigestTreeCase {
  const rows = digestRows(ids);
  const nodes = [...rows.entries()]
    .sort(([a], [b]) => compareUtf8(a, b))
    .map(([prefix, { count, hash }]) => ({ prefix, count, hash }));
  // A prefix below each leaf, and the empty children of each node of more than 16 ids.
  const probes: ({ prefix: string } & DigestNode)[] = [];
  for (const [prefix, row] of rows) {
    if (row.ids !== undefined && row.ids.length > 0) {
      const below = row.ids[0]!.slice(0, prefix.length + 2);
      probes.push({ prefix: below, ...digestOf(ids, below) });
    } else
      for (const digit of "0123456789abcdef")
        if (!rows.has(prefix + digit)) {
          probes.push({ prefix: prefix + digit, ...digestOf(ids, prefix + digit) });
          break;
        }
  }
  probes.push({ prefix: "ff", ...digestOf(ids, "ff") });
  probes.sort((a, b) => compareUtf8(a.prefix, b.prefix));
  return { name, ids: [...ids].sort(compareUtf8), nodes, probes };
}

function trees(): DigestTreeCase[] {
  const out: DigestTreeCase[] = [];
  for (const size of [0, 1, 2, 15, 16, 17, 18, 32, 33, 40])
    out.push(
      tree(
        `${size} ids that share 12 digits`,
        Array.from({ length: size }, (_, i) => made("abcdef012345", i)),
      ),
    );
  out.push(
    tree("16 ids that share 63 of 64 digits, one that shares 62, and one that shares only 1e20", [
      ...Array.from({ length: 16 }, (_, i) => made("", i)),
      made("", 0x10),
      made("f", 1),
    ]),
  );
  out.push(
    tree("three groups of 17 at three depths", [
      ...Array.from({ length: 17 }, (_, i) => made("1", i)),
      ...Array.from({ length: 17 }, (_, i) => made("22", i)),
      ...Array.from({ length: 17 }, (_, i) => made("333", i)),
    ]),
  );
  return out;
}

/** The store cases. Each step's expectation is the model's node over the ids the peer holds. */
function cases(
  named: ReadonlyMap<string, Delta>,
  groups: Record<string, string[]>,
): DigestStoreCase[] {
  const out: DigestStoreCase[] = [];
  const model = new Map<string, Set<string>>();
  const ids = (names: readonly string[]) => names.map((name) => named.get(name)!.id);
  let steps: DigestStep[] = [];
  const begin = () => {
    steps = [];
    model.clear();
  };
  const held = (peer: string): Set<string> => {
    let set = model.get(peer);
    if (set === undefined) model.set(peer, (set = new Set()));
    return set;
  };
  const append = (peer: string, names: readonly string[]) => {
    for (const id of ids(names)) held(peer).add(id);
    steps.push({ op: "append", peer, deltas: names });
  };
  const purge = (peer: string, names: readonly string[]) => {
    for (const id of ids(names)) held(peer).delete(id);
    steps.push({ op: "purge", peer, deltas: names });
  };
  const root = (peer: string) => steps.push({ op: "root", peer, expect: digestOf(held(peer)) });
  const node = (peer: string, prefix: string) =>
    steps.push({ op: "digest", peer, prefix, expect: digestOf(held(peer), prefix) });
  const end = (name: string, spec: string) => out.push({ name, spec, requires: ["digest"], steps });

  const deep = groups["deep"]!;
  const wide = groups["wide"]!;
  const loose = groups["loose"]!;

  begin();
  root("A");
  node("A", "");
  node("A", "1e20");
  end("an-empty-peer", "SPEC-18 §4.7.6; §4.13 reading 139");

  begin();
  for (const name of deep) {
    append("A", [name]);
    root("A");
  }
  for (const name of [...deep].reverse()) {
    purge("A", [name]);
    root("A");
  }
  end(
    "one-id-at-a-time-up-to-20-and-down-to-0",
    "§4.13 reading 139: a split at 17 ids and a merge at 16, eight digits deep",
  );

  begin();
  append("A", [...deep, ...wide, ...loose]);
  const all = new Set(held("A"));
  for (const prefix of digestRows(all).keys()) node("A", prefix);
  for (const id of all) {
    node("A", id.slice(0, 9));
    node("A", id);
  }
  node("A", "1e20f0f0");
  end("every-node-of-one-peer", "§4.13 reading 139: every stored node, and prefixes below a leaf");

  begin();
  append("A", [...deep].sort());
  append("B", [...deep].reverse().slice(0, 10));
  append("B", [...deep].reverse().slice(10));
  root("A");
  root("B");
  purge("A", [deep[3]!, deep[17]!]);
  append("A", [deep[17]!, deep[3]!]);
  root("A");
  end(
    "one-set-one-root-in-any-order",
    "§4.13 reading 139: the same set gives the same root, after a purge and an append of it too",
  );

  begin();
  append("A", deep.slice(0, 18));
  steps.push({ op: "read", peer: "A", as: "old" });
  const before = digestOf(held("A"));
  append("A", []);
  steps.push({ op: "digest", snapshot: "old", prefix: "", expect: before });
  append("A", [wide[0]!]);
  steps.push({ op: "root", snapshot: "old", expect: before });
  steps.push({ op: "digest", snapshot: "old", prefix: "", error: "snapshot-moved" });
  steps.push({ op: "read", peer: "A", as: "new" });
  const now = digestOf(held("A"));
  // A purge of an id the peer does not hold releases nothing, and moves no snapshot.
  purge("A", [loose[0]!]);
  steps.push({ op: "digest", snapshot: "new", prefix: "", expect: now });
  purge("A", [deep[0]!]);
  steps.push({ op: "root", snapshot: "new", expect: now });
  steps.push({ op: "digest", snapshot: "new", prefix: "1e20", error: "snapshot-moved" });
  root("A");
  end(
    "a-digest-call-is-strict",
    "§4.13 reading 140: root is fixed; digest refuses once the held set moves, not before",
  );

  begin();
  append("A", [loose[0]!]);
  for (const prefix of ["1E20", "1e20 ", "g", "1e20x"])
    steps.push({ op: "digest", peer: "A", prefix, error: "invalid-request" });
  end("a-prefix-is-lowercase-hex", "§4.13 reading 139");

  begin();
  append("A", deep);
  append("B", [...wide, ...loose]);
  for (const peer of ["A", "B"]) {
    root(peer);
    for (const prefix of digestRows(held(peer)).keys()) node(peer, prefix);
  }
  end(
    "each-peer-answers-its-own-tree",
    "§4.13 reading 139: two peers hold different sets, and each answers its own root and nodes",
  );

  begin();
  append("A", [loose[0]!]);
  steps.push({ op: "read", peer: "A", as: "old" });
  append("A", [loose[1]!]);
  steps.push({ op: "digest", snapshot: "old", prefix: "", error: "snapshot-moved" });
  for (const prefix of ["1E20", "g"])
    steps.push({ op: "digest", snapshot: "old", prefix, error: "invalid-request" });
  end(
    "a-bad-prefix-is-refused-before-the-move",
    "§4.13 readings 139 and 140: a moved snapshot refuses a prefix that is not lowercase hex as invalid-request",
  );

  return out;
}

/** The shared digest vectors. The committed `vectors/store/digest.json` is exactly this. */
export function digestVectors(): StoreDigestDocument {
  // 20 ids that share `1e20c0d`, 12 that share `1e20c0` and not `1e20c0d`, and 6 others.
  const deep = grind("1e20c0d", 20, 1);
  const wide = grind("1e20c0", 40, 1)
    .filter((d) => !d.id.startsWith("1e20c0d"))
    .slice(0, 12);
  const loose = grind("1e20", 6, 1_000_000);
  const named = new Map<string, Delta>();
  const groups: Record<string, string[]> = { deep: [], wide: [], loose: [] };
  for (const [group, deltas] of Object.entries({ deep, wide, loose }))
    deltas.forEach((delta, i) => {
      const name = `${group}-${i}`;
      named.set(name, delta);
      groups[group]!.push(name);
    });
  const empty = digestOf([]).hash;
  return {
    format: STORE_DIGEST_FORMAT,
    note: "SPEC-18 proposal §4.7.6: the holdings digest, its root and its strict call. See vectors/store/README.md §12.",
    reference: { formatVersion: MEMORY_STORE_FORMAT },
    hash: { leafTag: `${VOCAB_PREFIX}.digest.leaf`, nodeTag: `${VOCAB_PREFIX}.digest.node`, empty },
    trees: trees(),
    peers: { A: PEERS["A"]!, B: PEERS["B"]! },
    deltas: [...named].map(([name, delta]) => ({
      name,
      id: delta.id,
      claims: claimsToJson(delta.claims),
    })),
    cases: cases(named, groups),
  };
}
