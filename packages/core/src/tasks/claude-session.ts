import { homedir } from "node:os";
import path from "node:path";
import {
  createSdkMcpServer,
  query,
  type SandboxSettings,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { WORKER_EFFORT, WORKER_MODEL } from "../constants.ts";
import { agentAccountEnvironment } from "../github/agent-account-environment.ts";
import type { AgentAccount } from "../github/resolve-agent-account.ts";
import type { Repo } from "../repos/config.ts";
import type { TaskInput } from "../store/inputs.ts";
import type { Task } from "../store/tasks.ts";
import { describeError } from "../utils/describe-error.ts";
import {
  type AgentPrompt,
  type StartConversation,
  startAgentSession,
} from "./agent-session.ts";
import type { Worktree } from "./prepare-worktree.ts";
import { REPORT_STATES, type WorkerReport } from "./record-report.ts";
import { type ToolOutcome, toToolResult } from "./tool-outcome.ts";
import { createWorkerGuard } from "./worker-guard.ts";
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
  ack(): Promise<string>;
  readThread(): Promise<string>;
  report(report: WorkerReport): ToolOutcome;
  handBack(inputId: number, reason: string): ToolOutcome;
  nothingToReport(): ToolOutcome;
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

export interface ClaudeSessionStarterOptions {
  startConversation?: StartConversation;
  environment?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  /** Run the worker's shell commands in Claude Code's sandbox. */
  sandbox?: boolean;
  /** Act on GitHub as this account; without one, workers use the machine's own GitHub logins. */
  gitHubAccount?: AgentAccount | undefined;
}

export const WORKER_SERVER_NAME = "superagent";

export const WORKER_BUILT_IN_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash",
  "Task",
  "WebSearch",
  "Skill",
];

const WORKER_TOOLS = [
  ...WORKER_BUILT_IN_TOOLS,
  ...["ack", "read_thread", "report", "hand_back", "nothing_to_report"].map(
    (toolName) => `mcp__${WORKER_SERVER_NAME}__${toolName}`,
  ),
];

/**
 * Set for every worker: Claude Code backgrounds a long command and ends the
 * turn, and the runner ends an idle session, so a backgrounded build would
 * never finish. In the foreground it runs to its own timeout of up to ten minutes.
 */
const WORKER_FIXED_ENVIRONMENT = { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" };

const WORKER_ENVIRONMENT_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "CLAUDE_CONFIG_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "SSH_AUTH_SOCK",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);

const WORKER_ENVIRONMENT_PREFIXES = ["LC_", "ANTHROPIC_", "CLAUDE_CODE_"];

const WORKER_SANDBOX_DOMAINS = [
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "crates.io",
  "*.crates.io",
];

const toAgentPrompt = ({ id, source, text }: TaskInput): AgentPrompt => ({
  id,
  text:
    source === "slack" || source === "router"
      ? `[message ${id}] ${text}`
      : `[${source}] ${text}`,
});

export const agentEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        WORKER_ENVIRONMENT_NAMES.has(name) ||
        WORKER_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix)),
    ),
  );

const workerSandbox = (
  worktree: Worktree,
  gitDirectory: string,
): SandboxSettings => ({
  enabled: true,
  failIfUnavailable: true,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: false,
  network: { allowedDomains: WORKER_SANDBOX_DOMAINS },
  filesystem: { allowWrite: [worktree.path, gitDirectory] },
});

export const createAckTool = (ack: WorkerSessionOptions["ack"]) =>
  tool(
    "ack",
    "Put 👀 on the owner's messages you've been given and haven't finished yet, so they know you've seen them. Call it when you start on a message from the owner.",
    {},
    async () => ({ content: [{ type: "text", text: await ack() }] }),
  );

export const createReadThreadTool = (
  readThread: WorkerSessionOptions["readThread"],
) =>
  tool(
    "read_thread",
    "Read the task's Slack thread so far, oldest first: the owner's messages and superagent's own posts, including your earlier reports.",
    {},
    async () => {
      try {
        return { content: [{ type: "text", text: await readThread() }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Couldn't read the thread: ${describeError(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

export const createReportTool = (report: WorkerSessionOptions["report"]) =>
  tool(
    "report",
    "Say where the task stands. It's posted where the messages you're answering came from: the task's Slack thread for Slack messages, the pull request for [github] ones.",
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
    async (workerReport) => toToolResult(report(workerReport)),
  );

export const createHandBackTool = (
  handBack: WorkerSessionOptions["handBack"],
) =>
  tool(
    "hand_back",
    "Hand a message from the owner back to superagent's router, when it isn't about this task, such as a new request sent in your thread. The router decides what happens to it.",
    {
      message_id: z
        .number()
        .int()
        .positive()
        .describe("The N from the message's [message N] label."),
      reason: z
        .string()
        .min(1)
        .describe("One sentence on why the message isn't about this task."),
    },
    async (args) => toToolResult(handBack(args.message_id, args.reason)),
  );

export const createNothingToReportTool = (
  nothingToReport: WorkerSessionOptions["nothingToReport"],
) =>
  tool(
    "nothing_to_report",
    "End this turn without posting anything, leaving the task where it stood. Use it only when this turn handed messages back and nothing else needs an answer.",
    {},
    async () => toToolResult(nothingToReport()),
  );

export const createClaudeSessionStarter =
  ({
    startConversation = query,
    environment = process.env,
    homeDirectory = homedir(),
    sandbox = false,
    gitHubAccount,
  }: ClaudeSessionStarterOptions = {}): StartWorkerSession =>
  ({
    task,
    repo,
    worktree,
    inputs,
    ack,
    readThread,
    report,
    handBack,
    nothingToReport,
    events,
  }) => {
    const gitDirectory = path.join(repo.path, ".git");
    const session = startAgentSession({
      startConversation,
      options: {
        cwd: worktree.path,
        resume: task.sessionId ?? undefined,
        model: WORKER_MODEL,
        effort: WORKER_EFFORT,
        tools: WORKER_BUILT_IN_TOOLS,
        permissionMode: "dontAsk",
        allowedTools: WORKER_TOOLS,
        strictMcpConfig: true,
        hooks: {
          PreToolUse: [
            {
              hooks: [
                createWorkerGuard({
                  worktreePath: worktree.path,
                  gitDirectory,
                  baseBranch: repo.baseBranch,
                  homeDirectory,
                }),
              ],
              onFailure: "block",
            },
          ],
        },
        ...(sandbox ? { sandbox: workerSandbox(worktree, gitDirectory) } : {}),
        settingSources: ["project"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: workerInstructions({ task, repo, worktree }),
        },
        mcpServers: {
          [WORKER_SERVER_NAME]: createSdkMcpServer({
            name: WORKER_SERVER_NAME,
            version: "1.0.0",
            tools: [
              createAckTool(ack),
              createReadThreadTool(readThread),
              createReportTool(report),
              createHandBackTool(handBack),
              createNothingToReportTool(nothingToReport),
            ],
          }),
        },
        env: {
          ...agentEnvironment(environment),
          ...(gitHubAccount === undefined
            ? {}
            : agentAccountEnvironment(gitHubAccount)),
          ...WORKER_FIXED_ENVIRONMENT,
        },
        title: task.title,
      },
      prompts: inputs.map(toAgentPrompt),
      events: {
        onSessionId: events.onSessionId,
        onTurnEnd: ({ readIds, ...turn }) =>
          events.onTurnEnd({ ...turn, readInputIds: readIds }),
        onEnd: events.onEnd,
      },
    });

    return {
      send: (nextInputs) => session.send(nextInputs.map(toAgentPrompt)),
      interrupt: session.interrupt,
      end: session.end,
      close: session.close,
    };
  };
