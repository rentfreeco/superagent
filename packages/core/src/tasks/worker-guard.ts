import path from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export interface WorkerGuardOptions {
  worktreePath: string;
  /** The checkout's .git directory, where a worktree's commits and refs are written. */
  gitDirectory: string;
  baseBranch: string;
  homeDirectory: string;
}

interface CommandRule {
  pattern: RegExp;
  reason: string;
}

const CREDENTIAL_DIRECTORIES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".config/gh",
  ".claude",
  ".docker",
];
const CREDENTIAL_FILES = [".netrc", ".git-credentials", ".npmrc", ".pypirc"];
const FILE_WRITING_TOOLS = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);
const FILE_READING_TOOLS = new Set(["Read", "Grep", "Glob"]);

const commandInputSchema = z.object({ command: z.string() });
const fileInputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  path: z.string().optional(),
});
const preToolUseSchema = z.object({
  hook_event_name: z.literal("PreToolUse"),
  tool_name: z.string(),
  tool_input: z.unknown(),
});

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const commandRules = (baseBranch: string): CommandRule[] => [
  {
    pattern: /\bgh\s+pr\s+merge\b/,
    reason: "Merging is the owner's call. Report ready instead.",
  },
  {
    pattern: /\bgh\s+pr\s+review\b[^|;&]*--approve\b/,
    reason: "Approving a pull request is the owner's call.",
  },
  {
    pattern: /\bgh\s+issue\s+close\b/,
    reason: "Closing an issue is the owner's call.",
  },
  {
    pattern: /\bgh\s+(repo|release)\s+delete\b/,
    reason: "Deleting a repository or release is not part of a task.",
  },
  {
    pattern: /\bgit\s+push\b[^|;&]*(\s--force(?!-with-lease)\b|\s-f\b|\s\+\S)/,
    reason:
      "Force pushes are refused. Use --force-with-lease on your own branch if you must rewrite it.",
  },
  {
    pattern: /\bgit\s+push\b[^|;&]*\s(--delete|-d|--mirror)\b/,
    reason: "Deleting remote branches is refused.",
  },
  {
    pattern: new RegExp(
      `\\bgit\\s+push\\b[^|;&]*[\\s:](refs/heads/)?${escapeRegExp(baseBranch)}(\\s|$|[|;&])`,
    ),
    reason: `Pushing to ${baseBranch} is refused. Push your own branch and open a pull request.`,
  },
];

const isInside = (directory: string, filePath: string): boolean => {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const isCredentialPath = (homeDirectory: string, filePath: string): boolean =>
  CREDENTIAL_DIRECTORIES.some((directory) =>
    isInside(path.join(homeDirectory, directory), filePath),
  ) ||
  CREDENTIAL_FILES.some(
    (fileName) => filePath === path.join(homeDirectory, fileName),
  );

const resolvePath = (
  { worktreePath, homeDirectory }: WorkerGuardOptions,
  filePath: string,
): string =>
  filePath === "~" || filePath.startsWith("~/")
    ? path.join(homeDirectory, filePath.slice(1))
    : path.resolve(worktreePath, filePath);

export const refusalFor = (
  toolName: string,
  toolInput: unknown,
  options: WorkerGuardOptions,
): string | undefined => {
  if (toolName === "Bash") {
    const command = commandInputSchema.safeParse(toolInput);
    if (!command.success) return undefined;
    return commandRules(options.baseBranch).find(({ pattern }) =>
      pattern.test(command.data.command),
    )?.reason;
  }
  const files = fileInputSchema.safeParse(toolInput);
  if (!files.success) return undefined;
  const target =
    files.data.file_path ?? files.data.notebook_path ?? files.data.path;
  if (target === undefined) return undefined;
  const filePath = resolvePath(options, target);
  if (
    FILE_WRITING_TOOLS.has(toolName) &&
    !isInside(options.worktreePath, filePath) &&
    !isInside(options.gitDirectory, filePath)
  ) {
    return `Writing outside your worktree (${options.worktreePath}) is refused.`;
  }
  if (
    FILE_READING_TOOLS.has(toolName) &&
    isCredentialPath(options.homeDirectory, filePath)
  ) {
    return "Reading credential files is refused.";
  }
  return undefined;
};

export const createWorkerGuard =
  (options: WorkerGuardOptions): HookCallback =>
  async (input) => {
    const toolUse = preToolUseSchema.safeParse(input);
    if (!toolUse.success) return {};
    const reason = refusalFor(
      toolUse.data.tool_name,
      toolUse.data.tool_input,
      options,
    );
    if (reason === undefined) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  };
