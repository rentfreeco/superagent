# agent

The superagent bot process. It reads its settings, loads the repo config, connects to Slack, routes every message from the owner, and runs a Claude Code session for each task.

## Run it

1. Set up a Slack app of your own, as `CONTRIBUTING.md` describes.
2. Copy `.env.example` to `.env` in this directory and fill in the tokens and your member ID.
3. Copy `superagent.config.example.ts` at the repository root to `superagent.config.ts` and map your channels.
4. Make sure this machine can run Claude Code (a `claude` login or `ANTHROPIC_API_KEY`), and that `gh` is logged in and git can push to the configured repos.
5. From the repository root, run `pnpm dev`, which restarts the bot when a source file changes, or `pnpm --filter agent start` to run it once.

On startup it opens the store at `$SUPERAGENT_DATA_DIR/state.db` (`~/.superagent/state.db` unless set), takes the recovery snapshot (which events were left unfinished, which tasks were running, and where catch-up starts in each conversation), connects, starts the outbox sender, and prints the bot's user ID, the mapped channels, and the store's path. Then it runs restart recovery: it replays the unfinished events, tells running tasks about the restart, and catches up on what you sent while it was down, and it prints what it did. Last, it starts the task runner, which resumes the tasks a restart interrupted. `Ctrl+C` closes the Claude Code sessions (their tasks pick up again on the next start), lets the sender finish the post in flight, disconnects from Slack, and closes the store before exiting.

## What it does with a message

- **A mention in a mapped channel** starts a task: a Claude Code session works on it in its own worktree, puts 👀 on your message when it starts on it, and can read the thread for context. Its report comes back in the thread: a pull request link, a question, an answer, or what went wrong.
- **A reply in a task's thread,** with or without an @-mention, goes to that task's worker, which puts 👀 on it when it gets to it. `stop` on its own, or 🛑 on the task's first message, stops the task and keeps its branch.
- **A DM** gets a reply listing the repo channels.
- **A mention in an unmapped channel** gets a reply with the config line to add.

Nothing is posted directly. The handler writes the task, input, or reply rows and settles the event (`routed`, `task_input`, `stopped_task`, or `replied`) in one transaction, then wakes the outbox sender and the task runner. If handling throws, nothing is written and the event stays `received`, which marks it for a retry after a restart.

Startup stops with a message, and exit code 1, when a setting is missing or malformed, when `superagent.config.ts` doesn't exist, or when the config is invalid.
