import { describe, expect, it, vi } from "vitest";
import type { Repo } from "../repos/config.ts";
import type { TaskInput } from "../store/inputs.ts";
import type { Task } from "../store/tasks.ts";
import { createAsyncQueue } from "../utils/create-async-queue.ts";
import type {
  AgentConversation,
  ConversationRequest,
  StartConversation,
} from "./agent-session.ts";
import {
  createAckTool,
  createClaudeSessionStarter,
  createHandBackTool,
  createReadThreadTool,
  createReportTool,
  WORKER_SERVER_NAME,
} from "./claude-session.ts";
import type { WorkerReport } from "./record-report.ts";
import type { ToolOutcome } from "./tool-outcome.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

const queuedTask: Task = {
  id: "abcd2345",
  title: "fix the flaky test",
  repo: "superagent",
  state: "running",
  branch: "agent/abcd2345",
  worktree: "/data/worktrees/abcd2345",
  prNumber: null,
  sessionId: null,
  originChannel: "C0MAPPED",
  originTs: "100.000001",
  createdAt: 1,
  lastActivityAt: 1,
};

const taskInput = (fields: Partial<TaskInput>): TaskInput => ({
  id: 1,
  taskId: "abcd2345",
  source: "slack",
  ref: "Ev1",
  text: "fix the flaky test",
  createdAt: 1,
  deliveredAt: null,
  readAt: null,
  ...fields,
});

const turnResult = (fields: Record<string, unknown>) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Done.",
  queued_turn_count: 0,
  ...fields,
});

const setup = ({
  task = queuedTask,
  conversationMessages = createAsyncQueue<unknown>(),
  iterate = () => conversationMessages[Symbol.asyncIterator](),
  sandbox = false,
}: {
  task?: Task;
  conversationMessages?: ReturnType<typeof createAsyncQueue<unknown>>;
  iterate?: AgentConversation[typeof Symbol.asyncIterator];
  sandbox?: boolean;
} = {}) => {
  const requests: ConversationRequest[] = [];
  const conversation = {
    [Symbol.asyncIterator]: iterate,
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => conversationMessages.end()),
  };
  const startConversation: StartConversation = (request) => {
    requests.push(request);
    return conversation;
  };
  const events = {
    onSessionId: vi.fn((_sessionId: string) => undefined),
    onTurnEnd: vi.fn(),
    onEnd: vi.fn((_error: unknown): void => undefined),
  };
  const session = createClaudeSessionStarter({
    startConversation,
    environment: {
      PATH: "/usr/bin",
      LC_ALL: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GH_TOKEN: "ghp_test",
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_APP_TOKEN: "xapp-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      SUPERAGENT_DATA_DIR: "/data",
    },
    homeDirectory: "/home/agent",
    sandbox,
  })({
    task,
    repo: superagentRepo,
    worktree: { branch: "agent/abcd2345", path: "/data/worktrees/abcd2345" },
    inputs: [
      taskInput({}),
      taskInput({ id: 2, source: "system", ref: null, text: "restarted" }),
    ],
    ack: () => "Put 👀 on the owner's message.",
    readThread: async () => "[owner]\nfix the flaky test",
    report: (_report: WorkerReport): ToolOutcome => ({
      isAccepted: true,
      reply: "Posted.",
    }),
    handBack: () => ({ isAccepted: true, reply: "Handed back." }),
    events,
  });
  const [request] = requests;
  if (request === undefined) throw new Error("No conversation started");
  const promptReader = request.prompt[Symbol.asyncIterator]();
  const nextPrompt = async () => (await promptReader.next()).value;
  const ended = new Promise<unknown>((resolve) => {
    events.onEnd.mockImplementation((error) => resolve(error));
  });
  return {
    conversation,
    conversationMessages,
    ended,
    events,
    nextPrompt,
    request,
    session,
  };
};

describe("createClaudeSessionStarter", () => {
  it("starts an unattended Claude Code session in the worktree, with only the environment it needs", () => {
    const { request } = setup();

    expect(request.options).toMatchObject({
      cwd: "/data/worktrees/abcd2345",
      resume: undefined,
      model: "claude-opus-5-5",
      effort: "high",
      permissionMode: "dontAsk",
      settingSources: ["project"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: expect.stringContaining("git push -u origin agent/abcd2345"),
      },
      title: "fix the flaky test",
    });
    expect(request.options.env).toEqual({
      PATH: "/usr/bin",
      LC_ALL: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-test",
      GH_TOKEN: "ghp_test",
    });
    expect(request.options).not.toHaveProperty(
      "allowDangerouslySkipPermissions",
    );
    expect(request.options).not.toHaveProperty("sandbox");
    expect(Object.keys(request.options.mcpServers ?? {})).toEqual([
      WORKER_SERVER_NAME,
    ]);
  });

  it("allows only its working tools, including the superagent ones, and guards each call", async () => {
    const { request } = setup();

    expect(request.options.allowedTools).toEqual(
      expect.arrayContaining([
        "Read",
        "Edit",
        "Bash",
        "mcp__superagent__ack",
        "mcp__superagent__read_thread",
        "mcp__superagent__report",
        "mcp__superagent__hand_back",
      ]),
    );
    expect(request.options.allowedTools).not.toContain("AskUserQuestion");
    const [matcher] = request.options.hooks?.PreToolUse ?? [];
    expect(matcher?.onFailure).toBe("block");
    const [guard] = matcher?.hooks ?? [];
    const decision = await guard?.(
      {
        hook_event_name: "PreToolUse",
        session_id: "s-1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/data/worktrees/abcd2345",
        tool_name: "Write",
        tool_input: { file_path: "/code/superagent/src/index.ts" },
        tool_use_id: "toolu_1",
      },
      "toolu_1",
      { signal: new AbortController().signal },
    );
    expect(decision).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });

  it("runs shell commands in the sandbox when asked, writing only to the worktree and the checkout's git directory", () => {
    const { request } = setup({ sandbox: true });

    expect(request.options.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: expect.arrayContaining(["github.com"]) },
      filesystem: {
        allowWrite: ["/data/worktrees/abcd2345", "/code/superagent/.git"],
      },
    });
  });

  it("resumes the task's session when it has one", () => {
    const { request } = setup({ task: { ...queuedTask, sessionId: "s-1" } });
    expect(request.options.resume).toBe("s-1");
  });

  it("sends each input as a prompt with its own uuid, labeling Slack messages with their number and others with their source", async () => {
    const { nextPrompt, session } = setup();

    session.send([taskInput({ id: 3, source: "github", text: "CI failed" })]);

    const prompts = [
      await nextPrompt(),
      await nextPrompt(),
      await nextPrompt(),
    ];
    expect(prompts.map((prompt) => prompt?.message.content)).toEqual([
      "[message 1] fix the flaky test",
      "[system] restarted",
      "[github] CI failed",
    ]);
    expect(new Set(prompts.map((prompt) => prompt?.uuid)).size).toBe(3);
  });

  it("passes on the session ID, and which inputs each turn read, until nothing is left unread", async () => {
    const { conversationMessages, events, nextPrompt } = setup();
    const firstUuid = (await nextPrompt())?.uuid;
    const secondUuid = (await nextPrompt())?.uuid;

    conversationMessages.push({
      type: "system",
      subtype: "init",
      session_id: "s-1",
    });
    conversationMessages.push({ type: "assistant", message: {} });
    conversationMessages.push(turnResult({ user_message_uuids: [firstUuid] }));
    conversationMessages.push(
      turnResult({ user_message_uuid: secondUuid, result: "All done." }),
    );
    await vi.waitFor(() => expect(events.onTurnEnd).toHaveBeenCalledTimes(2));

    expect(events.onSessionId).toHaveBeenCalledExactlyOnceWith("s-1");
    expect(events.onTurnEnd.mock.calls).toEqual([
      [
        {
          readInputIds: [1],
          isError: false,
          resultText: "Done.",
          isIdle: false,
        },
      ],
      [
        {
          readInputIds: [2],
          isError: false,
          resultText: "All done.",
          isIdle: true,
        },
      ],
    ]);
  });

  it("isn't idle while the session still has turns queued", async () => {
    const { conversationMessages, events } = setup();

    conversationMessages.push(turnResult({ queued_turn_count: 1 }));

    await vi.waitFor(() =>
      expect(events.onTurnEnd).toHaveBeenCalledExactlyOnceWith({
        readInputIds: [1, 2],
        isError: false,
        resultText: "Done.",
        isIdle: false,
      }),
    );
  });

  it("passes on an error turn with its errors as the text", async () => {
    const { conversationMessages, events } = setup();

    conversationMessages.push(
      turnResult({
        subtype: "error_max_turns",
        is_error: true,
        result: undefined,
        errors: ["Reached the maximum number of turns"],
      }),
    );

    await vi.waitFor(() =>
      expect(events.onTurnEnd).toHaveBeenCalledWith(
        expect.objectContaining({
          isError: true,
          resultText: "Reached the maximum number of turns",
        }),
      ),
    );
  });

  it("ends without an error when the conversation finishes, and closes it", async () => {
    const { conversation, conversationMessages, ended } = setup();
    conversationMessages.end();
    expect(await ended).toBeUndefined();
    expect(conversation.close).toHaveBeenCalled();
  });

  it("ends with the error when the conversation fails", async () => {
    const failure = new Error("Claude Code exited with code 1");
    const { ended } = setup({
      iterate: () => ({ next: () => Promise.reject(failure) }),
    });
    expect(await ended).toBe(failure);
  });

  it("interrupts, ends its input, or closes the conversation on request", async () => {
    const { conversation, nextPrompt, session } = setup();
    await nextPrompt();
    await nextPrompt();

    await session.interrupt();
    session.end();

    expect(conversation.interrupt).toHaveBeenCalledOnce();
    expect(await nextPrompt()).toBeUndefined();
    expect(() => session.send([taskInput({ id: 3 })])).toThrow(/ended/);
    session.close();
    expect(conversation.close).toHaveBeenCalled();
  });
});

describe("createAckTool", () => {
  it("puts 👀 on the owner's messages and says what it did", async () => {
    const ack = vi.fn(() => "Put 👀 on the owner's message.");

    const answer = await createAckTool(ack).handler({}, undefined);

    expect(ack).toHaveBeenCalledOnce();
    expect(answer).toEqual({
      content: [{ type: "text", text: "Put 👀 on the owner's message." }],
    });
  });
});

describe("createReadThreadTool", () => {
  it("answers with the thread, or with why it couldn't be read", async () => {
    const readThread = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("[owner]\nfix the flaky test")
      .mockRejectedValueOnce(new Error("ratelimited"));
    const readThreadTool = createReadThreadTool(readThread);

    expect(readThreadTool.name).toBe("read_thread");
    expect(await readThreadTool.handler({}, undefined)).toEqual({
      content: [{ type: "text", text: "[owner]\nfix the flaky test" }],
    });
    expect(await readThreadTool.handler({}, undefined)).toEqual({
      content: [
        { type: "text", text: "Couldn't read the thread: ratelimited" },
      ],
      isError: true,
    });
  });
});

describe("createReportTool", () => {
  it("passes the worker's report on, and answers with the outcome", async () => {
    const report = vi.fn((_report: WorkerReport): ToolOutcome => ({
      isAccepted: false,
      reply: "Not posted: a ready report needs the pull request's URL.",
    }));
    const reportTool = createReportTool(report);

    const answer = await reportTool.handler(
      {
        state: "ready",
        summary: "Done.",
        question: undefined,
        prUrl: undefined,
      },
      undefined,
    );

    expect(reportTool.name).toBe("report");
    expect(report).toHaveBeenCalledExactlyOnceWith({
      state: "ready",
      summary: "Done.",
    });
    expect(answer).toEqual({
      content: [
        {
          type: "text",
          text: "Not posted: a ready report needs the pull request's URL.",
        },
      ],
      isError: true,
    });
  });
});

describe("createHandBackTool", () => {
  it("passes the message the worker names and its reason on, and answers with the outcome", async () => {
    const handBack = vi.fn(
      (_inputId: number, _reason: string): ToolOutcome => ({
        isAccepted: true,
        reply: "Handed the message back.",
      }),
    );
    const handBackTool = createHandBackTool(handBack);

    const answer = await handBackTool.handler(
      { message_id: 2, reason: "It asks about another repo." },
      undefined,
    );

    expect(handBackTool.name).toBe("hand_back");
    expect(handBack).toHaveBeenCalledExactlyOnceWith(
      2,
      "It asks about another repo.",
    );
    expect(answer).toEqual({
      content: [{ type: "text", text: "Handed the message back." }],
      isError: false,
    });
  });
});
