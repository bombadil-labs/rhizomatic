import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
});
