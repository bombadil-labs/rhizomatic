// Regenerate malformed private-image bytes used by both peer-state decoders.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  array,
  bool,
  bstr,
  decode,
  encode,
  float,
  map,
  tstr,
  type CborValue,
} from "../src/cbor.js";

const root = resolve(import.meta.dirname, "../../..");
const state = JSON.parse(readFileSync(resolve(root, "vectors/peer/state.json"), "utf8")) as {
  cases: Array<{ expectedHex: string }>;
};
const fixture = JSON.parse(
  readFileSync(resolve(root, "vectors/principal/evidence.json"), "utf8"),
) as {
  deltas: Array<{ id: string }>;
};
const path = resolve(root, "vectors/peer/state-invalid.json");
const vector = JSON.parse(readFileSync(path, "utf8")) as {
  cases: Array<{ mutation: string; hex: string }>;
};
const base = Buffer.from(state.cases[0]!.expectedHex, "hex");
const top = decode(base);
if (top.t !== "map") throw new Error("expected map");
const replace = (key: string, value: CborValue): Uint8Array =>
  encode(map(top.v.map(([name, current]) => [name, name === key ? value : current])));
const ids = fixture.deltas
  .slice(0, 2)
  .map((d) => d.id)
  .sort();

for (const c of vector.cases) {
  let bytes: Uint8Array;
  switch (c.mutation) {
    case "wrongPeer":
      bytes = base;
      break;
    case "version":
      bytes = replace("version", float(2));
      break;
    case "extraField":
      bytes = encode(map([...top.v, ["extra", bool(true)]]));
      break;
    case "badPack":
      bytes = replace("pack", bstr(Uint8Array.of(0xff)));
      break;
    case "duplicateRefusal":
      bytes = replace("refused", array([tstr(ids[0]!), tstr(ids[0]!)]));
      break;
    case "unsortedRefusals":
      bytes = replace("refused", array(ids.reverse().map(tstr)));
      break;
    case "junkRefusal":
      bytes = replace("refused", array([tstr("x")]));
      break;
    case "trailing":
      bytes = Uint8Array.from([...base, 0]);
      break;
    default:
      throw new Error(`unknown mutation ${c.mutation}`);
  }
  c.hex = Buffer.from(bytes).toString("hex");
}
writeFileSync(path, `${JSON.stringify(vector, null, 2)}\n`);
