/**
 * Remembers keys for a fixed window so repeated deliveries can be dropped.
 *
 * Slack redelivers an event under the same event_id when it doesn't see the
 * ack in time (up to three retries over about five minutes), and a Socket
 * Mode reconnect can replay one, so the default window covers both.
 */
export class Deduper {
  readonly #ttlMs: number;
  readonly #now: () => number;
  // The TTL is constant, so insertion order is expiry order and pruning can
  // stop at the first live entry.
  readonly #expiresAt = new Map<string, number>();

  constructor({
    ttlMs = 15 * 60_000,
    now = Date.now,
  }: { ttlMs?: number; now?: () => number } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** Records `key` and reports whether this is its first sighting within the window. */
  firstSeen(key: string): boolean {
    const now = this.#now();
    for (const [seenKey, expiresAt] of this.#expiresAt) {
      if (expiresAt > now) break;
      this.#expiresAt.delete(seenKey);
    }
    if (this.#expiresAt.has(key)) return false;
    this.#expiresAt.set(key, now + this.#ttlMs);
    return true;
  }
}
