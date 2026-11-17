import { fileURLToPath } from "node:url";

export const CONFIG_PATH = fileURLToPath(
  new URL("../../../superagent.config.ts", import.meta.url),
);

export const STORE_FILE_NAME = "state.db";
export const WORKTREES_DIRECTORY_NAME = "worktrees";
export const ROUTER_DIRECTORY_NAME = "router";
export const CACHE_DIRECTORY_NAME = "cache";
/** Claude Code refuses file edits under any directory with this name. */
export const CLAUDE_DIRECTORY_NAME = ".claude";
