// SPEC-16 M3: the six maintained verbs over an in-memory control store, driven by the shared
// `plant` batch fixture so every root result must equal the batch oracle byte for byte.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decode, encode, type CborValue } from "../src/delta/cbor.js";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { signClaims } from "../src/delta/sign.js";
import { claimsToJson } from "../src/delta/json-profile.js";
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
  return { status: status === "completed" ? status : status + ":" + text(field(body, "code")), body };
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
