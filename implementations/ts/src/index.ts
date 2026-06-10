export type { Primitive, EntityRef, DeltaRef, Target, Pointer, Claims, Delta } from "./types.js";
export { encode, type CborValue, tstr, float, bool, array, map } from "./cbor.js";
export { contentAddress } from "./hash.js";
export {
  claimsToCbor,
  canonicalBytes,
  canonicalHex,
  computeId,
  assertValidClaims,
} from "./delta.js";
export { parseClaims } from "./json-profile.js";
export {
  AUTHOR_PREFIX,
  authorForSeed,
  publicKeyFromSeed,
  signClaims,
  verifyDelta,
  type Verification,
} from "./sign.js";
export { DeltaSet, federate, fork, makeDelta, makeNegationClaims, merge } from "./set.js";
export {
  comparePrimitives,
  evalPred,
  type Cmp,
  type PPred,
  type Pred,
  type StrMatch,
  type ValMatch,
} from "./pred.js";
export {
  evalTerm,
  resultCanonicalHex,
  type EvalResult,
  type MaskPolicy,
  type Term,
} from "./eval.js";
export { parsePred, parseTerm } from "./term-json.js";
