import { describe, expect, it } from "vitest";
import { Deduper } from "./dedupe.ts";

describe("Deduper", () => {
  it("reports only the first sighting of a key", () => {
    const deduper = new Deduper();
    expect(deduper.firstSeen("Ev1")).toBe(true);
    expect(deduper.firstSeen("Ev1")).toBe(false);
    expect(deduper.firstSeen("Ev2")).toBe(true);
  });

  it("forgets a key once its window has passed", () => {
    let now = 0;
    const deduper = new Deduper({ ttlMs: 1_000, now: () => now });
    deduper.firstSeen("Ev1");
    now = 999;
    expect(deduper.firstSeen("Ev1")).toBe(false);
    now = 1_000;
    expect(deduper.firstSeen("Ev1")).toBe(true);
  });
});
