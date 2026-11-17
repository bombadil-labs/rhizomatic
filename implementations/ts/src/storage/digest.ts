// The holdings digest (SPEC-18 proposal §4.7.6; §4.13 reading 139). A tree over the hex digits of
// the held ids: the node of a prefix covers the held ids that start with it. A node of at most 16
// ids is a leaf, whose hash is over its ids in ascending order; any other node has 16 children,
// one per next digit, and its hash is over their counts and hashes. The node of every prefix is
// defined by the set of ids alone, so two stores that hold one set give one root, whatever the
// order the ids arrived in.
//
// Each hash is the content address of one canonical CBOR array whose first item is a tag of its
// own. A delta id is the content address of a CBOR map, so a leaf, a node and a delta never hash
// the same bytes. The digest holds ids only: no claims, no payload and no arrival data.

import { array, compareUtf8, encode, float, tstr } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import { VOCAB_PREFIX } from "../delta/vocab.js";
import type { Id } from "./store.js";

/** One node of the holdings digest: how many held ids share its prefix, and its hash. */
export type DigestNode = { readonly count: number; readonly hash: string };

/** A node of at most this many ids is a leaf. */
export const DIGEST_LEAF = 16;
const DIGITS = [..."0123456789abcdef"];
const LEAF_TAG = `${VOCAB_PREFIX}.digest.leaf`;
const NODE_TAG = `${VOCAB_PREFIX}.digest.node`;
/** A content address: `1e20` and 64 lowercase hex digits, the form of every delta id. */
const ID_FORM = /^1e20[0-9a-f]{64}$/;
const PREFIX_FORM = /^[0-9a-f]*$/;

/** The hash of a leaf over its ids, ascending. The leaf of no id is the empty node. */
export const leafHash = (ids: readonly Id[]): string =>
  contentAddress(encode(array([tstr(LEAF_TAG), array(ids.map(tstr))])));

/** The hash of a node over its 16 children, in digit order. */
export const nodeHash = (children: readonly DigestNode[]): string =>
  contentAddress(
    encode(
      array([
        tstr(NODE_TAG),
        array(children.map((child) => array([float(child.count), tstr(child.hash)]))),
      ]),
    ),
  );

/** The node of a prefix that no held id starts with, and the root of an empty peer. */
export const EMPTY_DIGEST: DigestNode = Object.freeze({ count: 0, hash: leafHash([]) });

/** True for a prefix a digest call takes: a string of lowercase hex digits, the empty one too. */
export const isDigestPrefix = (value: unknown): value is string =>
  typeof value === "string" && PREFIX_FORM.test(value);

/** The 16 children of a prefix, in digit order. */
export const childrenOf = (prefix: string): string[] => DIGITS.map((digit) => prefix + digit);

/** The ids grouped by the digit that follows `prefix`; each id starts with `prefix`. */
function byDigit(ids: readonly Id[], prefix: string): Map<string, Id[]> {
  const groups = new Map<string, Id[]>();
  for (const id of ids) {
    const digit = id[prefix.length]!;
    const group = groups.get(digit);
    if (group === undefined) groups.set(digit, [id]);
    else group.push(id);
  }
  return groups;
}

function nodeOf(ids: readonly Id[], prefix: string, into?: Map<string, DigestRow>): DigestNode {
  let node: DigestNode;
  if (ids.length <= DIGEST_LEAF) {
    node = { count: ids.length, hash: leafHash(ids) };
    if (ids.length > 0) into?.set(prefix, { ...node, ids });
  } else {
    const groups = byDigit(ids, prefix);
    node = {
      count: ids.length,
      hash: nodeHash(
        childrenOf(prefix).map((child) => nodeOf(groups.get(child.at(-1)!) ?? [], child, into)),
      ),
    };
    into?.set(prefix, node);
  }
  return node;
}

function canonical(ids: Iterable<Id>): Id[] {
  const set = [...new Set(ids)];
  for (const id of set)
    if (typeof id !== "string" || !ID_FORM.test(id))
      throw new TypeError("digest: an id is `1e20` and 64 lowercase hex digits");
  return set.sort(compareUtf8);
}

/**
 * The node of `prefix` over a set of ids: the reference that every store's `digest` answers.
 * Each id is a content address (`1e20` and 64 lowercase hex digits). Costs O(n log n).
 */
export function digestOf(ids: Iterable<Id>, prefix = ""): DigestNode {
  if (!isDigestPrefix(prefix))
    throw new TypeError("digest: a prefix is a string of lowercase hex digits");
  return nodeOf(
    canonical(ids).filter((id) => id.startsWith(prefix)),
    prefix,
  );
}

/** A stored node: a leaf keeps its ids, ascending. */
export type DigestRow = DigestNode & { readonly ids?: readonly Id[] };

/**
 * Every node a store keeps for a set of ids, by prefix: the root when it holds an id, and each
 * child of a node of more than 16 ids that holds an id. A leaf keeps its ids. A prefix below a
 * leaf has no row; its node is the leaf over the leaf's ids that start with it.
 */
export function digestRows(ids: Iterable<Id>): Map<string, DigestRow> {
  const rows = new Map<string, DigestRow>();
  nodeOf(canonical(ids), "", rows);
  return rows;
}

/**
 * The stored rows of one peer's digest, as the incremental update reads and writes them. `held`
 * answers the ids the peer holds now that start with `prefix`, ascending; the update calls it only
 * where the answer is at most 16 ids plus the ids of the change that start with `prefix`.
 */
export interface DigestStore {
  rows(prefixes: readonly string[]): readonly (DigestNode | undefined)[];
  held(prefix: string): readonly Id[];
  put(prefix: string, node: DigestNode, leaf: readonly Id[] | undefined): void;
  drop(prefix: string): void;
  /** Drops every stored row whose prefix starts with `prefix` and is longer. */
  dropUnder(prefix: string): void;
}

/**
 * Brings a peer's stored digest from its holdings before a change to its holdings after it, and
 * answers the new root. `added` are the ids the change made held, `removed` the ids it released;
 * the holdings already include the change. It visits the path of each changed id, and each node
 * that splits or merges: O(depth × 16) row reads per changed id, never the whole peer.
 */
export function updateDigest(
  rows: DigestStore,
  added: readonly Id[],
  removed: readonly Id[],
): DigestNode {
  const [root] = rows.rows([""]);
  return visit(
    rows,
    "",
    root?.count ?? 0,
    [...added].sort(compareUtf8),
    [...removed].sort(compareUtf8),
  );
}

/**
 * The new node of `prefix`. `was` is its count before the change when it was a node of the stored
 * tree, and undefined when it lay below a leaf. Children are written before their parent, so a
 * read of the rows above or below a node sees them as they were before the change.
 */
function visit(
  rows: DigestStore,
  prefix: string,
  was: number | undefined,
  added: readonly Id[],
  removed: readonly Id[],
): DigestNode {
  let ids = was === undefined ? rows.held(prefix) : undefined;
  const count = ids?.length ?? was! + added.length - removed.length;
  let node: DigestNode;
  let leaf: readonly Id[] | undefined;
  const internal = was !== undefined && was > DIGEST_LEAF;
  if (count <= DIGEST_LEAF) {
    ids ??= rows.held(prefix);
    // A leaf has no row below it. The rows below are dropped whatever the stored count says, so
    // a damaged count or a lost row cannot keep a row that hashes a released id (reading 142).
    rows.dropUnder(prefix);
    // A leaf takes its count from the holdings it read, so a damaged count above it cannot make
    // a write fail: an append or a purge completes, and `fsck` reports the damage.
    node = { count: ids.length, hash: leafHash(ids) };
    leaf = ids;
  } else {
    const names = childrenOf(prefix);
    const stored = internal ? rows.rows(names) : [];
    const more = byDigit(added, prefix);
    const less = byDigit(removed, prefix);
    const children = names.map((name, i) => {
      const digit = name.at(-1)!;
      const a = more.get(digit) ?? [];
      const r = less.get(digit) ?? [];
      if (internal && a.length === 0 && r.length === 0) return stored[i] ?? EMPTY_DIGEST;
      return visit(rows, name, internal ? (stored[i]?.count ?? 0) : undefined, a, r);
    });
    node = { count, hash: nodeHash(children) };
  }
  if (node.count === 0) rows.drop(prefix);
  else rows.put(prefix, node, leaf);
  return node;
}
