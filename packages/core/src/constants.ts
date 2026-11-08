export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_BASE_RETRY_DELAY_MS = 5_000;
export const OUTBOX_MAX_RETRY_DELAY_MS = 5 * 60_000;
export const OUTBOX_POLL_INTERVAL_MS = 1_000;

export const SLACK_DELIVERY_TIMEOUT_MS = 10_000;

export const GITHUB_API_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
export const GITHUB_ERROR_BODY_MAX_LENGTH = 300;
export const GITHUB_NOREPLY_EMAIL_DOMAIN = "users.noreply.github.com";
export const GITHUB_PAGE_SIZE = 100;
export const GITHUB_MAX_PAGES = 10;

export const PULL_REQUEST_POLL_INTERVAL_MS = 60_000;
export const PULL_REQUEST_MAX_BOT_ROUNDS = 3;
export const PULL_REQUEST_INPUT_MAX_LENGTH = 4_000;

export const TASK_ID_LENGTH = 8;
export const TASK_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export const TASK_TITLE_MAX_LENGTH = 80;
export const TASK_ACK_REACTION = "eyes";
export const TASK_DONE_REACTION = "white_check_mark";
/** GitHub's reactions have no check mark, so a finished comment gets a thumbs-up, as Greptile does. */
export const GITHUB_DONE_REACTION = "+1";
export const TASK_STOP_REACTION = "octagonal_sign";
/** What the router reacts with to a message it lets be: thanks, an acknowledgement, a greeting, or anything else. */
export const ROUTER_IGNORE_REACTIONS = [
  "heart",
  "thumbsup",
  "wave",
  "white_check_mark",
] as const;
export const TASK_MAX_SESSIONS = 3;
export const TASK_RUNNER_POLL_INTERVAL_MS = 5_000;
export const TASK_FALLBACK_SUMMARY_MAX_LENGTH = 3_000;
export const TASK_THREAD_READ_MAX_LENGTH = 40_000;

export const RECOVERY_ENDED_TASK_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const WORKER_MODEL = "claude-opus-5-5";
export const WORKER_EFFORT = "high";

export const ROUTER_TASK_LIST_LIMIT = 30;
export const ROUTER_EFFORT = "low";
export const ROUTER_POLL_INTERVAL_MS = 5_000;
export const ROUTER_DECISION_TIMEOUT_MS = 5 * 60_000;
