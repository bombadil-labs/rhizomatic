import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandEndpoint, type CommandBoot } from "../src/command/endpoint.js";
import { CommandFixtureStore } from "../tools/command-store.js";
import {
  parseCommandDelta,
  serializeCommandDelta,
  readOutcome,
  writeCommandDescription,
  commandFields,
  encodeBindings,
} from "../src/command-data/codec.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import type { Delta, Target } from "../src/delta/types.js";
import type { Term, Schema } from "../src/syntax/model.js";
import { termHash, schemaHash } from "../src/syntax/term-io.js";
import {
  HYPER_SCHEMA_SCHEMA,
  publishHyperSchemaClaims,
  publishSchemaClaims,
} from "../src/schema-load/schema-deltas.js";
import { decodeView, viewCanonicalHex } from "../src/resolve-kernel/resolution.js";
import { OrdinaryJournalPeer } from "../src/federation/ordinary-journal-peer.js";
import { readCommandResult } from "../src/command/read-result.js";
const vector = JSON.parse(
  readFileSync(new URL("../../../vectors/command/execution.json", import.meta.url), "utf8"),
) as {
  fixtures: Record<string, unknown>;
  cases: {
    id: string;
    milestone: string;
    driver: string;
    context: {
      receiverSeed: string;
      callerSeed: string;
      definitionSeed: string;
      boot: { configuration: unknown; declarations: unknown[] };
    };
  }[];
};
const context = vector.cases[0]!.context;
const native = (key: string) => parseCommandDelta(vector.fixtures[key]);
const height = native("height"),
  gather = native("gather"),
  reading = native("reading"),
  request = native("evaluation");
const t = (value: string | number): readonly Target[] => [{ kind: "primitive", value }];
const refs = (ids: string[]): readonly Target[] =>
  ids.map((delta) => ({ kind: "delta", deltaRef: { delta } }));
const latest: Schema = {
  props: new Map(),
  default: { kind: "pick", order: { kind: "byTimestamp", dir: "desc" } },
};
function publishTerm(body: Term, name = "fixture.Generic", at = 1): Delta {
  return signClaims(
    publishHyperSchemaClaims(
      { name, alg: 1, body },
      "fixture-gather",
      authorForSeed(context.definitionSeed),
      at,
    ),
    context.definitionSeed,
  );
}
function publishReading(body: Schema, name = "fixture.Latest"): Delta {
  return signClaims(
    publishSchemaClaims(
      { ...body, name, alg: 1 },
      "fixture-reading",
      authorForSeed(context.definitionSeed),
      1,
    ),
    context.definitionSeed,
  );
}
function query(g = gather, r = reading, extra: Record<string, readonly Target[]> = {}): Delta {
  const fields: Record<string, readonly Target[]> = {
    ...commandFields(request),
    hyperschema: refs([g.id]),
    schema: refs([r.id]),
    "hyperschema-pin": t(termHash(g === gather ? HYPER_SCHEMA_SCHEMA.body : readTerm(g))),
    "schema-pin": t(schemaHash(r === reading ? latest : readReading(r))),
    ...extra,
  };
  delete fields.kind;
  return writeCommandDescription(context.callerSeed, 1, "request/1", fields);
}
// The helpers above need the owner's exact decoder, never an endpoint-produced program.
import { readCommandDefinition } from "../src/schema-load/command-definitions.js";
function readTerm(d: Delta): Term {
  const x = readCommandDefinition(d, 10);
  if (x.kind !== "hyper") throw Error();
  return x.hyper.body;
}
function readReading(d: Delta): Schema {
  const x = readCommandDefinition(d, 10);
  if (x.kind !== "reading") throw Error();
  return x.reading;
}
function changedHeight(value: number, at = 2, seed = context.definitionSeed): Delta {
  return signClaims(
    {
      ...height.claims,
      timestamp: at,
      validFrom: at,
      author: authorForSeed(seed),
      pointers: height.claims.pointers.map((p) =>
        p.role === "value" ? { ...p, target: { kind: "primitive", value } } : p,
      ),
    },
    seed,
  );
}
function decoded(delta: Delta) {
  const out = readOutcome(delta);
  const code = out.body.get("code");
  return {
    ...out,
    code: code?.t === "tstr" ? code.v : undefined,
    view: out.value ? decodeView(out.value) : undefined,
  };
}
describe("shared command exact evaluation scenarios", () => {
  for (const c of vector.cases.filter((c) => c.milestone === "M3"))
    it(`M3:${c.id}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "command-evaluate-"));
      try {
        const store = new CommandFixtureStore(join(directory, "journal.json"));
        let now = 10;
        const boot: CommandBoot = {
          seed: context.receiverSeed,
          configuration: parseCommandDelta(context.boot.configuration),
          declarations: context.boot.declarations.map(parseCommandDelta),
          store,
          clock: () => now,
          diagnostic: () => {},
        };
        const endpoint = await CommandEndpoint.boot(boot);
        const retain = async (payload: Delta[]) => {
          const fields: Record<string, readonly Target[]> = {
            ...commandFields(native("heightRequest")),
            payload: refs(payload.map((d) => d.id)),
          };
          delete fields.kind;
          const root = writeCommandDescription(context.callerSeed, 1, "request/1", fields);
          return decoded(
            await endpoint.invoke(root.id, [root, ...payload].map(serializeCommandDelta)),
          );
        };
        const evaluate = async (root = request, support = [gather, reading]) =>
          decoded(await endpoint.invoke(root.id, [root, ...support].map(serializeCommandDelta)));
        const source = async () => {
          const s = await OrdinaryJournalPeer.open(store, authorForSeed(context.receiverSeed));
          if (s.status !== "open") throw Error();
          return s.peer;
        };
        await retain([height]);
        switch (c.driver) {
          case "query_ephemeral": {
            const before = store.observed(),
              image = (await source()).snapshot();
            expect((await evaluate()).view).toEqual({ height: 42 });
            expect(store.observed()).toEqual(before);
            expect((await source()).snapshot().base.arrivals).toEqual(image.base.arrivals);
            expect(store.observed().ids).toEqual([height.id]);
            break;
          }
          case "catalog_discovery":
          case "catalog_with_unavailable_store": {
            const catalogGather = publishTerm(
              { ...HYPER_SCHEMA_SCHEMA.body, key: { kind: "byRole" } } as Term,
              "fixture.Catalog",
            );
            const q = query(catalogGather, reading, {
              source: t("catalog"),
              root: [{ kind: "entity", entity: { id: authorForSeed(context.receiverSeed) } }],
            });
            const before = store.observed();
            if (c.driver === "catalog_with_unavailable_store") store.fault = "source-unavailable";
            const answer = await evaluate(q, [catalogGather, reading]);
            expect(answer.status).toBe("completed");
            expect(answer.body.has("head")).toBe(false);
            expect(answer.body.get("digest")).toEqual({
              t: "tstr",
              v: endpoint.catalog().digest(),
            });
            expect(answer.view).toMatchObject({
              "rhizomatic.command.receiver": {
                "rhizomatic.command.kind": "endpoint/1",
                "rhizomatic.command.installed": boot.declarations.map((d) => d.id).sort(),
              },
            });
            if (c.driver === "catalog_discovery") {
              const lookalike = signClaims(
                { ...boot.declarations[0]!.claims, timestamp: 2 },
                context.receiverSeed,
              );
              await retain([lookalike]);
              expect((await evaluate(q, [catalogGather, reading])).view).toEqual(answer.view);
              expect(endpoint.catalog().size).toBe(3);
            } else {
              expect((await evaluate()).code).toBe("source-unavailable");
              expect(
                (
                  await evaluate(
                    query(gather, reading, { source: t("catalog"), "expected-head": t("") }),
                  )
                ).code,
              ).toBe("invalid-arguments");
            }
            store.fault = undefined;
            expect(before.ids).toEqual([height.id]);
            break;
          }
          case "coherent_external_change": {
            const external = await source();
            const order = signClaims(
              {
                timestamp: 11,
                validFrom: 11,
                author: authorForSeed(context.definitionSeed),
                pointers: [
                  { role: "erases", target: { kind: "delta", deltaRef: { delta: height.id } } },
                ],
              },
              context.definitionSeed,
            );
            expect(
              (
                await external.admitErasures({
                  orders: [{ delta: order, targetId: height.id, surfaceHoldsBytes: true }],
                  origin: { kind: "unattributed" },
                  arrivedAt: 11,
                  capacity: 10,
                  policyState: {},
                  guards: [],
                  authorize: () => true,
                  targetBudget: 1,
                  advanceRefusalCap: 1,
                  mode: "atomic",
                })
              ).status,
            ).toBe("committed");
            now = 12;
            const result = await evaluate();
            expect(result.view).toEqual({});
            expect(result.body.get("digest")).toEqual({
              t: "tstr",
              v: (await source()).snapshot().base.admitted.digest(),
            });
            break;
          }
          case "source_changes_during_capture": {
            let once = false;
            store.afterReadRows = async () => {
              if (once) return;
              once = true;
              const other = await CommandEndpoint.boot({
                ...boot,
                store: new CommandFixtureStore(store.path),
              });
              const payload = changedHeight(43);
              const root = writeCommandDescription(context.callerSeed, 1, "request/1", {
                ...commandFields(native("heightRequest")),
                payload: refs([payload.id]),
              });
              await other.invoke(root.id, [root, payload].map(serializeCommandDelta));
            };
            expect((await evaluate()).code).toBe("source-changed");
            break;
          }
          case "query_snapshot_after_capture": {
            const before = store.observed().head;
            const readHead = store.readHead.bind(store);
            let once = false;
            store.readHead = async () => {
              const observed = await readHead();
              if (!once) {
                once = true;
                const otherStore = new CommandFixtureStore(store.path);
                const other = await CommandEndpoint.boot({ ...boot, store: otherStore });
                const payload = changedHeight(43);
                const fields: Record<string, readonly Target[]> = {
                  ...commandFields(native("heightRequest")),
                  payload: refs([payload.id]),
                };
                delete fields.kind;
                const root = writeCommandDescription(context.callerSeed, 1, "request/1", fields);
                await other.invoke(root.id, [root, payload].map(serializeCommandDelta));
              }
              return observed;
            };
            const answer = await evaluate();
            expect(answer.view).toEqual({ height: 42 });
            expect(answer.body.get("head")).toEqual({ t: "tstr", v: before });
            expect(store.observed().head).not.toBe(before);
            break;
          }
          case "degraded_source":
            store.rawRows([]);
            expect((await evaluate()).code).toBe("source-unavailable");
            break;
          case "write_then_query": {
            const head = store.observed().head!;
            const q = query(gather, reading, { "expected-head": t(head) });
            expect((await evaluate(q)).view).toEqual({ height: 42 });
            await retain([changedHeight(43)]);
            expect((await evaluate(q)).code).toBe("precondition-failed");
            break;
          }
          case "source_digest_precondition": {
            for (const sourceKind of ["admitted", "catalog"]) {
              const digest =
                sourceKind === "catalog"
                  ? endpoint.catalog().digest()
                  : (await source()).snapshot().base.admitted.digest();
              expect(
                (
                  await evaluate(
                    query(gather, reading, { source: t(sourceKind), "expected-digest": t(digest) }),
                  )
                ).status,
              ).toBe("completed");
              expect(
                (
                  await evaluate(
                    query(gather, reading, {
                      source: t(sourceKind),
                      "expected-digest": t("1e20" + "00".repeat(32)),
                    }),
                  )
                ).code,
              ).toBe("precondition-failed");
            }
            break;
          }
          case "query_repeat_current": {
            const old = await evaluate();
            await retain([changedHeight(43)]);
            const next = await evaluate();
            expect(old.view).toEqual({ height: 42 });
            expect(next.view).toEqual({ height: 43 });
            expect(old.body.get("digest")).not.toEqual(next.body.get("digest"));
            break;
          }
          case "explicit_time": {
            const fact = signClaims(
              { ...height.claims, timestamp: 50, validFrom: 50, validUntil: 100 },
              context.definitionSeed,
            );
            await retain([fact]);
            now = 1000;
            for (const at of [49, 50, 99, 100]) {
              const isolatedRoot = query(gather, reading, { at: t(at) });
              const result = await evaluate(isolatedRoot);
              expect(result.view).toEqual({ height: 42 });
              expect(result.body.get("at")).toEqual({ t: "float", v: at });
              expect(result.fields.status).toBeDefined();
            }
            // The permanently valid baseline cannot hide the temporal fact's visibility.
            const timed = changedHeight(50, 50);
            const bounded = signClaims(
              { ...timed.claims, validUntil: 100 },
              context.definitionSeed,
            );
            await retain([bounded]);
            for (const at of [49, 50, 99, 100])
              expect((await evaluate(query(gather, reading, { at: t(at) }))).view).toEqual({
                height: at >= 50 && at < 100 ? 50 : 42,
              });
            break;
          }
          case "exact_definition_act": {
            const newer = publishTerm(
              { kind: "group", key: { kind: "const", prop: "renamed" }, of: { kind: "input" } },
              "fixture.Generic",
              2,
            );
            await retain([newer]);
            expect((await evaluate()).view).toEqual({ height: 42 });
            expect(store.observed().ids).toContain(newer.id);
            break;
          }
          case "definition_pin_mismatch":
            expect(
              (
                await evaluate(
                  query(gather, reading, { "hyperschema-pin": t("1e20" + "00".repeat(32)) }),
                )
              ).code,
            ).toBe("pin-mismatch");
            break;
          case "definition_validity_and_version": {
            for (const claims of [
              { ...gather.claims, validFrom: 11 },
              { ...gather.claims, pointers: gather.claims.pointers.slice(1) },
              {
                ...gather.claims,
                pointers: gather.claims.pointers.map((p) =>
                  p.role.endsWith(".alg")
                    ? { ...p, target: { kind: "primitive" as const, value: 2 } }
                    : p,
                ),
              },
              {
                ...gather.claims,
                pointers: [...gather.claims.pointers, gather.claims.pointers[0]!],
              },
              {
                ...gather.claims,
                pointers: gather.claims.pointers.map((p) =>
                  p.role.endsWith(".term")
                    ? { ...p, target: { kind: "primitive" as const, value: "f6" } }
                    : p,
                ),
              },
            ]) {
              const bad = signClaims(claims, context.definitionSeed);
              const fields: Record<string, readonly Target[]> = {
                ...commandFields(request),
                hyperschema: refs([bad.id]),
              };
              delete fields.kind;
              const q = writeCommandDescription(context.callerSeed, 1, "request/1", fields);
              expect((await evaluate(q, [bad, reading])).code).toBe("invalid-definition");
            }
            const wrong = publishTerm({ kind: "input" });
            expect((await evaluate(query(wrong), [wrong, reading])).code).toBe("invalid-program");
            break;
          }
          case "definition_name_conflict": {
            const duplicate = signClaims(
              { ...gather.claims, timestamp: 2 },
              context.definitionSeed,
            );
            const q = query(gather, reading, { definition: refs([duplicate.id]) });
            for (const support of [
              [gather, reading, duplicate],
              [duplicate, reading, gather],
            ])
              expect((await evaluate(q, support)).code).toBe("ambiguous-definition");
            break;
          }
          case "definition_closure":
          case "definition_cycle":
          case "nested_reference_analysis": {
            const child = publishTerm(HYPER_SCHEMA_SCHEMA.body, "fixture.Child");
            const childReading = publishReading(latest, "fixture.ChildReading");
            const parent = publishTerm({
              kind: "expand",
              role: { kind: "exact", value: "link" },
              schema: { kind: "name", name: "fixture.Child" },
              reading: { kind: "pinned", hash: schemaHash(latest) },
              of: HYPER_SCHEMA_SCHEMA.body,
            });
            if (c.driver === "definition_cycle") {
              const cyclic = publishTerm({
                kind: "fix",
                schema: { kind: "name", name: "fixture.Generic" },
                entity: "subject",
              });
              expect((await evaluate(query(cyclic), [cyclic, reading])).code).toBe(
                "definition-cycle",
              );
              expect((await evaluate()).status).toBe("completed");
            } else if (c.driver === "nested_reference_analysis") {
              const nested = publishTerm({
                kind: "group",
                key: { kind: "byTargetContext" },
                of: {
                  kind: "select",
                  pred: {
                    kind: "inView",
                    term: {
                      kind: "select",
                      pred: {
                        kind: "actsFor",
                        root: authorForSeed(context.definitionSeed),
                        policy: { kind: "exact", scope: "read" },
                      },
                      of: { kind: "input" },
                    },
                    field: "id",
                    extract: { kind: "field", field: "id" },
                  },
                  of: { kind: "input" },
                },
              });
              expect((await evaluate(query(nested), [nested, reading])).code).toBe(
                "invalid-program",
              );
              expect(
                (
                  await evaluate(
                    query(nested, reading, { interpretation: t("principal-sameAuthor/1") }),
                    [nested, reading],
                  )
                ).view,
              ).toEqual({ height: 42 });
              const orderReading = publishReading({
                ...latest,
                default: {
                  kind: "pick",
                  order: {
                    kind: "byPred",
                    pred: {
                      kind: "actsFor",
                      root: authorForSeed(context.definitionSeed),
                      policy: { kind: "exact", scope: "read" },
                    },
                    then: { kind: "lexById" },
                  },
                },
              });
              expect(
                (await evaluate(query(gather, orderReading), [gather, orderReading])).code,
              ).toBe("invalid-program");
              expect(
                (
                  await evaluate(
                    query(gather, orderReading, { interpretation: t("principal-sameAuthor/1") }),
                    [gather, orderReading],
                  )
                ).view,
              ).toEqual({ height: 42 });
            } else {
              const grand = publishTerm(HYPER_SCHEMA_SCHEMA.body, "fixture.Grand");
              const grandReadingBody: Schema = {
                props: new Map(),
                default: { kind: "pick", order: { kind: "byTimestamp", dir: "asc" } },
              };
              const grandReading = publishReading(grandReadingBody, "fixture.GrandReading");
              const childBody: Term = {
                kind: "expand",
                role: { kind: "exact", value: "link" },
                schema: { kind: "pinned", hash: termHash(HYPER_SCHEMA_SCHEMA.body) },
                reading: { kind: "name", name: "fixture.GrandReading" },
                of: HYPER_SCHEMA_SCHEMA.body,
              };
              const nestedChild = publishTerm(childBody, "fixture.Child");
              const childReadingBody: Schema = {
                props: new Map(),
                default: { kind: "pick", order: { kind: "lexById" } },
              };
              const nestedReading = publishReading(childReadingBody, "fixture.ChildReading");
              const nestedParent = publishTerm({
                ...readTerm(parent),
                reading: { kind: "pinned", hash: schemaHash(childReadingBody) },
              } as Term);
              const link = (id: string, prop: string, target: string) =>
                signClaims(
                  {
                    timestamp: 2,
                    validFrom: 2,
                    author: authorForSeed(context.definitionSeed),
                    pointers: [
                      { role: "about", target: { kind: "entity", entity: { id, context: prop } } },
                      { role: "link", target: { kind: "entity", entity: { id: target } } },
                    ],
                  },
                  context.definitionSeed,
                );
              const leaf = signClaims(
                {
                  ...height.claims,
                  pointers: height.claims.pointers.map((p) =>
                    p.role === "about"
                      ? {
                          ...p,
                          target: {
                            kind: "entity" as const,
                            entity: { id: "grand", context: "height" },
                          },
                        }
                      : p,
                  ),
                },
                context.definitionSeed,
              );
              await retain([
                link("subject", "child", "child"),
                link("child", "grandchild", "grand"),
                leaf,
              ]);
              const deps = [nestedChild, nestedReading, grand, grandReading];
              const q = query(nestedParent, reading, { definition: refs(deps.map((d) => d.id)) });
              expect((await evaluate(q, [nestedParent, reading, ...deps])).view).toEqual({
                height: 42,
                child: { grandchild: { height: 42 } },
              });
              const omitted = deps.filter((d) => d.id !== grand.id);
              expect(
                (
                  await evaluate(
                    query(nestedParent, reading, { definition: refs(omitted.map((d) => d.id)) }),
                    [nestedParent, reading, ...omitted],
                  )
                ).code,
              ).toBe("definition-closure");
              expect((await evaluate(query(parent), [parent, reading])).code).toBe(
                "definition-closure",
              );
              const extra = query(gather, reading, {
                definition: refs([child.id, childReading.id]),
              });
              expect((await evaluate(extra, [gather, reading, child, childReading])).code).toBe(
                "definition-closure",
              );
            }
            break;
          }
          case "variables": {
            const variable = publishTerm({
              kind: "group",
              key: { kind: "byTargetContext" },
              of: {
                kind: "select",
                pred: {
                  kind: "hasPointer",
                  ppred: { targetEntity: { kind: "hole", name: "target" } },
                },
                of: { kind: "input" },
              },
            });
            const q = query(variable, reading, {
              bindings: [
                {
                  kind: "bytes",
                  mime: "application/cbor",
                  value: encodeBindings({ target: "subject" }),
                },
              ],
            });
            expect((await evaluate(q, [variable, reading])).view).toEqual({ height: 42 });
            expect(
              (
                await evaluate(
                  query(variable, reading, {
                    bindings: [
                      {
                        kind: "bytes",
                        mime: "application/cbor",
                        value: encodeBindings({ target: 42 }),
                      },
                    ],
                  }),
                  [variable, reading],
                )
              ).code,
            ).toBe("invalid-program");
            expect((await evaluate(query(variable), [variable, reading])).code).toBe(
              "invalid-program",
            );
            const rootOverride = query(variable, reading, {
              bindings: [
                {
                  kind: "bytes",
                  mime: "application/cbor",
                  value: Uint8Array.from([0xa1, 0x64, 0x72, 0x6f, 0x6f, 0x74, 0x61, 0x78]),
                },
              ],
            });
            expect((await evaluate(rootOverride, [variable, reading])).code).toBe(
              "invalid-arguments",
            );
            break;
          }
          case "core_principal_refusal":
          case "principal_profiles":
          case "principal_pins_and_source": {
            const root = authorForSeed(context.definitionSeed),
              middleSeed = "04".repeat(32),
              leafSeed = "05".repeat(32),
              middle = authorForSeed(middleSeed),
              leaf = authorForSeed(leafSeed);
            const delegation = (seed: string, key: string) =>
              signClaims(
                {
                  timestamp: 1,
                  validFrom: 1,
                  author: authorForSeed(seed),
                  pointers: [
                    {
                      role: "principal",
                      target: {
                        kind: "entity",
                        entity: { id: root, context: "rhizomatic.principal" },
                      },
                    },
                    { role: "kind", target: { kind: "primitive", value: "delegation" } },
                    { role: "key", target: { kind: "primitive", value: key } },
                    { role: "scope", target: { kind: "primitive", value: "read" } },
                    { role: "delegable", target: { kind: "primitive", value: true } },
                  ],
                },
                seed,
              );
            const edge = delegation(middleSeed, leaf),
              negation = signClaims(
                {
                  timestamp: 2,
                  validFrom: 2,
                  author: root,
                  pointers: [
                    { role: "negates", target: { kind: "delta", deltaRef: { delta: edge.id } } },
                  ],
                },
                context.definitionSeed,
              );
            await retain([
              delegation(context.definitionSeed, middle),
              edge,
              negation,
              changedHeight(55, 2, leafSeed),
            ]);
            const body: Term = {
              kind: "group",
              key: { kind: "byTargetContext" },
              of: {
                kind: "select",
                pred: {
                  kind: "and",
                  left: { kind: "actsFor", root, policy: { kind: "exact", scope: "read" } },
                  right: { kind: "hasPointer", ppred: { targetEntity: { kind: "root" } } },
                },
                of: { kind: "input" },
              },
            };
            const program = publishTerm(body);
            if (c.driver === "core_principal_refusal")
              expect((await evaluate(query(program), [program, reading])).code).toBe(
                "invalid-program",
              );
            else {
              const wrapperBody: Term = {
                kind: "fix",
                schema: { kind: "name", name: "fixture.PrincipalChild" },
                entity: "subject",
              };
              const selected =
                c.driver === "principal_pins_and_source" ? publishTerm(wrapperBody) : program;
              const child =
                c.driver === "principal_pins_and_source"
                  ? publishTerm(body, "fixture.PrincipalChild")
                  : undefined;
              const extra = child ? { definition: refs([child.id]) } : {};
              const support = child ? [selected, reading, child] : [selected, reading];
              const same = await evaluate(
                query(selected, reading, { ...extra, interpretation: t("principal-sameAuthor/1") }),
                support,
              );
              const rootOr = await evaluate(
                query(selected, reading, {
                  ...extra,
                  interpretation: t("principal-rootOrSameAuthor/1"),
                }),
                support,
              );
              expect(same.view).toEqual({ height: 55 });
              expect(rootOr.view).toEqual({ height: 42 });
              expect(same.body.get("hyperschemaPin")).toEqual({
                t: "tstr",
                v: termHash(child ? wrapperBody : body),
              });
            }
            break;
          }
          case "outcome_provenance": {
            const bytes = signClaims(
              {
                ...height.claims,
                timestamp: 2,
                pointers: height.claims.pointers.map((p) =>
                  p.role === "value"
                    ? {
                        ...p,
                        target: {
                          kind: "bytes" as const,
                          mime: "image/png",
                          value: Uint8Array.from([1, 2, 3]),
                        },
                      }
                    : p,
                ),
              },
              context.definitionSeed,
            );
            await retain([bytes]);
            const signed = await endpoint.invoke(
              request.id,
              [request, gather, reading].map(serializeCommandDelta),
            );
            const result = readCommandResult(
              signed,
              {
                receiver: authorForSeed(context.receiverSeed),
                configuration: boot.configuration.id,
                request: request.id,
              },
              request,
            );
            expect(result.view).toEqual({
              height: { mime: "image/png", value: Uint8Array.from([1, 2, 3]) },
            });
            expect(signed.claims.author).toBe(authorForSeed(context.receiverSeed));
            expect(signed.claims.author).not.toBe(bytes.claims.author);
            break;
          }
          case "no_hidden_observations": {
            const reads: string[] = [];
            for (const method of ["readJournal", "readAdmittedRows", "readHead"] as const) {
              const member = store[method].bind(store);
              // Explicit host instrumentation counts observations at the port.
              Object.defineProperty(store, method, {
                value: (...args: unknown[]) => {
                  reads.push(method);
                  return Reflect.apply(member, undefined, args);
                },
                configurable: true,
              });
            }
            const before = store.observed(),
              answer = await evaluate();
            expect(reads).toEqual(["readJournal", "readAdmittedRows", "readHead"]);
            store.fault = "source-unavailable";
            // Catalog does not observe the unavailable durable source; fixed time and input fix result.
            const q = query(gather, reading, { source: t("catalog") });
            expect((await evaluate(q)).status).toBe("completed");
            expect(reads).toHaveLength(3);
            store.fault = undefined;
            now = 999;
            const repeated = await evaluate();
            expect(viewCanonicalHex(repeated.view!)).toBe(viewCanonicalHex(answer.view!));
            expect(store.observed()).toEqual(before);
            break;
          }
          case "error_priority": {
            const bad = signClaims({ ...gather.claims, validFrom: 11 }, context.definitionSeed);
            const fields: Record<string, readonly Target[]> = {
              ...commandFields(request),
              hyperschema: refs([bad.id]),
              "expected-head": t("1e20" + "00".repeat(32)),
              "hyperschema-pin": t("1e20" + "00".repeat(32)),
            };
            delete fields.kind;
            expect(
              (
                await evaluate(
                  writeCommandDescription(context.callerSeed, 1, "request/1", fields),
                  [bad, reading],
                )
              ).code,
            ).toBe("precondition-failed");
            delete fields["expected-head"];
            expect(
              (
                await evaluate(
                  writeCommandDescription(context.callerSeed, 1, "request/1", fields),
                  [bad, reading],
                )
              ).code,
            ).toBe("invalid-definition");
            break;
          }
          default:
            throw Error("unimplemented required M3 scenario " + c.driver);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
});
