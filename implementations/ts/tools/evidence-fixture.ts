// Fresh-process JSON transport adapter; all runtime effects belong to this test host.
import { readFileSync } from "node:fs";
import {
  encodeHViewEnvelope,
  decodeHViewEnvelope,
  type HViewEnvelopeLimits,
} from "../src/algebra/hview-envelope.js";
import { hviewCanonicalHex } from "../src/algebra/hview.js";
import { bytesToHex, contentAddress } from "../src/delta/hash.js";
import { EvidenceCodecError } from "../src/syntax/evidence-codec.js";
import { parseSchema } from "../src/syntax/term-json.js";
import { resolveView, viewCanonicalHex } from "../src/resolve-kernel/resolution.js";
import { fixtureView, inspectView } from "../test/support/evidence-fixture.js";
const input = JSON.parse(readFileSync(0, "utf8")) as {
  mode: "encode" | "decode";
  native: unknown;
  envelopeHex: string;
  limits?: Partial<HViewEnvelopeLimits>;
};
try {
  const native =
    input.mode === "encode"
      ? fixtureView(input.native)
      : decodeHViewEnvelope(Uint8Array.from(Buffer.from(input.envelopeHex, "hex")), input.limits);
  const bytes = encodeHViewEnvelope(native, input.limits);
  let resolution: unknown;
  try {
    resolution = {
      status: "resolved",
      viewHex: viewCanonicalHex(
        resolveView(parseSchema({ props: {}, default: { pick: { order: "lexById" } } }), native),
      ),
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("reading"))
      resolution = { status: "missing-reading" };
    else resolution = { status: "native-refusal" };
  }
  process.stdout.write(
    JSON.stringify({
      envelopeHex: bytesToHex(bytes),
      transportId: contentAddress(bytes),
      existingHViewHex: hviewCanonicalHex(native),
      native: inspectView(native),
      resolution,
    }),
  );
} catch (error) {
  if (!(error instanceof EvidenceCodecError)) throw error;
  process.stdout.write(JSON.stringify({ error: error.code }));
}
