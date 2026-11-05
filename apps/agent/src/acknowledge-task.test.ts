import type { InboundMessage } from "@repo/core/slack";
import { expect, it, vi } from "vitest";
import { acknowledgeTask } from "./acknowledge-task.ts";

it("tells the owner which repo the request was routed to", async () => {
  const reply = vi.fn(async () => {});
  const message: InboundMessage = {
    eventId: "Ev1",
    channel: "C0123ABCD",
    ts: "100.000001",
    threadTs: "100.000001",
    user: "U0OWNER",
    text: "fix the flaky test",
    via: "mention",
  };

  await acknowledgeTask({
    message,
    repo: {
      name: "superagent",
      github: "pakgin/superagent",
      path: "/code/superagent",
      baseBranch: "main",
    },
    slack: { reply, fetchThread: vi.fn(async () => []) },
  });

  expect(reply).toHaveBeenCalledExactlyOnceWith(
    message,
    expect.stringMatching(/\*superagent\* \(`pakgin\/superagent`\)/),
  );
});
