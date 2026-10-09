// SPEC-16 MR-14 control image codec and MR-16 planner against the shared independent oracles.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bytesToHex } from "../src/delta/hash.js";
import {
  decodeMaterializationControl,
  encodeMaterializationControl,
  emptyMaterializationControl,
  materializationAppearanceKey,
  materializationControlImage,
  materializationControlRevision,
  planMaterializationControl,
  MaterializationControlError,
  type MaterializationControlEntry,
  type MaterializationControlLimits,
} from "../src/federation/materialization-control.js";
const url = new URL("../../../vectors/materialization/control-image.json", import.meta.url);
const corpus = readFileSync(url);
const vectors = JSON.parse(corpus.toString("utf8")) as {
  keys: { receiver: string };
  configuration: string;
  limits: MaterializationControlLimits;
  positives: {
    id: string;
    imageHex: string;
    revision: string;
    expected: {
      receiver: string;
      configuration: string;
      generation: number;
      entries: MaterializationControlEntry[];
      deltaKeys: string[];
    };
  }[];
  negatives: {
    id: string;
    imageHex: string;
    code: string;
    limits?: MaterializationControlLimits;
  }[];
};
const bytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const corpusId = createHash("sha256").update(corpus).digest("hex");
function record(group: string, id: string, before: number): void {
  console.log(
    "materialization-m3-assertion:" +
      JSON.stringify({
        corpus: "control-image",
        corpusId,
        group,
        id,
        assertions: expect.getState().assertionCalls - before,
      }),
  );
}
for (const f of vectors.positives)
  it(`shared control image positive ${f.id}`, () => {
    const before = expect.getState().assertionCalls;
    const image = decodeMaterializationControl(bytes(f.imageHex), vectors.limits);
    expect(image.receiver).toBe(f.expected.receiver);
    expect(image.configuration).toBe(f.expected.configuration);
    expect(image.generation).toBe(f.expected.generation);
    expect(image.entries).toEqual(f.expected.entries);
    expect([...image.deltas.keys()]).toEqual(f.expected.deltaKeys);
    for (const [key, value] of image.deltas) expect(materializationAppearanceKey(value)).toBe(key);
    expect(bytesToHex(encodeMaterializationControl(image, vectors.limits))).toBe(f.imageHex);
    expect(materializationControlRevision(bytes(f.imageHex), image.generation)).toBe(f.revision);
    record("positives", f.id, before);
  });
for (const f of vectors.negatives)
  it(`shared control image negative ${f.id}`, () => {
    const before = expect.getState().assertionCalls;
    let code: string | undefined;
    try {
      decodeMaterializationControl(bytes(f.imageHex), f.limits ?? vectors.limits);
    } catch (e) {
      code = e instanceof MaterializationControlError ? e.code : "unexpected";
    }
    expect(code).toBe(f.code);
    record("negatives", f.id, before);
  });
it("planner derives the shared images from selections and refuses by MR-16 category", () => {
  const [, one, two] = vectors.positives;
  const oneImage = decodeMaterializationControl(bytes(one!.imageHex), vectors.limits);
  const twoImage = decodeMaterializationControl(bytes(two!.imageHex), vectors.limits);
  const active = oneImage.entries[0]!;
  const empty = emptyMaterializationControl(vectors.keys.receiver, vectors.configuration);
  expect(
    materializationControlRevision(
      encodeMaterializationControl(
        materializationControlImage(empty, vectors.limits),
        vectors.limits,
      ),
      0,
    ),
  ).toBe("");
  const install = planMaterializationControl(
    empty,
    {
      verb: "install",
      entry: { ...active, capture: active.capture! },
      transition: active.transition,
      support: oneImage.deltas,
    },
    vectors.limits,
  );
  if (install.status !== "planned") throw Error(install.code);
  expect(
    bytesToHex(
      encodeMaterializationControl(
        materializationControlImage(install.selection, vectors.limits),
        vectors.limits,
      ),
    ),
  ).toBe(one!.imageHex);
  expect(
    planMaterializationControl(
      install.selection,
      {
        verb: "install",
        entry: { ...active, capture: active.capture! },
        transition: active.transition,
        support: oneImage.deltas,
      },
      vectors.limits,
    ),
  ).toEqual({ status: "refused", code: "already-installed" });
  const retiredEntry = twoImage.entries.find((e) => e.status === "retired")!;
  expect(
    planMaterializationControl(
      install.selection,
      {
        verb: "retire",
        registration: retiredEntry.registration,
        transition: retiredEntry.transition,
        support: new Map(),
      },
      vectors.limits,
    ),
  ).toEqual({ status: "refused", code: "registration-missing" });
  expect(
    planMaterializationControl(
      install.selection,
      {
        verb: "advance-time",
        registration: active.registration,
        at: active.at - 1,
        transition: active.transition,
        support: new Map(),
        superseded: [],
      },
      vectors.limits,
    ),
  ).toEqual({ status: "refused", code: "time-regression" });
  expect(
    planMaterializationControl(
      install.selection,
      {
        verb: "install",
        entry: { ...retiredEntry, capture: active.capture! },
        transition: retiredEntry.transition,
        support: new Map(),
      },
      { ...vectors.limits, registrations: 1 },
    ),
  ).toEqual({ status: "refused", code: "resource-limit" });
  // Retirement keeps only the terminal transition act reachable for that entry.
  const retireKey = [...twoImage.deltas.keys()].find((k) => !oneImage.deltas.has(k))!;
  const second = planMaterializationControl(
    install.selection,
    {
      verb: "install",
      entry: { ...retiredEntry, capture: active.capture! },
      transition: active.transition,
      support: new Map([[retireKey, twoImage.deltas.get(retireKey)!]]),
    },
    vectors.limits,
  );
  if (second.status !== "planned") throw Error(second.code);
  const retired = planMaterializationControl(
    second.selection,
    {
      verb: "retire",
      registration: retiredEntry.registration,
      transition: retiredEntry.transition,
      support: new Map([[retireKey, twoImage.deltas.get(retireKey)!]]),
    },
    vectors.limits,
  );
  if (retired.status !== "planned") throw Error(retired.code);
  const image = materializationControlImage(retired.selection, vectors.limits);
  expect(image.generation).toBe(3);
  expect(image.entries).toEqual(twoImage.entries);
  expect(bytesToHex(encodeMaterializationControl(image, vectors.limits))).toBe(two!.imageHex);
  expect(
    planMaterializationControl(
      retired.selection,
      {
        verb: "retire",
        registration: retiredEntry.registration,
        transition: retiredEntry.transition,
        support: new Map(),
      },
      vectors.limits,
    ),
  ).toEqual({ status: "refused", code: "retired" });
});
