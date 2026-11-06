import { expect, it } from "vitest";
import { openTestStore } from "./open-test-store.ts";

it("records one decision per candidate and finds it by the candidate", () => {
  const { store, clock } = openTestStore();
  store.events.record({
    eventId: "Ev1",
    type: "message",
    channel: "D0OWNER",
    ts: "100.000001",
    threadTs: null,
    user: "U0OWNER",
    text: "thanks!",
  });
  const candidate = store.candidates.add({
    eventId: "Ev1",
    channel: "D0OWNER",
    ts: "100.000001",
    threadTs: "100.000001",
    user: "U0OWNER",
    text: "thanks!",
    via: "dm",
    handedBackBy: null,
    handBackReason: null,
  });
  const decision = {
    candidateId: candidate?.id ?? 0,
    outcome: "ignore" as const,
    taskId: null,
    reason: "A thank-you needs no answer.",
    decidedBy: "router" as const,
  };

  expect(store.decisions.add(decision)).toEqual({
    id: 1,
    ...decision,
    createdAt: clock.now,
  });
  expect(store.decisions.forCandidate(candidate?.id ?? 0)?.outcome).toBe(
    "ignore",
  );
  expect(() => store.decisions.add(decision)).toThrow(/UNIQUE/);
});
