import { computeId } from "../src/delta/delta.js";
import { authorForSeed, signClaims } from "../src/delta/sign.js";
import type { Claims, Delta } from "../src/delta/types.js";
import type { ImportedHoldings } from "../src/federation/imported-holdings.js";
import type { RefusalSnapshot } from "../src/federation/refusal-snapshot.js";
import { makeManifestClaims } from "../src/reactor/reactor.js";

const seed = "01".repeat(32);
const author = authorForSeed(seed);

function claims(label: string, timestamp: number, validFrom: number): Claims {
  return {
    timestamp,
    validFrom,
    author,
    pointers: [{ role: "note", target: { kind: "primitive", value: label } }],
  };
}

export const signed = signClaims(claims("signed", 1, 100), seed);
export const unsigned: Delta = {
  claims: claims("unsigned", 2, 2),
  id: computeId(claims("unsigned", 2, 2)),
};
export const cover = signClaims(makeManifestClaims(author, 3, [unsigned.id]), seed);
export const emptySnapshot: RefusalSnapshot = { events: [], current: [] };
export const refusedSnapshot: RefusalSnapshot = {
  events: [
    {
      sourcePeerId: "peer-old",
      sequence: 1,
      targetId: signed.id,
      orderIds: [`1e20${"c".repeat(64)}`],
    },
  ],
  current: [{ sourcePeerId: "peer-old", sequence: 1, targetId: signed.id }],
};

export function importedCase(names: readonly string[], hasCover: boolean): ImportedHoldings {
  return {
    holdings: names.map((name) => {
      if (name === "signed") return signed;
      if (name === "unsigned") return unsigned;
      throw new Error(`unknown holding ${name}`);
    }),
    covers: hasCover ? [cover] : [],
  };
}

export function invalidCase(mutation: string): {
  imported: ImportedHoldings;
  snapshot: RefusalSnapshot;
} {
  switch (mutation) {
    case "duplicate-holding":
      return { imported: { holdings: [signed, signed], covers: [] }, snapshot: emptySnapshot };
    case "forged-signature":
      return {
        imported: { holdings: [{ ...signed, sig: "00".repeat(64) }], covers: [] },
        snapshot: emptySnapshot,
      };
    case "forged-id":
      return {
        imported: { holdings: [{ ...signed, id: `1e20${"0".repeat(64)}` }], covers: [] },
        snapshot: emptySnapshot,
      };
    case "unsigned-uncovered":
      return { imported: { holdings: [unsigned], covers: [] }, snapshot: emptySnapshot };
    case "forged-cover":
      return {
        imported: { holdings: [unsigned], covers: [{ ...cover, sig: "00".repeat(64) }] },
        snapshot: emptySnapshot,
      };
    case "wrong-cover-author":
      return {
        imported: {
          holdings: [unsigned],
          covers: [
            signClaims(
              makeManifestClaims(authorForSeed("02".repeat(32)), 3, [unsigned.id]),
              "02".repeat(32),
            ),
          ],
        },
        snapshot: emptySnapshot,
      };
    case "refused-holding":
      return { imported: { holdings: [signed], covers: [] }, snapshot: refusedSnapshot };
    default:
      throw new Error(`unknown mutation ${mutation}`);
  }
}
