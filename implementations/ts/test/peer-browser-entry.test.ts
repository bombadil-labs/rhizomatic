import { build } from "esbuild";
import { describe, expect, it } from "vitest";

describe("typed peer API browser entry", () => {
  it("bundles the public pure API without Node file APIs", async () => {
    const result = await build({
      stdin: {
        contents: `import {
          openSinglePeer, admitSinglePeerTransfer, emptyDurablePeerState,
          encodeDurablePeerState, decodeDurablePeerState,
          planSignedLooseOrdinaryTransfer, OrdinaryJournalPeer
        } from "./src/index.ts";
        console.log(openSinglePeer, admitSinglePeerTransfer, emptyDurablePeerState,
          encodeDurablePeerState, decodeDurablePeerState, planSignedLooseOrdinaryTransfer,
          OrdinaryJournalPeer);`,
        resolveDir: process.cwd(),
        sourcefile: "peer-browser-entry.ts",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      external: ["node:http"], // Existing transport export has a separate browser stub.
    });
    const javascript = result.outputFiles[0]!.text;
    expect(javascript).not.toMatch(/node:(?:fs|crypto|path)/);
    expect(javascript).toContain("openSinglePeer");
    expect(javascript).toContain("OrdinaryJournalPeer");
  });
});
