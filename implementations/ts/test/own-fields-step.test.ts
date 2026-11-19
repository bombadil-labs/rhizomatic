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
import type { Claims, Delta } from "../src/delta/types.js";
import {
  assertValidClaims,
  authorForSeed,
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
};

const absent = (field: Field): Expect => (field.optional ? "without" : "refuse");

/** A getter that answers `first` on its first read and `then` on every later read. */
function changing(first: unknown, then: unknown): () => unknown {
  let reads = 0;
  return () => (++reads === 1 ? first : then);
}

const FIELD_SHAPES: readonly Shape[] = [
  {
    name: "inherited from a prototype",
    expect: absent,
    make: (h, f, v) => Object.assign(Object.create({ [f.key]: v }) as Json, without(h, f.key)),
  },
  {
    name: "inherited from a class instance",
    expect: absent,
    make: (h, f, v) => {
      class Held {}
      Object.defineProperty(Held.prototype, f.key, { get: () => v });
      return Object.assign(new Held(), without(h, f.key));
    },
  },
  {
    name: "own and not enumerable",
    expect: absent,
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
    expect: () => "base",
    make: (h) => Object.assign(new (class Held {})(), h),
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

const CASES: Case[] = [];
for (const field of FIELDS) {
  const shapes = field.key === "pointers" ? [...FIELD_SHAPES, ...LIST_SHAPES] : FIELD_SHAPES;
  for (const shape of shapes) {
    const expect = shape.expect(field);
    const plain = expected(expect, field.at, field.key);
    CASES.push({
      name: `${[...field.at, field.key].join(".")}: ${shape.name}`,
      expect,
      topLevel: field.at.length === 0,
      plain,
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
  return `${id} sig:${delta.sig ?? "none"}`;
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
        if (c.plain !== undefined && want === "refused")
          wrong.push(`${where}: the plain equivalent is refused`);
        const got = await run(runner, c.odd, id, where);
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

describe("findings 1 to 4: a held delta means what its copies mean", () => {
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

  it("finding 1: a negation with an inherited validUntil has the id of its copy, and negates at 5000 when read from the held object and from its copy", () => {
    const own = makeNegationClaims(AUTHOR, 1000, fact.id);
    const inherited = Object.assign(Object.create({ validUntil: 2000 }) as Claims, own);
    const held = makeDelta(inherited);
    const copy = makeDelta(structuredClone(inherited));
    expect(held.id).toBe(copy.id);
    expect(held.id).toBe(makeDelta(own).id);
    expect(survivors([fact, held], 5000)).toEqual(survivors([fact, copy], 5000));
    expect(survivors([fact, structuredClone(held)], 5000)).toEqual([held.id]);
    expect(survivors([fact, held], 5000)).toEqual([held.id]);
  });

  it("finding 2: an entity reference with an inherited context has the id of its copy, and files under no context in the held object and in its copy", () => {
    const entity = Object.assign(Object.create({ context: "name" }) as object, { id: "e1" });
    const claims = {
      timestamp: 1,
      validFrom: 1,
      author: AUTHOR,
      pointers: [{ role: "subject", target: { kind: "entity", entity } }],
    } as Claims;
    const held = makeDelta(claims);
    const copy = makeDelta(structuredClone(claims));
    expect(held.id).toBe(copy.id);
    const group = parseTerm({ op: "group", key: "byTargetContext", in: "input" });
    const contexts = (delta: Delta): string[] => {
      const result = evalTerm(group, DeltaSet.from([delta]), 10, "e1");
      return result.sort === "hview" ? [...result.hview.props.keys()] : ["not an hview"];
    };
    expect(contexts(held)).toEqual(contexts(copy));
    const target = held.claims.pointers[0]!.target;
    expect(target.kind === "entity" && "context" in target.entity).toBe(false);
  });

  it("finding 3: a delta reference with an inherited context has the id of its copy, and the held reference has no context", () => {
    const deltaRef = Object.assign(Object.create({ context: "why" }) as object, { delta: fact.id });
    const claims = {
      timestamp: 1,
      validFrom: 1,
      author: AUTHOR,
      pointers: [{ role: "about", target: { kind: "delta", deltaRef } }],
    } as Claims;
    const held = makeDelta(claims);
    expect(held.id).toBe(makeDelta(structuredClone(claims)).id);
    const target = held.claims.pointers[0]!.target;
    expect(target.kind === "delta" && "context" in target.deltaRef).toBe(false);
  });

  it("finding 4: a delta with an inherited sig reads as unsigned in the core and in both stores", async () => {
    const signed = signClaims(baseClaims() as unknown as Claims, SEED);
    const inherited = Object.assign(Object.create({ sig: signed.sig }) as Delta, {
      id: signed.id,
      claims: structuredClone(signed.claims),
    });
    const set = new DeltaSet();
    set.add(inherited);
    const reactor = new Reactor();
    reactor.ingest(inherited);
    const answers = [
      verifyDelta(inherited),
      verifyCanonicalDelta(inherited),
      "sig" in set.get(signed.id)!,
      "sig" in reactor.arrivalLog()[0]!,
      await stored(createMemoryStore(), inherited, signed.id, "memory"),
      await stored(
        await openSqliteStore(join(dir, `store-${++files}.db`)),
        inherited,
        signed.id,
        "sqlite",
      ),
    ];
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

describe("finding 10: a field set on Object.prototype does not reach the hash", () => {
  it("validUntil and sig set on Object.prototype change no id and no verdict, and no held delta reads them [gap: context is not polluted here, because the BLAKE3 library reads its own context option through the prototype]", () => {
    const plain = baseClaims();
    delete plain.validUntil;
    const want = computeId(clone(plain) as unknown as Claims);
    const proto = Object.prototype as Json;
    const seen: unknown[] = [];
    proto.validUntil = 50;
    proto.sig = "ab".repeat(64);
    try {
      const made = makeDelta(clone(plain) as unknown as Claims);
      const set = DeltaSet.from([{ id: made.id, claims: clone(plain) as unknown as Claims }]);
      seen.push(
        computeId(clone(plain) as unknown as Claims),
        made.id,
        verifyDelta({ id: made.id, claims: clone(plain) as unknown as Claims }),
        "validUntil" in made.claims,
        "sig" in set.get(made.id)!,
      );
    } finally {
      delete proto.validUntil;
      delete proto.sig;
    }
    expect(seen).toEqual([want, want, "unsigned", false, false]);
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
