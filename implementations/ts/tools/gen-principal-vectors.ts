// Rebuild signed SPEC-14 evidence bytes. The decisions below are curated from the spec;
// this generator computes ids and signatures, never the expected authority answers.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { claimsToJson } from "../src/json-profile.js";
import { makeDelta, makeNegationClaims } from "../src/set.js";
import { signClaims } from "../src/sign.js";
import type { Claims, Delta, Pointer, Primitive } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const keyVectors = JSON.parse(
  readFileSync(resolve(root, "vectors/keys/keys.json"), "utf8"),
) as Array<{ keyId: string; seedHex: string; author: string }>;
const byKeyId = new Map(keyVectors.map((key) => [key.keyId, key]));
const keyIds = {
  userRoot: "test-key-1",
  userKey: "test-key-2",
  connection: "test-key-3",
  replacement: "test-key-4",
  operatorRoot: "test-key-5",
} as const;
type KeyName = keyof typeof keyIds;
const key = (name: KeyName) => byKeyId.get(keyIds[name])!;
const author = (name: KeyName) => key(name).author;
const keys = Object.fromEntries(
  (Object.keys(keyIds) as KeyName[]).map((name) => [name, author(name)]),
);

const entries: Array<{ name: string; delta: Delta }> = [];
const named = new Map<string, Delta>();
function add(name: string, claims: Claims, signer?: KeyName): Delta {
  if (named.has(name)) throw new Error(`duplicate fixture name ${name}`);
  const delta = signer === undefined ? makeDelta(claims) : signClaims(claims, key(signer).seedHex);
  entries.push({ name, delta });
  named.set(name, delta);
  return delta;
}
const id = (name: string) => named.get(name)!.id;
const primitive = (role: string, value: Primitive): Pointer => ({
  role,
  target: { kind: "primitive", value },
});
function record(
  name: string,
  signer: KeyName,
  principal: KeyName,
  kind: string,
  fields: readonly Pointer[],
  from = 0,
  until?: number,
  timestamp = from,
  signed = true,
): Delta {
  return add(
    name,
    {
      author: author(signer),
      timestamp,
      validFrom: from,
      ...(until === undefined ? {} : { validUntil: until }),
      pointers: [
        {
          role: "principal",
          target: {
            kind: "entity",
            entity: { id: author(principal), context: "rhizomatic.principal" },
          },
        },
        primitive("kind", kind),
        ...fields,
      ],
    },
    signed ? signer : undefined,
  );
}
function delegation(
  name: string,
  signer: KeyName,
  principal: KeyName,
  recipient: KeyName,
  scope: string,
  delegable: boolean,
  from = 0,
  until?: number,
  timestamp = from,
): Delta {
  return record(
    name,
    signer,
    principal,
    "delegation",
    [
      primitive("key", author(recipient)),
      primitive("scope", scope),
      primitive("delegable", delegable),
    ],
    from,
    until,
    timestamp,
  );
}
function negation(
  name: string,
  signer: KeyName,
  target: string,
  from: number,
  until?: number,
): Delta {
  return add(
    name,
    {
      ...makeNegationClaims(author(signer), from, id(target)),
      ...(until === undefined ? {} : { validUntil: until }),
    },
    signer,
  );
}

record("userRootDeclaration", "userRoot", "userRoot", "root", []);
record("operatorRootDeclaration", "operatorRoot", "operatorRoot", "root", []);
record(
  "bindingUserKey",
  "userRoot",
  "userRoot",
  "binding",
  [primitive("key", author("userKey"))],
  0,
  50,
);
record("claimedConnectionBinding", "userKey", "userRoot", "binding", [
  primitive("key", author("connection")),
]);
record(
  "successionToReplacement",
  "userRoot",
  "userRoot",
  "succession",
  [primitive("previous", author("userKey")), primitive("key", author("replacement"))],
  10,
);
record(
  "competingSuccession",
  "userRoot",
  "userRoot",
  "succession",
  [primitive("previous", author("userKey")), primitive("key", author("connection"))],
  10,
);
delegation("userDelegation", "userRoot", "userRoot", "userKey", "ada", true, 0, 50, 1000);
delegation(
  "connectionDelegation",
  "userKey",
  "userRoot",
  "connection",
  "ada:journal",
  false,
  5,
  20,
);
delegation("directConnection", "userRoot", "userRoot", "connection", "ada:journal", false, 0, 20);
delegation(
  "connectionSubdelegation",
  "connection",
  "userRoot",
  "replacement",
  "ada:journal:notes",
  false,
  5,
  20,
);
delegation("nondelegableUser", "userRoot", "userRoot", "userKey", "ada", false, 0, 50);
delegation("universalConnection", "userRoot", "userRoot", "connection", "*", false, 0, 50);
record("missingScope", "userRoot", "userRoot", "delegation", [
  primitive("key", author("connection")),
  primitive("delegable", false),
]);
record("missingDelegable", "userRoot", "userRoot", "delegation", [
  primitive("key", author("connection")),
  primitive("scope", "ada:journal"),
]);
record("wrongTypeDelegable", "userRoot", "userRoot", "delegation", [
  primitive("key", author("connection")),
  primitive("scope", "ada:journal"),
  primitive("delegable", "false"),
]);
record(
  "unsignedDelegation",
  "userRoot",
  "userRoot",
  "delegation",
  [
    primitive("key", author("connection")),
    primitive("scope", "ada:journal"),
    primitive("delegable", false),
  ],
  1,
  undefined,
  1,
  false,
);
record("operatorDelegation", "operatorRoot", "operatorRoot", "delegation", [
  primitive("key", author("connection")),
  primitive("scope", "*"),
  primitive("delegable", false),
]);
record("locator", "userRoot", "userRoot", "locator", [
  primitive("address", "https://example.invalid/ada"),
]);
record("otherLocator", "operatorRoot", "operatorRoot", "locator", [
  primitive("address", "https://example.invalid/operator"),
]);
record("dataRoot", "userRoot", "userRoot", "data", [primitive("value", "root")]);
record("dataUser", "userKey", "userRoot", "data", [primitive("value", "user")]);
record("dataConnection", "connection", "userRoot", "data", [primitive("value", "connection")]);
record("dataReplacement", "replacement", "userRoot", "data", [primitive("value", "replacement")]);
negation("negateUserDelegation", "userRoot", "userDelegation", 10, 15);
negation("negateConnectionByRoot", "userRoot", "connectionDelegation", 12, 19);
negation("counterRootByUser", "userKey", "negateConnectionByRoot", 13, 19);
negation("counterRootByRoot", "userRoot", "negateConnectionByRoot", 14, 19);
negation("negateConnectionByUser", "userKey", "connectionDelegation", 11, 16);
negation("negateBinding", "userRoot", "bindingUserKey", 25, 45);
negation("negateSuccession", "userRoot", "successionToReplacement", 15, 18);

const cases = [
  {
    name: "root-needs-no-declaration",
    members: [],
    key: "userRoot",
    at: 0,
    scope: "*",
    expected: { grade: "rooted", authorized: true, delegable: true, authors: ["userRoot"] },
  },
  {
    name: "other-root-does-not-appoint-governor",
    members: ["operatorRootDeclaration", "operatorDelegation"],
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "same-set-under-operator-pin",
    members: ["operatorRootDeclaration", "operatorDelegation"],
    root: "operatorRoot",
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: false,
      authors: ["operatorRoot", "connection"],
    },
  },
  {
    name: "unrooted-claim-is-not-association",
    members: ["claimedConnectionBinding"],
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: { grade: "claimed", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "binding-is-not-delegation",
    members: ["bindingUserKey"],
    key: "userKey",
    at: 0,
    scope: "ada",
    expected: { grade: "rooted", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "succession-before-start",
    members: ["bindingUserKey", "successionToReplacement"],
    key: "replacement",
    at: 9,
    scope: "ada",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "succession-needs-previous-association",
    members: ["successionToReplacement"],
    key: "replacement",
    at: 10,
    scope: "ada",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "succession-is-not-delegation",
    members: ["bindingUserKey", "successionToReplacement"],
    key: "replacement",
    at: 10,
    scope: "ada",
    expected: { grade: "rooted", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "succession-dispute-has-no-winner",
    members: ["bindingUserKey", "successionToReplacement", "competingSuccession"],
    key: "replacement",
    at: 10,
    scope: "ada",
    expected: { grade: "disputed", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "succession-negated-inside-window",
    members: ["bindingUserKey", "successionToReplacement", "negateSuccession"],
    key: "replacement",
    at: 15,
    scope: "ada",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "succession-revives-at-negation-end",
    members: ["bindingUserKey", "successionToReplacement", "negateSuccession"],
    key: "replacement",
    at: 18,
    scope: "ada",
    expected: { grade: "rooted", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "binding-negated-but-held",
    members: ["bindingUserKey", "negateBinding"],
    key: "userKey",
    at: 25,
    scope: "ada",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "binding-revives-at-negation-end",
    members: ["bindingUserKey", "negateBinding"],
    key: "userKey",
    at: 45,
    scope: "ada",
    expected: { grade: "rooted", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "delegation-can-authorize-without-association",
    members: ["userDelegation"],
    key: "userKey",
    at: 0,
    scope: "ada",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: true,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "prefix-permits-child-scope",
    members: ["userDelegation", "connectionDelegation"],
    key: "connection",
    at: 5,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: false,
      authors: ["userRoot", "userKey", "connection"],
    },
  },
  {
    name: "exact-does-not-widen-parent",
    members: ["userDelegation", "connectionDelegation"],
    key: "connection",
    at: 5,
    scope: "ada:journal",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "nondelegable-parent-cannot-extend",
    members: ["nondelegableUser", "connectionDelegation"],
    key: "connection",
    at: 5,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: false,
      delegable: false,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "nondelegable-connection-cannot-extend",
    members: ["userDelegation", "connectionDelegation", "connectionSubdelegation"],
    key: "replacement",
    at: 5,
    scope: "ada:journal:notes",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: false,
      delegable: false,
      authors: ["userRoot", "userKey", "connection"],
    },
  },
  {
    name: "direct-user-root-connection",
    members: ["directConnection", "connectionSubdelegation"],
    key: "connection",
    at: 5,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: false,
      authors: ["userRoot", "connection"],
    },
  },
  {
    name: "prefix-segment-boundary",
    members: ["userDelegation"],
    key: "userKey",
    at: 5,
    scope: "adam:journal",
    scopePolicy: "prefix",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "universal-scope-is-explicit",
    members: ["universalConnection"],
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: false,
      authors: ["userRoot", "connection"],
    },
  },
  {
    name: "scoped-edge-does-not-grant-universal",
    members: ["userDelegation"],
    key: "userKey",
    at: 0,
    scope: "*",
    scopePolicy: "prefix",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "missing-scope-is-not-evidence",
    members: ["missingScope"],
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "missing-delegable-is-not-evidence",
    members: ["missingDelegable"],
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "wrong-type-delegable-is-not-evidence",
    members: ["wrongTypeDelegable"],
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "unsigned-is-not-evidence",
    members: ["unsignedDelegation"],
    key: "connection",
    at: 1,
    scope: "ada:journal",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "locator-is-not-authority",
    members: ["locator", "otherLocator"],
    key: "connection",
    at: 0,
    scope: "ada:journal",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  {
    name: "delegation-creation-time-is-not-validity",
    members: ["userDelegation"],
    key: "userKey",
    at: 0,
    scope: "ada",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: true,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "observation-time-does-not-create-or-remove-edge",
    members: ["userDelegation"],
    key: "userKey",
    at: 0,
    now: 100,
    scope: "ada",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: true,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "delegation-before-connection-start",
    members: ["userDelegation", "connectionDelegation"],
    key: "connection",
    at: 4,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: false,
      delegable: false,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "delegation-at-connection-end",
    members: ["userDelegation", "connectionDelegation"],
    key: "connection",
    at: 20,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: false,
      delegable: false,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "delegation-at-parent-end",
    members: ["userDelegation", "connectionDelegation"],
    key: "connection",
    at: 50,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: { grade: "unresolved", authorized: false, delegable: false, authors: ["userRoot"] },
  },
  ...([9, 10, 15] as const).map((at) => ({
    name: `timed-negation-at-${at}`,
    members: ["userDelegation", "connectionDelegation", "negateUserDelegation"],
    key: "connection",
    at,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: at !== 10,
      delegable: false,
      authors: at === 10 ? ["userRoot"] : ["userRoot", "userKey", "connection"],
    },
  })),
  {
    name: "root-revokes-delegates-grant",
    members: ["userDelegation", "connectionDelegation", "negateConnectionByRoot"],
    key: "connection",
    at: 12,
    scope: "ada:journal",
    scopePolicy: "prefix",
    suppression: "rootOrSameAuthor",
    expected: {
      grade: "unresolved",
      authorized: false,
      delegable: false,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "same-author-does-not-honor-root-on-delegate",
    members: ["userDelegation", "connectionDelegation", "negateConnectionByRoot"],
    key: "connection",
    at: 12,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: false,
      authors: ["userRoot", "userKey", "connection"],
    },
  },
  {
    name: "delegate-cannot-counter-root-revocation",
    members: [
      "userDelegation",
      "connectionDelegation",
      "negateConnectionByRoot",
      "counterRootByUser",
    ],
    key: "connection",
    at: 13,
    scope: "ada:journal",
    scopePolicy: "prefix",
    suppression: "rootOrSameAuthor",
    expected: {
      grade: "unresolved",
      authorized: false,
      delegable: false,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "root-can-counter-its-revocation",
    members: [
      "userDelegation",
      "connectionDelegation",
      "negateConnectionByRoot",
      "counterRootByRoot",
    ],
    key: "connection",
    at: 14,
    scope: "ada:journal",
    scopePolicy: "prefix",
    suppression: "rootOrSameAuthor",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: false,
      authors: ["userRoot", "userKey", "connection"],
    },
  },
  {
    name: "delegator-can-revoke",
    members: ["userDelegation", "connectionDelegation", "negateConnectionByUser"],
    key: "connection",
    at: 11,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: false,
      delegable: false,
      authors: ["userRoot", "userKey"],
    },
  },
  {
    name: "expired-self-revocation-revives",
    members: ["userDelegation", "connectionDelegation", "negateConnectionByUser"],
    key: "connection",
    at: 16,
    scope: "ada:journal",
    scopePolicy: "prefix",
    expected: {
      grade: "unresolved",
      authorized: true,
      delegable: false,
      authors: ["userRoot", "userKey", "connection"],
    },
  },
] as const;

const history = [
  {
    name: "negated-binding-stays-in-history",
    members: ["bindingUserKey", "negateBinding"],
    now: 30,
    expected: [
      { key: "userRoot", via: [], negated: false },
      { key: "userKey", via: ["bindingUserKey"], negated: true },
    ],
  },
  {
    name: "successor-stays-in-history",
    members: ["bindingUserKey", "successionToReplacement", "negateBinding", "negateSuccession"],
    now: 30,
    expected: [
      { key: "userRoot", via: [], negated: false },
      { key: "userKey", via: ["bindingUserKey"], negated: true },
      { key: "replacement", via: ["bindingUserKey", "successionToReplacement"], negated: true },
    ],
  },
] as const;

const predicates = [
  {
    name: "acts-for-prefix",
    members: [
      "userDelegation",
      "connectionDelegation",
      "dataRoot",
      "dataUser",
      "dataConnection",
      "dataReplacement",
    ],
    now: 6,
    policy: { kind: "prefix", scope: "ada:journal" },
    expected: ["userDelegation", "connectionDelegation", "dataRoot", "dataUser", "dataConnection"],
  },
  {
    name: "acts-for-exact",
    members: ["userDelegation", "connectionDelegation", "dataRoot", "dataUser", "dataConnection"],
    now: 6,
    policy: { kind: "exact", scope: "ada:journal" },
    expected: ["userDelegation", "dataRoot"],
  },
] as const;

for (const c of [...cases, ...history, ...predicates]) {
  for (const name of c.members) if (!named.has(name)) throw new Error(`${c.name}: unknown ${name}`);
}
for (const c of cases) {
  for (const alias of c.expected.authors) {
    if (!(alias in keys)) throw new Error(`${c.name}: unknown expected author ${alias}`);
  }
}
const sortedHistory = history.map((c) => ({
  ...c,
  expected: [...c.expected].sort((left, right) => {
    const a = author(left.key);
    const b = author(right.key);
    return a < b ? -1 : a > b ? 1 : 0;
  }),
}));
const predicateCases = predicates.map((c) => ({
  ...c,
  term: {
    op: "select",
    pred: { actsFor: { root: author("userRoot"), policy: c.policy } },
    in: "input",
  },
  missingResolverMustThrow: true,
}));
const output = {
  spec: "SPEC-14 §§1–5",
  keys,
  deltas: entries.map(({ name, delta }) => ({
    name,
    id: delta.id,
    ...(delta.sig === undefined ? {} : { sig: delta.sig }),
    claims: claimsToJson(delta.claims),
  })),
  defaults: { root: "userRoot", now: 30, scopePolicy: "exact", suppression: "sameAuthor" },
  cases,
  history: sortedHistory,
  predicates: predicateCases,
  note: "Expected decisions are curated from SPEC-14, not computed by the generator. Case members name signed deltas above. Query output author aliases are sets; witnesses compare them after sorting by author id. Implementations must run every case in forward and reverse ingest order.",
};
const out = resolve(root, "vectors/principal/evidence.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
console.log(`wrote ${entries.length} principal deltas and ${cases.length} authority cases`);
