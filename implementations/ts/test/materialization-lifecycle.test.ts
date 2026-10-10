// SPEC-16 M3: the six maintained verbs over an in-memory control store, driven by the shared
// `plant` batch fixture so every root result must equal the batch oracle byte for byte.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decode, encode, type CborValue } from "../src/delta/cbor.js";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { signClaims } from "../src/delta/sign.js";
import { claimsToJson } from "../src/delta/json-profile.js";
const serializeCommandDelta = (d: Delta) => ({
  id: d.id,
  claims: claimsToJson(d.claims),
  ...(d.sig === undefined ? {} : { sig: d.sig }),
});
import type { Delta, Target } from "../src/delta/types.js";
import {
  parseCommandDelta,
  commandBytes,
  commandEntity,
  commandNumber,
  commandRef,
  commandText,
} from "../src/command-data/codec.js";
import {
  materializationDescriptionClaims,
  readMaterializationDescription,
  readMaterializationLimits,
  MATERIALIZATION_VERBS,
  materializationVerbEffect,
  MATERIALIZATION_PREFIX,
} from "../src/command-data/materialization-codec.js";
import type { MaterializationSourceCapability } from "../src/federation/materialization-source.js";
import {
  decodeMaterializationControl,
  type MaterializationControlStore,
} from "../src/federation/materialization-control.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import { initializeMaterializationControl } from "../src/command/materialization-lifecycle.js";
import { readMaterializationResult } from "../src/command/materialization-result.js";
import { preflightMaterializationInput } from "../src/command/materialization-preflight.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../vectors/materialization/commands.json", import.meta.url), "utf8"),
);
const plant = fixture.positives.find((p: { id: string }) => p.id === "plant");
const keys = fixture.keys as Record<string, string>,
  seeds = fixture.seeds as Record<string, string>;
const p = (value: string | number): Target => ({ kind: "primitive", value });
const ent = (id: string): Target => ({ kind: "entity", entity: { id } });
const ref = (delta: string): Target => ({ kind: "delta", deltaRef: { delta } });
const blob = (value: Uint8Array): Target => ({ kind: "bytes", mime: "application/cbor", value });
const sign = (
  kind: Parameters<typeof materializationDescriptionClaims>[2],
  fields: Record<string, Target[]>,
  seed = seeds.caller!,
  at = 1000,
) =>
  signClaims(
    materializationDescriptionClaims(
      keys[
        seed === seeds.receiver ? "receiver" : seed === seeds.definition ? "definition" : "caller"
      ]!,
      at,
      kind,
      fields,
    ),
    seed,
  );
const hex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
const field = (v: CborValue, k: string): CborValue =>
  v.t === "map"
    ? new Map(v.v).get(k)!
    : (() => {
        throw Error();
      })();
const text = (v: CborValue) =>
  v.t === "tstr"
    ? v.v
    : (() => {
        throw Error();
      })();
const num = (v: CborValue) =>
  v.t === "float"
    ? v.v
    : (() => {
        throw Error();
      })();

// Release-B boot: the plant binding and limits with all eight operations installed.
const binding = parseCommandDelta(fixture.boot.bindings[0]);
const limitsBytes = commandBytes(
  readMaterializationDescription(parseCommandDelta(fixture.boot.configuration)),
  "limits",
);
const limits = readMaterializationLimits(limitsBytes);
const operations = MATERIALIZATION_VERBS.map((verb) =>
  sign(
    "operation/1",
    {
      name: [ent(MATERIALIZATION_PREFIX + verb)],
      interpreter: [p(MATERIALIZATION_PREFIX + verb + "/1")],
      "input-contract": [p(MATERIALIZATION_PREFIX + verb + "/1")],
      "output-contract": [p(MATERIALIZATION_PREFIX + "outcome/1")],
      effect: [p(materializationVerbEffect(verb))],
      replay: [p("re-evaluate/1")],
      dependencies: [p("explicit-support/1")],
    },
    seeds.receiver!,
    0,
  ),
);
const configuration = sign(
  "endpoint/1",
  {
    receiver: [ent(keys.receiver!)],
    caller: [p(keys.caller!)],
    administrator: [p(keys.caller!)],
    installed: operations.map((o) => ref(o.id)),
    "source-binding": [ref(binding.id)],
    limits: [blob(limitsBytes)],
  },
  seeds.receiver!,
  0,
);
const op = (verb: string) =>
  operations.find(
    (o) =>
      commandEntity(readMaterializationDescription(o), "name") === MATERIALIZATION_PREFIX + verb,
  )!;
const delivered: Delta[] = plant.delivery.map(parseCommandDelta);
const kindOf = (d: Delta) => {
  try {
    return commandText(readMaterializationDescription(d), "kind");
  } catch {
    return d.claims.pointers[0]!.role.startsWith("rhizomatic.hyperschema.") ? "hyper" : "reading";
  }
};
const gatherRequest = delivered.find((d) => kindOf(d) === "request/1")!,
  gf = readMaterializationDescription(gatherRequest, "gather"),
  capture = delivered.find((d) => kindOf(d) === "capture/1")!,
  snapshot = delivered.find((d) => kindOf(d) === "snapshot/1")!,
  authority = delivered.find((d) => kindOf(d) === "authority/1")!,
  definitions = delivered.filter((d) => ["hyper", "reading"].includes(kindOf(d)));
const descriptor = sign(
  "registration/1",
  {
    "source-binding": [ref(binding.id)],
    hyperschema: [ref(commandRef(gf, "hyperschema"))],
    "hyperschema-pin": [p(commandText(gf, "hyperschema-pin"))],
    schema: [ref(commandRef(gf, "schema"))],
    "schema-pin": [p(commandText(gf, "schema-pin"))],
    roots: [ent(commandEntity(gf, "root"))],
    bindings: [blob(commandBytes(gf, "bindings"))],
    "definition-at": [p(commandNumber(gf, "definition-at"))],
    interpretation: [p("core/1")],
    "result-kind": [p("hview-and-view/1")],
    "time-policy": [p("live-time/1")],
    alias: [p("Plant")],
  },
  seeds.definition!,
  0,
);
class MemoryStore implements MaterializationControlStore {
  readonly images = new Map<string, { bytes: Uint8Array; revision: string }>();
  async initialize(receiver: string, configuration: string, emptyBytes: Uint8Array) {
    const key = receiver + "/" + configuration,
      existing = this.images.get(key);
    if (existing) return { status: "existing" as const, ...existing };
    this.images.set(key, { bytes: emptyBytes, revision: "" });
    return { status: "initialized" as const, bytes: emptyBytes };
  }
  async read(receiver: string, configuration: string) {
    const existing = this.images.get(receiver + "/" + configuration);
    return existing
      ? { status: "image" as const, ...existing }
      : { status: "unavailable" as const, fault: "absent" };
  }
  async compareAndSet(
    receiver: string,
    configuration: string,
    expectedRevision: string,
    bytes: Uint8Array,
    revision: string,
  ) {
    const key = receiver + "/" + configuration;
    if (this.images.get(key)?.revision !== expectedRevision) return { status: "conflict" as const };
    this.images.set(key, { bytes, revision });
    return { status: "durable" as const, revision };
  }
}
const grant: MaterializationSourceCapability = {
  async capture() {
    throw Error("never recaptures");
  },
  async reacquireSnapshot() {
    throw Error("never restores");
  },
  async checkCurrent(b, revision, auth) {
    return b === plant.source.binding &&
      revision === plant.source.revision &&
      auth === plant.source.authority
      ? { status: "current" }
      : { status: "source-changed" };
  },
};
const request = (verb: string, fields: Record<string, Target[]>) =>
  sign("request/1", {
    receiver: [ent(keys.receiver!)],
    configuration: [ref(configuration.id)],
    operation: [ref(op(verb).id)],
    ...fields,
  });
const resultOf = (outcome: Delta) => {
  const f = readMaterializationDescription(outcome),
    body = decode(commandBytes(f, "result")),
    status = commandText(f, "status");
  // A refusal reports its code in the status so a failing step names its category.
  return {
    status: status === "completed" ? status : status + ":" + text(field(body, "code")),
    body,
  };
};
async function host() {
  const store = new MemoryStore();
  await initializeMaterializationControl(store, keys.receiver!, configuration.id, limits);
  const endpoint = MaterializationEndpoint.boot({
    configuration,
    declarations: operations,
    bindings: [binding],
    signer: { author: keys.receiver!, sign: (claims) => signClaims(claims, seeds.receiver!) },
    sourceGrants: new Map([[binding.id, grant]]),
    controlStore: store,
    diagnostic: (fault) => {
      throw fault;
    },
  });
  const wire = (d: Delta) => ({ id: d.id, claims: claimsToJson(d.claims), sig: d.sig });
  const invoke = async (q: Delta, ...support: Delta[]) =>
    resultOf(await endpoint.invoke(q.id, [q, ...support].map(wire), 1000));
  const image = () => {
    const stored = store.images.get(keys.receiver + "/" + configuration.id)!;
    return { ...decodeMaterializationControl(stored.bytes, limits), revision: stored.revision };
  };
  return { store, endpoint, invoke, image };
}
const gatherBody = decode(hex(plant.expected.gatherBodyHex)),
  resolveBody = decode(hex(plant.expected.resolveBodyHex));

it("install, read, advance, replace, retire and restore agree with the batch oracle", async () => {
  const h = await host();
  expect(h.image().generation).toBe(0);
  const install = request("install", {
    "expected-control": [p("")],
    registration: [ref(descriptor.id)],
    capture: [ref(capture.id)],
    snapshot: [ref(snapshot.id)],
    at: [p(1000)],
    "serving-at": [p(1000)],
  });
  const installed = await h.invoke(
    install,
    descriptor,
    capture,
    snapshot,
    authority,
    ...definitions,
  );
  expect(installed.status).toBe("completed");
  expect(text(field(installed.body, "kind"))).toBe("install");
  expect(num(field(installed.body, "generation"))).toBe(1);
  const results = field(installed.body, "results");
  if (results.t !== "array") throw Error();
  expect(results.v).toHaveLength(1);
  const root = results.v[0]!;
  for (const k of ["envelope", "transport", "hview"])
    expect(bytesToHex(encode(field(root, k)))).toBe(bytesToHex(encode(field(gatherBody, k))));
  for (const k of ["value", "view"])
    expect(bytesToHex(encode(field(root, k)))).toBe(bytesToHex(encode(field(resolveBody, k))));
  expect(bytesToHex(encode(field(installed.body, "basis")))).toBe(
    bytesToHex(encode(field(gatherBody, "basis"))),
  );
  const c1 = h.image();
  expect(c1.generation).toBe(1);
  expect(text(field(installed.body, "control"))).toBe(c1.revision);
  expect(c1.revision).toBe(
    contentAddress(h.store.images.get(keys.receiver + "/" + configuration.id)!.bytes),
  );
  expect(c1.entries[0]!.registration).toBe(descriptor.id);
  expect(c1.entries[0]!.transition).toBe(text(field(installed.body, "transition")));
  expect(c1.entries[0]!.capture).toBe(capture.id);
  // Stored support: descriptor, two definitions, capture, authority, transition.
  expect(c1.deltas.size).toBe(6);

  // Stale and wrong preconditions are known refusals with the image unchanged.
  expect(
    await h.invoke(install, descriptor, capture, snapshot, authority, ...definitions),
  ).toMatchObject({
    status: "refused:precondition-failed",
  });
  const again = await h.invoke(
    request("install", {
      "expected-control": [p(c1.revision)],
      registration: [ref(descriptor.id)],
      capture: [ref(capture.id)],
      snapshot: [ref(snapshot.id)],
      at: [p(1000)],
      "serving-at": [p(1000)],
    }),
    descriptor,
    capture,
    snapshot,
    authority,
    ...definitions,
  );
  expect(text(field(again.body, "code"))).toBe("already-installed");

  const read = await h.invoke(
    request("read", {
      "expected-control": [p(c1.revision)],
      registration: [ref(descriptor.id)],
      "expected-source": [p(plant.source.revision)],
      snapshot: [ref(snapshot.id)],
      "serving-at": [p(1000)],
    }),
    snapshot,
  );
  expect(read.status).toBe("completed");
  expect(text(field(read.body, "kind"))).toBe("read");
  expect(text(field(read.body, "control"))).toBe(c1.revision);
  expect(bytesToHex(encode(field(read.body, "results")))).toBe(bytesToHex(encode(results)));
  expect(h.image().generation).toBe(1);

  const advanced = await h.invoke(
    request("advance-time", {
      "expected-control": [p(c1.revision)],
      registration: [ref(descriptor.id)],
      "expected-source": [p(plant.source.revision)],
      snapshot: [ref(snapshot.id)],
      at: [p(1500)],
      "serving-at": [p(1000)],
    }),
    snapshot,
  );
  expect(advanced.status).toBe("completed");
  const c2 = h.image();
  expect(c2.generation).toBe(2);
  expect(c2.entries[0]!.at).toBe(1500);
  expect(c2.deltas.size).toBe(6);
  expect(num(field(field(advanced.body, "basis"), "at"))).toBe(1500);

  const regress = await h.invoke(
    request("advance-time", {
      "expected-control": [p(c2.revision)],
      registration: [ref(descriptor.id)],
      "expected-source": [p(plant.source.revision)],
      snapshot: [ref(snapshot.id)],
      at: [p(1200)],
      "serving-at": [p(1000)],
    }),
    snapshot,
  );
  expect(text(field(regress.body, "code"))).toBe("time-regression");
  expect(h.image().generation).toBe(2);

  const replaced = await h.invoke(
    request("replace-source", {
      "expected-control": [p(c2.revision)],
      registration: [ref(descriptor.id)],
      "expected-source": [p(plant.source.revision)],
      capture: [ref(capture.id)],
      snapshot: [ref(snapshot.id)],
      "serving-at": [p(1000)],
    }),
    capture,
    snapshot,
    authority,
  );
  expect(replaced.status).toBe("completed");
  const c3 = h.image();
  expect(c3.generation).toBe(3);
  expect(c3.deltas.size).toBe(6);

  const retired = await h.invoke(
    request("retire", { "expected-control": [p(c3.revision)], registration: [ref(descriptor.id)] }),
  );
  expect(retired.status).toBe("completed");
  expect(text(field(retired.body, "kind"))).toBe("retire");
  const c4 = h.image();
  expect(c4.generation).toBe(4);
  expect(c4.entries[0]!.status).toBe("retired");
  expect(c4.entries[0]!.capture).toBeUndefined();
  expect(c4.deltas.size).toBe(1);

  const readRetired = await h.invoke(
    request("read", {
      "expected-control": [p(c4.revision)],
      registration: [ref(descriptor.id)],
      "expected-source": [p(plant.source.revision)],
      snapshot: [ref(snapshot.id)],
      "serving-at": [p(1000)],
    }),
    snapshot,
  );
  expect(text(field(readRetired.body, "code"))).toBe("retired");
  const restored = await h.invoke(request("restore", { "expected-control": [p(c4.revision)] }));
  expect(restored.status).toBe("completed");
  const selections = field(restored.body, "selections");
  if (selections.t !== "array") throw Error();
  expect(text(field(selections.v[0]!, "availability"))).toBe("retired");
  const reinstall = await h.invoke(
    request("install", {
      "expected-control": [p(c4.revision)],
      registration: [ref(descriptor.id)],
      capture: [ref(capture.id)],
      snapshot: [ref(snapshot.id)],
      at: [p(1000)],
      "serving-at": [p(1000)],
    }),
    descriptor,
    capture,
    snapshot,
    authority,
    ...definitions,
  );
  expect(text(field(reinstall.body, "code"))).toBe("retired");
  expect(h.image().generation).toBe(4);
});
it("the empty image restores with no selections and refuses unknown registrations", async () => {
  const h = await host();
  const restored = await h.invoke(request("restore", { "expected-control": [p("")] }));
  expect(restored.status).toBe("completed");
  expect(text(field(restored.body, "control"))).toBe("");
  const missing = await h.invoke(
    request("retire", { "expected-control": [p("")], registration: [ref(descriptor.id)] }),
  );
  expect(text(field(missing.body, "code"))).toBe("registration-missing");
  const stale = await h.invoke(
    request("restore", { "expected-control": [p(contentAddress(encode(decode(hex("a0")))))] }),
  );
  expect(text(field(stale.body, "code"))).toBe("precondition-failed");
});

// ---- Shared schedule: a fresh endpoint per step from an explicit image (vectors/lifecycle.json).
const schedule = JSON.parse(
  readFileSync(new URL("../../../vectors/materialization/lifecycle.json", import.meta.url), "utf8"),
);
const scheduleCorpusId = createHash("sha256")
  .update(readFileSync(new URL("../../../vectors/materialization/lifecycle.json", import.meta.url)))
  .digest("hex");
const scheduleBoot = {
  configuration: parseCommandDelta(schedule.boot.configuration),
  declarations: schedule.boot.declarations.map(parseCommandDelta),
  bindings: schedule.boot.bindings.map(parseCommandDelta),
};
// The grant is current exactly for the source a step names; a step may name a moved source,
// a later receive time, or no grant at all.
const scheduleGrantFor = (source: {
  binding: string;
  revision: string;
  authority: string;
}): MaterializationSourceCapability => ({
  async capture() {
    throw Error("never recaptures");
  },
  async reacquireSnapshot() {
    throw Error("never restores");
  },
  async checkCurrent(b, revision, auth) {
    return b === source.binding && revision === source.revision && auth === source.authority
      ? { status: "current" }
      : { status: "source-changed" };
  },
});
const snapshotPayloads = (delivery: unknown[]) =>
  delivery
    .map(parseCommandDelta)
    .filter((d) => JSON.stringify(scheduleKind(d)) === JSON.stringify(p("snapshot/1")))
    .map((d) => bytesToHex(commandBytes(readMaterializationDescription(d), "data")));
const scheduleKind = (d: Delta) =>
  d.claims.pointers.find((x) => x.role === MATERIALIZATION_PREFIX + "kind")?.target;
for (const step of schedule.steps)
  it(`shared lifecycle step ${step.id}`, async () => {
    const before = expect.getState().assertionCalls;
    const store = new MemoryStore();
    // A step may boot another configuration of the same receiver (limits, administrators).
    const boot = step.bootOverride
      ? {
          configuration: parseCommandDelta(step.bootOverride.configuration),
          declarations: step.bootOverride.declarations.map(parseCommandDelta),
          bindings: step.bootOverride.bindings.map(parseCommandDelta),
        }
      : scheduleBoot;
    const key = schedule.keys.receiver + "/" + boot.configuration.id;
    store.images.set(key, {
      bytes: hex(step.initialControl.hex),
      revision: step.initialControlRevision ?? step.initialControl.revision,
    });
    const source = step.source ?? schedule.source;
    const endpoint = MaterializationEndpoint.boot({
      ...boot,
      signer: {
        author: schedule.keys.receiver,
        sign: (c) => signClaims(c, schedule.seeds.receiver),
      },
      sourceGrants: step.noGrant
        ? new Map()
        : new Map([[source.binding, scheduleGrantFor(source)]]),
      controlStore: store,
      diagnostic: (fault) => {
        throw fault;
      },
    });
    const q = parseCommandDelta(step.request);
    const outcome = await endpoint.invoke(q.id, step.delivery, step.receivedAt ?? 1000);
    expect(serializeCommandDelta(outcome)).toEqual(step.expected.outcome);
    expect(
      preflightMaterializationInput(boot, q.id, step.delivery, step.receivedAt ?? 1000),
    ).toEqual(step.expected.preflight);
    const f = readMaterializationDescription(outcome);
    expect(commandText(f, "status")).toBe(step.expected.status);
    expect(bytesToHex(commandBytes(f, "result"))).toBe(step.expected.bodyHex);
    expect(bytesToHex(store.images.get(key)!.bytes)).toBe(step.expected.controlHex);
    // The image keeps captures and acts, never a snapshot payload (MR-14).
    expect(
      snapshotPayloads(step.delivery).some((payload) => step.expected.controlHex.includes(payload)),
    ).toBe(false);
    console.log(
      "materialization-m3-assertion:" +
        JSON.stringify({
          corpus: "lifecycle",
          corpusId: scheduleCorpusId,
          group: "steps",
          id: step.id,
          assertions: expect.getState().assertionCalls - before,
        }),
    );
  });

// ---- MR-20 readback of every shared step: the request, the post-CAS image and the delivered
// source pair link a completed body to a verified contextual answer; any broken link demotes it.
const scheduleDelivered = (step: (typeof schedule.steps)[number], kind: string) =>
  (step.delivery as unknown[])
    .map(parseCommandDelta)
    .find((d) => JSON.stringify(scheduleKind(d)) === JSON.stringify(p(kind)));
const installStep = schedule.steps.find((s: { id: string }) => s.id === "install");
// A read step delivers only its snapshot; its capture was delivered by the install or
// replacement that selected that snapshot.
const capturePairedWith = new Map<string, Delta>();
for (const s of schedule.steps) {
  const c = scheduleDelivered(s, "capture/1"),
    n = scheduleDelivered(s, "snapshot/1");
  if (c && n) capturePairedWith.set(n.id, c);
}
for (const step of schedule.steps)
  it(`shared lifecycle readback ${step.id}`, () => {
    const before = expect.getState().assertionCalls;
    const outcome = parseCommandDelta(step.expected.outcome);
    const q = parseCommandDelta(step.request);
    const base = {
      receiver: schedule.keys.receiver as string,
      configuration: (step.bootOverride
        ? parseCommandDelta(step.bootOverride.configuration)
        : scheduleBoot.configuration
      ).id,
      request: q.id,
      receivedAt: (step.receivedAt as number | undefined) ?? 1000,
    };
    const structure = readMaterializationResult(outcome, base);
    expect(structure.status).toBe(step.expected.status);
    expect(bytesToHex(encode(structure.body))).toBe(step.expected.bodyHex);
    expect(structure.classification).toBe("verified-structure");
    const snapshot = scheduleDelivered(step, "snapshot/1");
    const capture =
      scheduleDelivered(step, "capture/1") ?? (snapshot && capturePairedWith.get(snapshot.id));
    const full = {
      ...base,
      requestDelta: q,
      control: hex(step.expected.controlHex),
      ...(snapshot && capture ? { capture, snapshot } : {}),
    };
    if (step.expected.status === "refused") {
      const read = readMaterializationResult(outcome, { ...base, requestDelta: q });
      expect(read.classification).toBe("verified-context");
      expect(text(field(read.body, "code"))).toBe(step.expected.code);
      expect(() => readMaterializationResult(outcome, { ...base, request: outcome.id })).toThrow(
        "invalid-evidence",
      );
    } else {
      const read = readMaterializationResult(outcome, full);
      expect(read.classification).toBe("verified-context");
      expect(read.sourceCommitments).toBe(snapshot ? "commitments-verified" : "attested");
      expect(read.values === undefined).toBe(!snapshot);
      // The pre-CAS image is not the image the body names, except for the effect-free verbs.
      const stale = { ...full, control: hex(step.initialControl.hex) };
      if (step.initialControl.hex === step.expected.controlHex)
        expect(readMaterializationResult(outcome, stale).classification).toBe("verified-context");
      else expect(() => readMaterializationResult(outcome, stale)).toThrow("invalid-evidence");
      // The request must be the one the outcome names.
      const other = schedule.steps.find((s: { id: string }) => s.id !== step.id);
      expect(() =>
        readMaterializationResult(outcome, {
          ...full,
          requestDelta: parseCommandDelta(other.request),
          request: other.request.id,
        }),
      ).toThrow("invalid-evidence");
      // A body missing one root, or naming another registration, no longer reads.
      const body = decode(hex(step.expected.bodyHex));
      if (body.t === "map" && body.v.some(([k]) => k === "results")) {
        const dropped: CborValue = {
          t: "map",
          v: body.v.map(([k, x]): [string, CborValue] =>
            k === "results" && x.t === "array" ? [k, { t: "array", v: x.v.slice(1) }] : [k, x],
          ),
        };
        const forged = signClaims(
          materializationDescriptionClaims(schedule.keys.receiver, 1000, "outcome/1", {
            receiver: [ent(schedule.keys.receiver)],
            configuration: [ref(scheduleBoot.configuration.id)],
            request: [ref(q.id)],
            status: [p("completed")],
            result: [blob(encode(dropped))],
          }),
          schedule.seeds.receiver,
        );
        expect(readMaterializationResult(forged, base).classification).toBe("verified-structure");
        expect(() => readMaterializationResult(forged, full)).toThrow("invalid-evidence");
      }
    }
    console.log(
      "materialization-m3-assertion:" +
        JSON.stringify({
          corpus: "lifecycle",
          corpusId: scheduleCorpusId,
          group: "readback",
          id: step.id,
          assertions: expect.getState().assertionCalls - before,
        }),
    );
  });
it("indeterminate outcomes read as structure with their exact MR-19 shape", () => {
  const q = parseCommandDelta(installStep.request);
  const outcome = (result: CborValue) =>
    signClaims(
      materializationDescriptionClaims(schedule.keys.receiver, 1000, "outcome/1", {
        receiver: [ent(schedule.keys.receiver)],
        configuration: [ref(scheduleBoot.configuration.id)],
        request: [ref(q.id)],
        status: [p("indeterminate")],
        result: [blob(encode(result))],
      }),
      schedule.seeds.receiver,
    );
  const base = {
    receiver: schedule.keys.receiver as string,
    configuration: scheduleBoot.configuration.id,
    request: q.id,
  };
  const control = contentAddress(new Uint8Array([1]));
  const tstr = (v: string): CborValue => ({ t: "tstr", v });
  const m = (fields: [string, CborValue][]): CborValue => ({ t: "map", v: fields });
  const unconfirmed = readMaterializationResult(
    outcome(m([["code", tstr("commit-unconfirmed")]])),
    base,
  );
  expect(unconfirmed.status).toBe("indeterminate");
  expect(unconfirmed.classification).toBe("verified-structure");
  const unavailable = readMaterializationResult(
    outcome(
      m([
        ["code", tstr("result-unavailable")],
        ["control", tstr(control)],
      ]),
    ),
    { ...base, requestDelta: q },
  );
  expect(unavailable.status).toBe("indeterminate");
  expect(unavailable.classification).toBe("verified-context");
  for (const bad of [
    m([["code", tstr("result-unavailable")]]),
    m([
      ["code", tstr("commit-unconfirmed")],
      ["control", tstr(control)],
    ]),
    m([["code", tstr("write-conflict")]]),
  ])
    expect(() => readMaterializationResult(outcome(bad), base)).toThrow("invalid-evidence");
});

// A linked readback must refuse a request the selected transition did not answer: a different
// expected control, or a serving time the outcome and Basis do not carry.
it("hostile request contexts demote a linked readback", () => {
  const outcome = parseCommandDelta(installStep.expected.outcome),
    q = parseCommandDelta(installStep.request),
    f = readMaterializationDescription(q, "install"),
    control = hex(installStep.expected.controlHex),
    snapshot = scheduleDelivered(installStep, "snapshot/1")!,
    capture = scheduleDelivered(installStep, "capture/1")!;
  const resigned = (patch: Record<string, Target[]>) => {
    const fields = { ...f, ...patch };
    delete fields.kind;
    const request = signClaims(
      materializationDescriptionClaims(schedule.keys.caller, 1000, "request/1", fields),
      schedule.seeds.caller,
    );
    const of = readMaterializationDescription(outcome);
    const forged = signClaims(
      materializationDescriptionClaims(schedule.keys.receiver, 1000, "outcome/1", {
        receiver: of.receiver!,
        configuration: of.configuration!,
        request: [ref(request.id)],
        status: of.status!,
        result: of.result!,
      }),
      schedule.seeds.receiver,
    );
    return { request, forged };
  };
  const context = (request: Delta) => ({
    receiver: schedule.keys.receiver as string,
    configuration: scheduleBoot.configuration.id,
    request: request.id,
    requestDelta: request,
    receivedAt: 1000,
    control,
    capture,
    snapshot,
  });
  expect(readMaterializationResult(outcome, context(q)).classification).toBe("verified-context");
  const wrongControl = resigned({
    "expected-control": [p(contentAddress(new Uint8Array([0x12])))],
  });
  expect(() =>
    readMaterializationResult(wrongControl.forged, context(wrongControl.request)),
  ).toThrow("invalid-evidence");
  const wrongServing = resigned({ "serving-at": [p(9999)] });
  expect(() =>
    readMaterializationResult(wrongServing.forged, context(wrongServing.request)),
  ).toThrow("invalid-evidence");
});
