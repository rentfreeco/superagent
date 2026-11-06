import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  DecisionResult,
  IgnoreDecision,
  ReplyDecision,
  StartTaskDecision,
  TaskDecision,
} from "./decide.ts";

export interface RouterActions {
  startTask(decision: StartTaskDecision): DecisionResult;
  reply(decision: ReplyDecision): DecisionResult;
  attach(decision: TaskDecision): DecisionResult;
  stop(decision: TaskDecision): DecisionResult;
  ignore(decision: IgnoreDecision): DecisionResult;
  listTasks(which: "open" | "all"): string;
}

export const ROUTER_SERVER_NAME = "router";

export const ROUTER_TOOL_NAMES = [
  "start_task",
  "reply",
  "attach",
  "stop",
  "ignore",
  "list_tasks",
].map((toolName) => `mcp__${ROUTER_SERVER_NAME}__${toolName}`);

const candidateId = z
  .number()
  .int()
  .positive()
  .describe("The candidate's candidate_id.");
const reason = z
  .string()
  .min(1)
  .describe("One sentence on why, kept with the decision.");
const taskId = z.string().min(1).describe("The task's ID, from list_tasks.");

const answer = async ({
  isAccepted,
  reply,
}: DecisionResult): Promise<CallToolResult> => ({
  content: [{ type: "text", text: reply }],
  isError: !isAccepted,
});

const listed = async (text: string): Promise<CallToolResult> => ({
  content: [{ type: "text", text }],
});

export const createRouterTools = (actions: RouterActions) => ({
  start_task: tool(
    "start_task",
    "Start a task for the candidate in a repo. Its worker reads the original message.",
    {
      candidate_id: candidateId,
      repo: z
        .string()
        .min(1)
        .describe("The repo's name, from the list in your instructions."),
      title: z.string().min(1).describe("A short title for the task."),
      reason,
    },
    async (args) =>
      answer(
        actions.startTask({
          candidateId: args.candidate_id,
          repo: args.repo,
          title: args.title,
          reason: args.reason,
        }),
      ),
  ),
  reply: tool(
    "reply",
    "Reply in the candidate's thread: a quick answer, or one concrete question.",
    { candidate_id: candidateId, text: z.string().min(1), reason },
    async (args) =>
      answer(
        actions.reply({
          candidateId: args.candidate_id,
          text: args.text,
          reason: args.reason,
        }),
      ),
  ),
  attach: tool(
    "attach",
    "Pass the candidate to an existing task it points at explicitly.",
    { candidate_id: candidateId, task_id: taskId, reason },
    async (args) =>
      answer(
        actions.attach({
          candidateId: args.candidate_id,
          taskId: args.task_id,
          reason: args.reason,
        }),
      ),
  ),
  stop: tool(
    "stop",
    "Stop a task the owner asked to stop. The confirmation goes in the candidate's thread.",
    { candidate_id: candidateId, task_id: taskId, reason },
    async (args) =>
      answer(
        actions.stop({
          candidateId: args.candidate_id,
          taskId: args.task_id,
          reason: args.reason,
        }),
      ),
  ),
  ignore: tool(
    "ignore",
    "Leave the candidate unanswered, such as thanks or chat.",
    { candidate_id: candidateId, reason },
    async (args) =>
      answer(
        actions.ignore({ candidateId: args.candidate_id, reason: args.reason }),
      ),
  ),
  list_tasks: tool(
    "list_tasks",
    "List tasks with their ID, state, title, repo, thread, and pull request.",
    {
      which: z
        .enum(["open", "all"])
        .describe(
          "open: not done or stopped. all: the most recent of every state.",
        ),
    },
    async (args) => listed(actions.listTasks(args.which)),
  ),
});
