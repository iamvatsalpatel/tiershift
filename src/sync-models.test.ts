import { describe, expect, it } from "vitest";
import { metaFromModelsDev } from "./sync-models.js";

describe("metaFromModelsDev", () => {
  it("maps cost, limits, and capabilities", () => {
    const meta = metaFromModelsDev({
      id: "x", cost: { input: 0.2, output: 1.2 }, limit: { context: 1050000, output: 128000 },
      tool_call: true, reasoning: true, modalities: { input: ["text", "image"] }, release_date: "2026-07-09",
    });
    expect(meta).toEqual({ price: { input: 0.2, output: 1.2 }, context: 1050000, max_output: 128000, caps: ["tools", "reasoning", "vision"], release_date: "2026-07-09" });
  });
  it("leaves unknown fields unset instead of guessing", () => {
    expect(metaFromModelsDev({ id: "x" })).toEqual({});
    expect(metaFromModelsDev({ id: "x", cost: { input: 1 } })).toEqual({});
  });
});
