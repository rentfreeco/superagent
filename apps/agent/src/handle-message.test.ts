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
  const handleMessage = createMessageHandler({ channelRepos, startTask });
  return { handleMessage, reply, slack, startTask };
};

describe("createMessageHandler", () => {
  it("starts a task for a mention in a mapped channel", async () => {
    const { handleMessage, reply, slack, startTask } = setup();
    const message = inboundMessage({});

    await handleMessage(message, slack);

    expect(startTask).toHaveBeenCalledExactlyOnceWith({
      message,
      repo: superagentRepo,
      slack,
    });
    expect(reply).not.toHaveBeenCalled();
  });

  it("replies to a DM instead of starting a task", async () => {
    const { handleMessage, reply, slack, startTask } = setup();
    const message = inboundMessage({ channel: "D0123ABCD", via: "dm" });

    await handleMessage(message, slack);

    expect(reply).toHaveBeenCalledExactlyOnceWith(
      message,
      expect.stringContaining("DMs don't map to a repo"),
    );
    expect(startTask).not.toHaveBeenCalled();
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
});
