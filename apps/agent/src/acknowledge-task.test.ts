import type { InboundMessage } from "@repo/core/slack";
import { IN_MEMORY_STORE, openStore } from "@repo/core/store";
import { expect, it } from "vitest";
import { acknowledgeTask } from "./acknowledge-task.ts";

it("queues a post telling the owner which repo the request was routed to", () => {
  const store = openStore({ path: IN_MEMORY_STORE });
  const message: InboundMessage = {
    eventId: "Ev1",
    channel: "C0123ABCD",
    ts: "100.000001",
    threadTs: "100.000001",
    user: "U0OWNER",
    text: "fix the flaky test",
    via: "mention",
  };

  acknowledgeTask({
    message,
    repo: {
      name: "superagent",
      github: "pakgin/superagent",
      path: "/code/superagent",
      baseBranch: "main",
    },
    store,
  });

  expect(store.outbox.pending()).toEqual([
    expect.objectContaining({
      dedupeKey: "ack:Ev1",
      channel: "C0123ABCD",
      threadTs: "100.000001",
      message: {
        kind: "post",
        text: expect.stringMatching(/\*superagent\* \(`pakgin\/superagent`\)/),
      },
    }),
  ]);
});
