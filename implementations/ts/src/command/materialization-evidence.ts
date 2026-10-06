// Complete supplied evidence validation. Structure/attribution do not prove gather execution.
import { encode } from "../delta/cbor.js";
import { contentAddress } from "../delta/hash.js";
import type { MaterializationLimits } from "../command-data/materialization-codec.js";
import { decodeHViewEnvelope, hviewCanonicalHex, type HView } from "../resolve/evidence.js";
import { EvidenceCodecError } from "../syntax/evidence-codec.js";
import { validateMaterializationReading, CommandProgramError } from "../schema/command-program.js";
import {
  materializationBasisProgram,
  validateMaterializationBasis,
} from "./materialization-basis.js";
import { mBytes, mFields, mText, mId, mFail, mLimit } from "./materialization-values.js";
import type { CborValue } from "../delta/cbor.js";
export function validateGatherMaterializationEvidence(
  body: CborValue,
  limits: MaterializationLimits,
) {
  const fs = mFields(body, ["kind", "root", "basis", "envelope", "transport", "hview"]);
  if (mText(fs.get("kind")) !== "gather" || !mText(fs.get("root"))) mFail();
  const envelope = mBytes(fs.get("envelope"));
  let hview: HView;
  try {
    hview = decodeHViewEnvelope(envelope, {
      artifactBytes: limits.artifactBytes,
      appearances: limits.appearances,
      entries: limits.entries,
      nodes: limits.nodes,
      depth: limits.depth,
      pointers: limits.pointers,
      buckets: limits.buckets,
      readings: limits.readings,
      syntaxDepth: limits.syntaxDepth,
      syntaxNodes: limits.syntaxNodes,
    });
  } catch (e) {
    if (e instanceof EvidenceCodecError) mFail(e.code);
    throw e;
  }
  const program = materializationBasisProgram(fs.get("basis")!, limits);
  validateMaterializationBasis(fs.get("basis")!, limits);
  const hviewBytes = Uint8Array.from(hviewCanonicalHex(hview).match(/../g)!, (h) =>
    parseInt(h, 16),
  );
  if (
    contentAddress(envelope) !== mId(fs.get("transport")) ||
    contentAddress(hviewBytes) !== mId(fs.get("hview"))
  )
    mFail();
  mLimit(encode(body).length, limits.artifactBytes);
  const check = (node: HView): void => {
    for (const entries of node.props.values())
      for (const entry of entries) {
        for (const reading of entry.readings?.values() ?? []) {
          try {
            validateMaterializationReading(reading, new Map());
          } catch (e) {
            if (e instanceof CommandProgramError) mFail(e.code);
            throw e;
          }
        }
        for (const child of entry.expanded?.values() ?? []) check(child);
      }
  };
  check(hview);
  return { fields: fs, hview, program };
}
export function materializationHasMissingReading(hview: HView): boolean {
  for (const bucket of hview.props.values())
    for (const entry of bucket)
      for (const [index, child] of entry.expanded ?? [])
        if (!entry.readings?.has(index) || materializationHasMissingReading(child)) return true;
  return false;
}
export function materializationHexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}
