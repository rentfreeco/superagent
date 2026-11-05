# agent

The superagent bot process. It reads its settings, loads the repo config, connects to Slack, and routes every message from the owner.

## Run it

1. Set up a Slack app of your own, as `CONTRIBUTING.md` describes.
2. Copy `.env.example` to `.env` in this directory and fill in the tokens and your member ID.
3. Copy `superagent.config.example.ts` at the repository root to `superagent.config.ts` and map your channels.
4. From the repository root, run `pnpm dev`, which restarts the bot when a source file changes, or `pnpm --filter agent start` to run it once.

On startup it opens the store at `$SUPERAGENT_DATA_DIR/state.db` (`~/.superagent/state.db` unless set), connects, starts the outbox sender, then prints the bot's user ID, the mapped channels, and the store's path. `Ctrl+C` lets the sender finish the post in flight, disconnects from Slack, and closes the store before exiting.

## What it does with a message

- **A mention in a mapped channel** goes to `startTask` with the message and its repo. For now that is `acknowledgeTask`, which queues a reply naming the repo it routed to; the task runner replaces it.
- **A DM** gets a reply listing the repo channels.
- **A mention in an unmapped channel** gets a reply with the config line to add.

Nothing is posted directly. The handler queues each reply in the store's outbox and settles the event as `routed` or `replied` in the same transaction, then wakes the sender, which posts it. If handling throws, nothing is queued and the event stays `received`, which marks it for a retry after a restart.

Startup stops with a message, and exit code 1, when a setting is missing or malformed, when `superagent.config.ts` doesn't exist, or when the config is invalid.
