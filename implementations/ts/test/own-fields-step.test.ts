// What the hash covers is exactly what the delta holds (issue #133). Each case puts one odd shape at
// one place of a plain base delta. The expected answer is fixed by construction from a plain
// object: the base, the base without that field, or a refusal. Every entry point must give that
// answer, and never a third one. Every store file lives in this file's own `mkdtempSync` directory.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hexToBytes } from "@noble/hashes/utils";
import { afterAll, describe, expect, it } from "vitest";
import { parseCommandDelta, serializeCommandDelta } from "../src/command-data/codec.js";
import { array, bool, bstr, type CborValue, encode, float, map, tstr } from "../src/delta/cbor.js";
import { verifyCanonicalDelta } from "../src/delta/sign.js";
import { verifyPureDerivation } from "../src/derivation/derivation.js";
import type { Claims, Delta } from "../src/delta/types.js";
import {
  assertValidClaims,
  authorForSeed,
  bundleEntryStatus,
  looseEntryStatus,
  makeManifestClaims,
  preflightTransfer,
  readCommandDefinition,
  canonicalBytes,
  canonicalHex,
  claimsToCbor,
  claimsToJson,
  computeId,
  contentAddress,
  DeltaSet,
  evalTerm,
  makeDelta,
  makeNegationClaims,
  packSet,
  parseClaims,
  parseTerm,
  Reactor,
  signClaims,
  unpackSet,
  verifyDelta,
} from "../src/index.js";
import { admissionOf } from "../src/storage/admission.js";
import { createMemoryStore } from "../src/storage/memory-store.js";
import { openSqliteStore } from "../src/storage/sqlite-store.js";
import type { Store } from "../src/storage/store.js";

const dir = mkdtempSync(join(tmpdir(), "rhizomatic-own-step-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let files = 0;

type Json = Record<string | symbol, unknown>;
type Path = readonly (string | number)[];
type Expect = "base" | "without" | "refuse";

const SEED = "11".repeat(32);
const AUTHOR = authorForSeed(SEED);
const OTHER_AUTHOR = authorForSeed("22".repeat(32));
const REF = `1e20${"ab".repeat(32)}`;
const PEER = `ed25519:${"7e".repeat(32)}`;

/** The plain base claims: every field of the schema is present, at each level. */
const baseClaims = (): Json => ({
  timestamp: 0,
  validFrom: 0,
  validUntil: 100,
  author: AUTHOR,
  pointers: [
    { role: "subject", target: { kind: "entity", entity: { id: "e1", context: "name" } } },
    { role: "about", target: { kind: "delta", deltaRef: { delta: REF, context: "why" } } },
    { role: "value", target: { kind: "primitive", value: 0 } },
    { role: "blob", target: { kind: "bytes", mime: "text/plain", value: new Uint8Array([1, 2]) } },
  ],
});

const clone = <T>(value: T): T => structuredClone(value);

function get(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((at, key) => (at as Json)[key as string], root);
}

/** A deep plain copy of `root` with the holder at `path` replaced by `change(holder)`. */
function replaceAt(root: Json, path: Path, change: (holder: Json) => unknown): Json {
  if (path.length === 0) return change(clone(root)) as Json;
  const copy = clone(root);
  const parent = get(copy, path.slice(0, -1)) as Json;
  const key = path[path.length - 1] as string;
  parent[key] = change(parent[key] as Json);
  return copy;
}

const without = (holder: Json, key: string): Json => {
  const copy = { ...holder };
  delete copy[key];
  return copy;
};

/** A plain delta of these plain claims: signed when `signed`, and its id. */
function plainDelta(claims: Json, signed: boolean): Json {
  const made = signClaims(clone(claims) as unknown as Claims, SEED);
  return signed
    ? { id: made.id, claims: clone(claims), sig: made.sig }
    : { id: made.id, claims: clone(claims) };
}

type Field = {
  /** The holder's path from the delta, and the field's key. */
  readonly at: Path;
  readonly key: string;
  readonly optional: boolean;
  /** The answer for -0 in place of the base value: only a number field can take it. */
  readonly zero: Expect;
  /** A second valid value, which a changing accessor answers after its first read. */
  readonly other: unknown;
};

const C = ["claims"];
const P = (i: number): Path => ["claims", "pointers", i];
const T = (i: number): Path => ["claims", "pointers", i, "target"];
const otherClaims = { ...baseClaims(), timestamp: 7, validFrom: 7 };
const FIELDS: readonly Field[] = [
  { at: [], key: "id", optional: false, zero: "refuse", other: REF },
  { at: [], key: "claims", optional: false, zero: "refuse", other: otherClaims },
  { at: [], key: "sig", optional: true, zero: "refuse", other: "cd".repeat(64) },
  { at: C, key: "timestamp", optional: false, zero: "base", other: 5 },
  { at: C, key: "validFrom", optional: false, zero: "base", other: 5 },
  { at: C, key: "validUntil", optional: true, zero: "refuse", other: 50 },
  { at: C, key: "author", optional: false, zero: "refuse", other: OTHER_AUTHOR },
  {
    at: C,
    key: "pointers",
    optional: false,
    zero: "refuse",
    other: [{ role: "x", target: { kind: "primitive", value: "y" } }],
  },
  ...[0, 1, 2, 3].flatMap((i): Field[] => [
    { at: P(i), key: "role", optional: false, zero: "refuse", other: "other" },
    {
      at: P(i),
      key: "target",
      optional: false,
      zero: "refuse",
      other: { kind: "primitive", value: "other" },
    },
    { at: T(i), key: "kind", optional: false, zero: "refuse", other: "primitive" },
  ]),
  {
    at: T(0),
    key: "entity",
    optional: false,
    zero: "refuse",
    other: { id: "e2", context: "c2" },
  },
  { at: [...T(0), "entity"], key: "id", optional: false, zero: "refuse", other: "e2" },
  { at: [...T(0), "entity"], key: "context", optional: true, zero: "refuse", other: "c2" },
  { at: T(1), key: "deltaRef", optional: false, zero: "refuse", other: { delta: "x" } },
  { at: [...T(1), "deltaRef"], key: "delta", optional: false, zero: "refuse", other: "x" },
  { at: [...T(1), "deltaRef"], key: "context", optional: true, zero: "refuse", other: "c2" },
  { at: T(2), key: "value", optional: false, zero: "base", other: 9 },
  { at: T(3), key: "mime", optional: false, zero: "refuse", other: "text/html" },
  { at: T(3), key: "value", optional: false, zero: "refuse", other: new Uint8Array([9]) },
];

const HOLDERS: readonly Path[] = [
  [],
  C,
  ...[0, 1, 2, 3].flatMap((i) => [P(i), T(i)]),
  [...T(0), "entity"],
  [...T(1), "deltaRef"],
];

type Shape = {
  readonly name: string;
  readonly expect: (field: Field) => Expect;
  readonly make: (holder: Json, field: Field, value: unknown) => unknown;
  /** True when the case sets the field on `Object.prototype` while each entry point runs. */
  readonly pollutes?: boolean;
};

const absent = (field: Field): Expect => (field.optional ? "without" : "refuse");

/** A getter that answers `first` on its first read and `then` on every later read. */
function changing(first: unknown, then: unknown): () => unknown {
  let reads = 0;
  return () => (++reads === 1 ? first : then);
}

const FIELD_SHAPES: readonly Shape[] = [
  {
    name: "set only on Object.prototype",
    expect: absent,
    make: (h, f) => without(h, f.key),
    pollutes: true,
  },
  {
    name: "inherited from a prototype made with Object.create",
    expect: () => "refuse",
    make: (h, f, v) => Object.assign(Object.create({ [f.key]: v }) as Json, without(h, f.key)),
  },
  {
    name: "inherited from a class instance",
    expect: () => "refuse",
    make: (h, f, v) => {
      class Held {}
      Object.defineProperty(Held.prototype, f.key, { get: () => v });
      return Object.assign(new Held(), without(h, f.key));
    },
  },
  {
    name: "own and not enumerable",
    expect: () => "refuse",
    make: (h, f, v) => Object.defineProperty(without(h, f.key), f.key, { value: v }),
  },
  {
    name: "an own accessor that answers one value",
    expect: () => "base",
    make: (h, f, v) =>
      Object.defineProperty(without(h, f.key), f.key, { get: () => v, enumerable: true }),
  },
  {
    name: "an own accessor that changes its answer on each read",
    expect: () => "base",
    make: (h, f, v) =>
      Object.defineProperty(without(h, f.key), f.key, {
        get: changing(v, f.other),
        enumerable: true,
      }),
  },
  {
    name: "a Proxy whose field changes on each read",
    expect: () => "base",
    make: (h, f, v) => {
      const read = changing(v, f.other);
      return new Proxy(h, {
        get: (target, key, receiver) =>
          key === f.key ? read() : (Reflect.get(target, key, receiver) as unknown),
      });
    },
  },
  {
    name: "a boxed primitive",
    expect: () => "refuse",
    make: (h, f, v) => ({ ...h, [f.key]: Object(typeof v === "object" ? 1 : v) as unknown }),
  },
  { name: "undefined", expect: absent, make: (h, f) => ({ ...h, [f.key]: undefined }) },
  { name: "null", expect: () => "refuse", make: (h, f) => ({ ...h, [f.key]: null }) },
  { name: "-0", expect: (f) => f.zero, make: (h, f) => ({ ...h, [f.key]: -0 }) },
];

const HOLDER_SHAPES: readonly Shape[] = [
  {
    name: "an extra Symbol key",
    expect: () => "refuse",
    make: (h) => ({ ...h, [Symbol("extra")]: 1 }),
  },
  { name: "an extra own text key", expect: () => "refuse", make: (h) => ({ ...h, extra: 1 }) },
  { name: "a Proxy", expect: () => "base", make: (h) => new Proxy(h, {}) },
  {
    name: "a class instance with own fields",
    expect: () => "refuse",
    make: (h) => Object.assign(new (class Held {})(), h),
  },
  {
    name: "an Object.create(proto) object with own fields",
    expect: () => "refuse",
    make: (h) => Object.assign(Object.create({}) as Json, h),
  },
  {
    name: "an object with a null prototype",
    expect: () => "base",
    make: (h) => Object.assign(Object.create(null) as Json, h),
  },
];

class Listed extends Array<unknown> {
  override map<U>(): U[] {
    return [];
  }
}

const LIST_SHAPES: readonly Shape[] = [
  {
    name: "an array-like",
    expect: () => "refuse",
    make: (h, f, v) => ({
      ...h,
      [f.key]: { ...(v as unknown[]), length: (v as unknown[]).length },
    }),
  },
  {
    name: "an array-like whose length is not enumerable",
    expect: () => "refuse",
    make: (h, f, v) => ({
      ...h,
      [f.key]: Object.defineProperty({ ...(v as unknown[]) }, "length", {
        value: (v as unknown[]).length,
      }),
    }),
  },
  {
    name: "a Set",
    expect: () => "refuse",
    make: (h, f, v) => ({ ...h, [f.key]: new Set(v as unknown[]) }),
  },
  {
    name: "an Array subclass with its own map",
    expect: () => "base",
    make: (h, f, v) => ({ ...h, [f.key]: Listed.from(v as unknown[]) }),
  },
  {
    name: "an array with an own map",
    expect: () => "refuse",
    make: (h, f, v) => ({ ...h, [f.key]: Object.assign([...(v as unknown[])], { map: () => [] }) }),
  },
  {
    name: "an array with an own iterator",
    expect: () => "refuse",
    make: (h, f, v) => {
      const list: unknown[] = [...(v as unknown[])];
      (list as unknown as Json)[Symbol.iterator] = function* () {
        yield (v as unknown[])[0];
      };
      return { ...h, [f.key]: list };
    },
  },
  {
    name: "a sparse array",
    expect: () => "refuse",
    make: (h, f, v) => {
      const list: unknown[] = [...(v as unknown[])];
      delete list[1];
      return { ...h, [f.key]: list };
    },
  },
  {
    name: "a Proxy of an array",
    expect: () => "base",
    make: (h, f, v) => ({ ...h, [f.key]: new Proxy([...(v as unknown[])], {}) }),
  },
];

type Case = {
  readonly name: string;
  readonly expect: Expect;
  /** True when the shape sits at the delta's own level, outside the claims. */
  readonly topLevel: boolean;
  /** A fresh odd delta. Each call builds a new one: some shapes count their reads. */
  readonly odd: () => Json;
  /** The plain delta with the expected meaning. Undefined for a refusal. */
  readonly plain: Json | undefined;
  /** The field and value set on `Object.prototype` while each entry point runs the odd delta. */
  readonly pollute?: readonly [string, unknown];
};

const BASE = plainDelta(baseClaims(), true);

function expected(expect: Expect, at: Path, key: string | undefined): Json | undefined {
  if (expect === "refuse") return undefined;
  if (expect === "base" || key === undefined) return BASE;
  if (at.length === 0) return without(BASE, key);
  return plainDelta(replaceAt(BASE, at, (h) => without(h, key)).claims as Json, true);
}

function oddDelta(at: Path, change: (holder: Json) => unknown, plain: Json | undefined): Json {
  const odd = replaceAt(BASE, at, change);
  if (at.length === 0) return odd;
  const shell = plain ?? BASE;
  return {
    id: shell.id,
    claims: odd.claims,
    ...(shell.sig === undefined ? {} : { sig: shell.sig }),
  };
}

// `value` is not set on Object.prototype: `Object.defineProperty` reads a descriptor's `value`
// through the prototype, so the test's own odd shapes could not be built.
const UNPOLLUTED = new Set(["value"]);

/** Runs `body` while `Object.prototype[key]` is `value`, and removes the field afterwards. */
async function polluted<T>(
  pollute: readonly [string, unknown] | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (pollute === undefined) return body();
  const proto = Object.prototype as Json;
  proto[pollute[0]] = pollute[1];
  try {
    return await body();
  } finally {
    delete proto[pollute[0]];
  }
}

const CASES: Case[] = [];
for (const field of FIELDS) {
  const shapes = field.key === "pointers" ? [...FIELD_SHAPES, ...LIST_SHAPES] : FIELD_SHAPES;
  for (const shape of shapes) {
    const expect = shape.expect(field);
    const plain = expected(expect, field.at, field.key);
    if (shape.pollutes === true && UNPOLLUTED.has(field.key)) continue;
    CASES.push({
      name: `${[...field.at, field.key].join(".")}: ${shape.name}`,
      expect,
      topLevel: field.at.length === 0,
      plain,
      ...(shape.pollutes === true
        ? { pollute: [field.key, clone(get(BASE, [...field.at, field.key]))] as const }
        : {}),
      odd: () =>
        oddDelta(
          field.at,
          (h) => shape.make(h, field, clone(get(BASE, [...field.at, field.key]))),
          plain,
        ),
    });
  }
}
for (const at of HOLDERS)
  for (const shape of HOLDER_SHAPES) {
    const expect = shape.expect(FIELDS[0]!);
    const plain = expected(expect, at, undefined);
    CASES.push({
      name: `${at.join(".") || "the delta"}: ${shape.name}`,
      expect,
      topLevel: at.length === 0,
      plain,
      odd: () => oddDelta(at, (h) => shape.make(h, FIELDS[0]!, undefined), plain),
    });
  }

const KEYS: Readonly<Record<string, readonly string[]>> = {
  delta: ["id", "claims", "sig"],
  claims: ["timestamp", "validFrom", "validUntil", "author", "pointers"],
  pointer: ["role", "target"],
  primitive: ["kind", "value"],
  entity: ["kind", "entity"],
  delta_: ["kind", "deltaRef"],
  bytes: ["kind", "mime", "value"],
  entityRef: ["id", "context"],
  deltaRef: ["delta", "context"],
};

/** The keys at any level of a held delta that its schema does not name. */
function extraKeys(delta: Delta): string[] {
  const extra: string[] = [];
  const check = (value: object, keys: readonly string[], where: string): void => {
    for (const key of Reflect.ownKeys(value))
      if (typeof key === "symbol" || !keys.includes(key)) extra.push(`${where}.${String(key)}`);
  };
  check(delta, KEYS.delta!, "delta");
  check(delta.claims, KEYS.claims!, "claims");
  const list = delta.claims.pointers;
  check(list, [...list.keys()].map(String).concat("length"), "pointers");
  list.forEach((pointer, i) => {
    check(pointer, KEYS.pointer!, `pointers[${i}]`);
    const t = pointer.target;
    check(t, KEYS[t.kind === "delta" ? "delta_" : t.kind]!, `pointers[${i}].target`);
    if (t.kind === "entity") check(t.entity, KEYS.entityRef!, `pointers[${i}].entity`);
    if (t.kind === "delta") check(t.deltaRef, KEYS.deltaRef!, `pointers[${i}].deltaRef`);
  });
  return extra;
}

const problems: string[] = [];

/** The outcome of a held delta: its id and signature. Checks its copies recompute to its id. */
function held(delta: Delta | undefined, where: string): string {
  if (delta === undefined) return "absent";
  const id = delta.id;
  const copies: [string, () => string][] = [
    ["structuredClone", () => computeId(structuredClone(delta).claims)],
    [
      "the JSON round trip",
      () => computeId(parseClaims(JSON.parse(JSON.stringify(claimsToJson(delta.claims))))),
    ],
    [
      "the pack round trip",
      () => [...unpackSet(packSet(DeltaSet.from([structuredClone(delta)])))][0]!.id,
    ],
  ];
  for (const [name, recompute] of copies) {
    let answer: string;
    try {
      answer = recompute();
    } catch (error) {
      answer = String(error);
    }
    if (answer !== id) problems.push(`${where}: ${name} answers ${answer}, not ${id}`);
  }
  for (const key of extraKeys(delta)) problems.push(`${where}: holds the extra key ${key}`);
  const { timestamp, validFrom, validUntil, pointers } = delta.claims;
  const numbers = [timestamp, validFrom, validUntil, ...pointers.map((p) => p.target)];
  if (
    numbers.some(
      (n) =>
        Object.is(n, -0) ||
        (typeof n === "object" && Object.is(n.kind === "primitive" ? n.value : 0, -0)),
    )
  )
    problems.push(`${where}: holds -0`);
  return `${id} sig:${Object.hasOwn(delta, "sig") ? delta.sig : "none"}`;
}

type Runner = (delta: () => Json, id: string, where: string) => Promise<string>;

const asClaims = (delta: () => Json): Claims => delta().claims as unknown as Claims;
const asDelta = (delta: () => Json): Delta => delta() as unknown as Delta;

const CLAIMS_RUNNERS: Readonly<Record<string, Runner>> = {
  computeId: async (d) => computeId(asClaims(d)),
  canonicalBytes: async (d) => contentAddress(canonicalBytes(asClaims(d))),
  canonicalHex: async (d) => contentAddress(hexToBytes(canonicalHex(asClaims(d)))),
  assertValidClaims: async (d) => {
    assertValidClaims(asClaims(d));
    return "valid";
  },
  makeDelta: async (d, _, where) => held(makeDelta(asClaims(d)), where),
  signClaims: async (d, _, where) => held(signClaims(asClaims(d), SEED), where),
  claimsToJson: async (d) =>
    computeId(parseClaims(JSON.parse(JSON.stringify(claimsToJson(asClaims(d)))))),
};

const verdict = (answer: string): string => (answer === "invalid" ? "refused" : answer);

async function stored(store: Store, delta: Delta, id: string, where: string): Promise<string> {
  try {
    const peer = await store.createPeer(PEER, { erasure: "unproven" });
    const result = await peer.append({
      expectedHead: null,
      nextHead: "h1",
      frame: null,
      added: [{ delta, arrival: { id, at: 1, sequence: 1, transfer: 1, sender: "local" } }],
    });
    if (result.status !== "committed") return "refused";
    const [own] = await (await peer.read()).get([id]);
    return held(own, where);
  } finally {
    await store.close();
  }
}

const manifests = new Map<string, Delta>();

/** A manifest that AUTHOR signs, which commits to the one member `id`. */
function manifestFor(id: string): Delta {
  let manifest = manifests.get(id);
  if (manifest === undefined) {
    manifest = signClaims(makeManifestClaims(AUTHOR, 50, [id]), SEED);
    manifests.set(id, manifest);
  }
  return manifest;
}

/** The answers of an entry gate: refused when every call answers invalid. */
const gate = (answers: readonly string[]): string =>
  answers.every((answer) => answer === "invalid") ? "refused" : answers.join(" ");

/** The entry gates refuse an unsigned loose delta, so their plain equivalent may be refused. */
const GATES = new Set(["looseEntryStatus", "bundleEntryStatus", "preflightTransfer"]);

const DELTA_RUNNERS: Readonly<Record<string, Runner>> = {
  verifyDelta: async (d) => verdict(verifyDelta(asDelta(d))),
  verifyCanonicalDelta: async (d) => verdict(verifyCanonicalDelta(asDelta(d))),
  "DeltaSet.add": async (d, _, where) => {
    const set = new DeltaSet();
    set.add(asDelta(d));
    return held([...set][0], where);
  },
  "Reactor.ingest": async (d, _, where) => {
    const reactor = new Reactor();
    if (reactor.ingest(asDelta(d)).status !== "accepted") return "refused";
    return held(reactor.arrivalLog()[0], where);
  },
  "Reactor.ingestBatch": async (d, _, where) => {
    const reactor = new Reactor();
    if (reactor.ingestBatch([asDelta(d)]).status !== "accepted") return "refused";
    return held(reactor.arrivalLog()[0], where);
  },
  packSet: async (d, _, where) => {
    const set = new DeltaSet();
    set.add(asDelta(d));
    return held([...unpackSet(packSet(set))][0], where);
  },
  "serializeCommandDelta, parseCommandDelta": async (d, _, where) =>
    held(parseCommandDelta(JSON.parse(JSON.stringify(serializeCommandDelta(asDelta(d))))), where),
  admissionOf: async (d, _, where) => {
    const admission = admissionOf({ head: null, lastSequence: 0, lastTransfer: 0 }, [asDelta(d)], {
      at: 1,
      sender: "local",
      nextHead: "h1",
    });
    return held(admission.added[0]?.delta, where);
  },
  "Reactor.ingestBundle": async (d, id, where) => {
    const reactor = new Reactor();
    const manifest = manifestFor(id);
    if (reactor.ingestBundle(manifest, [asDelta(d)]).status !== "accepted") return "refused";
    return held(
      reactor.arrivalLog().find((delta) => delta.id !== manifest.id),
      where,
    );
  },
  looseEntryStatus: async (d, id) =>
    gate([
      looseEntryStatus(asDelta(d), new Set(), new Set([id])),
      looseEntryStatus(asDelta(d), new Set([id]), new Set()),
      looseEntryStatus(asDelta(d), new Set(), new Set()),
    ]),
  bundleEntryStatus: async (d, id) =>
    gate([
      bundleEntryStatus(manifestFor(id), [asDelta(d)], new Set(), new Set([id])),
      bundleEntryStatus(manifestFor(id), [asDelta(d)], new Set([id]), new Set()),
      bundleEntryStatus(manifestFor(id), [asDelta(d)], new Set(), new Set()),
    ]),
  preflightTransfer: async (d, id) => {
    const answers = [new Set([id]), new Set<string>()].flatMap((refusedIds) =>
      preflightTransfer(
        [
          { kind: "loose", delta: asDelta(d) },
          { kind: "bundle", manifest: manifestFor(id), members: [asDelta(d)] },
        ],
        {
          admittedBefore: new DeltaSet(),
          refusedIds,
          sendingPeerId: "sender",
          receivingPeerId: "receiver",
          arrivedAt: 1,
          policyState: {},
          guards: [],
        },
      ).map((unit) => `${unit.status}[${unit.freshIds.join(",")}]`),
    );
    return answers.every((answer) => answer === "invalid[]") ? "refused" : answers.join(" ");
  },
  "memory store append, get": async (d, id, where) =>
    stored(createMemoryStore(), asDelta(d), id, where),
  "SQLite store append, get": async (d, id, where) =>
    stored(await openSqliteStore(join(dir, `store-${++files}.db`)), asDelta(d), id, where),
};

async function run(runner: Runner, delta: () => Json, id: string, where: string): Promise<string> {
  try {
    return await runner(delta, id, where);
  } catch {
    return "refused";
  }
}

describe("every entry point reads a delta by one rule: own fields, once, of the right type", () => {
  it("each odd shape at each field gives the answer of its plain equivalent at every entry point, and never a third answer", async () => {
    const wrong: string[] = [];
    const plainAnswers = new Map<string, string>();
    for (const c of CASES) {
      const runners = c.topLevel ? DELTA_RUNNERS : { ...CLAIMS_RUNNERS, ...DELTA_RUNNERS };
      const id = (c.plain ?? BASE).id as string;
      for (const [entry, runner] of Object.entries(runners)) {
        const where = `${c.name} @ ${entry}`;
        let want = "refused";
        if (c.plain !== undefined) {
          const key = `${entry} ${JSON.stringify(c.plain, (_, v: unknown) => (v instanceof Uint8Array ? [...v] : v))}`;
          want =
            plainAnswers.get(key) ??
            (await run(runner, () => clone(c.plain!), id, `${where} (plain)`));
          plainAnswers.set(key, want);
        }
        if (c.plain !== undefined && want === "refused" && !GATES.has(entry))
          wrong.push(`${where}: the plain equivalent is refused`);
        const got = await polluted(c.pollute, () => run(runner, c.odd, id, where));
        if (got !== want) wrong.push(`${where}: answers ${got}, not ${want}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(problems).toEqual([]);
  }, 300_000);

  it("the plain equivalents are the base, the base without the field, or a refusal, as the case names", () => {
    const baseId = BASE.id;
    const seen = CASES.map((c) => {
      if (c.plain === undefined) return [c.expect, "refused"];
      return [c.expect, c.plain.id === baseId && c.plain.sig === BASE.sig ? "base" : "other"];
    });
    expect(seen.filter(([want, got]) => (want === "base") !== (got === "base"))).toEqual([]);
    expect(CASES.length).toBeGreaterThan(250);
  });

  it("parseClaims reads own fields only, once: each odd shape of the JSON form gives its plain answer", () => {
    const json = claimsToJson(baseClaims() as unknown as Claims) as Json;
    const baseId = computeId(parseClaims(clone(json)));
    const jsonFields: { at: Path; key: string; optional: boolean; other: unknown }[] = [
      ...["timestamp", "validFrom", "validUntil", "author", "pointers"].map((key) => ({
        at: [],
        key,
        optional: key === "validUntil",
        other: key === "author" ? OTHER_AUTHOR : key === "pointers" ? [] : 5,
      })),
      { at: ["pointers", 0], key: "role", optional: false, other: "other" },
      { at: ["pointers", 0], key: "target", optional: false, other: "other" },
      { at: ["pointers", 0, "target"], key: "id", optional: false, other: "e2" },
      { at: ["pointers", 0, "target"], key: "context", optional: true, other: "c2" },
      { at: ["pointers", 1, "target"], key: "delta", optional: false, other: "x" },
      { at: ["pointers", 1, "target"], key: "context", optional: true, other: "c2" },
      { at: ["pointers", 3, "target"], key: "mime", optional: false, other: "text/html" },
    ];
    const wrong: string[] = [];
    const answer = (make: () => unknown): string => {
      try {
        return computeId(parseClaims(make()));
      } catch {
        return "refused";
      }
    };
    for (const f of jsonFields) {
      const field: Field = { ...f, zero: "refuse" };
      const plainWithout = answer(() => replaceAt(json, f.at, (h) => without(h, f.key)));
      const shapes = [
        ...FIELD_SHAPES.filter((s) => s.name !== "-0"),
        ...HOLDER_SHAPES,
        ...(f.key === "pointers" ? LIST_SHAPES : []),
      ];
      for (const shape of shapes) {
        const expect = shape.expect(field);
        const want = expect === "base" ? baseId : expect === "without" ? plainWithout : "refused";
        const got = answer(() =>
          replaceAt(json, f.at, (h) => shape.make(h, field, clone(h[f.key]))),
        );
        if (got !== want) wrong.push(`${[...f.at, f.key].join(".")}: ${shape.name}: ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

/** Runs `body` while each field of `fields` is set on `Object.prototype`, then removes them. */
function withPrototype<T>(fields: Json, body: () => T): T {
  const proto = Object.prototype as Json;
  Object.assign(proto, fields);
  try {
    return body();
  } finally {
    for (const key of Object.keys(fields)) delete proto[key];
  }
}

describe("findings 1 to 4: a field that only a prototype holds", () => {
  const MASK = parseTerm({ op: "mask", policy: "drop", in: "input" });
  const fact = makeDelta({
    timestamp: 1,
    validFrom: 1,
    author: AUTHOR,
    pointers: [{ role: "subject", target: { kind: "entity", entity: { id: "e1" } } }],
  });
  const survivors = (deltas: readonly Delta[], now: number): string[] => {
    const result = evalTerm(MASK, DeltaSet.from(deltas), now);
    return result.sort === "dset" ? result.set.ids() : [];
  };
  const refusal = (call: () => unknown): string => {
    try {
      call();
      return "accepted";
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("finding 1: a negation with Object.prototype.validUntil set has its plain id, and negates at 5000 as its plain copy does", () => {
    const own = makeNegationClaims(AUTHOR, 1000, fact.id);
    const plain = makeDelta(structuredClone(own));
    const answers = withPrototype({ validUntil: 2000 }, () => {
      const held = makeDelta(structuredClone(own));
      return [held.id, survivors([fact, held], 5000), survivors([fact, plain], 5000)];
    });
    expect(answers).toEqual([plain.id, [plain.id], [plain.id]]);
  });

  it("findings 1 to 4: a field held only by a prototype made with Object.create or a class is refused, and names the holder", () => {
    const negation = makeNegationClaims(AUTHOR, 1000, fact.id);
    const entity = Object.assign(Object.create({ context: "name" }) as object, { id: "e1" });
    const deltaRef = Object.assign(Object.create({ context: "why" }) as object, { delta: fact.id });
    const at = (target: unknown): Claims =>
      ({ timestamp: 1, validFrom: 1, author: AUTHOR, pointers: [{ role: "r", target }] }) as Claims;
    class Signed {
      get sig(): string {
        return "ab".repeat(64);
      }
    }
    const signed = Object.assign(new Signed(), {
      id: fact.id,
      claims: structuredClone(fact.claims),
    });
    expect([
      refusal(() =>
        makeDelta(Object.assign(Object.create({ validUntil: 2000 }) as Claims, negation)),
      ),
      refusal(() => makeDelta(at({ kind: "entity", entity }))),
      refusal(() => makeDelta(at({ kind: "delta", deltaRef }))),
      refusal(() => verifyDelta(signed as unknown as Delta)),
    ]).toEqual([
      "claims must be a plain object, not a class instance or an object made with Object.create",
      "claims.pointers[0].target.entity must be a plain object, not a class instance or an object made with Object.create",
      "claims.pointers[0].target.deltaRef must be a plain object, not a class instance or an object made with Object.create",
      "the delta must be a plain object, not a class instance or an object made with Object.create",
    ]);
  });

  it("findings 1 to 4: an own schema field that is not enumerable is refused, and names the field", () => {
    const hidden = (holder: object, key: string, value: unknown): object =>
      Object.defineProperty(holder, key, { value });
    const claims = (target: unknown): Claims =>
      ({ timestamp: 1, validFrom: 1, author: AUTHOR, pointers: [{ role: "r", target }] }) as Claims;
    expect([
      refusal(() => makeDelta(hidden(structuredClone(fact.claims), "validUntil", 2000) as Claims)),
      refusal(() =>
        makeDelta(claims({ kind: "entity", entity: hidden({ id: "e1" }, "context", "name") })),
      ),
      refusal(() =>
        makeDelta(
          claims({ kind: "delta", deltaRef: hidden({ delta: fact.id }, "context", "why") }),
        ),
      ),
      refusal(() =>
        verifyDelta(
          hidden({ id: fact.id, claims: structuredClone(fact.claims) }, "sig", "ab") as Delta,
        ),
      ),
    ]).toEqual([
      'claims has the key "validUntil", which is not enumerable',
      'claims.pointers[0].target.entity has the key "context", which is not enumerable',
      'claims.pointers[0].target.deltaRef has the key "context", which is not enumerable',
      'the delta has the key "sig", which is not enumerable',
    ]);
  });

  it("finding 4: a delta with Object.prototype.sig set reads as unsigned in the core and in both stores", async () => {
    const signed = signClaims(baseClaims() as unknown as Claims, SEED);
    const plain = { id: signed.id, claims: structuredClone(signed.claims) } as Delta;
    const proto = Object.prototype as Json;
    proto.sig = signed.sig;
    let answers: unknown[];
    try {
      const set = new DeltaSet();
      set.add(structuredClone(plain));
      const reactor = new Reactor();
      reactor.ingest(structuredClone(plain));
      answers = [
        verifyDelta(structuredClone(plain)),
        verifyCanonicalDelta(structuredClone(plain)),
        Object.hasOwn(set.get(signed.id)!, "sig"),
        Object.hasOwn(reactor.arrivalLog()[0]!, "sig"),
        await stored(createMemoryStore(), structuredClone(plain), signed.id, "memory"),
        await stored(
          await openSqliteStore(join(dir, `store-${++files}.db`)),
          structuredClone(plain),
          signed.id,
          "sqlite",
        ),
      ];
    } finally {
      delete proto.sig;
    }
    expect(answers).toEqual([
      "unsigned",
      "unsigned",
      false,
      false,
      `${signed.id} sig:none`,
      `${signed.id} sig:none`,
    ]);
  });
});

describe("finding 10: a field set on Object.prototype reaches no hash and no decision", () => {
  it("validUntil, sig, context and key set on Object.prototype change no id, no signature and no verdict", () => {
    const plain = baseClaims();
    delete plain.validUntil;
    const entity = (plain.pointers as Json[])[0]!.target as Json;
    delete (entity.entity as Json).context;
    const ref = (plain.pointers as Json[])[1]!.target as Json;
    delete (ref.deltaRef as Json).context;
    const run = (): unknown[] => {
      const made = makeDelta(clone(plain) as unknown as Claims);
      const signed = signClaims(clone(plain) as unknown as Claims, SEED);
      const unsigned = { id: made.id, claims: clone(plain) } as unknown as Delta;
      return [
        computeId(clone(plain) as unknown as Claims),
        made.id,
        signed.sig,
        verifyDelta(unsigned),
        verifyDelta({ ...unsigned, sig: signed.sig } as Delta),
        new Reactor().ingest(unsigned).status,
        looseEntryStatus(unsigned, new Set(), new Set()),
      ];
    };
    const want = run();
    const got = withPrototype(
      { validUntil: 50, sig: "ab".repeat(64), context: "polluted", key: new Uint8Array(32) },
      run,
    );
    expect(got).toEqual(want);
  });
});

describe("the first review of #137: each gate reads its own copy, once", () => {
  const unsignedOther = (): Delta =>
    makeDelta({
      timestamp: 3,
      validFrom: 3,
      author: OTHER_AUTHOR,
      pointers: [{ role: "note", target: { kind: "primitive", value: "other" } }],
    });
  const signedOwn = (value: string): Delta =>
    signClaims(
      {
        timestamp: 4,
        validFrom: 4,
        author: AUTHOR,
        pointers: [{ role: "note", target: { kind: "primitive", value } }],
      },
      SEED,
    );
  const plainOf = (delta: Delta): Delta => structuredClone(delta);
  const NONE = new Set<string>();

  it("looseEntryStatus: an id accessor that changes after its second read answers refused and duplicate, as its plain delta does", () => {
    const plain = plainOf(signedOwn("loose"));
    const odd = (): Delta => {
      let reads = 0;
      const delta = { claims: structuredClone(plain.claims), sig: plain.sig } as Json;
      Object.defineProperty(delta, "id", {
        enumerable: true,
        get: () => (++reads <= 2 ? plain.id : REF),
      });
      return delta as unknown as Delta;
    };
    const refused = new Set([plain.id]);
    expect([
      looseEntryStatus(odd(), NONE, refused),
      looseEntryStatus(odd(), refused, NONE),
      looseEntryStatus(plain, NONE, refused),
      looseEntryStatus(plain, refused, NONE),
    ]).toEqual(["refused", "duplicate", "refused", "duplicate"]);
  });

  it("bundleEntryStatus: an unsigned member of another author with sig only on its prototype is invalid, as its structuredClone is", () => {
    const member = unsignedOther();
    const manifest = signClaims(makeManifestClaims(AUTHOR, 9, [member.id]), SEED);
    const odd = Object.assign(Object.create({ sig: "ab".repeat(64) }) as Json, {
      id: member.id,
      claims: structuredClone(member.claims),
    }) as unknown as Delta;
    expect([
      bundleEntryStatus(manifest, [odd], NONE, NONE),
      bundleEntryStatus(manifest, [structuredClone(odd)], NONE, NONE),
    ]).toEqual(["invalid", "invalid"]);
  });

  it("bundleEntryStatus and ingestBundle: a manifest whose claims accessor answers other members on its second read refuses a member the signed manifest does not name", () => {
    const named = signedOwn("named");
    const other = signedOwn("other");
    const manifest = plainOf(signClaims(makeManifestClaims(AUTHOR, 9, [named.id]), SEED));
    const swapped = makeManifestClaims(AUTHOR, 9, [other.id]);
    const odd = (): Delta => {
      let reads = 0;
      const delta = { id: manifest.id } as Json;
      Object.defineProperty(delta, "claims", {
        enumerable: true,
        get: () => (++reads === 2 ? structuredClone(swapped) : structuredClone(manifest.claims)),
      });
      delta.sig = manifest.sig;
      return delta as unknown as Delta;
    };
    expect([
      bundleEntryStatus(odd(), [other], NONE, NONE),
      bundleEntryStatus(manifest, [other], NONE, NONE),
      bundleEntryStatus(odd(), [named], NONE, NONE),
    ]).toEqual(["invalid", "invalid", "eligible"]);
    expect([
      new Reactor().ingestBundle(odd(), [other]).status,
      new Reactor().ingestBundle(odd(), [named]).status,
    ]).toEqual(["rejected", "accepted"]);
  });

  it("preflightTransfer: Object.prototype.sig does not make an unsigned member of another author eligible", () => {
    const member = unsignedOther();
    const manifest = signClaims(makeManifestClaims(AUTHOR, 9, [member.id]), SEED);
    const run = () =>
      preflightTransfer([{ kind: "bundle", manifest, members: [member] }], {
        admittedBefore: new DeltaSet(),
        refusedIds: NONE,
        sendingPeerId: "sender",
        receivingPeerId: "receiver",
        arrivedAt: 1,
        policyState: {},
        guards: [],
      }).map((unit) => unit.status);
    const proto = Object.prototype as Json;
    let polluted: string[];
    proto.sig = "ab".repeat(64);
    try {
      polluted = run();
    } finally {
      delete proto.sig;
    }
    expect([polluted, run()]).toEqual([["invalid"], ["invalid"]]);
  });

  it("the step never calls a Proxy's get trap, and calls its getOwnPropertyDescriptor trap once per field", () => {
    const gets: string[] = [];
    const descriptors = new Map<string, number>();
    const watched = <T extends object>(target: T, where: string): T =>
      new Proxy(target, {
        get: (t, key, receiver) => {
          gets.push(`${where}.${String(key)}`);
          return Reflect.get(t, key, receiver) as unknown;
        },
        getOwnPropertyDescriptor: (t, key) => {
          const name = `${where}.${String(key)}`;
          descriptors.set(name, (descriptors.get(name) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(t, key);
        },
      });
    const plain = plainOf(BASE as unknown as Delta);
    const claims = structuredClone(plain.claims) as unknown as Json;
    claims.pointers = watched(
      (claims.pointers as Json[]).map((p, i) => watched(p, `pointers[${i}]`)),
      "pointers",
    );
    const odd = watched(
      { id: plain.id, claims: watched(claims, "claims"), sig: plain.sig },
      "delta",
    ) as unknown as Delta;
    const reactor = new Reactor();
    expect(reactor.ingest(odd).status).toBe("accepted");
    expect(gets).toEqual([]);
    expect([...descriptors].filter(([, n]) => n !== 1)).toEqual([]);
    expect(descriptors.size).toBe(3 + 5 + 5 + 4 * 2);
  });

  it("a target refuses a defined key of another kind: a primitive with a mime, an entity with a value", () => {
    const at = (target: Json): Claims =>
      ({ ...clone(baseClaims()), pointers: [{ role: "x", target }] }) as unknown as Claims;
    const answers = [
      { kind: "primitive", value: 1, mime: "x" },
      { kind: "entity", entity: { id: "e" }, value: 1 },
      { kind: "delta", deltaRef: { delta: REF }, entity: { id: "e" } },
      { kind: "bytes", mime: "x", value: new Uint8Array([1]), deltaRef: { delta: REF } },
    ].map((target) => {
      try {
        return computeId(at(target));
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(answers).toEqual([
      'claims.pointers[0].target of kind primitive has the key "mime"',
      'claims.pointers[0].target of kind entity has the key "value"',
      'claims.pointers[0].target of kind delta has the key "entity"',
      'claims.pointers[0].target of kind bytes has the key "deltaRef"',
    ]);
  });

  it("pointers with an extra key that holds a pointer is refused, and is not hashed as one more pointer", () => {
    const claims = clone(baseClaims());
    const pointers = claims.pointers as Json[] & Json;
    pointers.extra = { role: "x", target: { kind: "primitive", value: 1 } };
    expect(() => computeId(claims as unknown as Claims)).toThrow(
      "claims.pointers must have exactly one item at each index, and no other key",
    );
  });

  it("verifyCanonicalDelta reads the format of the own sig: a malformed sig only on Object.prototype reads as unsigned", () => {
    const plain = makeDelta(clone(baseClaims()) as unknown as Claims);
    const odd = { id: plain.id, claims: clone(baseClaims()) } as unknown as Delta;
    expect(
      withPrototype({ sig: "ZZ" }, () => [verifyCanonicalDelta(odd), verifyDelta(odd)]),
    ).toEqual(["unsigned", "unsigned"]);
  });

  it("both stores answer claims of one shape: each object is plain, as the core's copy is", async () => {
    const made = makeDelta(clone(baseClaims()) as unknown as Claims);
    const proto = Object.prototype;
    const shapeOf = (delta: Delta): boolean[] =>
      [
        delta.claims,
        ...delta.claims.pointers.flatMap((p) => [
          p,
          p.target,
          ...(p.target.kind === "entity" ? [p.target.entity] : []),
          ...(p.target.kind === "delta" ? [p.target.deltaRef] : []),
        ]),
      ].map((value) => Object.getPrototypeOf(value) === proto);
    const read = async (store: Store): Promise<boolean[]> => {
      try {
        const peer = await store.createPeer(PEER, { erasure: "unproven" });
        await peer.append({
          expectedHead: null,
          nextHead: "h1",
          frame: null,
          added: [
            {
              delta: made,
              arrival: { id: made.id, at: 1, sequence: 1, transfer: 1, sender: "local" },
            },
          ],
        });
        const [own] = await (await peer.read()).get([made.id]);
        return shapeOf(own!);
      } finally {
        await store.close();
      }
    };
    const all = shapeOf(made).map(() => true);
    expect([
      await read(createMemoryStore()),
      await read(await openSqliteStore(join(dir, `store-${++files}.db`))),
    ]).toEqual([all, all]);
  });

  it("an own key whose value is undefined is absent everywhere: a schema key, an unknown key, and a key of another target kind", () => {
    const plain = clone(baseClaims());
    delete plain.validUntil;
    const want = computeId(clone(plain) as unknown as Claims);
    const shapes: Json[] = [
      { ...clone(plain), validUntil: undefined },
      { ...clone(plain), extra: undefined },
      { ...clone(plain), [Symbol("extra")]: undefined },
      replaceAt(plain, ["pointers", 0], (h) => ({ ...h, extra: undefined })),
      replaceAt(plain, ["pointers", 2, "target"], (h) => ({
        ...h,
        entity: undefined,
        mime: undefined,
      })),
      replaceAt(plain, ["pointers", 0, "target", "entity"], (h) => ({ ...h, extra: undefined })),
    ];
    const answers = shapes.map((claims) => {
      try {
        return computeId(claims as unknown as Claims);
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(answers).toEqual(shapes.map(() => want));
    const made = makeDelta(clone(plain) as unknown as Claims);
    const reactor = new Reactor();
    const delta = { id: made.id, claims: shapes[4], sig: undefined, extra: undefined };
    expect(reactor.ingest(delta as unknown as Delta).status).toBe("accepted");
    expect(Object.keys(reactor.arrivalLog()[0]!)).toEqual(["id", "claims"]);
  });
});

describe("the second review of #137", () => {
  const PREFLIGHT = {
    admittedBefore: new DeltaSet(),
    refusedIds: new Set<string>(),
    sendingPeerId: "sender",
    receivingPeerId: "receiver",
    arrivedAt: 1,
    policyState: {},
    guards: [],
  };
  const message = (call: () => unknown): unknown => {
    try {
      return call();
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("charge 2: verifyCanonicalDelta answers invalid for an empty author, and readCommandDefinition throws invalid-definition", () => {
    const odd = { id: REF, claims: { ...clone(baseClaims()), author: "" } } as unknown as Delta;
    expect([
      message(() => verifyCanonicalDelta(odd)),
      message(() => readCommandDefinition(odd, 5)),
    ]).toEqual(["invalid", "invalid-definition"]);
  });

  it("charge 3: preflightTransfer answers invalid for an invalid unit that holds a function or is a Proxy, and reads it no second time", () => {
    let reads = 0;
    const once = { claims: clone(baseClaims()) } as Json;
    Object.defineProperty(once, "id", {
      enumerable: true,
      get: () => (++reads === 1 ? REF : `${REF}`),
    });
    const units = [
      { id: REF, claims: { ...clone(baseClaims()), author: () => AUTHOR } },
      new Proxy({ id: REF, claims: clone(baseClaims()) }, {}),
      once,
    ];
    expect(
      units.map((delta) =>
        message(
          () =>
            preflightTransfer([{ kind: "loose", delta: delta as unknown as Delta }], PREFLIGHT)[0]!
              .status,
        ),
      ),
    ).toEqual(["invalid", "invalid", "invalid"]);
    expect(reads).toBe(1);
  });

  it("note 3: verifyPureDerivation answers false for an emitted delta whose claims are not valid", () => {
    const bad = {
      id: REF,
      claims: { ...clone(baseClaims()), validUntil: -1 },
      sig: "ab".repeat(64),
    } as unknown as Delta;
    expect(
      message(() =>
        verifyPureDerivation(bad, {} as never, (() => []) as never, {} as never, "e1", "v"),
      ),
    ).toBe(false);
  });
});

// The canonical encoding as it read a claims object before the step: plain property access.
function encodeAsBefore(claims: Claims): Uint8Array {
  const target = (t: Claims["pointers"][number]["target"]): CborValue => {
    if (t.kind === "primitive")
      return typeof t.value === "string"
        ? tstr(t.value)
        : typeof t.value === "boolean"
          ? bool(t.value)
          : float(t.value);
    if (t.kind === "bytes")
      return map([
        ["mime", tstr(t.mime)],
        ["value", bstr(t.value)],
      ]);
    const [key, value, context] =
      t.kind === "entity"
        ? ["id", t.entity.id, t.entity.context]
        : ["delta", t.deltaRef.delta, t.deltaRef.context];
    const entries: [string, CborValue][] = [[key, tstr(value)]];
    if (context !== undefined) entries.push(["context", tstr(context)]);
    return map(entries);
  };
  const entries: [string, CborValue][] = [
    ["author", tstr(claims.author)],
    [
      "pointers",
      array(
        claims.pointers.map((p) =>
          map([
            ["role", tstr(p.role)],
            ["target", target(p.target)],
          ]),
        ),
      ),
    ],
    ["timestamp", float(claims.timestamp)],
    ["validFrom", float(claims.validFrom)],
  ];
  if (claims.validUntil !== undefined) entries.push(["validUntil", float(claims.validUntil)]);
  return encode(map(entries));
}

describe("no plain delta changes", () => {
  it("every claims object of the shared vector files that parses has the same canonical bytes through the step as before it: 4272 of 4272", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../vectors");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".json"),
    );
    const found: unknown[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === "object" && value !== null) {
        const keys = Object.keys(value);
        if (["author", "pointers", "timestamp", "validFrom"].every((k) => keys.includes(k)))
          found.push(value);
        Object.values(value).forEach(walk);
      }
    };
    for (const file of files) walk(JSON.parse(readFileSync(join(root, file), "utf8")));
    let same = 0;
    let parsed = 0;
    const differ: string[] = [];
    for (const json of found) {
      let plain: Claims;
      try {
        plain = structuredClone(parseClaims(json));
      } catch {
        continue;
      }
      parsed++;
      const before = Buffer.from(encodeAsBefore(plain)).toString("hex");
      const after = Buffer.from(encode(claimsToCbor(plain))).toString("hex");
      if (before === after) same++;
      else differ.push(JSON.stringify(json));
    }
    expect(differ).toEqual([]);
    expect([files.length, parsed, same]).toEqual([70, 4272, 4272]);
  });
});
