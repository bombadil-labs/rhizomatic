/** Pin canonical old-peer prepared claims and their detached Ed25519 signatures. */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes } from "@noble/hashes/utils";
import { bstr, decode, encode, float, map, tstr, type CborValue } from "../src/delta/cbor.js";
import { authorForSeed } from "../src/delta/sign.js";
import { decodeClosedImportState } from "../src/federation/closed-import.js";
import {
  encodePreparedHandoffClaim,
  preparedDescriptorFromStage,
  signPreparedHandoff,
} from "../src/federation/prepared-handoff.js";

const oldSeedHex = "01".repeat(32);
const newSeedHex = "02".repeat(32);
const file = fileURLToPath(new URL("../../../vectors/peer/prepared-handoff.json", import.meta.url));
const closed = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../vectors/peer/closed-import.json", import.meta.url)),
    "utf8",
  ),
) as { cases: Array<{ expectedHex: string }> };
const cases = [
  { name: "empty prepared surface", baseCase: 0, surfaceId: "pool-empty" },
  { name: "active debt prepared surface", baseCase: 2, surfaceId: "pool-x" },
].map((c) => {
  const stage = decodeClosedImportState(
    Buffer.from(closed.cases[c.baseCase]!.expectedHex, "hex"),
    "peer-new",
  );
  const bound = {
    ...stage,
    oldPeerId: authorForSeed(oldSeedHex),
    closed: {
      ...stage.closed,
      local: {
        ...stage.closed.local,
        base: { ...stage.closed.local.base, peerId: authorForSeed(newSeedHex) },
      },
    },
  };
  const descriptor = preparedDescriptorFromStage(bound, c.surfaceId);
  return {
    ...c,
    descriptor,
    expectedClaimHex: Buffer.from(encodePreparedHandoffClaim(descriptor)).toString("hex"),
    expectedSignedHex: Buffer.from(signPreparedHandoff(descriptor, oldSeedHex)).toString("hex"),
  };
});

function signedWrongClaim(field: "domain" | "version"): string {
  const value = decode(Buffer.from(cases[0]!.expectedClaimHex, "hex"));
  if (value.t !== "map") throw new Error("prepared fixture is not a map");
  const claim = encode(
    map(
      value.v.map(([key, item]): [string, CborValue] => [
        key,
        key === field
          ? field === "domain"
            ? tstr("rhizomatic.peer.handoff.commit.v1")
            : float(2)
          : item,
      ]),
    ),
  );
  const signature = ed25519.sign(claim, hexToBytes(oldSeedHex));
  return Buffer.from(
    encode(
      map([
        ["claim", bstr(claim)],
        ["signature", bstr(signature)],
      ]),
    ),
  ).toString("hex");
}

writeFileSync(
  file,
  JSON.stringify(
    {
      spec: "SPEC-6 vNext §1 old-peer prepared handoff attestation v1",
      description:
        "Canonical domain-separated old-peer signature over the complete prepared descriptor. This is not durable commit proof.",
      oldSeedHex,
      newSeedHex,
      cases,
      invalidCases: [
        { name: "attempt substitution", mutation: "attempt" },
        { name: "surface substitution", mutation: "surface" },
        { name: "old version substitution", mutation: "old-version" },
        { name: "deadline substitution", mutation: "deadline" },
        { name: "new peer substitution", mutation: "new-peer" },
        { name: "refusal digest substitution", mutation: "refusal-digest" },
        { name: "carried digest substitution", mutation: "carried-digest" },
        { name: "policy digest substitution", mutation: "policy-digest" },
        { name: "old peer substitution", mutation: "old-peer" },
        { name: "invalid signature", mutation: "signature" },
        { name: "wrong signing seed", mutation: "wrong-seed" },
        { name: "changed staged policy", mutation: "stage-policy" },
      ],
      invalidImages: [
        {
          name: "valid old-key signature under wrong handoff domain",
          expectedHex: signedWrongClaim("domain"),
          expected: "wrong domain or version",
        },
        {
          name: "valid old-key signature under wrong claim version",
          expectedHex: signedWrongClaim("version"),
          expected: "wrong domain or version",
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
