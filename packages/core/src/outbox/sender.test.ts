import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Store } from "../store/open-store.ts";
import { openTestStore } from "../store/open-test-store.ts";
import {
  createOutboxSender,
  type OutboxDelivery,
  type OutboxFailure,
  type OutboxPost,
} from "./sender.ts";

const CHANNEL = "C0123ABCD";

const enqueuePost = (
  store: Store,
  dedupeKey: string,
  threadTs: string | null = "1.000001",
): number =>
  store.outbox.enqueue({
    dedupeKey,
    channel: CHANNEL,
    threadTs,
    message: { kind: "post", text: `text for ${dedupeKey}` },
  })?.id ?? -1;

const setup = () => {
  const { store, clock } = openTestStore();
  const postedKeys: string[] = [];
  const delivery = {
    post: vi.fn(async (post: OutboxPost) => {
      postedKeys.push(post.dedupeKey);
      return `9.${String(postedKeys.length).padStart(6, "0")}`;
    }),
    react: vi.fn(async () => undefined),
    findPost: vi.fn(async (): Promise<string | undefined> => undefined),
    classifyFailure: vi.fn((): OutboxFailure => ({ kind: "transient" })),
  } satisfies OutboxDelivery;
  const logger = { warn: vi.fn(), error: vi.fn() };
  const sender = createOutboxSender({
    outbox: store.outbox,
    logger,
    pollIntervalMs: 1_000,
  });
  return { store, clock, delivery, logger, sender, postedKeys };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("outbox sender", () => {
  it("sends due posts and reactions in order and records each post's ts", async () => {
    const { store, delivery, sender, postedKeys } = setup();
    const firstPost = enqueuePost(store, "reply:Ev1");
    const reaction =
      store.outbox.enqueue({
        dedupeKey: "ack:abc",
        channel: CHANNEL,
        threadTs: null,
        message: { kind: "reaction", name: "eyes", timestamp: "1.000001" },
      })?.id ?? -1;
    const secondPost = enqueuePost(store, "reply:Ev2", "2.000001");

    sender.start(delivery);
    await sender.drain();
    await sender.stop();

    expect(postedKeys).toEqual(["reply:Ev1", "reply:Ev2"]);
    expect(delivery.post).toHaveBeenNthCalledWith(1, {
      channel: CHANNEL,
      threadTs: "1.000001",
      dedupeKey: "reply:Ev1",
      text: "text for reply:Ev1",
    });
    expect(delivery.react).toHaveBeenCalledExactlyOnceWith({
      channel: CHANNEL,
      timestamp: "1.000001",
      name: "eyes",
    });
    expect(store.outbox.get(firstPost)).toMatchObject({
      status: "sent",
      slackTs: "9.000001",
    });
    expect(store.outbox.get(secondPost)?.slackTs).toBe("9.000002");
    expect(store.outbox.get(reaction)).toMatchObject({
      status: "sent",
      slackTs: null,
    });
  });

  it("retries a transient failure after its backoff, holding that thread's next post", async () => {
    const { store, clock, delivery, logger, sender } = setup();
    const first = enqueuePost(store, "report:1");
    enqueuePost(store, "report:2");
    delivery.post.mockRejectedValueOnce(new Error("socket hang up"));
    const attemptedKeys = () =>
      delivery.post.mock.calls.map(([post]) => post.dedupeKey);

    sender.start(delivery);
    await sender.drain();
    expect(attemptedKeys()).toEqual(["report:1"]);
    expect(logger.warn).toHaveBeenCalledOnce();

    clock.now = store.outbox.get(first)?.nextAttemptAt ?? clock.now;
    await sender.drain();
    await sender.stop();

    expect(attemptedKeys()).toEqual(["report:1", "report:1", "report:2"]);
    expect(store.outbox.pending()).toEqual([]);
  });

  it("waits as long as a rate limit asks before retrying", async () => {
    const { store, clock, delivery, sender } = setup();
    const entryId = enqueuePost(store, "report:1");
    delivery.post.mockRejectedValueOnce(new Error("rate limited"));
    delivery.classifyFailure.mockReturnValueOnce({
      kind: "transient",
      retryAfterMs: 30_000,
    });

    sender.start(delivery);
    await sender.drain();
    await sender.stop();

    expect((store.outbox.get(entryId)?.nextAttemptAt ?? 0) - clock.now).toBe(
      30_000,
    );
  });

  it("gives up at once on a permanent failure and moves on to the thread's next post", async () => {
    const { store, delivery, logger, sender } = setup();
    const first = enqueuePost(store, "report:1");
    const second = enqueuePost(store, "report:2");
    delivery.post.mockRejectedValueOnce(new Error("not_in_channel"));
    delivery.classifyFailure.mockReturnValueOnce({ kind: "permanent" });

    sender.start(delivery);
    await sender.drain();
    await sender.stop();

    expect(store.outbox.get(first)).toMatchObject({
      status: "failed",
      lastError: "not_in_channel",
    });
    expect(store.outbox.get(second)?.status).toBe("sent");
    expect(delivery.post.mock.calls.map(([post]) => post.dedupeKey)).toEqual([
      "report:1",
      "report:2",
    ]);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      "outbox: gave up on report:1: not_in_channel",
    );
  });

  it("checks whether an interrupted post got through before posting it again", async () => {
    const { store, delivery, sender } = setup();
    const entryId = enqueuePost(store, "report:1");
    const createdAt = store.outbox.beginAttempt(entryId).createdAt;
    delivery.findPost.mockResolvedValueOnce("9.000042");

    sender.start(delivery);
    await sender.drain();
    await sender.stop();

    expect(delivery.findPost).toHaveBeenCalledExactlyOnceWith({
      channel: CHANNEL,
      threadTs: "1.000001",
      dedupeKey: "report:1",
      postedAfter: createdAt,
    });
    expect(delivery.post).not.toHaveBeenCalled();
    expect(store.outbox.get(entryId)).toMatchObject({
      status: "sent",
      slackTs: "9.000042",
    });
  });

  it("posts again when an interrupted attempt left nothing behind", async () => {
    const { store, delivery, sender } = setup();
    const entryId = enqueuePost(store, "report:1");
    store.outbox.beginAttempt(entryId);

    sender.start(delivery);
    await sender.drain();
    await sender.stop();

    expect(delivery.findPost).toHaveBeenCalledOnce();
    expect(delivery.post).toHaveBeenCalledOnce();
    expect(store.outbox.get(entryId)?.status).toBe("sent");
  });

  it("doesn't start a post when stopped while checking an interrupted one", async () => {
    const { store, delivery, sender } = setup();
    const entryId = enqueuePost(store, "report:1");
    store.outbox.beginAttempt(entryId);
    const lookup = Promise.withResolvers<string | undefined>();
    delivery.findPost.mockImplementationOnce(() => lookup.promise);

    sender.start(delivery);
    await vi.waitFor(() => expect(delivery.findPost).toHaveBeenCalledOnce());
    const stopped = sender.stop();
    lookup.resolve(undefined);
    await stopped;

    expect(delivery.post).not.toHaveBeenCalled();
    expect(store.outbox.get(entryId)?.status).toBe("pending");
  });

  it("does nothing until started, and folds wake-ups during a drain into one more pass", async () => {
    const { store, delivery, sender, postedKeys } = setup();
    enqueuePost(store, "reply:Ev1");
    sender.wake();
    expect(delivery.post).not.toHaveBeenCalled();

    const slowPost = Promise.withResolvers<string>();
    let postsInFlight = 0;
    let mostPostsInFlight = 0;
    delivery.post.mockImplementation(async (post: OutboxPost) => {
      postsInFlight += 1;
      mostPostsInFlight = Math.max(mostPostsInFlight, postsInFlight);
      postedKeys.push(post.dedupeKey);
      const ts =
        post.dedupeKey === "reply:Ev1" ? await slowPost.promise : "9.000002";
      postsInFlight -= 1;
      return ts;
    });

    sender.start(delivery);
    enqueuePost(store, "reply:Ev2", "2.000001");
    sender.wake();
    sender.wake();
    slowPost.resolve("9.000001");
    await sender.drain();
    await sender.stop();

    expect(postedKeys).toEqual(["reply:Ev1", "reply:Ev2"]);
    expect(mostPostsInFlight).toBe(1);
    expect(store.outbox.pending()).toEqual([]);
  });

  it("polls, so a retry goes out once its time comes", async () => {
    const { store, clock, delivery, sender } = setup();
    const entryId = enqueuePost(store, "report:1");
    delivery.post.mockRejectedValueOnce(new Error("socket hang up"));

    sender.start(delivery);
    await vi.waitFor(() => expect(delivery.post).toHaveBeenCalledOnce());
    clock.now = store.outbox.get(entryId)?.nextAttemptAt ?? clock.now;

    await vi.waitFor(() =>
      expect(store.outbox.get(entryId)?.status).toBe("sent"),
    );
    await sender.stop();
    expect(delivery.post).toHaveBeenCalledTimes(2);
  });

  it("finishes the post in flight on stop, then sends nothing more", async () => {
    const { store, delivery, sender } = setup();
    const first = enqueuePost(store, "reply:Ev1");
    const second = enqueuePost(store, "reply:Ev2", "2.000001");
    const slowPost = Promise.withResolvers<string>();
    delivery.post.mockImplementationOnce(async () => slowPost.promise);

    sender.start(delivery);
    await vi.waitFor(() => expect(delivery.post).toHaveBeenCalledOnce());
    const stopped = sender.stop();
    slowPost.resolve("9.000001");
    await stopped;
    sender.wake();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(store.outbox.get(first)?.status).toBe("sent");
    expect(store.outbox.get(second)?.status).toBe("pending");
    expect(delivery.post).toHaveBeenCalledOnce();
  });
});
