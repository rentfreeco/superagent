import { randomUUID, type UUID } from "node:crypto";
import {
  createSdkMcpServer,
  type Options,
  query,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { WORKER_EFFORT, WORKER_MODEL } from "../constants.ts";
import type { Repo } from "../repos/config.ts";
import type { TaskInput } from "../store/inputs.ts";
import type { Task } from "../store/tasks.ts";
import { createAsyncQueue } from "../utils/create-async-queue.ts";
import type { Worktree } from "./prepare-worktree.ts";
import {
  REPORT_STATES,
  type ReportOutcome,
  type WorkerReport,
} from "./record-report.ts";
import { workerInstructions } from "./worker-instructions.ts";

export interface WorkerTurn {
  readInputIds: number[];
  isError: boolean;
  resultText: string;
  isIdle: boolean;
}

export interface WorkerSessionEvents {
  onSessionId(sessionId: string): void;
  onTurnEnd(turn: WorkerTurn): void;
  onEnd(error: unknown): void;
}

export interface WorkerSessionOptions {
  task: Task;
  repo: Repo;
  worktree: Worktree;
  inputs: readonly TaskInput[];
  report(report: WorkerReport): ReportOutcome;
  events: WorkerSessionEvents;
}

export interface WorkerSession {
  send(inputs: readonly TaskInput[]): void;
  interrupt(): Promise<void>;
  end(): void;
  close(): void;
}

export type StartWorkerSession = (
  options: WorkerSessionOptions,
) => WorkerSession;

export interface WorkerConversation extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  close(): void;
}

export interface ConversationRequest {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}

export type StartConversation = (
  request: ConversationRequest,
) => WorkerConversation;

export interface ClaudeSessionStarterOptions {
  startConversation?: StartConversation;
  environment?: Readonly<Record<string, string | undefined>>;
}

export const REPORT_SERVER_NAME = "superagent";

const sessionInitSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
});

const turnResultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  user_message_uuid: z.string().optional(),
  user_message_uuids: z.array(z.string()).optional(),
  queued_turn_count: z.number().optional(),
});

const toPrompt = ({ source, text }: TaskInput, uuid: UUID): SDKUserMessage => ({
  type: "user",
  message: {
    role: "user",
    content: source === "slack" ? text : `[${source}] ${text}`,
  },
  parent_tool_use_id: null,
  uuid,
});

const withoutSlackSettings = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("SLACK_")),
  );

export const createReportTool = (report: WorkerSessionOptions["report"]) =>
  tool(
    "report",
    "Tell the owner where the task stands. It posts to the task's Slack thread, and nothing else you write reaches them.",
    {
      state: z
        .enum(REPORT_STATES)
        .describe(
          "ready: a pull request is open. waiting: you need the owner's answer. done: finished without a pull request. blocked: you need something to go on. failed: it can't be done.",
        ),
      summary: z.string().min(1).describe("Two or three lines for the owner."),
      question: z
        .string()
        .optional()
        .describe("For waiting: the one question the owner should answer."),
      prUrl: z
        .string()
        .optional()
        .describe(
          "For ready: the pull request's URL, as gh pr create prints it.",
        ),
    },
    async (workerReport) => {
      const { isAccepted, reply } = report(workerReport);
      return { content: [{ type: "text", text: reply }], isError: !isAccepted };
    },
  );

export const createClaudeSessionStarter =
  ({
    startConversation = query,
    environment = process.env,
  }: ClaudeSessionStarterOptions = {}): StartWorkerSession =>
  ({ task, repo, worktree, inputs, report, events }) => {
    const prompts = createAsyncQueue<SDKUserMessage>();
    const unreadInputIds = new Map<string, number>();

    const send = (nextInputs: readonly TaskInput[]): void => {
      for (const input of nextInputs) {
        const uuid = randomUUID();
        unreadInputIds.set(uuid, input.id);
        prompts.push(toPrompt(input, uuid));
      }
    };

    const takeReadInputIds = (consumedUuids: readonly string[]): number[] =>
      consumedUuids.flatMap((uuid) => {
        const inputId = unreadInputIds.get(uuid);
        unreadInputIds.delete(uuid);
        return inputId === undefined ? [] : [inputId];
      });

    const handleMessage = (message: unknown): void => {
      const init = sessionInitSchema.safeParse(message);
      if (init.success) {
        events.onSessionId(init.data.session_id);
        return;
      }
      const result = turnResultSchema.safeParse(message);
      if (!result.success) return;
      const turn = result.data;
      const consumedUuids =
        turn.user_message_uuids ??
        (turn.user_message_uuid === undefined
          ? [...unreadInputIds.keys()]
          : [turn.user_message_uuid]);
      events.onTurnEnd({
        readInputIds: takeReadInputIds(consumedUuids),
        isError: turn.is_error || turn.subtype !== "success",
        resultText:
          turn.subtype === "success"
            ? (turn.result ?? "")
            : (turn.errors ?? []).join("\n"),
        isIdle:
          unreadInputIds.size === 0 && (turn.queued_turn_count ?? 0) === 0,
      });
    };

    send(inputs);
    const conversation = startConversation({
      prompt: prompts,
      options: {
        cwd: worktree.path,
        resume: task.sessionId ?? undefined,
        model: WORKER_MODEL,
        effort: WORKER_EFFORT,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: workerInstructions({ task, repo, worktree }),
        },
        mcpServers: {
          [REPORT_SERVER_NAME]: createSdkMcpServer({
            name: REPORT_SERVER_NAME,
            version: "1.0.0",
            tools: [createReportTool(report)],
          }),
        },
        env: withoutSlackSettings(environment),
        title: task.title,
      },
    });

    const consume = async (): Promise<unknown> => {
      try {
        for await (const message of conversation) handleMessage(message);
        return undefined;
      } catch (error) {
        return error;
      } finally {
        prompts.end();
        conversation.close();
      }
    };
    void consume().then(events.onEnd);

    return {
      send,
      interrupt: async () => {
        await conversation.interrupt();
      },
      end: prompts.end,
      close: () => {
        prompts.end();
        conversation.close();
      },
    };
  };
