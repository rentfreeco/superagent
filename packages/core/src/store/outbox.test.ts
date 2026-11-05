import { describe, expect, it } from "vitest";
import {
  OUTBOX_BASE_RETRY_DELAY_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_MAX_RETRY_DELAY_MS,
} from "../constants.ts";
import { openTestStore } from "./open-test-store.ts";
import type { NewOutboxEntry } from "./outbox.ts";

const summaryPost: NewOutboxEntry = {
  dedupeKey: "report:1",
  channel: "C0123ABCD",
  threadTs: "100.000001",
  message: { kind: "post", text: "Opened #12: fixed the flaky test." },
};

describe("outbox", () => {
  it("queues a post and a reaction exactly as given", () => {
    const { store, clock } = openTestStore();
    const reaction: NewOutboxEntry = {
      dedupeKey: "ack:abc",
      channel: "C0123ABCD",
      threadTs: null,
      message: { kind: "reaction", name: "eyes", timestamp: "100.000001" },
    };

    const post = store.outbox.enqueue(summaryPost);
    store.outbox.enqueue(reaction);

    expect(post).toMatchObject({
      dedupeKey: "report:1",
      status: "pending",
      attempts: 0,
      nextAttemptAt: clock.now,
      slackTs: null,
    });
    expect(store.outbox.pending().map(({ message }) => message)).toEqual([
      summaryPost.message,
      reaction.message,
    ]);
  });

  it("queues each dedupe key once", () => {
    const { store } = openTestStore();
    expect(store.outbox.enqueue(summaryPost)).toBeDefined();
    expect(store.outbox.enqueue(summaryPost)).toBeUndefined();
    expect(store.outbox.pending()).toHaveLength(1);
  });

  it("counts an attempt before it is made, and stops offering a sent entry", () => {
    const { store } = openTestStore();
    const entryId = store.outbox.enqueue(summaryPost)?.id ?? -1;

    expect(store.outbox.beginAttempt(entryId).attempts).toBe(1);
    store.outbox.markSent(entryId, "100.000009");

    expect(store.outbox.pending()).toEqual([]);
    expect(() => store.outbox.beginAttempt(entryId)).toThrow(
      `No pending outbox entry ${entryId}`,
    );
  });

  it("backs off exponentially up to the cap, then gives up", () => {
    const { store, clock } = openTestStore();
    const entryId = store.outbox.enqueue(summaryPost)?.id ?? -1;
    const delays: number[] = [];

    for (let attempt = 1; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      store.outbox.beginAttempt(entryId);
      const entry = store.outbox.markFailed(entryId, "ratelimited");
      expect(entry.status).toBe("pending");
      expect(store.outbox.pending()).toEqual([]);
      delays.push(entry.nextAttemptAt - clock.now);
      clock.now = entry.nextAttemptAt;
      expect(store.outbox.pending().map(({ id }) => id)).toEqual([entryId]);
    }
    store.outbox.beginAttempt(entryId);
    const lastAttempt = store.outbox.markFailed(entryId, "ratelimited");

    expect(delays).toEqual(
      delays.map((_, index) =>
        Math.min(
          OUTBOX_BASE_RETRY_DELAY_MS * 2 ** index,
          OUTBOX_MAX_RETRY_DELAY_MS,
        ),
      ),
    );
    expect(delays.at(-1)).toBe(OUTBOX_MAX_RETRY_DELAY_MS);
    expect(lastAttempt).toMatchObject({
      status: "failed",
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: "ratelimited",
    });
    clock.now += OUTBOX_MAX_RETRY_DELAY_MS;
    expect(store.outbox.pending()).toEqual([]);
  });

  it("fails an entry at once when it can never be delivered", () => {
    const { store } = openTestStore();
    const entryId = store.outbox.enqueue(summaryPost)?.id ?? -1;
    store.outbox.beginAttempt(entryId);

    expect(
      store.outbox.markUndeliverable(entryId, "not_in_channel"),
    ).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "not_in_channel",
    });
    expect(store.outbox.pending()).toEqual([]);
  });

  it("holds a thread's later entries until the earlier one is settled", () => {
    const { store, clock } = openTestStore();
    const first = store.outbox.enqueue(summaryPost)?.id ?? -1;
    const second =
      store.outbox.enqueue({ ...summaryPost, dedupeKey: "report:2" })?.id ?? -1;
    const otherThread =
      store.outbox.enqueue({
        ...summaryPost,
        dedupeKey: "report:3",
        threadTs: "200.000001",
      })?.id ?? -1;
    const pendingIds = () => store.outbox.pending().map(({ id }) => id);

    expect(pendingIds()).toEqual([first, otherThread]);

    store.outbox.beginAttempt(first);
    const retry = store.outbox.markFailed(first, "ratelimited");
    expect(pendingIds()).toEqual([otherThread]);

    clock.now = retry.nextAttemptAt;
    store.outbox.markSent(otherThread, "200.000002");
    expect(pendingIds()).toEqual([first]);

    store.outbox.beginAttempt(first);
    store.outbox.markUndeliverable(first, "msg_too_long");
    expect(pendingIds()).toEqual([second]);
  });

  it("refuses to fail an entry that already went out", () => {
    const { store } = openTestStore();
    const entryId = store.outbox.enqueue(summaryPost)?.id ?? -1;
    store.outbox.markSent(entryId, "100.000009");
    expect(() => store.outbox.markFailed(entryId, "late error")).toThrow(
      `No pending outbox entry ${entryId}`,
    );
  });
});
