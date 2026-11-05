# agent

The superagent bot process. It reads its settings, loads the repo config, connects to Slack, and routes every message from the owner.

## Run it

1. Set up a Slack app of your own, as `CONTRIBUTING.md` describes.
2. Copy `.env.example` to `.env` in this directory and fill in the tokens and your member ID.
3. Copy `superagent.config.example.ts` at the repository root to `superagent.config.ts` and map your channels.
4. From the repository root, run `pnpm dev`, which restarts the bot when a source file changes, or `pnpm --filter agent start` to run it once.

On startup it opens the store at `$SUPERAGENT_DATA_DIR/state.db` (`~/.superagent/state.db` unless set), then prints the bot's user ID, the mapped channels, and the store's path. `Ctrl+C` disconnects from Slack and closes the store before exiting.

## What it does with a message

- **A mention in a mapped channel** goes to `startTask` with the message and its repo. For now that is `acknowledgeTask`, which replies with the repo it routed to; the task runner replaces it.
- **A DM** gets a reply listing the repo channels.
- **A mention in an unmapped channel** gets a reply with the config line to add.

Once a message is handled, its event is settled in the store as `routed` or `replied`. If handling throws, the event stays `received`, which marks it for a retry after a restart.

Startup stops with a message, and exit code 1, when a setting is missing or malformed, when `superagent.config.ts` doesn't exist, or when the config is invalid.
