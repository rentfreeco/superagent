import { expect, it } from "vitest";
import { z } from "zod";
import { openTestStore } from "./open-test-store.ts";

const routerStateSchema = z.object({
  sessionId: z.string(),
  promptVersion: z.number(),
});

it("stores JSON values by key and checks them on the way out", () => {
  const { store } = openTestStore();
  expect(store.kv.get("router", routerStateSchema)).toBeUndefined();

  store.kv.set("router", { sessionId: "session-1", promptVersion: 1 });
  store.kv.set("router", { sessionId: "session-2", promptVersion: 2 });

  expect(store.kv.get("router", routerStateSchema)).toEqual({
    sessionId: "session-2",
    promptVersion: 2,
  });
  expect(() => store.kv.get("router", z.string())).toThrow();
});
