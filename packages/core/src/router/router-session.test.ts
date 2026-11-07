import { expect, it, vi } from "vitest";
import type { Repo } from "../repos/config.ts";
import type { Candidate } from "../store/candidates.ts";
import type {
  ConversationRequest,
  StartConversation,
} from "../tasks/agent-session.ts";
import { createAsyncQueue } from "../utils/create-async-queue.ts";
import type { ToolOutcome } from "../tasks/tool-outcome.ts";
import { createRouterSessionStarter } from "./router-session.ts";
import { createRouterTools, ROUTER_TOOL_NAMES } from "./router-tools.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
  description: "The Slack coding agent itself",
};

const candidate: Candidate = {
  id: 7,
  eventId: "EvDm",
  channel: "D0OWNER",
  ts: "100.000001",
  threadTs: "100.000001",
  user: "U0OWNER",
  text: "what's waiting on me?",
  via: "dm",
  handedBackBy: null,
  handBackReason: null,
  createdAt: 1,
  deliveredAt: null,
  decidedAt: null,
};

const accepted: ToolOutcome = { isAccepted: true, reply: "Done." };

const actions = {
  startTask: vi.fn(() => accepted),
  reply: vi.fn(() => accepted),
  attach: vi.fn(() => accepted),
  stop: vi.fn(() => accepted),
  ignore: vi.fn(() => accepted),
  listTasks: vi.fn(() => "There are no open tasks."),
};

it("starts the router with only its routing tools, no settings files, its instructions, and each candidate as a card", async () => {
  const requests: ConversationRequest[] = [];
  const messages = createAsyncQueue<unknown>();
  const startConversation: StartConversation = (request) => {
    requests.push(request);
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      interrupt: async () => undefined,
      close: () => messages.end(),
    };
  };

  createRouterSessionStarter({
    workingDirectory: "/data/router",
    repos: new Map([["superagent", superagentRepo]]),
    channelRepos: new Map([["C0MAPPED", superagentRepo]]),
    startConversation,
    environment: { PATH: "/usr/bin", SLACK_BOT_TOKEN: "xoxb-secret" },
  })({
    sessionId: "s-1",
    candidates: [candidate],
    actions,
    events: { onSessionId: vi.fn(), onTurnEnd: vi.fn(), onEnd: vi.fn() },
  });

  const [request] = requests;
  expect(request?.options).toMatchObject({
    cwd: "/data/router",
    resume: "s-1",
    effort: "low",
    tools: [],
    permissionMode: "dontAsk",
    allowedTools: ROUTER_TOOL_NAMES,
    strictMcpConfig: true,
    settingSources: [],
    systemPrompt: expect.stringContaining(
      "- superagent (pakgin/superagent): The Slack coding agent itself. Channels: C0MAPPED.",
    ),
    env: { PATH: "/usr/bin" },
  });
  const firstPrompt = await request?.prompt[Symbol.asyncIterator]().next();
  expect(firstPrompt?.value?.message.content).toBe(
    "candidate_id: 7\nwhere: a DM to the bot\nthread: D0OWNER/100.000001\nmessage:\nwhat's waiting on me?",
  );
  messages.end();
});

it("passes each routing tool's arguments to the router's actions", async () => {
  const tools = createRouterTools(actions);

  await tools.start_task.handler(
    { candidate_id: 7, repo: "superagent", title: "Fix it", reason: "Asked." },
    undefined,
  );
  await tools.ignore.handler(
    { candidate_id: 7, reason: "Thanks.", reaction: "heart" },
    undefined,
  );
  const listed = await tools.list_tasks.handler({ which: "open" }, undefined);

  expect(actions.startTask).toHaveBeenCalledWith({
    candidateId: 7,
    repo: "superagent",
    title: "Fix it",
    reason: "Asked.",
  });
  expect(actions.ignore).toHaveBeenCalledWith({
    candidateId: 7,
    reason: "Thanks.",
    reaction: "heart",
  });
  expect(listed).toEqual({
    content: [{ type: "text", text: "There are no open tasks." }],
  });
  expect(Object.keys(tools)).toEqual([
    "start_task",
    "reply",
    "attach",
    "stop",
    "ignore",
    "list_tasks",
  ]);
});
