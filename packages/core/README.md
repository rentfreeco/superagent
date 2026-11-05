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
  onMessage: async (message, slack) => {
    const history = await slack.fetchThread(message.channel, message.threadTs);
    await slack.reply(message, "on it");
    store.events.setDisposition(message.eventId, "replied");
  },
});
```

`onMessage` gets the gateway as its second argument, so a handler never depends on `connect` having returned. `apps/agent` is the real wiring.

What reaches `onMessage`:

- DMs to the bot, and @-mentions of it in channels. A thread reply in a channel needs the @-mention too.
- Only from `ownerUserId`. Everyone else is dropped, including other bots.
- Never the bot's own posts, edits, deletions, or a redelivered event. Redeliveries are recognised by `event_id`, and a message Slack sends as both `message` and `app_mention` is passed on once.

Every event is acked as soon as it arrives (Bolt does this before any middleware runs), so a slow handler doesn't trigger Slack retries. The gate records each event in `eventLog` (the store's `events` table) before anything else, so dedupe survives a restart, and it settles every event it drops with the reason: `dropped_self`, `dropped_not_owner`, `ignored`, or `duplicate_message`. An event that reaches `onMessage` stays `received` until the handler settles it.

`message.threadTs` is the thread's root ts, which is a stable key for "one task per thread". `fetchThread` reads the whole thread from Slack on each call and marks the bot's own posts with `fromSelf`. `slack.reply(message, text)` posts into the message's thread.

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

// inside onMessage(message, slack):
const route = routeMessage(channelRepos, message);
if (route.kind === "reply") return slack.reply(message, route.text);
// route.repo: { name, github, path, baseBranch }
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
    dedupeKey: `ack:${task.id}`,
    channel,
    threadTs: null,
    message: { kind: "reaction", name: "eyes", timestamp: originTs },
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
