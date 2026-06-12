import { describe, expect, it } from "vitest";
import { main } from "../chorus/demo.js";

describe("the chorus demo", () => {
  it("walks the whole thesis end-to-end, deterministically", () => {
    const transcript = main();
    expect(transcript).toContain("ACT 7");
    expect(transcript).toContain("the next session starts where the last one stopped");
    expect(transcript).toContain('superposition at hub: {"healthy":[true,false]}');
    expect(transcript).toContain("replay-verified: true");
    expect(transcript).toContain("basis verified byte-for-byte: true");
    expect(transcript).toContain("the now-retracted claim still counts THEN");
    expect(transcript).toContain('after:  svc:db {"healthy":true}');
    expect(transcript).toContain(
      'ask in A\'s dialect about bob (B\'s data): {"job":"company:initech"}',
    );
    // Determinism: the transcript is identical on a second run (fresh agents, fixed clocks).
    expect(main()).toBe(transcript);
  });
});
