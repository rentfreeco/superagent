# agent

The superagent bot process. It reads its settings, loads the repo config, connects to Slack, routes every message from the owner, runs a Claude Code session for each task, and follows each task's pull request.

## Run it

1. Set up a Slack app of your own, as `CONTRIBUTING.md` describes.
2. Copy `.env.example` to `.env` in this directory and fill in the tokens and your member ID, and, for superagent's own GitHub account, its token and your GitHub login.
3. Copy `superagent.config.example.ts` at the repository root to `superagent.config.ts` and list your repos and channels.
4. Make sure this machine can run Claude Code (a `claude` login or `ANTHROPIC_API_KEY`). Without `SUPERAGENT_GITHUB_TOKEN`, also make sure `gh` is logged in and git can push to the configured repos, since workers then act on GitHub as you.
5. From the repository root, run `pnpm dev`, which restarts the bot when a source file changes, or `pnpm --filter agent start` to run it once.

## Startup and shutdown

On startup it:

1. checks its settings and loads `superagent.config.ts`;
2. with `SUPERAGENT_GITHUB_TOKEN`, asks GitHub whose the token is, and refuses to go on if it's `SUPERAGENT_OWNER_GITHUB`'s;
3. opens the store at `$SUPERAGENT_DATA_DIR/state.db` (`~/.superagent/state.db` unless set) and takes the recovery snapshot: which events were left unfinished, which tasks were running, and where catch-up starts in each conversation;
4. connects to Slack, starts the outbox sender, and prints the bot's user ID, the mapped channels, and the store's path;
5. runs restart recovery: it replays the unfinished events, tells running tasks about the restart, and catches up on what you sent while it was down, then prints what it did;
6. starts the task runner, which resumes the tasks a restart interrupted, the router, which decides what recovery queued, and, with a GitHub account, the pull request watcher.

`Ctrl+C` stops the router and the watcher, closes the Claude Code sessions (their tasks pick up again on the next start), lets the sender finish the post in flight, disconnects from Slack, and closes the store before exiting.

Startup stops with a message, and exit code 1, when:

- a setting is missing or malformed, or `SLACK_OWNER_ID` is the bot's own user;
- `superagent.config.ts` doesn't exist, or the config is invalid;
- `SUPERAGENT_GITHUB_TOKEN` belongs to `SUPERAGENT_OWNER_GITHUB`;
- the store can't use write-ahead logging, such as on a network filesystem, or was written by a newer superagent.

## What it does with a message

- **A DM, or a mention outside a task's thread,** goes to the router, which starts a task in the repo it's about, answers, asks one question, passes it to a task it points at, stops one, or lets it be with a reaction. With `SUPERAGENT_ROUTER=off`, or when the router can't decide, the channel map decides: a mention in a mapped channel starts a task there, a DM gets a reply listing the repo channels, and a mention in an unmapped channel gets the config line to add.
- **A started task** gets a Claude Code session that works on it in its own worktree, puts 👀 on your message when it starts on it, and can read the thread for context. Its report comes back in the thread: a pull request link, a question, an answer, or what went wrong. When the turn ends, 👀 becomes ✅.
- **A reply in a task's thread,** with or without an @-mention, goes to that task's worker, which puts 👀 on it when it gets to it. If it isn't about the task, the worker hands it back to the router. `stop` on its own, or 🛑 on the task's first message or one of your messages in its thread, stops the task and keeps its branch.
- **The task's pull request,** with superagent's own GitHub account, is polled every minute. Your reviews and comments, automated reviewers', and failed checks reach the worker, which answers on GitHub. A merge or close posts once in the thread and ends the task.

Nothing is posted directly. The handler writes the task input or the router candidate in one transaction, then wakes the outbox sender, the task runner, and the router. A candidate's event stays `received` until the router's decision settles it. If handling throws, nothing is written and the event stays `received`, which marks it for a retry after a restart.
