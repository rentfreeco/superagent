import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Repo } from "../repos/config.ts";
import type { InboundMessage } from "../slack/inbound.ts";
import type { Candidate } from "../store/candidates.ts";
import { openTestStore } from "../store/open-test-store.ts";
import { queueCandidate } from "./queue-candidate.ts";
import { createRouter, ROUTER_SESSION_KEY, type Router } from "./router.ts";
import type {
  RouterSessionOptions,
  StartRouterSession,
} from "./router-session.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

interface FakeRouterSession {
  options: RouterSessionOptions;
  sent: number[][];
  end: ReturnType<typeof vi.fn<() => void>>;
  close: ReturnType<typeof vi.fn<() => void>>;
}

const routers: Router[] = [];

afterEach(() => {
  for (const router of routers.splice(0)) router.stop();
});

const idleTurn = {
  readIds: [],
  isError: false,
  resultText: "",
  isIdle: true,
};

const setup = ({
  startSession,
}: { startSession?: StartRouterSession } = {}) => {
  const { clock, store } = openTestStore();
  const sessions: FakeRouterSession[] = [];
  const fakeStart: StartRouterSession = (options) => {
    const fake: FakeRouterSession = {
      options,
      sent: [options.candidates.map(({ id }) => id)],
      end: vi.fn(),
      close: vi.fn(),
    };
    sessions.push(fake);
    return {
      send: (candidates) => fake.sent.push(candidates.map(({ id }) => id)),
      interrupt: async () => undefined,
      end: fake.end,
      close: fake.close,
    };
  };
  const wakeOutbox = vi.fn();
  const wakeTaskRunner = vi.fn();
  const logger = { info: vi.fn(), error: vi.fn() };
  const router = createRouter({
    store,
    repos: new Map([["superagent", superagentRepo]]),
    channelRepos: new Map([["C0MAPPED", superagentRepo]]),
    startSession: startSession ?? fakeStart,
    wakeOutbox,
    wakeTaskRunner,
    logger,
    now: () => clock.now,
    pollIntervalMs: 60_000,
    decisionTimeoutMs: 60_000,
  });
  routers.push(router);
  let nextTs = 1;
  const queue = (fields: Partial<InboundMessage> = {}): Candidate => {
    nextTs += 1;
    const ts = `100.00000${nextTs}`;
    const message: InboundMessage = {
      eventId: `Ev${nextTs}`,
      channel: "C0MAPPED",
      ts,
      threadTs: ts,
      user: "U0OWNER",
      text: "fix the flaky test",
      via: "mention",
      ...fields,
    };
    store.events.record({
      eventId: message.eventId,
      type: "app_mention",
      channel: message.channel,
      ts: message.ts,
      threadTs: null,
      user: message.user,
      text: message.text,
    });
    queueCandidate({ message, store });
    const candidate = store.candidates.undecided().at(-1);
    if (candidate === undefined) throw new Error("Nothing queued");
    return candidate;
  };
  const sessionAt = (index: number) => {
    const session = sessions[index];
    if (session === undefined) throw new Error(`No session ${index}`);
    return session;
  };
  return {
    clock,
    logger,
    queue,
    router,
    sessionAt,
    sessions,
    store,
    wakeOutbox,
    wakeTaskRunner,
  };
};

describe("createRouter", () => {
  it("starts one session with every waiting candidate, resuming the stored session", () => {
    const { queue, router, sessionAt, sessions, store } = setup();
    store.kv.set(ROUTER_SESSION_KEY, "s-1");
    const first = queue();
    const second = queue();

    router.start();

    expect(sessions).toHaveLength(1);
    expect(sessionAt(0).options.sessionId).toBe("s-1");
    expect(sessionAt(0).sent).toEqual([[first.id, second.id]]);
    expect(store.candidates.undelivered()).toEqual([]);
  });

  it("pushes a new candidate into the live session, and keeps the session ID it reports", () => {
    const { queue, router, sessionAt, store } = setup();
    queue();
    router.start();
    const later = queue();

    router.wake();
    sessionAt(0).options.events.onSessionId("s-2");

    expect(sessionAt(0).sent.at(-1)).toEqual([later.id]);
    expect(store.kv.get(ROUTER_SESSION_KEY, z.string())).toBe("s-2");
  });

  it("settles a decision the router makes and wakes the outbox and the task runner", () => {
    const { queue, router, sessionAt, store, wakeOutbox, wakeTaskRunner } =
      setup();
    const candidate = queue();
    router.start();

    const result = sessionAt(0).options.actions.startTask({
      candidateId: candidate.id,
      repo: "superagent",
      title: "Fix the flaky test",
      reason: "A mention asking for a fix.",
    });

    expect(result.isAccepted).toBe(true);
    expect(store.decisions.forCandidate(candidate.id)).toMatchObject({
      outcome: "start_task",
      decidedBy: "router",
    });
    expect(wakeOutbox).toHaveBeenCalled();
    expect(wakeTaskRunner).toHaveBeenCalled();
  });

  it("lets the channel map decide what the router left undecided once its turn went idle, then ends the session", () => {
    const { queue, router, sessionAt, store } = setup();
    const candidate = queue();
    router.start();

    sessionAt(0).options.events.onTurnEnd(idleTurn);

    expect(store.decisions.forCandidate(candidate.id)).toMatchObject({
      outcome: "start_task",
      decidedBy: "fallback",
    });
    expect(sessionAt(0).end).toHaveBeenCalledOnce();
  });

  it("falls back when the session fails, and starts a new one for what comes next", () => {
    const { logger, queue, router, sessionAt, sessions, store } = setup();
    const crashed = queue();
    router.start();

    sessionAt(0).options.events.onEnd(new Error("exited with code 1"));
    const next = queue();
    router.wake();

    expect(store.decisions.forCandidate(crashed.id)?.decidedBy).toBe(
      "fallback",
    );
    expect(logger.error).toHaveBeenCalledWith(
      "router: the session failed: exited with code 1",
    );
    expect(sessions).toHaveLength(2);
    expect(sessionAt(1).sent).toEqual([[next.id]]);
  });

  it("falls back for a candidate left waiting past the timeout, and closes the stuck session", () => {
    const { clock, queue, router, sessionAt, store } = setup();
    const candidate = queue();
    router.start();

    clock.now += 61_000;
    router.wake();

    expect(store.decisions.forCandidate(candidate.id)?.decidedBy).toBe(
      "fallback",
    );
    expect(sessionAt(0).close).toHaveBeenCalledOnce();
  });

  it("falls back when the session can't start", () => {
    const { queue, router, store } = setup({
      startSession: () => {
        throw new Error("claude not found");
      },
    });
    const candidate = queue();

    router.start();

    expect(store.decisions.forCandidate(candidate.id)?.decidedBy).toBe(
      "fallback",
    );
  });

  it("on stop, closes the session and decides nothing more", () => {
    const { queue, router, sessionAt, store } = setup();
    const candidate = queue();
    router.start();

    router.stop();
    sessionAt(0).options.events.onEnd(undefined);

    expect(sessionAt(0).close).toHaveBeenCalledOnce();
    expect(store.decisions.forCandidate(candidate.id)).toBeUndefined();
  });
});
