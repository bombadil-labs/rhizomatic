import { describe, expect, it } from "vitest";
import { main } from "../demo/demo.js";

describe("the reference demo", () => {
  it("runs the full seven-act story without throwing", () => {
    const transcript = main();
    expect(transcript).toContain("ACT 7");
    expect(transcript).toContain("digest match: true");
    expect(transcript).toContain("Alice digest == Bob digest: true");
    expect(transcript).toContain("It compiles.");
  });
});
