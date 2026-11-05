import type { webApi } from "@slack/bolt";
import { expect, it, vi } from "vitest";
import { postReply } from "./reply.ts";

it("posts the reply into the message's thread", async () => {
  const postMessage = vi.fn().mockResolvedValue({ ok: true });
  const client = { chat: { postMessage } } as unknown as webApi.WebClient;

  await postReply(
    client,
    { channel: "C0123ABCD", threadTs: "100.000001" },
    "on it",
  );

  expect(postMessage).toHaveBeenCalledExactlyOnceWith({
    channel: "C0123ABCD",
    thread_ts: "100.000001",
    text: "on it",
  });
});
