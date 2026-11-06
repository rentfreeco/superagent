import { describe, expect, it } from "vitest";
import type { NewCandidate } from "./candidates.ts";
import type { Store } from "./open-store.ts";
import { openTestStore } from "./open-test-store.ts";

const recordEvent = (store: Store, eventId: string) =>
  store.events.record({
    eventId,
    type: "message",
    channel: "D0OWNER",
    ts: "100.000001",
    threadTs: null,
    user: "U0OWNER",
    text: "fix the flaky test in superagent",
  });

const candidate = (fields: Partial<NewCandidate>): NewCandidate => ({
  eventId: "Ev1",
  channel: "D0OWNER",
  ts: "100.000001",
  threadTs: "100.000001",
  user: "U0OWNER",
  text: "fix the flaky test in superagent",
  via: "dm",
  handedBackBy: null,
  handBackReason: null,
  ...fields,
});

describe("candidates", () => {
  it("adds a message once, and once more for each task that hands it back", () => {
    const { store, clock } = openTestStore();
    recordEvent(store, "Ev1");
    const task = store.tasks.create({
      title: "Fix the flaky test",
      repo: "superagent",
      originChannel: "C0MAPPED",
      originTs: "90.000001",
    });

    expect(store.candidates.add(candidate({}))).toEqual({
      id: 1,
      ...candidate({}),
      createdAt: clock.now,
      deliveredAt: null,
      decidedAt: null,
    });
    expect(store.candidates.add(candidate({}))).toBeUndefined();
    const handedBack = candidate({
      handedBackBy: task.id,
      handBackReason: "It asks about the deploy, not this fix.",
    });
    expect(store.candidates.add(handedBack)?.id).toBe(2);
    expect(store.candidates.add(handedBack)).toBeUndefined();
  });

  it("tracks what is still to deliver and decide, and decides each once", () => {
    const { store } = openTestStore();
    for (const eventId of ["Ev1", "Ev2", "Ev3"]) {
      recordEvent(store, eventId);
      store.candidates.add(candidate({ eventId }));
    }

    store.candidates.markDelivered([1, 2]);
    expect(store.candidates.markDecided(1)).toBe(true);
    expect(store.candidates.markDecided(1)).toBe(false);

    expect(store.candidates.undelivered().map(({ id }) => id)).toEqual([3]);
    expect(store.candidates.undecided().map(({ id }) => id)).toEqual([2, 3]);
    expect(store.candidates.get(1)?.decidedAt).toEqual(expect.any(Number));
  });
});
