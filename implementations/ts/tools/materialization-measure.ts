// Measurement host bundled with a counting insertion in the exact real signature verifier.
// No timing assertion, alternate verifier, production hook or changed semantic expectation.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import * as sign from "../src/delta/sign.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import { readMaterializationResult } from "../src/command/materialization-result.js";
import {
  parseCommandDelta,
  serializeCommandDelta,
  commandBytes,
} from "../src/command-data/codec.js";
import { readMaterializationDescription } from "../src/command-data/materialization-codec.js";
import {
  decodeMaterializationSnapshot,
  validateMaterializationCaptureBasis,
  type MaterializationSourceCapability,
} from "../src/federation/materialization-source.js";
import { DeltaSet } from "../src/delta/set.js";
import { encode } from "../src/delta/cbor.js";
import { bytesToHex } from "../src/delta/hash.js";
const counter = sign as unknown as { measurementReset(): void; measurementCount(): number };
const input = JSON.parse(readFileSync(0, "utf8")),
  f = input.fixture;
const phases: Record<string, unknown> = {};
async function phase<T>(name: string, operation: () => T | Promise<T>): Promise<T> {
  counter.measurementReset();
  const start = performance.now();
  const answer = await operation();
  phases[name] = {
    wallMs: performance.now() - start,
    strictSignatureVerifications: counter.measurementCount(),
  };
  return answer;
}
const q = parseCommandDelta(f.request),
  capture = parseCommandDelta(f.capture),
  snapshot = parseCommandDelta(f.snapshot),
  snapshotBytes = commandBytes(readMaterializationDescription(snapshot), "data"),
  authority = parseCommandDelta(
    f.delivery.find((d: { id: string }) => d.id === f.source.authority),
  );
const rows = DeltaSet.from(f.rows.map(parseCommandDelta));
let calls = 0;
const grant: MaterializationSourceCapability = {
  async capture(binding, at, cutoff) {
    assert.equal(binding, f.source.binding);
    assert.equal(at, 1000);
    assert.equal(cutoff, undefined);
    // Native fixture acquisition returns the original frozen artifacts, after revalidating the full basis.
    for (const d of [capture, snapshot, authority])
      assert.equal(sign.verifyCanonicalDelta(d), "verified");
    if (input.selectedAppearances <= 4096) {
      const s = decodeMaterializationSnapshot(snapshotBytes);
      assert.equal(DeltaSet.from(s.deltas).digest(), rows.digest());
      validateMaterializationCaptureBasis(
        commandBytes(readMaterializationDescription(capture), "basis"),
        snapshotBytes,
      );
    }
    return { status: "captured", capture, snapshot, authority };
  },
  async reacquireSnapshot() {
    throw Error("M2 batch never restores");
  },
  async checkCurrent(binding, revision, authorityId, at, cutoff, support) {
    calls++;
    assert.equal(binding, f.source.binding);
    assert.equal(revision, f.source.revision);
    assert.equal(authorityId, f.source.authority);
    assert.equal(at, 1000);
    assert.equal(cutoff, undefined);
    assert.deepEqual(support, f.source.requiredSupport);
    return { status: "current" };
  },
};
await phase("capture-fixture-host", () => grant.capture(f.source.binding, 1000));
const boot = {
  configuration: parseCommandDelta(f.boot.configuration),
  declarations: f.boot.declarations.map(parseCommandDelta),
  bindings: f.boot.bindings.map(parseCommandDelta),
};
const endpoint = await phase("boot", () =>
  MaterializationEndpoint.boot({
    ...boot,
    signer: {
      author: sign.authorForSeed(f.seeds.receiver),
      sign: (claims) => sign.signClaims(claims, f.seeds.receiver),
    },
    sourceGrants: new Map([[f.source.binding, grant]]),
    diagnostic: (e) => {
      throw e;
    },
  }),
);
const gathered = await phase("gather", () => endpoint.invoke(q.id, f.delivery, 1000));
assert.deepEqual(serializeCommandDelta(gathered), f.expected.gather);
const context = {
  receiver: sign.authorForSeed(f.seeds.receiver),
  configuration: boot.configuration.id,
  request: q.id,
  requestDelta: q,
  receivedAt: 1000,
};
const read = await phase("gather-readback", () =>
  readMaterializationResult(gathered, { ...context, capture, snapshot }),
);
const lengths: Record<string, number> = {
  snapshot: snapshotBytes.length,
  capture: encodeCapture(capture),
  snapshotCarrier: encodeCapture(snapshot),
  delivery: f.delivery.reduce(
    (n: number, d: unknown) => n + encodeCapture(parseCommandDelta(d)),
    0,
  ),
  gatherResult: commandBytes(readMaterializationDescription(gathered), "result").length,
};
if (input.expectedStatus === "completed") {
  assert.equal(read.status, "completed");
  assert.equal(bytesToHex(encode(read.body)), f.expected.gatherBodyHex);
  if (read.body.t !== "map") throw Error();
  const envelope = read.body.v.find(([k]) => k === "envelope")![1];
  if (envelope.t !== "bstr") throw Error();
  lengths.envelope = envelope.v.length;
  const rq = parseCommandDelta(f.resolve);
  const resolved = await phase("resolve", () => endpoint.invoke(rq.id, f.resolveDelivery, 1000));
  assert.deepEqual(serializeCommandDelta(resolved), f.expected.resolve);
  const result = await phase("resolve-readback", () =>
    readMaterializationResult(resolved, {
      ...context,
      request: rq.id,
      requestDelta: rq,
      evidence: parseCommandDelta(f.resolveDelivery[1]),
      capture,
      snapshot,
    }),
  );
  assert.equal(bytesToHex(encode(result.body)), f.expected.resolveBodyHex);
  lengths.resolveResult = commandBytes(readMaterializationDescription(resolved), "result").length;
} else assert.equal(read.status, "refused");
function encodeCapture(d: ReturnType<typeof parseCommandDelta>): number {
  return signBytes(d.claims).length + (d.sig ? 64 : 0);
}
import { canonicalBytes as signBytes } from "../src/delta/delta.js";
console.log(
  JSON.stringify({
    witness: "ts",
    id: f.id,
    selectedAppearances: input.selectedAppearances,
    status: read.status,
    lengths,
    phases,
    currentChecks: calls,
    peakRssKiB: process.resourceUsage().maxRSS,
    nativeCapture:
      "Fixture-native validation/acquisition of original full artifacts; no Loam I/O, generic capturer, fresh-signing or M3 restore claimed.",
  }),
);
