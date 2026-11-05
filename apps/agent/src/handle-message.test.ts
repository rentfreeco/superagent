import type { Repo } from "@repo/core/repos";
import type { InboundMessage } from "@repo/core/slack";
import { describe, expect, it, vi } from "vitest";
import { createMessageHandler, type SlackThreads } from "./handle-message.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

const channelRepos = new Map([["C0123ABCD", superagentRepo]]);

const inboundMessage = (fields: Partial<InboundMessage>): InboundMessage => ({
  eventId: "Ev1",
  channel: "C0123ABCD",
  ts: "100.000001",
  threadTs: "100.000001",
  user: "U0OWNER",
  text: "fix the flaky test",
  via: "mention",
  ...fields,
});

const setup = () => {
  const reply = vi.fn(async () => {});
  const fetchThread = vi.fn(async () => []);
  const slack: SlackThreads = { reply, fetchThread };
  const startTask = vi.fn(async () => {});
  const setDisposition = vi.fn();
  const handleMessage = createMessageHandler({
    channelRepos,
    startTask,
    events: { setDisposition },
  });
  return { handleMessage, reply, setDisposition, slack, startTask };
};

describe("createMessageHandler", () => {
  it("starts a task for a mention in a mapped channel and settles it as routed", async () => {
    const { handleMessage, reply, setDisposition, slack, startTask } = setup();
    const message = inboundMessage({});

    await handleMessage(message, slack);

    expect(startTask).toHaveBeenCalledExactlyOnceWith({
      message,
      repo: superagentRepo,
      slack,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(setDisposition).toHaveBeenCalledExactlyOnceWith("Ev1", "routed");
  });

  it("replies to a DM instead of starting a task and settles it as replied", async () => {
    const { handleMessage, reply, setDisposition, slack, startTask } = setup();
    const message = inboundMessage({ channel: "D0123ABCD", via: "dm" });

    await handleMessage(message, slack);

    expect(reply).toHaveBeenCalledExactlyOnceWith(
      message,
      expect.stringContaining("DMs don't map to a repo"),
    );
    expect(startTask).not.toHaveBeenCalled();
    expect(setDisposition).toHaveBeenCalledExactlyOnceWith("Ev1", "replied");
  });

  it("replies to a mention in an unmapped channel", async () => {
    const { handleMessage, reply, slack, startTask } = setup();
    const message = inboundMessage({ channel: "C0999ZZZZ" });

    await handleMessage(message, slack);

    expect(reply).toHaveBeenCalledExactlyOnceWith(
      message,
      expect.stringContaining("C0999ZZZZ"),
    );
    expect(startTask).not.toHaveBeenCalled();
  });

  it("leaves the event unsettled when handling fails, so it can be retried", async () => {
    const { handleMessage, setDisposition, slack, startTask } = setup();
    startTask.mockRejectedValueOnce(new Error("worktree failed"));

    await expect(handleMessage(inboundMessage({}), slack)).rejects.toThrow(
      "worktree failed",
    );
    expect(setDisposition).not.toHaveBeenCalled();
  });
});
