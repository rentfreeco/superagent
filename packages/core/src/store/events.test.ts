import { describe, expect, it } from "vitest";
import type { NewEvent } from "./events.ts";
import { openTestStore } from "./open-test-store.ts";

const ownerMessage = (fields: Partial<NewEvent> = {}): NewEvent => ({
  eventId: "Ev1",
  type: "message",
  channel: "D0123ABCD",
  ts: "100.000001",
  threadTs: null,
  user: "U0OWNER",
  text: "fix the flaky test",
  ...fields,
});

describe("events", () => {
  it("records an event once by event ID", () => {
    const { store } = openTestStore();
    expect(store.events.record(ownerMessage())).toBe(true);
    expect(store.events.record(ownerMessage())).toBe(false);
    expect(store.events.get("Ev1")).toMatchObject({
      disposition: "received",
      text: "fix the flaky test",
    });
  });

  it("finds the event that claimed a message by its channel and ts", () => {
    const { store } = openTestStore();
    store.events.record(
      ownerMessage({ eventId: "EvUnclaimed", channel: "C0123ABCD" }),
    );
    store.events.record(
      ownerMessage({
        eventId: "EvClaimed",
        type: "app_mention",
        channel: "C0123ABCD",
        threadTs: "90.000001",
      }),
    );
    store.events.claimMessage("EvClaimed");

    expect(
      store.events.claimedMessage("C0123ABCD", "100.000001"),
    ).toMatchObject({ eventId: "EvClaimed", threadTs: "90.000001" });
    expect(
      store.events.claimedMessage("C0123ABCD", "100.000009"),
    ).toBeUndefined();
  });

  it("lets only one event claim a message", () => {
    const { store } = openTestStore();
    store.events.record(ownerMessage({ eventId: "EvMessage" }));
    store.events.record(
      ownerMessage({ eventId: "EvMention", type: "app_mention" }),
    );

    expect(store.events.claimMessage("EvMessage")).toBe(true);
    expect(store.events.claimMessage("EvMention")).toBe(false);
    expect(store.events.claimMessage("EvMessage")).toBe(true);
  });

  it("can't claim an event that has no message", () => {
    const { store } = openTestStore();
    store.events.record(
      ownerMessage({
        eventId: "EvJoin",
        type: "member_joined_channel",
        ts: null,
      }),
    );
    expect(store.events.claimMessage("EvJoin")).toBe(false);
  });

  it("forgets someone else's text when the gate drops their event", () => {
    const { store } = openTestStore();
    store.events.record(ownerMessage({ user: "U0SOMEONE" }));
    store.events.setDisposition("Ev1", "dropped_not_owner");
    expect(store.events.get("Ev1")).toMatchObject({
      disposition: "dropped_not_owner",
      text: null,
    });
  });

  it("keeps the owner's text when an event is ignored or handled", () => {
    const { store } = openTestStore();
    store.events.record(ownerMessage({ eventId: "EvIgnored" }));
    store.events.record(
      ownerMessage({ eventId: "EvRouted", ts: "100.000002" }),
    );
    store.events.setDisposition("EvIgnored", "ignored");
    store.events.setDisposition("EvRouted", "routed");
    expect(store.events.get("EvIgnored")?.text).toBe("fix the flaky test");
    expect(store.events.get("EvRouted")?.text).toBe("fix the flaky test");
  });

  it("lists unfinished events oldest first", () => {
    const { store, clock } = openTestStore();
    store.events.record(ownerMessage({ eventId: "EvB", ts: "100.000002" }));
    clock.now += 1;
    store.events.record(ownerMessage({ eventId: "EvA", ts: "100.000003" }));
    clock.now += 1;
    store.events.record(ownerMessage({ eventId: "EvDone", ts: "100.000004" }));
    store.events.setDisposition("EvDone", "replied");

    expect(store.events.unfinished().map(({ eventId }) => eventId)).toEqual([
      "EvB",
      "EvA",
    ]);
  });

  it("finds the latest message ts in a channel, ignoring reactions", () => {
    const { store } = openTestStore();
    store.events.record(ownerMessage({ eventId: "Ev1", ts: "100.000001" }));
    store.events.record(ownerMessage({ eventId: "Ev2", ts: "100.000009" }));
    store.events.record(
      ownerMessage({
        eventId: "Ev3",
        type: "reaction_added",
        ts: "200.000000",
      }),
    );
    store.events.record(
      ownerMessage({ eventId: "Ev4", channel: "C0OTHER", ts: "300.000000" }),
    );

    expect(store.events.latestTs("D0123ABCD")).toBe("100.000009");
    expect(store.events.latestTs("C0UNSEEN")).toBeUndefined();
  });

  it("finds the latest message in one thread, counting the root and its replies", () => {
    const { store } = openTestStore();
    store.events.record(
      ownerMessage({ eventId: "EvRoot", channel: "C0", ts: "100.000001" }),
    );
    store.events.record(
      ownerMessage({
        eventId: "EvReply",
        channel: "C0",
        ts: "100.000005",
        threadTs: "100.000001",
      }),
    );
    store.events.record(
      ownerMessage({
        eventId: "EvOtherThread",
        channel: "C0",
        ts: "100.000009",
        threadTs: "100.000002",
      }),
    );

    expect(store.events.latestTsInThread("C0", "100.000001")).toBe(
      "100.000005",
    );
    expect(store.events.latestTsInThread("C0", "300.000000")).toBeUndefined();
  });

  it("lists the DM channels a user has written in", () => {
    const { store } = openTestStore();
    store.events.record(ownerMessage({ eventId: "Ev1", channel: "D0OWNER" }));
    store.events.record(
      ownerMessage({ eventId: "Ev2", channel: "D0OWNER", ts: "100.000002" }),
    );
    store.events.record(
      ownerMessage({ eventId: "Ev3", channel: "D0SOMEONE", user: "U0SOMEONE" }),
    );
    store.events.record(ownerMessage({ eventId: "Ev4", channel: "C0CHANNEL" }));

    expect(store.events.directMessageChannels("U0OWNER")).toEqual(["D0OWNER"]);
  });
});
