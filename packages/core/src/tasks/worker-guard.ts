import { realpath } from "node:fs/promises";
import path from "node:path";
import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { splitShellCommands } from "../utils/split-shell-commands.ts";
import type { TaskPullRequest } from "./message-reactions.ts";

export interface WorkerGuardOptions {
  worktreePath: string;
  /** The checkout's .git directory, where a worktree's commits and refs are written. */
  gitDirectory: string;
  baseBranch: string;
  homeDirectory: string;
  /** The task's pull request, once it has one: the worker answers there only through its report. */
  pullRequest?: () => TaskPullRequest | undefined;
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
const SEARCH_TOOLS = new Set(["Grep", "Glob"]);
const GH_OPTIONS_WITH_VALUES = new Set([
  "-R",
  "--repo",
  "-b",
  "--body",
  "-F",
  "--body-file",
]);
const GIT_OPTIONS_WITH_VALUES = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);
const PUSH_OPTIONS_WITH_VALUES = new Set([
  "--repo",
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
]);

const MERGE_REFUSAL = "Merging is the owner's call. Report ready instead.";
const APPROVE_REFUSAL = "Approving a pull request is the owner's call.";
const CLOSE_REFUSAL = "Closing an issue is the owner's call.";
const DELETE_REFUSAL =
  "Deleting a repository or release is not part of a task.";
const FORCE_PUSH_REFUSAL =
  "Force pushes are refused. Use --force-with-lease on your own branch if you must rewrite it.";
const DELETE_BRANCH_REFUSAL = "Deleting remote branches is refused.";
const COMMENT_REFUSAL =
  "Your report is your answer on the pull request: it's posted there for [github] messages, so a comment of your own would say it twice. Reply only in a review comment's thread, then report.";
const GH_API_FIELD_OPTION =
  /^(?:-[fF]|--field|--raw-field|--input)(?:=|$)|^-[fF]\S/;
const READ_REFUSAL = "Reading credential files is refused.";
const SEARCH_REFUSAL =
  "Searching a directory that holds credential files is refused. Search inside your worktree.";

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

const positionalIndexes = (
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): number[] => {
  const indexes: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") {
      return [
        ...indexes,
        ...args.slice(index + 1).map((_, offset) => index + 1 + offset),
      ];
    }
    if (!arg.startsWith("-")) indexes.push(index);
    else if (optionsWithValues.has(arg)) index += 1;
  }
  return indexes;
};

const positionals = (
  args: readonly string[],
  optionsWithValues: ReadonlySet<string>,
): string[] =>
  positionalIndexes(args, optionsWithValues).map((index) => args[index] ?? "");

const GH_API_REFUSALS: readonly (readonly [RegExp, string])[] = [
  [
    /\/pulls\/\d+\/merge\b|\bmergePullRequest\b|\benablePullRequestAutoMerge\b/,
    MERGE_REFUSAL,
  ],
  [/\bevent\s*[=:]\s*"?APPROVE\b/, APPROVE_REFUSAL],
  [
    /\bcloseIssue\b|\/issues\/\d+\b.*\bstate\s*[=:]\s*"?closed\b/,
    CLOSE_REFUSAL,
  ],
];

/** The value of an option given as `--name value`, `--name=value`, or `-Nvalue`. */
const optionValue = (
  args: readonly string[],
  names: readonly string[],
): string | undefined => {
  for (const [index, arg] of args.entries()) {
    if (names.includes(arg)) return args[index + 1];
    for (const name of names) {
      const prefix = name.startsWith("--") ? `${name}=` : name;
      if (arg.startsWith(prefix) && arg.length > prefix.length) {
        return arg.slice(prefix.length);
      }
    }
  }
  return undefined;
};

/** gh api writes when its method isn't GET; without one, when it sends fields or an input file. */
const isGhApiWrite = (args: readonly string[]): boolean => {
  const method = optionValue(args, ["-X", "--method"]);
  return method === undefined
    ? args.some((arg) => GH_API_FIELD_OPTION.test(arg))
    : method.toUpperCase() !== "GET";
};

/** `owner/name`, or `HOST/owner/name` as gh's --repo takes it. */
const isRepository = (named: string, repository: string): boolean => {
  const lowerNamed = named.toLowerCase();
  const lowerRepository = repository.toLowerCase();
  return (
    lowerNamed === lowerRepository || lowerNamed.endsWith(`/${lowerRepository}`)
  );
};

const ghApiRefusal = (
  args: readonly string[],
  pullRequest: TaskPullRequest | undefined,
): string | undefined => {
  const request = args.join(" ");
  const lowerRequest = request.toLowerCase();
  const isTaskCommentList =
    pullRequest !== undefined &&
    [pullRequest.repository, "{owner}/{repo}"].some((repository) =>
      lowerRequest.includes(
        `repos/${repository.toLowerCase()}/issues/${pullRequest.number}/comments`,
      ),
    );
  if (isTaskCommentList && isGhApiWrite(args)) return COMMENT_REFUSAL;
  return GH_API_REFUSALS.find(([pattern]) => pattern.test(request))?.[1];
};

/**
 * Whether a gh pr or issue command names the task's pull request: by
 * number or URL in the task's repo, or by nothing, which means the
 * current branch's.
 */
const namesTaskPullRequest = (
  args: readonly string[],
  group: string | undefined,
  selector: string | undefined,
  { repository, number }: TaskPullRequest,
): boolean => {
  const repoOption = optionValue(args, ["-R", "--repo"]);
  if (repoOption !== undefined && !isRepository(repoOption, repository)) {
    return false;
  }
  if (selector === undefined) return group === "pr";
  const [, urlRepository, urlNumber] =
    selector.match(
      /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/,
    ) ?? [];
  if (urlRepository !== undefined) {
    return (
      isRepository(urlRepository, repository) && Number(urlNumber) === number
    );
  }
  return selector === String(number) || selector === `#${number}`;
};

const ghRefusal = (
  args: readonly string[],
  pullRequest: TaskPullRequest | undefined,
): string | undefined => {
  const [group, action, selector] = positionals(args, GH_OPTIONS_WITH_VALUES);
  if (group === "api") return ghApiRefusal(args, pullRequest);
  if (group === "pr" && action === "merge") return MERGE_REFUSAL;
  if (
    group === "pr" &&
    action === "review" &&
    args.some((arg) => arg === "--approve" || arg === "-a")
  ) {
    return APPROVE_REFUSAL;
  }
  if (group === "issue" && action === "close") return CLOSE_REFUSAL;
  if ((group === "repo" || group === "release") && action === "delete") {
    return DELETE_REFUSAL;
  }
  const isComment =
    (group === "pr" && (action === "comment" || action === "review")) ||
    (group === "issue" && action === "comment");
  if (
    isComment &&
    pullRequest !== undefined &&
    namesTaskPullRequest(args, group, selector, pullRequest)
  ) {
    return COMMENT_REFUSAL;
  }
  return undefined;
};

const pushDestination = (refspec: string): string => {
  const source = refspec.replace(/^\+/, "");
  const destination = source.includes(":")
    ? source.slice(source.indexOf(":") + 1)
    : source;
  return destination.replace(/^refs\/heads\//, "");
};

const gitRefusal = (
  args: readonly string[],
  baseBranch: string,
): string | undefined => {
  const [subcommandIndex] = positionalIndexes(args, GIT_OPTIONS_WITH_VALUES);
  if (subcommandIndex === undefined || args[subcommandIndex] !== "push") {
    return undefined;
  }
  const pushArgs = args.slice(subcommandIndex + 1);
  const [, ...refspecs] = positionals(pushArgs, PUSH_OPTIONS_WITH_VALUES);
  if (
    pushArgs.some(
      (arg) => arg === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg),
    ) ||
    refspecs.some((refspec) => refspec.startsWith("+"))
  ) {
    return FORCE_PUSH_REFUSAL;
  }
  if (
    pushArgs.some(
      (arg) => arg === "--delete" || arg === "-d" || arg === "--mirror",
    ) ||
    refspecs.some((refspec) => refspec.startsWith(":"))
  ) {
    return DELETE_BRANCH_REFUSAL;
  }
  if (refspecs.map(pushDestination).includes(baseBranch)) {
    return `Pushing to ${baseBranch} is refused. Push your own branch and open a pull request.`;
  }
  return undefined;
};

const commandRefusal = (
  command: string,
  { baseBranch, pullRequest }: WorkerGuardOptions,
): string | undefined => {
  const taskPullRequest = pullRequest?.();
  // Any word of a command can start the gh or git it runs, after a keyword
  // (if, do, !), a wrapper and its options (env -i, sudo -u bot, xargs), or a
  // VAR=value prefix, so every position is checked. An unquoted mention, such
  // as `echo gh pr merge`, is refused with them.
  for (const words of splitShellCommands(command)) {
    for (const [index, word] of words.entries()) {
      const program = path.basename(word);
      const args = words.slice(index + 1);
      const refusal =
        program === "gh"
          ? ghRefusal(args, taskPullRequest)
          : program === "git"
            ? gitRefusal(args, baseBranch)
            : undefined;
      if (refusal !== undefined) return refusal;
    }
  }
  return undefined;
};

const isInside = (directory: string, filePath: string): boolean => {
  const relative = path.relative(directory, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
};

const realPathOf = async (filePath: string): Promise<string> => {
  const missingSegments: string[] = [];
  let existingPath = filePath;
  for (;;) {
    try {
      return path.join(await realpath(existingPath), ...missingSegments);
    } catch {
      const parent = path.dirname(existingPath);
      if (parent === existingPath) return filePath;
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parent;
    }
  }
};

const credentialPaths = async (homeDirectory: string): Promise<string[]> => {
  const linkedPaths = [...CREDENTIAL_DIRECTORIES, ...CREDENTIAL_FILES].map(
    (name) => path.join(homeDirectory, name),
  );
  return [
    ...new Set([
      ...linkedPaths,
      ...(await Promise.all(linkedPaths.map(realPathOf))),
    ]),
  ];
};

const resolvePath = (
  { worktreePath, homeDirectory }: WorkerGuardOptions,
  filePath: string,
): string =>
  filePath === "~" || filePath.startsWith("~/")
    ? path.join(homeDirectory, filePath.slice(1))
    : path.resolve(worktreePath, filePath);

const fileRefusal = async (
  toolName: string,
  target: string,
  options: WorkerGuardOptions,
): Promise<string | undefined> => {
  const [filePath, worktreePath, gitDirectory] = await Promise.all([
    realPathOf(resolvePath(options, target)),
    realPathOf(options.worktreePath),
    realPathOf(options.gitDirectory),
  ]);
  if (
    FILE_WRITING_TOOLS.has(toolName) &&
    !isInside(worktreePath, filePath) &&
    !isInside(gitDirectory, filePath)
  ) {
    return `Writing outside your worktree (${options.worktreePath}) is refused.`;
  }
  const credentials = await credentialPaths(options.homeDirectory);
  const isCredential = credentials.some((credential) =>
    isInside(credential, filePath),
  );
  if (toolName === "Read" && isCredential) return READ_REFUSAL;
  if (
    SEARCH_TOOLS.has(toolName) &&
    (isCredential ||
      credentials.some((credential) => isInside(filePath, credential)))
  ) {
    return SEARCH_REFUSAL;
  }
  return undefined;
};

export const refusalFor = async (
  toolName: string,
  toolInput: unknown,
  options: WorkerGuardOptions,
): Promise<string | undefined> => {
  if (toolName === "Bash") {
    const command = commandInputSchema.safeParse(toolInput);
    return command.success
      ? commandRefusal(command.data.command, options)
      : undefined;
  }
  const files = fileInputSchema.safeParse(toolInput);
  if (!files.success) return undefined;
  const target =
    files.data.file_path ?? files.data.notebook_path ?? files.data.path;
  return target === undefined
    ? undefined
    : fileRefusal(toolName, target, options);
};

export const createWorkerGuard =
  (options: WorkerGuardOptions): HookCallback =>
  async (input) => {
    const toolUse = preToolUseSchema.safeParse(input);
    if (!toolUse.success) return {};
    const reason = await refusalFor(
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
