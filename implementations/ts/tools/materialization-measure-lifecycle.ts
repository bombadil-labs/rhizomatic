// M4 lifecycle measurement host, bundled with a counting insertion in the exact real signature
// verifier. Each step boots a fresh endpoint over an in-memory store seeded with the step's
// stored image, so every phase is a cold restart from durable bytes. Outcomes and images must
// equal the fixture's goldens; no timing assertion, alternate verifier or production hook.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import * as sign from "../src/delta/sign.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import {
  parseCommandDelta,
  serializeCommandDelta,
  commandBytes,
} from "../src/command-data/codec.js";
import { readMaterializationDescription } from "../src/command-data/materialization-codec.js";
import type { MaterializationSourceCapability } from "../src/federation/materialization-source.js";
import type { MaterializationControlStore } from "../src/index.js";
import { canonicalBytes } from "../src/delta/delta.js";
import { bytesToHex } from "../src/delta/hash.js";
const counter = sign as unknown as { measurementReset(): void; measurementCount(): number };
const f = JSON.parse(readFileSync(0, "utf8"));
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const signedBytes = (d: ReturnType<typeof parseCommandDelta>) =>
  canonicalBytes(d.claims).length + (d.sig ? 64 : 0);
async function timed<T>(operation: () => T | Promise<T>) {
  counter.measurementReset();
  const start = performance.now();
  const answer = await operation();
  return {
    answer,
    cost: {
      wallMs: performance.now() - start,
      strictSignatureVerifications: counter.measurementCount(),
    },
  };
}
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
const boot = {
  configuration: parseCommandDelta(f.boot.configuration),
  declarations: f.boot.declarations.map(parseCommandDelta),
  bindings: f.boot.bindings.map(parseCommandDelta),
};
const key = f.keys.receiver + "/" + boot.configuration.id;
const steps = [];
for (const step of f.steps) {
  const store = new MemoryStore();
  store.images.set(key, {
    bytes: hex(step.initialControl.hex),
    revision: step.initialControl.revision,
  });
  let checks = 0;
  const grant: MaterializationSourceCapability = {
    async capture() {
      throw Error("the measured lifecycle never recaptures");
    },
    async reacquireSnapshot() {
      throw Error("the measured lifecycle never reacquires");
    },
    async checkCurrent(binding, revision, authority) {
      checks++;
      return binding === step.source.binding &&
        revision === step.source.revision &&
        authority === step.source.authority
        ? { status: "current" }
        : { status: "source-changed" };
    },
  };
  const booted = await timed(() =>
    MaterializationEndpoint.boot({
      ...boot,
      signer: {
        author: f.keys.receiver,
        sign: (claims) => sign.signClaims(claims, f.seeds.receiver),
      },
      sourceGrants: new Map([[step.source.binding, grant]]),
      controlStore: store,
      diagnostic: (e) => {
        throw e;
      },
    }),
  );
  const q = parseCommandDelta(step.request);
  const ran = await timed(() => booted.answer.invoke(q.id, step.delivery, 1000));
  assert.deepEqual(serializeCommandDelta(ran.answer), step.expected.outcome, step.id);
  const after = store.images.get(key)!.bytes;
  assert.equal(bytesToHex(after), step.expected.controlHex, step.id);
  steps.push({
    phase: step.phase,
    id: step.id,
    status: step.expected.status,
    lengths: {
      delivery: step.delivery.reduce(
        (n: number, d: unknown) => n + signedBytes(parseCommandDelta(d)),
        0,
      ),
      controlBefore: step.initialControl.hex.length / 2,
      controlAfter: after.length,
      result: commandBytes(readMaterializationDescription(ran.answer), "result").length,
    },
    phases: { boot: booted.cost, [step.phase]: ran.cost },
    currentChecks: checks,
  });
}
console.log(
  JSON.stringify({
    witness: "ts",
    id: f.id,
    selectedAppearances: f.selectedAppearances,
    status: f.expectedStatus,
    steps,
    peakRssKiB: process.resourceUsage().maxRSS,
  }),
);
