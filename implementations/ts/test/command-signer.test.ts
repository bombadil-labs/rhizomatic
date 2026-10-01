import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { CommandEndpoint, type CommandBoot, type CommandSigner } from "../src/command/endpoint.js";
import {
  commandDescriptionClaims,
  commandFields,
  parseCommandDelta,
  serializeCommandDelta,
  writeCommandDescription,
  readOutcome,
  verifyCommandAppearance,
} from "../src/command-data/codec.js";
import { signClaims, authorForSeed } from "../src/delta/sign.js";
import { OrdinaryJournalPeer } from "../src/federation/ordinary-journal-peer.js";
import { CommandFixtureStore } from "../tools/command-store.js";
import type { Claims } from "../src/delta/types.js";
const vectors = JSON.parse(
  readFileSync(new URL("../../../vectors/command/execution.json", import.meta.url), "utf8"),
);
const context = vectors.cases[0].context;
const request = parseCommandDelta(vectors.fixtures.request);
const payload = parseCommandDelta(vectors.fixtures.first);
const receiver = authorForSeed(context.receiverSeed);
const invoke = (endpoint: CommandEndpoint) =>
  endpoint.invoke(request.id, [request, payload].map(serializeCommandDelta));
const capability = (): CommandSigner => ({
  author: receiver,
  sign: (claims) => signClaims(claims, context.receiverSeed),
});
async function fixture(
  body: (store: CommandFixtureStore, boot: Omit<CommandBoot, "seed" | "signer">) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "command-signer-"));
  try {
    const store = new CommandFixtureStore(join(dir, "journal.json"));
    await body(store, {
      configuration: parseCommandDelta(context.boot.configuration),
      declarations: context.boot.declarations.map(parseCommandDelta),
      store,
      clock: () => 10,
      diagnostic: () => {},
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function held(store: CommandFixtureStore) {
  const opened = await OrdinaryJournalPeer.open(store, receiver);
  if (opened.status !== "open") throw Error(opened.status);
  return opened.peer.availableDeltas();
}
describe("explicit command signing capability", () => {
  it("constructs unsigned claims matching existing seed-writer bytes and signature", () => {
    const fields = commandFields(request);
    const claims = commandDescriptionClaims(
      request.claims.author,
      request.claims.timestamp,
      "request/1",
      fields,
    );
    expect(claims).toEqual(request.claims);
    expect(signClaims(claims, context.callerSeed)).toEqual(
      writeCommandDescription(context.callerSeed, request.claims.timestamp, "request/1", fields),
    );
    expect(signClaims(claims, context.callerSeed)).toEqual(request);
    expect(() => commandDescriptionClaims("not-a-key", 10, "request/1", fields)).toThrow();
  });
  it("uses a seedless signer and snapshots its author and method at boot", async () =>
    fixture(async (store, boot) => {
      const signer = { ...capability() };
      const endpoint = await CommandEndpoint.boot({ ...boot, signer });
      signer.author = authorForSeed(context.callerSeed);
      signer.sign = () => {
        throw Error("replacement must not run");
      };
      const result = await invoke(endpoint);
      expect(result.claims.author).toBe(receiver);
      expect(readOutcome(result).status).toBe("completed");
      expect([...(await held(store)).ids()]).toEqual([payload.id]);
    }));
  it("snapshots accessor-backed testimony before validation and delivery", async () =>
    fixture(async (store, boot) => {
      let idReads = 0;
      let signedId = "";
      const endpoint = await CommandEndpoint.boot({
        ...boot,
        signer: {
          author: receiver,
          sign: (claims) => {
            const delta = signClaims(claims, context.receiverSeed);
            signedId = delta.id;
            return {
              ...delta,
              get id() {
                return ++idReads <= 3 ? delta.id : "1e20" + "00".repeat(32);
              },
            };
          },
        },
      });
      const result = await invoke(endpoint);
      expect(idReads).toBe(1);
      expect(result.id).toBe(signedId);
      expect(() => verifyCommandAppearance(result)).not.toThrow();
      expect(readOutcome(result).status).toBe("completed");
      expect([...(await held(store)).ids()]).toEqual([payload.id]);
    }));
  it("refuses missing, ambiguous or wrong-author signing selections before journal initialization", async () =>
    fixture(async (store, boot) => {
      for (const selection of [
        {},
        { seed: context.receiverSeed, signer: capability() },
        { seed: 123, signer: capability() },
        { signer: { ...capability(), author: authorForSeed(context.callerSeed) } },
      ]) {
        await expect(
          CommandEndpoint.boot({ ...boot, ...selection } as CommandBoot),
        ).rejects.toThrow();
        expect((await store.readJournal()).status).toBe("empty");
      }
    }));
  for (const [name, sign] of [
    [
      "wrong author",
      (claims: Claims) =>
        signClaims({ ...claims, author: authorForSeed(context.callerSeed) }, context.callerSeed),
    ],
    [
      "changed timestamp",
      (claims: Claims) =>
        signClaims({ ...claims, timestamp: 11, validFrom: 11 }, context.receiverSeed),
    ],
    [
      "changed pointer order",
      (claims: Claims) =>
        signClaims({ ...claims, pointers: [...claims.pointers].reverse() }, context.receiverSeed),
    ],
    [
      "mutated supplied claims",
      (claims: Claims) => {
        (claims as { timestamp: number }).timestamp = 11;
        return signClaims(claims, context.receiverSeed);
      },
    ],
    [
      "invalid signature",
      (claims: Claims) => ({ ...signClaims(claims, context.receiverSeed), sig: "00".repeat(64) }),
    ],
  ] as const)
    it(`rejects ${name} testimony as a host fault after the durable retain`, async () =>
      fixture(async (store, boot) => {
        const endpoint = await CommandEndpoint.boot({
          ...boot,
          signer: { author: receiver, sign },
        });
        await expect(invoke(endpoint)).rejects.toThrow();
        expect([...(await held(store)).ids()]).toEqual([payload.id]);
        const retry = await CommandEndpoint.boot({ ...boot, signer: capability() });
        const result = readOutcome(await invoke(retry));
        expect(result.status).toBe("completed");
        expect(result.body.get("duplicate")).toMatchObject({
          t: "array",
          v: [{ t: "tstr", v: payload.id }],
        });
      }));
  it("propagates a signing failure after commit and preserves refusal signing failures", async () =>
    fixture(async (store, boot) => {
      const signer = {
        author: receiver,
        sign: () => {
          throw Error("signing unavailable");
        },
      };
      const endpoint = await CommandEndpoint.boot({ ...boot, signer });
      await expect(invoke(endpoint)).rejects.toThrow("signing unavailable");
      expect([...(await held(store)).ids()]).toEqual([payload.id]);
      await expect(endpoint.invoke(request.id, [])).rejects.toThrow("signing unavailable");
    }));
});
