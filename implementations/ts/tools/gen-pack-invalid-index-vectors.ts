/** Materialize the shared malformed pack bytes from the source recipe. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { array, decode, encode, float, map, type CborValue } from "../src/cbor.js";
import { bytesToHex } from "../src/hash.js";
import { parseClaims } from "../src/json-profile.js";
import { packSet } from "../src/pack.js";
import { DeltaSet } from "../src/set.js";

const vectors = fileURLToPath(new URL("../../../vectors/", import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(resolve(vectors, name), "utf8")) as never;
const path = resolve(vectors, "l0-pack/invalid-index.json");
const vector = read("l0-pack/invalid-index.json") as {
  cases: Array<{
    source: string;
    section: string;
    field: string;
    index: number;
    hex?: string;
  }>;
};
const principal = read("principal/evidence.json") as {
  deltas: Array<{ name: string; id: string; sig: string; claims: unknown }>;
};
for (const c of vector.cases) {
  const bytes =
    c.source === "pack.json"
      ? Buffer.from((read("l0-pack/pack.json") as { packHex: string }).packHex, "hex")
      : packSet(
          DeltaSet.from(
            principal.deltas
              .filter((d) => d.name === "userRootDeclaration")
              .map((d) => ({ id: d.id, sig: d.sig, claims: parseClaims(d.claims) })),
          ),
        );
  const top = decode(bytes);
  if (top.t !== "map") throw new Error("expected pack map");
  let changed = false;
  const fields: Array<[string, CborValue]> = top.v.map(([key, value]) => {
    if (key !== c.section || value.t !== "array") return [key, value];
    const records = value.v.map((record) => {
      if (changed || record.t !== "map" || !record.v.some(([field]) => field === c.field))
        return record;
      changed = true;
      return map(
        record.v.map(([field, item]) => [field, field === c.field ? float(c.index) : item]),
      );
    });
    return [key, array(records)];
  });
  if (!changed) throw new Error(`missing ${c.section}.${c.field}`);
  c.hex = bytesToHex(encode(map(fields)));
}
writeFileSync(path, JSON.stringify(vector, null, 2) + "\n");
