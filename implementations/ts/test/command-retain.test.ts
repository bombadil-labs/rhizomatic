import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import {
  CommandEndpoint,
  CommandTransportError,
  type CommandBoot,
} from "../src/command/endpoint.js";
import { CommandFixtureStore } from "../tools/command-store.js";
import {
  parseCommandDelta,
  serializeCommandDelta,
  readOutcome,
  commandFields,
  commandRef,
} from "../src/command-data/codec.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import { canonicalBytes } from "../src/delta/delta.js";
import { OrdinaryJournalPeer } from "../src/federation/ordinary-journal-peer.js";
import type { Delta, Target } from "../src/delta/types.js";
interface Context {
  receiverSeed: string;
  callerSeed: string;
  definitionSeed: string;
  receivedAt: number;
  boot: { configuration: unknown; declarations: unknown[] };
}
const vector = JSON.parse(
  readFileSync(new URL("../../../vectors/command/execution.json", import.meta.url), "utf8"),
) as {
  fixtures: Record<string, unknown>;
  cases: { id: string; driver: string; context: Context }[];
};
const context = vector.cases[0]!.context;
const native = (key: string) => parseCommandDelta(vector.fixtures[key]);
const first = native("first"),
  second = native("second"),
  request = native("request");
function patch(delta: Delta, key: string, target: Target, seed = context.callerSeed): Delta {
  return signClaims(
    {
      ...delta.claims,
      pointers: delta.claims.pointers.map((p) =>
        p.role === `rhizomatic.command.${key}` ? { ...p, target } : p,
      ),
    },
    seed,
  );
}
const primitive = (value: string | number): Target => ({ kind: "primitive", value });
const reference = (delta: string): Target => ({ kind: "delta", deltaRef: { delta } });
function outcome(delta: Delta) {
  const decoded = readOutcome(delta);
  const code = decoded.body.get("code");
  const ids = (key: string) => {
    const x = decoded.body.get(key);
    return x?.t === "array" ? x.v.map((v) => (v.t === "tstr" ? v.v : "")) : [];
  };
  return {
    status: decoded.status,
    code: code?.t === "tstr" ? code.v : undefined,
    admitted: ids("admitted"),
    duplicate: ids("duplicate"),
    body: decoded.body,
  };
}
async function state(store: CommandFixtureStore) {
  const opened = await OrdinaryJournalPeer.open(store, authorForSeed(context.receiverSeed));
  if (opened.status !== "open") throw new Error("journal not open");
  return { peer: opened.peer, image: opened.peer.snapshot() };
}
describe("shared command durable retain scenarios", () => {
  for (const c of vector.cases)
    it(`M2:${c.id}`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "command-retain-"));
      try {
        const store = new CommandFixtureStore(join(directory, "journal.json"));
        let now = 10;
        const diagnostics: unknown[] = [];
        const boot: CommandBoot = {
          seed: context.receiverSeed,
          configuration: parseCommandDelta(context.boot.configuration),
          declarations: context.boot.declarations.map(parseCommandDelta),
          store,
          clock: () => now,
          diagnostic: (fault) => diagnostics.push(fault),
        };
        let endpoint = await CommandEndpoint.boot(boot);
        const invoke = (entry: Delta = request, support: Delta[] = [first]) =>
          endpoint.invoke(entry.id, [entry, ...support].map(serializeCommandDelta));
        const expectCode = async (
          code: string,
          entry: Delta = request,
          support: Delta[] = [first],
        ) =>
          expect(outcome(await invoke(entry, support))).toMatchObject({ status: "refused", code });
        switch (c.driver) {
          case "endpoint_boot": {
            expect(endpoint.catalog().size).toBe(3);
            const mutableBoot = {
              ...boot,
              store: new CommandFixtureStore(join(directory, "pinned.json")),
            };
            const pinned = await CommandEndpoint.boot(mutableBoot);
            mutableBoot.seed = context.callerSeed;
            const pinnedOutcome = await pinned.invoke(
              request.id,
              [request, first].map(serializeCommandDelta),
            );
            expect(pinnedOutcome.claims.author).toBe(authorForSeed(context.receiverSeed));
            await expect(
              CommandEndpoint.boot({ ...boot, declarations: [boot.declarations[0]!] }),
            ).rejects.toThrow();
            await expect(
              CommandEndpoint.boot({
                ...boot,
                declarations: [boot.declarations[0]!, boot.declarations[0]!],
              }),
            ).rejects.toThrow();
            const wrong = signClaims(
              { ...boot.configuration.claims, author: authorForSeed(context.callerSeed) },
              context.callerSeed,
            );
            await expect(CommandEndpoint.boot({ ...boot, configuration: wrong })).rejects.toThrow();
            const badOp = patch(
              boot.declarations[0]!,
              "effect",
              primitive("none"),
              context.receiverSeed,
            );
            await expect(
              CommandEndpoint.boot({ ...boot, declarations: [badOp, boot.declarations[1]!] }),
            ).rejects.toThrow();
            break;
          }
          case "configuration_not_self_installing": {
            await expectCode("unexpected-support", request, [
              first,
              parseCommandDelta((vector.fixtures.inert as unknown[])[1]),
            ]);
            const cfg = native("inertRequest");
            const inert = (vector.fixtures.inert as unknown[]).map(parseCommandDelta);
            expect(outcome(await invoke(cfg, inert)).status).toBe("completed");
            expect(endpoint.catalog().size).toBe(3);
            expect(
              endpoint.catalog().has(commandRef(commandFields(request), "configuration")),
            ).toBe(true);
            break;
          }
          case "caller_authorization": {
            await expectCode("unauthorized", native("wrongCaller"));
            await expectCode("configuration-mismatch", native("wrongReceiver"));
            await expectCode("configuration-mismatch", native("wrongConfiguration"));
            const expires = signClaims(
              { ...boot.configuration.claims, validUntil: 11 },
              context.receiverSeed,
            );
            endpoint = await CommandEndpoint.boot({ ...boot, configuration: expires });
            const req = patch(request, "configuration", reference(expires.id));
            expect(outcome(await invoke(req)).status).toBe("completed");
            now = 11;
            await expectCode("configuration-mismatch", req);
            now = 10;
            const declaration = signClaims(
              { ...boot.declarations[1]!.claims, validUntil: 11 },
              context.receiverSeed,
            );
            const declarationConfig = signClaims(
              {
                ...boot.configuration.claims,
                pointers: boot.configuration.claims.pointers.map((p) =>
                  p.role === "rhizomatic.command.installed" &&
                  p.target.kind === "delta" &&
                  p.target.deltaRef.delta === boot.declarations[1]!.id
                    ? { ...p, target: reference(declaration.id) }
                    : p,
                ),
              },
              context.receiverSeed,
            );
            endpoint = await CommandEndpoint.boot({
              ...boot,
              configuration: declarationConfig,
              declarations: [boot.declarations[0]!, declaration],
            });
            const declarationRequest = patch(
              request,
              "configuration",
              reference(declarationConfig.id),
            );
            expect(outcome(await invoke(declarationRequest)).status).toBe("completed");
            now = 11;
            await expectCode("configuration-mismatch", declarationRequest);
            break;
          }
          case "request_validity": {
            const req = signClaims(
              { ...request.claims, validFrom: 9, validUntil: 11 },
              context.callerSeed,
            );
            now = 8;
            await expectCode("request-outside-validity", req);
            now = 9;
            expect(outcome(await invoke(req)).admitted).toEqual([first.id]);
            now = 10;
            expect(outcome(await invoke(req)).duplicate).toEqual([first.id]);
            now = 11;
            await expectCode("request-outside-validity", req);
            break;
          }
          case "addressed_entry": {
            expect(outcome(await invoke(native("addressedRequest"), [request])).admitted).toEqual([
              request.id,
            ]);
            expect((await state(store)).image.base.admitted.has(first.id)).toBe(false);
            const result = await endpoint.invoke("1e20" + "99".repeat(32), []);
            expect(outcome(result).code).toBe("entry-missing");
            expect(() => endpoint.invoke("bad", [])).toThrow(CommandTransportError);
            break;
          }
          case "invalid_duplicate_appearance": {
            const invalid = { ...(serializeCommandDelta(first) as object), sig: "00".repeat(64) };
            for (const rows of [
              [serializeCommandDelta(first), invalid],
              [invalid, serializeCommandDelta(first)],
            ])
              expect(
                outcome(
                  await endpoint.invoke(request.id, [serializeCommandDelta(request), ...rows]),
                ).code,
              ).toBe("invalid-appearance");
            expect(store.observed().frames).toBe(0);
            await invoke();
            expect(
              outcome(
                await endpoint.invoke(request.id, [
                  serializeCommandDelta(request),
                  serializeCommandDelta(first),
                  invalid,
                ]),
              ).code,
            ).toBe("invalid-appearance");
            expect(store.observed().frames).toBe(1);
            break;
          }
          case "valid_duplicate_appearance": {
            expect(
              outcome(
                await endpoint.invoke(
                  request.id,
                  [request, first, first].map(serializeCommandDelta),
                ),
              ).admitted,
            ).toEqual([first.id]);
            expect((await state(store)).image.base.arrivals).toHaveLength(1);
            break;
          }
          case "limits": {
            const missingSig = vector.fixtures.missingSignatureByteLimit as {
              configuration: unknown;
              request: unknown;
              payload: unknown;
              expectedCode: string;
            };
            endpoint = await CommandEndpoint.boot({
              ...boot,
              configuration: parseCommandDelta(missingSig.configuration),
            });
            expect(
              outcome(
                await endpoint.invoke(parseCommandDelta(missingSig.request).id, [
                  missingSig.request,
                  missingSig.payload,
                ]),
              ).code,
            ).toBe(missingSig.expectedCode);
            const uppercase = {
              ...(serializeCommandDelta(first) as object),
              sig: first.sig!.toUpperCase(),
            };
            expect(
              outcome(
                await endpoint.invoke(parseCommandDelta(missingSig.request).id, [
                  missingSig.request,
                  uppercase,
                ]),
              ).code,
            ).toBe("resource-limit");
            endpoint = await CommandEndpoint.boot(boot);
            expect(
              outcome(
                await endpoint.invoke(request.id, [serializeCommandDelta(request), uppercase]),
              ).code,
            ).toBe("invalid-appearance");

            const config = patch(
              boot.configuration,
              "max-deltas",
              primitive(2),
              context.receiverSeed,
            );
            endpoint = await CommandEndpoint.boot({ ...boot, configuration: config });
            const req = patch(request, "configuration", reference(config.id));
            expect(outcome(await invoke(req)).status).toBe("completed");
            expect(
              outcome(await endpoint.invoke(req.id, [req, first, first].map(serializeCommandDelta)))
                .code,
            ).toBe("resource-limit");
            const bad = { ...(serializeCommandDelta(first) as object), sig: "00".repeat(64) };
            expect(
              outcome(
                await endpoint.invoke(req.id, [
                  serializeCommandDelta(req),
                  serializeCommandDelta(first),
                  bad,
                ]),
              ).code,
            ).toBe("resource-limit");
            const size =
              canonicalBytes(request.claims).length + canonicalBytes(first.claims).length + 128;
            const byteConfig = patch(
              boot.configuration,
              "max-bytes",
              primitive(size),
              context.receiverSeed,
            );
            endpoint = await CommandEndpoint.boot({ ...boot, configuration: byteConfig });
            const byteReq = patch(request, "configuration", reference(byteConfig.id));
            expect(outcome(await invoke(byteReq)).status).toBe("completed");
            expect(
              outcome(
                await endpoint.invoke(
                  byteReq.id,
                  [byteReq, first, first].map(serializeCommandDelta),
                ),
              ).code,
            ).toBe("resource-limit");
            break;
          }
          case "input_mutation": {
            const rawFirst = serializeCommandDelta(first) as {
              claims: { pointers: { target: unknown }[] };
            };
            const rawRequest = serializeCommandDelta(request);
            store.afterReadRows = async () => {
              rawFirst.claims.pointers[1]!.target = "unchecked mutation";
            };
            expect(outcome(await endpoint.invoke(request.id, [rawRequest, rawFirst])).status).toBe(
              "completed",
            );
            store.afterReadRows = undefined;
            const admitted = (await state(store)).image.base.admitted.get(first.id)!;
            expect(admitted.claims).toEqual(first.claims);
            break;
          }
          case "missing_and_extra_support": {
            await expectCode("missing-support", request, []);
            await expectCode("unexpected-support", request, [first, second]);
            const unresolved = native("unresolved");
            const req = patch(request, "payload", reference(unresolved.id));
            expect(outcome(await invoke(req, [unresolved])).status).toBe("completed");
            break;
          }
          case "delivery_permutation": {
            const a = await endpoint.invoke(
              request.id,
              [request, first].map(serializeCommandDelta),
            );
            const fresh = new CommandFixtureStore(join(directory, "second.json"));
            const other = await CommandEndpoint.boot({ ...boot, store: fresh });
            const b = await other.invoke(request.id, [first, request].map(serializeCommandDelta));
            expect(serializeCommandDelta(a)).toEqual(serializeCommandDelta(b));
            const variant = vector.fixtures.signatureVariants as {
              original: unknown;
              alternate: unknown;
              selectedSignature: string;
            };
            const answers: unknown[] = [];
            for (const [i, rows] of [
              [variant.original, variant.alternate],
              [variant.alternate, variant.original],
              [variant.original, variant.alternate, variant.alternate],
            ].entries()) {
              const isolated = new CommandFixtureStore(join(directory, `variants-${i}.json`));
              const target = await CommandEndpoint.boot({ ...boot, store: isolated });
              answers.push(
                serializeCommandDelta(
                  await target.invoke(request.id, [serializeCommandDelta(request), ...rows]),
                ),
              );
              expect((await state(isolated)).image.base.admitted.get(first.id)!.sig).toBe(
                variant.selectedSignature,
              );
            }
            expect(answers[0]).toEqual(answers[1]);
            expect(answers[0]).toEqual(answers[2]);
            // Existing membership retains its authenticated appearance rather than being rewritten.
            expect((await state(store)).image.base.admitted.get(first.id)!.sig).toBe(first.sig);
            expect(
              outcome(
                await endpoint.invoke(request.id, [
                  serializeCommandDelta(request),
                  variant.alternate,
                ]),
              ).duplicate,
            ).toEqual([first.id]);
            expect((await state(store)).image.base.admitted.get(first.id)!.sig).toBe(first.sig);

            break;
          }
          case "retain_only_payload": {
            const answer = await invoke();
            expect(outcome(answer).admitted).toEqual([first.id]);
            const s = (await state(store)).image;
            expect(s.base.admitted.ids()).toEqual([first.id]);
            expect(s.base.admitted.get(first.id)).toEqual(first);
            expect(s.base.arrivals).toMatchObject([{ sender: "unattributed", at: 10 }]);
            expect(s.base.admitted.has(request.id)).toBe(false);
            expect(s.base.admitted.has(answer.id)).toBe(false);
            break;
          }
          case "retained_request_inert": {
            const inert = (vector.fixtures.inert as unknown[]).map(parseCommandDelta);
            expect(outcome(await invoke(native("inertRequest"), inert)).admitted).toEqual(
              inert.map((d) => d.id).sort(),
            );
            const s = (await state(store)).image;
            expect(s.events).toHaveLength(0);
            expect(s.exclusions).toHaveLength(0);
            expect(s.obligations).toHaveLength(0);
            expect(endpoint.catalog().size).toBe(3);
            break;
          }
          case "unsigned_payload": {
            const unsigned = {
              id: first.id,
              claims: (serializeCommandDelta(first) as { claims: unknown }).claims,
            };
            expect(
              outcome(await endpoint.invoke(request.id, [serializeCommandDelta(request), unsigned]))
                .code,
            ).toBe("invalid-appearance");
            const manifest = signClaims(
              {
                timestamp: 1,
                validFrom: 1,
                author: authorForSeed(context.definitionSeed),
                pointers: [{ role: "rhizomatic.txn.member", target: reference(first.id) }],
              },
              context.definitionSeed,
            );
            const manifestRequest = signClaims(
              {
                ...request.claims,
                pointers: [
                  ...request.claims.pointers,
                  { role: "rhizomatic.command.payload", target: reference(manifest.id) },
                ],
              },
              context.callerSeed,
            );
            expect(
              outcome(
                await endpoint.invoke(manifestRequest.id, [
                  serializeCommandDelta(manifestRequest),
                  serializeCommandDelta(manifest),
                  unsigned,
                ]),
              ).code,
            ).toBe("invalid-appearance");
            expect(store.observed().frames).toBe(0);
            break;
          }
          case "retain_atomic_quota": {
            const config = patch(boot.configuration, "quota", primitive(1), context.receiverSeed);
            endpoint = await CommandEndpoint.boot({ ...boot, configuration: config });
            const both = patch(native("bothRequest"), "configuration", reference(config.id));
            await expectCode("admission-rejected", both, [first, second]);
            expect(store.observed().frames).toBe(0);
            const one = patch(request, "configuration", reference(config.id));
            await invoke(one);
            await expectCode("admission-rejected", both, [first, second]);
            expect((await state(store)).image.base.admitted.ids()).toEqual([first.id]);
            const closureStore = new CommandFixtureStore(join(directory, "closure.json"));
            const closure = await CommandEndpoint.boot({
              ...boot,
              configuration: config,
              store: closureStore,
            });
            const negation = signClaims(
              {
                timestamp: 2,
                validFrom: 2,
                author: authorForSeed(context.definitionSeed),
                pointers: [{ role: "negates", target: reference(first.id) }],
              },
              context.definitionSeed,
            );
            const closureRequest = signClaims(
              {
                ...one.claims,
                pointers: [
                  ...one.claims.pointers,
                  { role: "rhizomatic.command.payload", target: reference(negation.id) },
                ],
              },
              context.callerSeed,
            );
            expect(
              outcome(
                await closure.invoke(
                  closureRequest.id,
                  [closureRequest, first, negation].map(serializeCommandDelta),
                ),
              ).code,
            ).toBe("admission-rejected");
            expect(closureStore.observed().frames).toBe(0);
            break;
          }
          case "retain_duplicates": {
            const before = outcome(await invoke());
            endpoint = await CommandEndpoint.boot(boot);
            const after = outcome(await invoke());
            expect(after.admitted).toEqual([]);
            expect(after.duplicate).toEqual([first.id]);
            expect(after.body.get("head")).toEqual(before.body.get("head"));
            const s = (await state(store)).image;
            expect(s.base.arrivals).toHaveLength(1);
            expect(store.observed().frames).toBe(1);
            break;
          }
          case "retain_refused_id": {
            await invoke();
            const opened = await state(store);
            const order = signClaims(
              {
                timestamp: 11,
                validFrom: 11,
                author: authorForSeed(context.definitionSeed),
                pointers: [{ role: "erases", target: reference(first.id) }],
              },
              context.definitionSeed,
            );
            const erased = await opened.peer.admitErasures({
              orders: [{ delta: order, targetId: first.id, surfaceHoldsBytes: true }],
              origin: { kind: "unattributed" },
              arrivedAt: 11,
              capacity: 10,
              policyState: {},
              guards: [],
              authorize: () => true,
              targetBudget: 1,
              advanceRefusalCap: 1,
              mode: "atomic",
            });
            expect(erased.status).toBe("committed");
            now = 12;
            await expectCode("admission-rejected");
            expect((await state(store)).image.base.refusedIds.has(first.id)).toBe(true);
            break;
          }
          case "expected_head_write": {
            const initial = patch(request, "expected-head", primitive(""));
            const withHead = signClaims(
              {
                ...initial.claims,
                pointers: [
                  ...initial.claims.pointers,
                  { role: "rhizomatic.command.expected-head", target: primitive("") },
                ],
              },
              context.callerSeed,
            );
            expect(outcome(await invoke(withHead)).status).toBe("completed");
            await expectCode("precondition-failed", native("oldHeadRequest"), [second]);
            break;
          }
          case "write_conflict": {
            let once = false;
            store.beforeAppend = async () => {
              if (once) return;
              once = true;
              const externalStore = new CommandFixtureStore(store.path);
              const external = await CommandEndpoint.boot({ ...boot, store: externalStore });
              expect(
                outcome(
                  await external.invoke(
                    native("secondRequest").id,
                    [native("secondRequest"), second].map(serializeCommandDelta),
                  ),
                ).status,
              ).toBe("completed");
            };
            await expectCode("write-conflict");
            store.beforeAppend = undefined;
            expect(outcome(await invoke()).status).toBe("completed");
            expect((await state(store)).image.base.admitted.ids().sort()).toEqual(
              [first.id, second.id].sort(),
            );
            break;
          }
          case "commit_unconfirmed": {
            for (const fault of [
              "committed-unconfirmed-absent",
              "committed-unconfirmed-persist",
              "throw-before-append",
              "throw-after-append",
            ] as const) {
              const isolated = new CommandFixtureStore(join(directory, fault + ".json"));
              const target = await CommandEndpoint.boot({ ...boot, store: isolated });
              isolated.fault = fault;
              const answer = outcome(
                await target.invoke(request.id, [request, first].map(serializeCommandDelta)),
              );
              expect(answer).toMatchObject({ status: "indeterminate", code: "commit-unconfirmed" });
              isolated.fault = undefined;
              const reopened = await CommandEndpoint.boot({ ...boot, store: isolated });
              const retry = outcome(
                await reopened.invoke(request.id, [request, first].map(serializeCommandDelta)),
              );
              const persisted = fault.endsWith("persist") || fault === "throw-after-append";
              expect(retry.admitted).toEqual(persisted ? [] : [first.id]);
              expect(retry.duplicate).toEqual(persisted ? [first.id] : []);
              expect((await state(isolated)).image.base.arrivals).toHaveLength(1);
            }
            expect(diagnostics.length).toBeGreaterThanOrEqual(4);
            break;
          }
          case "response_delivery_failure": {
            const deliver = async () => {
              await invoke();
              throw new Error("injected transport delivery failure after durable append");
            };
            await expect(deliver()).rejects.toThrow("transport delivery failure");
            endpoint = await CommandEndpoint.boot(boot);
            expect(outcome(await invoke()).duplicate).toEqual([first.id]);
            expect((await state(store)).image.base.arrivals).toHaveLength(1);
            break;
          }
          case "rows_without_journal": {
            const orphan = new CommandFixtureStore(join(directory, "orphan.json"));
            orphan.rawRows([first]);
            await expect(CommandEndpoint.boot({ ...boot, store: orphan })).rejects.toThrow(
              "rows-without-journal",
            );
            expect(orphan.observed()).toMatchObject({ head: null, frames: 0 });
            break;
          }
          case "retain_outcome_partition": {
            await invoke();
            const before = (await state(store)).image.base.admitted.digest();
            const answer = outcome(await invoke(native("bothRequest"), [first, second]));
            expect(answer.admitted).toEqual([second.id]);
            expect(answer.duplicate).toEqual([first.id]);
            expect(answer.body.get("beforeDigest")).toEqual({ t: "tstr", v: before });
            expect(answer.body.get("digest")).toEqual({
              t: "tstr",
              v: (await state(store)).image.base.admitted.digest(),
            });
            break;
          }
          case "crash_before_append":
          case "crash_after_append": {
            const fault =
              c.driver === "crash_before_append" ? "crash-before-append" : "crash-after-append";
            const input = {
              mode: "execute",
              scenario: c.id,
              context: { ...context, storePath: store.path, fault, initialDeltas: [] },
              artifact: {
                format: "rhizomatic-command-artifact/1",
                entryId: request.id,
                deltas: [request, first].map(serializeCommandDelta),
              },
            };
            const run = spawnSync(
              process.execPath,
              [
                "--import",
                new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname,
                new URL("../tools/command-fixture.ts", import.meta.url).pathname,
              ],
              { input: JSON.stringify(input), encoding: "utf8" },
            );
            expect(run.status, run.stderr).toBe(77);
            expect(run.stdout).toBe("");
            endpoint = await CommandEndpoint.boot(boot);
            const retry = outcome(await invoke());
            expect(retry.admitted).toEqual(fault === "crash-before-append" ? [first.id] : []);
            expect(retry.duplicate).toEqual(fault === "crash-after-append" ? [first.id] : []);
            expect((await state(store)).image.base.arrivals).toHaveLength(1);
            break;
          }
          default:
            throw new Error("unimplemented required scenario " + c.driver);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
});
