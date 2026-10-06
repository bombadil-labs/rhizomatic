import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DeltaDebugCaptureError } from "../src/delta/json-profile.js";
import { MaterializationInputError } from "../src/command/materialization-values.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import { preflightMaterializationInput } from "../src/command/materialization-preflight.js";
import { readMaterializationResult } from "../src/command/materialization-result.js";
import {
  parseCommandDelta,
  serializeCommandDelta,
  commandBytes,
  commandText,
} from "../src/command-data/codec.js";
import { signClaims } from "../src/delta/sign.js";
import { DeltaSet } from "../src/delta/set.js";
import {
  decodeMaterializationSnapshot,
  type MaterializationSourceCapability,
} from "../src/federation/materialization-source.js";
import { readMaterializationDescription } from "../src/command-data/materialization-codec.js";
import { encode } from "../src/delta/cbor.js";
import { bytesToHex } from "../src/delta/hash.js";
const fixture = JSON.parse(
  readFileSync(new URL("../../../vectors/materialization/commands.json", import.meta.url), "utf8"),
);
const boot = {
  configuration: parseCommandDelta(fixture.boot.configuration),
  declarations: fixture.boot.declarations.map(parseCommandDelta),
  bindings: fixture.boot.bindings.map(parseCommandDelta),
};
function nativeGrant(f: (typeof fixture.positives)[number], actions: readonly string[] = []) {
  const rows = new Map<string, ReturnType<typeof parseCommandDelta>>(
    f.rows.map((d: unknown) => {
      const row = parseCommandDelta(d);
      return [row.id, row];
    }),
  );
  const snapshot = decodeMaterializationSnapshot(
    commandBytes(readMaterializationDescription(parseCommandDelta(f.snapshot)), "data"),
  );
  const expectedInventory = DeltaSet.from(snapshot.deltas).digest();
  const calls: {
    binding: string;
    revision: string;
    authority: string;
    at: number;
    cutoff: number | undefined;
    support: readonly string[];
  }[] = [];
  const refused = new Set<string>();
  const grant: MaterializationSourceCapability = {
    async capture() {
      throw Error("invoke must not recapture");
    },
    async reacquireSnapshot() {
      throw Error("batch must not restore");
    },
    async checkCurrent(binding, revision, authority, at, cutoff, support) {
      calls.push({ binding, revision, authority, at, cutoff, support: [...support] });
      if (support.some((id) => refused.has(id))) return { status: "unauthorized" };
      if (DeltaSet.from(rows.values()).digest() !== expectedInventory)
        return { status: "source-changed" };
      if (
        binding !== snapshot.binding ||
        revision !== snapshot.revision ||
        authority !== snapshot.authority ||
        actions.includes("change-authority-before")
      )
        return { status: "source-changed" };
      if (calls.length === 1) {
        if (actions.includes("remove-row-after-first-check")) rows.delete([...rows.keys()][0]!);
        if (actions.includes("refuse-support-after-first-check")) refused.add(support[0]!);
      }
      return { status: "current" };
    },
  };
  if (actions.includes("refuse-support-before")) refused.add(f.source.requiredSupport[0]);
  if (actions.includes("remove-row-before")) rows.delete([...rows.keys()][0]!);
  if (actions.includes("replace-row-before")) {
    rows.delete([...rows.keys()][0]!);
    const replacement = parseCommandDelta(
      fixture.positives
        .find((x: typeof f) => x.id === "negated")
        .rows.find(
          (d: (typeof fixture.positives)[number]["rows"][number]) =>
            !rows.has(d.id) && !f.rows.some((r: typeof d) => r.id === d.id),
        ),
    );
    rows.set(replacement.id, replacement);
  }
  return { grant, calls, refused, rows };
}
function endpoint(
  grants: ReadonlyMap<string, MaterializationSourceCapability> = new Map(),
  inputBoot = boot,
) {
  return MaterializationEndpoint.boot({
    ...inputBoot,
    signer: {
      author: fixture.keys.receiver,
      sign: (claims) => signClaims(claims, fixture.seeds.receiver),
    },
    sourceGrants: grants,
    diagnostic: (fault) => {
      throw fault;
    },
  });
}
const assertionCorpusId = createHash("sha256")
  .update(readFileSync(new URL("../../../vectors/materialization/commands.json", import.meta.url)))
  .digest("hex");
function recordAssertions(group: string, f: { id: string }, before: number): void {
  console.log(
    "materialization-m2-assertion:" +
      JSON.stringify({
        corpus: "commands",
        corpusId: assertionCorpusId,
        group,
        id: f.id,
        assertions: expect.getState().assertionCalls - before,
      }),
  );
}
describe("shared materialization complete command oracles", () => {
  for (const f of fixture.positives)
    it(f.id, async () => {
      const before = expect.getState().assertionCalls;
      const inputBoot = f.boot
        ? {
            configuration: parseCommandDelta(f.boot.configuration),
            declarations: f.boot.declarations.map(parseCommandDelta),
            bindings: f.boot.bindings.map(parseCommandDelta),
          }
        : boot;
      const at = f.receivedAt ?? 1000,
        host = nativeGrant(f),
        e = endpoint(new Map([[f.source.binding, host.grant]]), inputBoot),
        q = parseCommandDelta(f.request);
      expect(preflightMaterializationInput(inputBoot, q.id, f.delivery, at)).toEqual({
        status: "input-valid",
      });
      const gathered = await e.invoke(q.id, f.delivery, at);
      expect(serializeCommandDelta(gathered)).toEqual(f.expected.gather);
      const read = readMaterializationResult(gathered, {
        receiver: fixture.keys.receiver,
        configuration: inputBoot.configuration.id,
        request: q.id,
        requestDelta: q,
        capture: parseCommandDelta(f.capture),
        snapshot: parseCommandDelta(f.snapshot),
        receivedAt: at,
      });
      expect(bytesToHex(encode(read.body))).toBe(f.expected.gatherBodyHex);
      expect(read).toMatchObject({
        classification: "verified-context",
        sourceCommitments: "commitments-verified",
        executionVerified: false,
        receiverTestimony: true,
      });
      expect(host.calls).toHaveLength(2);
      expect(host.calls[0]).toEqual(host.calls[1]);
      expect(host.calls[0]).toEqual({
        binding: f.source.binding,
        revision: f.source.revision,
        authority: f.source.authority,
        at,
        cutoff: f.source.cutoff,
        support: f.source.requiredSupport,
      });
      const rq = parseCommandDelta(f.resolve);
      expect(preflightMaterializationInput(inputBoot, rq.id, f.resolveDelivery, at)).toEqual({
        status: "input-valid",
      });
      const resolved = await endpoint(new Map(), inputBoot).invoke(rq.id, f.resolveDelivery, at);
      expect(serializeCommandDelta(resolved)).toEqual(f.expected.resolve);
      const rr = readMaterializationResult(resolved, {
        receiver: fixture.keys.receiver,
        configuration: inputBoot.configuration.id,
        request: rq.id,
        requestDelta: rq,
        evidence: parseCommandDelta(f.resolveDelivery[1]),
        receivedAt: at,
      });
      expect(bytesToHex(encode(rr.body))).toBe(f.expected.resolveBodyHex);
      expect(rr.classification).toBe("verified-context");
      expect(rr.executionVerified).toBe(false);
      if (f.id === "supplied_testimony")
        expect(
          bytesToHex(
            commandBytes(
              readMaterializationDescription(parseCommandDelta(f.resolveDelivery[1])),
              "result",
            ),
          ),
        ).not.toBe(f.expected.gatherBodyHex);
      recordAssertions("positives", f, before);
    });
  for (const f of fixture.negatives)
    it(f.id, async () => {
      const before = expect.getState().assertionCalls;
      const inputBoot = f.boot
        ? {
            configuration: parseCommandDelta(f.boot.configuration),
            declarations: f.boot.declarations.map(parseCommandDelta),
            bindings: f.boot.bindings.map(parseCommandDelta),
          }
        : boot;
      const base = fixture.positives.find(
          (x: (typeof fixture.positives)[number]) => x.id === (f.fixtureSourceId ?? "plant"),
        ),
        host = nativeGrant(f.nativeSource ?? base, f.actions),
        q = parseCommandDelta(f.request);
      const e = endpoint(
          new Map(
            f.actions?.includes("absent-grant")
              ? []
              : [[f.source.binding ?? base.source.binding, host.grant]],
          ),
          inputBoot,
        ),
        at = f.receivedAt ?? 1000;
      if (f.first) {
        expect(serializeCommandDelta(await e.invoke(q.id, f.delivery, f.first.receivedAt))).toEqual(
          f.first.outcome,
        );
      }
      if (f.actions?.includes("success-then-revoke")) {
        const first = await e.invoke(q.id, f.delivery, at);
        expect(serializeCommandDelta(first)).toEqual(base.expected.gather);
        host.refused.add(f.source.requiredSupport[0]);
      }
      const result = await e.invoke(q.id, f.delivery, at);
      expect(serializeCommandDelta(result)).toEqual(f.expected.outcome);
      const preflight = f.expected.preflight ?? f.expected.code;
      expect(preflightMaterializationInput(inputBoot, q.id, f.delivery, at)).toEqual(
        preflight === "input-valid"
          ? { status: "input-valid" }
          : preflight === "resource-limit"
            ? { status: "over-input-limit", code: preflight }
            : { status: "invalid-input", code: preflight },
      );
      recordAssertions("negatives", f, before);
    });
  it("preflight is not a native grant or support permission", async () => {
    const f = fixture.positives[0],
      q = parseCommandDelta(f.request),
      host = nativeGrant(f);
    const refusal = (result: ReturnType<typeof parseCommandDelta>) =>
      readMaterializationResult(result, {
        receiver: fixture.keys.receiver,
        configuration: boot.configuration.id,
        request: q.id,
      }).body;
    expect(preflightMaterializationInput(boot, q.id, f.delivery, 1000)).toEqual({
      status: "input-valid",
    });
    expect(
      commandText(
        readMaterializationDescription(await endpoint().invoke(q.id, f.delivery, 1000)),
        "status",
      ),
    ).toBe("refused");
    host.refused.add(f.source.requiredSupport[0]);
    const denied = await endpoint(new Map([[f.source.binding, host.grant]])).invoke(
      q.id,
      f.delivery,
      1000,
    );
    expect(refusal(denied)).toEqual({ t: "map", v: [["code", { t: "tstr", v: "unauthorized" }]] });
  });
  for (const f of fixture.resultRejections)
    it("readback/" + f.id, () => {
      const before = expect.getState().assertionCalls;
      const base = fixture.positives.find(
          (x: (typeof fixture.positives)[number]) => x.id === f.fixture,
        ),
        q = parseCommandDelta(f.kind === "gather" ? base.request : base.resolve);
      expect(() =>
        readMaterializationResult(parseCommandDelta(f.outcome), {
          receiver: fixture.keys.receiver,
          configuration: boot.configuration.id,
          request: q.id,
          requestDelta: q,
          ...(f.kind === "resolve" ? { evidence: parseCommandDelta(base.resolveDelivery[1]) } : {}),
          ...f.context,
        }),
      ).toThrow();
      recordAssertions("resultRejections", f, before);
    });
  it("public Basis hides private raw inventories and labels commitments", () => {
    const f = fixture.positives.find(
        (x: (typeof fixture.positives)[number]) => x.id === "private_provenance",
      ),
      q = parseCommandDelta(f.request),
      outcome = parseCommandDelta(f.expected.gather),
      context = {
        receiver: fixture.keys.receiver,
        configuration: boot.configuration.id,
        request: q.id,
        requestDelta: q,
      };
    const read = readMaterializationResult(outcome, context);
    expect(read.sourceCommitments).toBe("attested");
    for (const word of [fixture.sentinel, "rawIds", "operandIds", "exclusions"]) {
      expect(Buffer.from(encode(read.body)).includes(Buffer.from(word))).toBe(false);
      expect(
        Buffer.from(
          commandBytes(
            readMaterializationDescription(parseCommandDelta(f.resolveDelivery[1])),
            "result",
          ),
        ).includes(Buffer.from(word)),
      ).toBe(false);
    }
    const full = readMaterializationResult(outcome, {
      ...context,
      capture: parseCommandDelta(f.capture),
      snapshot: parseCommandDelta(f.snapshot),
    });
    expect(full.sourceCommitments).toBe("commitments-verified");
  });
  it("native inputs and two trusted times survive asynchronous interleaving", async () => {
    const old = fixture.positives[0],
      fresh = fixture.positives.find(
        (x: (typeof fixture.positives)[number]) => x.id === "new_observation_same_revision",
      ),
      host = nativeGrant(old);
    let release!: () => void;
    const barrier = new Promise<void>((done) => {
      release = done;
    });
    const original = host.grant.checkCurrent.bind(host.grant);
    let first = true;
    host.grant.checkCurrent = async (...args) => {
      const result = await original(...args);
      if (first) {
        first = false;
        await barrier;
      }
      return result;
    };
    const e = endpoint(new Map([[old.source.binding, host.grant]])),
      mutable = structuredClone(old.delivery);
    const pending = e.invoke(old.request.id, mutable, 1000);
    mutable.length = 0;
    const later = await e.invoke(fresh.request.id, fresh.delivery, 1100);
    expect(serializeCommandDelta(later)).toEqual(fresh.expected.gather);
    release();
    expect(serializeCommandDelta(await pending)).toEqual(old.expected.gather);
    expect(host.calls.map((c) => c.at)).toEqual([1000, 1100, 1100, 1000]);
    expect(() => e.invoke(old.request.id, old.delivery, Infinity)).toThrow("transport framing");
    expect(() => preflightMaterializationInput(boot, old.request.id, old.delivery, NaN)).toThrow(
      "transport framing",
    );
  });
  it("native capture accepts legal proxies and owns getter values before await", async () => {
    const f = fixture.positives[0];
    const ds = structuredClone(f.delivery);
    ds[0] = new Proxy(ds[0], {});
    expect(preflightMaterializationInput(boot, f.request.id, ds, 1000)).toEqual({
      status: "input-valid",
    });
    const host = nativeGrant(f),
      e = endpoint(new Map([[f.source.binding, host.grant]]));
    expect(serializeCommandDelta(await e.invoke(f.request.id, ds, 1000))).toEqual(
      f.expected.gather,
    );
    const raw = structuredClone(f.delivery);
    const first = raw[0].claims.pointers[0],
      role = first.role;
    Object.defineProperty(first, "role", {
      enumerable: true,
      get() {
        raw[0].claims.author = "changed after header capture";
        return role;
      },
    });
    expect(preflightMaterializationInput(boot, f.request.id, raw, 1000)).toEqual({
      status: "input-valid",
    });
    const again = structuredClone(f.delivery);
    const original = again[0].claims.pointers[0],
      originalRole = original.role;
    Object.defineProperty(original, "role", {
      enumerable: true,
      get() {
        again[0].claims.author = "changed after header capture";
        return originalRole;
      },
    });
    expect(serializeCommandDelta(await e.invoke(f.request.id, again, 1000))).toEqual(
      f.expected.gather,
    );
  });
  it("native capture rejects trap failure, cycles, unknown/inherited fields and unsafe scalars", async () => {
    const f = fixture.positives[0];
    for (const defect of [
      "throw",
      "cycle",
      "unknown",
      "inherited",
      "unicode",
      "infinity",
      "nan",
      "date",
      "toJSON",
    ] as const) {
      const ds = structuredClone(f.delivery);
      if (defect === "throw")
        Object.defineProperty(ds[0], "claims", {
          enumerable: true,
          get() {
            throw Error("getter failure");
          },
        });
      if (defect === "cycle") ds[0].claims.pointers[0].target = ds[0];
      if (defect === "unknown") ds[0].extra = { value: "must not disappear" };
      if (defect === "inherited") {
        const claims = ds[0].claims;
        ds[0] = Object.create({ claims });
        Object.assign(ds[0], { id: f.request.id, sig: f.request.sig });
      }
      if (defect === "unicode") ds[0].claims.pointers[0].target = "\ud800";
      if (defect === "infinity") ds[0].claims.timestamp = Infinity;
      if (defect === "nan") ds[0].claims.timestamp = NaN;
      if (defect === "date") ds[0].claims.pointers[0].target = new Date(0);
      if (defect === "toJSON")
        ds[0].toJSON = () => {
          throw Error("must never call toJSON");
        };
      expect(preflightMaterializationInput(boot, f.request.id, ds, 1000)).toEqual({
        status: "invalid-input",
        code: "invalid-appearance",
      });
      const out = await endpoint().invoke(f.request.id, ds, 1000);
      const read = readMaterializationResult(out, {
        receiver: fixture.keys.receiver,
        configuration: boot.configuration.id,
        request: f.request.id,
        requestDelta: parseCommandDelta(f.request),
      });
      expect(read.body).toEqual({
        t: "map",
        v: [["code", { t: "tstr", v: "invalid-appearance" }]],
      });
    }
  });
  it("getter and proxy failures cannot spoof trusted scanner refusals", async () => {
    const f = fixture.positives[0];
    for (const route of ["preflight", "invoke"] as const)
      for (const phase of ["counts", "capture", "ownKeys"] as const)
        for (const forged of [
          new MaterializationInputError("resource-limit"),
          new DeltaDebugCaptureError("resource-limit"),
        ]) {
          const ds = structuredClone(f.delivery);
          if (phase === "counts")
            Object.defineProperty(ds[0], "claims", {
              enumerable: true,
              get() {
                throw forged;
              },
            });
          if (phase === "capture")
            Object.defineProperty(ds[0].claims.pointers[0], "role", {
              enumerable: true,
              get() {
                throw forged;
              },
            });
          if (phase === "ownKeys")
            ds[0] = new Proxy(ds[0], {
              ownKeys() {
                throw forged;
              },
            });
          if (route === "preflight")
            expect(preflightMaterializationInput(boot, f.request.id, ds, 1000)).toEqual({
              status: "invalid-input",
              code: "invalid-appearance",
            });
          else {
            const out = await endpoint().invoke(f.request.id, ds, 1000);
            expect(
              Buffer.from(commandBytes(readMaterializationDescription(out), "result")).includes(
                Buffer.from("invalid-appearance"),
              ),
            ).toBe(true);
          }
        }
  });
  it("preliminary delivery scan cannot allocate through a caller iterator", async () => {
    const f = fixture.positives[0];
    for (const route of ["preflight", "invoke"] as const) {
      const ds = structuredClone(f.delivery);
      let entered = 0;
      Object.defineProperty(ds, Symbol.iterator, {
        enumerable: true,
        value: function* () {
          entered++;
          for (;;) yield ds[0];
        },
      });
      if (route === "preflight")
        expect(preflightMaterializationInput(boot, f.request.id, ds, 1000)).toEqual({
          status: "invalid-input",
          code: "invalid-appearance",
        });
      else
        expect(
          commandText(
            readMaterializationDescription(await endpoint().invoke(f.request.id, ds, 1000)),
            "status",
          ),
        ).toBe("refused");
      expect(entered).toBe(0);
    }
  });
  it("captured pointer observation is checked again before member allocation", async () => {
    const f = fixture.positives.find((f: { id: string }) => f.id === "request_pointers_exact");
    const b = {
      configuration: parseCommandDelta(f.boot.configuration),
      declarations: f.boot.declarations.map(parseCommandDelta),
      bindings: f.boot.bindings.map(parseCommandDelta),
    };
    for (const route of ["preflight", "invoke"] as const) {
      const ds = structuredClone(f.delivery),
        small = ds[0].claims.pointers;
      let reads = 0;
      Object.defineProperty(ds[0].claims, "pointers", {
        enumerable: true,
        get() {
          reads++;
          return reads <= 2 ? small : [...small, small[0]];
        },
      });
      if (route === "preflight")
        expect(preflightMaterializationInput(b, f.request.id, ds, 1000)).toEqual({
          status: "over-input-limit",
          code: "resource-limit",
        });
      else {
        const out = await endpoint(new Map(), b).invoke(f.request.id, ds, 1000);
        expect(commandText(readMaterializationDescription(out), "status")).toBe("refused");
        expect(
          Buffer.from(commandBytes(readMaterializationDescription(out), "result")).includes(
            Buffer.from("resource-limit"),
          ),
        ).toBe(true);
      }
      expect(reads).toBe(3);
    }
  });
});
