// Easter egg (issue #7): a real image lives in the rhizome as a bytes delta. The mirror of
// ../../rust/tests/bytes_easter_egg.rs — both witnesses assert the SAME pinned content address,
// so the easter egg doubles as a cross-witness parity check.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalHex, computeId } from "../src/delta.js";
import { claimsToJson, parseClaims } from "../src/json-profile.js";
import type { Claims } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const bonzo = new Uint8Array(readFileSync(resolve(here, "../../../vectors/assets/bonzo.png")));

// bonzo's canonical content address — pinned identically in the Rust witness.
const BONZO_ID = "1e20d1a6dc435727435c822a76c5d23ae8235e5aa6c2bf3100b7b5a9434e362601d3";

const bonzoClaims = (): Claims => ({
  timestamp: 0,
  author: "bonzo",
  pointers: [{ role: "avatar", target: { kind: "bytes", mime: "image/png", value: bonzo } }],
});

describe("a real image lives in the rhizome as a bytes delta (issue #7)", () => {
  it("resolves to the pinned cross-witness content address", () => {
    expect(computeId(bonzoClaims())).toBe(BONZO_ID);
  });

  it("round-trips JSON(base64url) losslessly to the same id", () => {
    const claims = bonzoClaims();
    const reparsed = parseClaims(claimsToJson(claims));
    expect(canonicalHex(reparsed)).toBe(canonicalHex(claims));
    expect(computeId(reparsed)).toBe(BONZO_ID);
  });
});
