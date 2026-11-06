# @repo/core

Core logic for superagent. Each module is a subpath export, consumed as TypeScript source (no build step). Node 24 runs it directly.

## `@repo/core/slack`

The bot's Socket Mode connection to Slack.

```ts
import { SlackGateway } from "@repo/core/slack";

const slack = await SlackGateway.connect({
  botToken, // xoxb-…
  appToken, // xapp-…
  ownerUserId, // U…
  eventLog: store.events,
  // Replies in these threads reach onMessage without an @-mention.
  isFollowedThread: (channel, threadTs) =>
    Boolean(store.threads.owner(channel, threadTs)?.taskId),
  onMessage: (message) => {
    store.transaction(() => {
      store.outbox.enqueue({
        dedupeKey: `reply:${message.eventId}`,
        channel: message.channel,
        threadTs: message.threadTs,
        message: { kind: "post", text: "on it" },
      });
      store.events.setDisposition(message.eventId, "replied");
    });
    outboxSender.wake();
  },
  // Every reaction that reaches here needs settling, even one it ignores.
  onReaction: (reaction) => {
    store.events.setDisposition(reaction.eventId, "ignored");
  },
});
outboxSender.start(slack);
```

`onMessage` gets the gateway as its second argument, so a handler never depends on `connect` having returned. `apps/agent` is the real wiring.

What reaches `onMessage`:

- DMs to the bot, and @-mentions of it in channels.
- Replies in a channel thread that `isFollowedThread` says the app follows, such as a task's, with or without an @-mention. Any other channel message needs the mention. The bot receives every message in the channels it's in, so this is the gate's owner check doing its work, not Slack's.
- Only from `ownerUserId`. Everyone else is dropped, including other bots.
- Never the bot's own posts, edits, deletions, or a redelivered event. Redeliveries are recognised by `event_id`, and a message Slack sends as both `message` and `app_mention` is passed on once.

`onReaction` gets the owner's reactions to messages, with the message's channel and ts and the emoji's name, such as `octagonal_sign` for 🛑. The emoji is kept as the event's text, so a reaction can be replayed after a crash. A reaction added while the bot is down isn't caught up.

Every event is acked as soon as it arrives (Bolt does this before any middleware runs), so a slow handler doesn't trigger Slack retries. The gate records each event in `eventLog` (the store's `events` table) before anything else, so dedupe survives a restart, and it settles every event it drops with the reason: `dropped_self`, `dropped_not_owner`, `ignored`, or `duplicate_message`. An event that reaches `onMessage` stays `received` until the handler settles it.

`message.threadTs` is the thread's root ts, which is a stable key for "one task per thread". `fetchThread` reads the whole thread from Slack on each call and marks the bot's own posts with `fromSelf`.

The gateway's `post`, `react`, `findPost`, and `classifyFailure` exist for the outbox sender, which is the only thing that posts. They use their own Slack client, with no built-in retries, rate limits reported as errors, and a 10-second timeout, so a stuck call can't hold up the queue and the outbox's backoff is the only retry.

`replay` and `catchUp` exist for restart recovery (`@repo/core/recovery`). `replay` runs an event the gate recorded but never settled back through the gate's checks. `catchUp` reads a channel or thread after a given ts and feeds the owner's missed messages through the real gate, with Bolt's `processEvent`, as if they had just arrived.

### Slack app setup

1. Create an app at api.slack.com/apps → **From a manifest**, and paste [`slack-app-manifest.json`](./slack-app-manifest.json).
2. **Basic Information → App-Level Tokens**: create one with the `connections:write` scope. This is the `xapp-` token.
3. **Install App**: install it to the workspace and copy the Bot User OAuth Token (`xoxb-`).
4. Your user ID: in Slack, open your profile → ⋯ → **Copy member ID**.

## `@repo/core/repos`

Which repo a message is about. Each Slack channel maps to one repo, so every request in that channel, and every follow-up in its threads, refers to that repo.

```ts
import { loadConfig, routeMessage } from "@repo/core/repos";

const channelRepos = await loadConfig("superagent.config.ts");

// inside onMessage(message):
const route = routeMessage(channelRepos, message);
// route.kind === "reply": queue route.text as a post in the message's thread
// route.kind === "repo": route.repo is { name, github, path, baseBranch }
```

The config is a TypeScript file at the repository root. Copy [`superagent.config.example.ts`](../../superagent.config.example.ts) to `superagent.config.ts`, which is git-ignored:

```ts
import { defineConfig } from "@repo/core/repos";

export default defineConfig({
  repos: {
    superagent: {
      github: "pakgin/superagent",
      path: "~/code/superagent",
      baseBranch: "main",
    },
  },
  channels: {
    C0123ABCD: "superagent",
  },
});
```

- `repos` defines each repo once: its GitHub `owner/name`, a local git checkout (a path relative to the config file, or starting with `~`), and its base branch.
- `channels` maps Slack channel IDs to repo names. Several channels can share a repo. Use IDs, not names, since names change: open the channel, click its name, and the ID is at the bottom of the **About** tab.

`loadConfig` reads the file once and fails at startup, naming each problem: an unknown or misspelled key, a channel name in place of an ID, a channel pointing at a repo that isn't defined, or a repo path that isn't a git checkout.

`routeMessage` returns the repo for a mention in a mapped channel. A DM gets a reply listing the repo channels, and a mention in an unmapped channel gets a reply with the line to add to the config. The bot only hears channels it has been invited to (`/invite @superagent`).

## `@repo/core/store`

All state the service needs after a restart, in one SQLite file in write-ahead-logging mode, through Node's built-in `node:sqlite`. Every call is synchronous.

```ts
import { openStore } from "@repo/core/store";

const store = openStore({ path: "/data/state.db" });

store.transaction(() => {
  const task = store.tasks.create({
    title,
    repo: "superagent",
    originChannel,
    originTs,
  });
  store.threads.claim({ channel, threadTs, taskId: task.id });
  store.outbox.enqueue({
    dedupeKey: `ack:${eventId}`,
    channel,
    threadTs: null,
    message: { kind: "reaction", name: "eyes", timestamp: messageTs },
  });
  store.events.setDisposition(eventId, "routed");
});
```

`openStore` creates the file and its directory, refuses to run unless SQLite actually switched to write-ahead logging, and applies any pending migrations. It also refuses a store written by newer code.

| Table     | Answers                                                    | Guarantees                                                                                          |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `events`  | Have I seen this Slack event, and what did I do with it?   | One row per `event_id`; one event per message claims it; dropped events lose their text             |
| `threads` | Which task owns this thread? `null` means the router       | A router thread can pass to a task; a task's thread never moves                                     |
| `tasks`   | What work exists and where is it?                          | Short random IDs; every state change goes through `TASK_TRANSITIONS`, and an illegal one throws     |
| `inputs`  | What has each worker been told, and what is still waiting? | One input per `(source, ref)`                                                                       |
| `reports` | What did the worker last say?                              | `latest(taskId)` is the newest                                                                      |
| `outbox`  | What must reach Slack, and did it?                         | One entry per `dedupeKey`; exponential backoff from 5 seconds up to 5 minutes, failed after 8 tries |
| `kv`      | Router session ID, prompt version, cursors                 | Values are JSON, read back through the zod schema you pass                                          |

`store.transaction(work)` runs synchronous work in one `BEGIN IMMEDIATE` transaction and rolls it all back if `work` throws. A transaction inside another joins the outer one. `openTestStore()` gives tests an in-memory store with a clock they can move.

## `@repo/core/outbox`

The sender that turns outbox rows into Slack posts and reactions. Everything the bot says goes through it, so a reply queued just before a crash still goes out after the restart.

```ts
import { createOutboxSender } from "@repo/core/outbox";

const outboxSender = createOutboxSender({
  outbox: store.outbox,
  logger: console,
});
outboxSender.start(slack); // the gateway is the delivery
outboxSender.wake(); // after queueing something, to send it now
await outboxSender.stop(); // on shutdown: finishes the post in flight
```

- **When it sends:** right away when woken, and on a one-second poll that also picks up retries once their backoff has passed. Only one pass runs at a time; a wake during a pass asks for one more.
- **Order:** an entry waits while an earlier entry in the same thread is still pending, so a retry never reorders a conversation.
- **Failures:** rate limits, network errors, timeouts, and Slack-side errors back off and retry; a rate limit waits at least as long as Slack's `Retry-After` asks. Errors retrying can't fix (`not_in_channel`, `channel_not_found`, `msg_too_long`, …) fail the entry at once and log it. A reaction that is already there counts as sent.
- **No double posts after a crash:** the attempt is counted before Slack is called, and each post carries its dedupe key in message metadata. Before posting an entry that was attempted before, the sender looks for the bot's post with that key in the thread, and records it instead of posting again.
- **Stopping:** `stop()` lets a post already on its way finish, and starts nothing after that, including a post that was waiting on the duplicate check. An entry left that way stays pending and goes out after the next start.

## `@repo/core/recovery`

What runs once on every start, so a restart loses nothing. `apps/agent` calls it after connecting to Slack and starting the outbox sender, which by then is already sending whatever the outbox still holds.

```ts
import { recoverAfterRestart, takeRecoverySnapshot } from "@repo/core/recovery";

const snapshot = takeRecoverySnapshot({
  store,
  ownerUserId,
  channels: [...channelRepos.keys()],
}); // before connecting
// ... connect, start the outbox sender ...
const report = await recoverAfterRestart({
  store,
  slack, // the gateway: replay and catchUp
  snapshot,
  logger: console,
});
```

`takeRecoverySnapshot` reads everything recovery needs while nothing else is writing to the store: the unfinished events, the running tasks, and where catch-up starts in each conversation. Once the bot connects, live events get recorded, including the bot's own posts echoed back by Slack. Reading after that would replay an event the gate is still handling, or start catch-up after a newer event and skip the messages sent while the bot was down.

1. **Unfinished events.** Each event the snapshot has as `received` goes back through the gate's checks, then to the message handler. That covers a crash while handling a message and a crash inside the gate.
2. **Running tasks.** Each task running at the snapshot gets a `system` input saying the service restarted, for the task runner to resume it with.
3. **Catch-up.** For your DM channel, every mapped channel, and every open task's thread, it reads what was sent after the latest ts the snapshot has for it, and feeds your messages through the real gate as synthetic events (`catchup:<channel>:<ts>`). In channels only messages that mention the bot count, as they would live. The gate's per-message claim skips anything already handled.

A channel the store has no events for has no starting point, so it is skipped and listed in the report. Channel history only holds top-level messages, so thread replies are caught up only in task threads: those of open tasks, and of tasks that ended in the last seven days, since a reply can resume one. A reply in an older thread sent while the bot was down is missed. A failure anywhere is logged and counted, and recovery carries on with the next item.

## `@repo/core/router`

What happens to a message no task owns. The handler queues it as a candidate, and the router, one Claude session that only routes, decides it.

```ts
import {
  createRouter,
  createRouterSessionStarter,
  queueCandidate,
} from "@repo/core/router";

// inside the message handler's transaction, for a message no task owns:
queueCandidate({ message, store }); // its event stays received until a decision

const router = createRouter({
  store,
  repos, // repo name -> Repo
  channelRepos, // channel ID -> Repo, for the fallback
  startSession: createRouterSessionStarter({
    workingDirectory: "/data/router",
    repos,
    channelRepos,
  }),
  wakeOutbox: outboxSender.wake,
  wakeTaskRunner: taskRunner.wake,
  logger: console,
});
router.start(); // after restart recovery
router.wake(); // after the handler queues a candidate
router.stop(); // on shutdown
```

- **Decisions:** `start_task` (in any configured repo; the channel's repo is a default), `reply` (a short answer or one question), `attach` (to a task the message points at explicitly), `stop`, and `ignore`. Each runs in one transaction that records the decision with its reason, writes the task, input, or reply, settles the Slack event, and marks the candidate decided. A second decision for the same candidate is refused.
- **Status:** `list_tasks` lists tasks for questions like "what's waiting on me?".
- **The session:** `claude-opus-5-5` at low effort, resumed from the session ID kept in `kv`, with no built-in tools, no settings files, and only the routing tools allowed. Each candidate arrives as a card: where it was sent, its thread, and, for a hand-back, which task handed it back and why.
- **Fallback:** the channel map decides a candidate the router left undecided when its turn went idle, when its session failed or couldn't start, or after `ROUTER_DECISION_TIMEOUT_MS`. So every candidate is settled, even with the router down.
- **Repo descriptions:** a repo's `description` in the config goes into the router's instructions, so it can tell repos apart.

## `@repo/core/tasks`

Turns requests into Claude Code sessions. Each task gets a worktree of its own on `agent/<task id>`, and one session at a time through the Claude Agent SDK.

```ts
import {
  createClaudeSessionStarter,
  createTaskRunner,
  startTask,
  takeFollowUp,
} from "@repo/core/tasks";

// inside the message handler's transaction:
startTask({ message, repo, store }); // a new request
const disposition = takeFollowUp({ message, taskId, store }); // a message in a task's thread

const taskRunner = createTaskRunner({
  store,
  repos, // repo name -> Repo
  worktreesDirectory: "/data/worktrees",
  startSession: createClaudeSessionStarter(),
  wakeOutbox: outboxSender.wake,
  logger: console,
  ownerUserId, // U…, whose messages read_thread shows
});
taskRunner.start(slack); // after restart recovery; the gateway reads threads
taskRunner.wake(); // after the handler writes rows
await taskRunner.stop(); // on shutdown: closes the sessions, and their tasks stay running
```

- **A new request:** `startTask` queues a task that owns the thread and keeps the message as its first input. Nothing is posted until the worker acts.
- **Starting:** the runner fetches the repo's base branch, adds a worktree on `agent/<task id>` from it, and starts a session there. The worker gets Claude Code's own system prompt and the repo's `CLAUDE.md`, plus instructions to push the branch, open a pull request with `gh`, and report.
- **Worker tools:** the worker reaches Slack only through three tools.
  - `ack` puts 👀 on each of your messages it has been given and hasn't finished. It is told to call it when it starts on a message.
  - `read_thread` reads the task's thread, oldest first: your messages and the bot's own, the newest that fit in 40,000 characters, notices included. A newest message longer than that is cut short. Other people's messages are left out and counted.
  - `report` posts where the task stands: `ready` with the pull request's URL, `waiting` with one question, `done`, `blocked`, or `failed`, each with a short summary. `recordReport` saves it, moves the task to that state, and queues the post in the thread, in one transaction.
- **Follow-ups:** a reply in the task's thread, with or without an @-mention, becomes an input, and gets an 👀 once the worker acks it. A live session gets it at its next step, and the task goes back to `running` even if the worker had already reported, so its answer still posts. An ended task's session is resumed with it.
- **Stop:** the word `stop` alone in the thread, or 🛑 on the task's first message or one of your messages there, marks the task stopped and drops what the worker hadn't read. The runner interrupts the session, the branch stays, and the thread gets a one-line confirmation. On a `done`, `failed`, or `blocked` task it cancels a retry still waiting to start, and the task keeps its state.
- **Restarts:** a task left `running` is resumed from its stored session ID with every input it hadn't read, including recovery's restart note.
- **Limits:** at most three sessions run at once; other tasks wait, oldest first.
- **When things go wrong:** a turn that ends without a report posts the worker's last message and waits on you. A failed turn, a session that ends early, or a task that can't start is marked `failed` with the reason. Replying in the thread tries again.

Sessions use `claude-opus-5-5` at high effort, in `dontAsk` mode with an allowlist of working tools. A `PreToolUse` guard refuses merges, approvals, closing issues, force pushes, pushes to the base branch, writes outside the worktree, and reads of credential files. With `createClaudeSessionStarter({ sandbox: true })` the worker's shell commands also run in Claude Code's sandbox. Sessions get only an allowlist of the service's environment (the shell basics, `ANTHROPIC_*`, `GH_TOKEN`, `SSH_AUTH_SOCK`, and the commit identity), so they use this machine's Claude Code login (or `ANTHROPIC_API_KEY`) and its `gh` and push credentials, and never the Slack tokens.
