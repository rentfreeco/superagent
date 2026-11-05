export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export const OUTBOX_MAX_ATTEMPTS = 8;
export const OUTBOX_BASE_RETRY_DELAY_MS = 5_000;
export const OUTBOX_MAX_RETRY_DELAY_MS = 5 * 60_000;
export const OUTBOX_POLL_INTERVAL_MS = 1_000;

export const SLACK_DELIVERY_TIMEOUT_MS = 10_000;

export const TASK_ID_LENGTH = 8;
export const TASK_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
