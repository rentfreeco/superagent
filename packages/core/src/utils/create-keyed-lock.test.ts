import { expect, it } from "vitest";
import { createKeyedLock } from "./create-keyed-lock.ts";

it("runs work for the same key one at a time, in order, even after a failure, and other keys alongside", async () => {
  const lock = createKeyedLock();
  const events: string[] = [];
  const firstRelease = Promise.withResolvers<void>();

  const first = lock("repo", async () => {
    events.push("first starts");
    await firstRelease.promise;
    events.push("first fails");
    throw new Error("fetch failed");
  });
  const second = lock("repo", async () => {
    events.push("second runs");
    return "second";
  });
  const other = lock("other-repo", async () => {
    events.push("other runs");
    return "other";
  });

  await expect(other).resolves.toBe("other");
  firstRelease.resolve();
  await expect(first).rejects.toThrow("fetch failed");
  await expect(second).resolves.toBe("second");
  expect(events).toEqual([
    "first starts",
    "other runs",
    "first fails",
    "second runs",
  ]);
});
