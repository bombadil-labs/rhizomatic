import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CommandEndpoint } from "../src/command/endpoint.js";
import { MaterializationEndpoint } from "../src/command/materialization-endpoint.js";
import { CommandFixtureStore } from "../tools/command-store.js";
import { OrdinaryJournalPeer } from "../src/federation/ordinary-journal-peer.js";
import {
  parseCommandDelta,
  serializeCommandDelta,
  commandDescriptionClaims,
  commandRef,
  commandFields,
  readOutcome,
} from "../src/command-data/codec.js";
import { signClaims, authorForSeed } from "../src/delta/sign.js";
const v = JSON.parse(
  readFileSync(new URL("../../../vectors/materialization/commands.json", import.meta.url), "utf8"),
);
const old = JSON.parse(
  readFileSync(new URL("../../../vectors/command/execution.json", import.meta.url), "utf8"),
);
it("cmd_inert_retention::batch actual profile1 journal preserves native catalogs and grants", async () => {
  const c = old.cases[0].context,
    dir = mkdtempSync(join(tmpdir(), "materialization-inert-"));
  try {
    const store = new CommandFixtureStore(join(dir, "journal.json"));
    const legacy = await CommandEndpoint.boot({
      seed: c.receiverSeed,
      configuration: parseCommandDelta(c.boot.configuration),
      declarations: c.boot.declarations.map(parseCommandDelta),
      store,
      clock: () => 1000,
      diagnostic: (e) => {
        throw e;
      },
    });
    const materialization = MaterializationEndpoint.boot({
      configuration: parseCommandDelta(v.boot.configuration),
      declarations: v.boot.declarations.map(parseCommandDelta),
      bindings: v.boot.bindings.map(parseCommandDelta),
      signer: { author: v.keys.receiver, sign: (claims) => signClaims(claims, v.seeds.receiver) },
      sourceGrants: new Map(),
      diagnostic: (e) => {
        throw e;
      },
    });
    const before = materialization.catalog().digest(),
      legacyBefore = legacy.catalog().digest();
    const retain = parseCommandDelta(old.fixtures.inertRequest),
      fields = commandFields(retain);
    const refs = v.retention.map((d: { id: string }) => ({
      kind: "delta" as const,
      deltaRef: { delta: d.id },
    }));
    const request = signClaims(
      commandDescriptionClaims(authorForSeed(c.callerSeed), 1000, "request/1", {
        receiver: [{ kind: "entity", entity: { id: authorForSeed(c.receiverSeed) } }],
        configuration: [
          { kind: "delta", deltaRef: { delta: commandRef(fields, "configuration") } },
        ],
        operation: [{ kind: "delta", deltaRef: { delta: commandRef(fields, "operation") } }],
        payload: refs,
      }),
      c.callerSeed,
    );
    const retained = readOutcome(
      await legacy.invoke(request.id, [serializeCommandDelta(request), ...v.retention]),
    );
    expect(retained.status).toBe("completed");
    const opened = await OrdinaryJournalPeer.open(store, authorForSeed(c.receiverSeed));
    if (opened.status !== "open") throw Error("journal");
    expect(
      v.retention.every((d: { id: string }) => opened.peer.snapshot().base.admitted.has(d.id)),
    ).toBe(true);
    expect(legacy.catalog().digest()).toBe(legacyBefore);
    expect(materialization.catalog().digest()).toBe(before);
    const f = v.positives.find((f: { id: string }) => f.id === "plant");
    expect(
      serializeCommandDelta(await materialization.invoke(f.request.id, f.delivery, 1000)),
    ).toEqual(v.negatives.find((f: { id: string }) => f.id === "absent_grant").expected.outcome);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
