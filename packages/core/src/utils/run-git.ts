import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readStringField } from "./read-string-field.ts";

const execFileAsync = promisify(execFile);

export const runGit = async (
  directory: string,
  args: readonly string[],
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync("git", ["-C", directory, ...args]);
    return stdout.trim();
  } catch (error) {
    const stderr =
      error instanceof Error ? readStringField(error, "stderr")?.trim() : "";
    throw new Error(
      `git ${args.join(" ")} failed in ${directory}: ${stderr || String(error)}`,
      { cause: error },
    );
  }
};
