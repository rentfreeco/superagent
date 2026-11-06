import { expect, it } from "vitest";
import { createAsyncQueue } from "./create-async-queue.ts";

it("hands items to the reader in order, waiting for ones not pushed yet, until the queue ends", async () => {
  const queue = createAsyncQueue<string>();
  queue.push("first");
  const received: string[] = [];
  const reading = (async () => {
    for await (const item of queue) received.push(item);
  })();

  await Promise.resolve();
  queue.push("second");
  queue.end();
  await reading;

  expect(received).toEqual(["first", "second"]);
  expect(() => queue.push("third")).toThrow(/ended/);
});
