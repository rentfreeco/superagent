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
  onMessage: async (message, slack) => {
    const history = await slack.fetchThread(message.channel, message.threadTs);
    await slack.reply(message, "on it");
  },
});
```

`onMessage` gets the gateway as its second argument, so a handler never depends on `connect` having returned. `apps/agent` is the real wiring.

What reaches `onMessage`:

- DMs to the bot, and @-mentions of it in channels. A thread reply in a channel needs the @-mention too.
- Only from `ownerUserId`. Everyone else is dropped, including other bots.
- Never the bot's own posts, edits, deletions, or a redelivered event. Redeliveries are recognised by `event_id`, and a message Slack sends as both `message` and `app_mention` is passed on once.

Every event is acked as soon as it arrives (Bolt does this before any middleware runs), so a slow handler doesn't trigger Slack retries. Dedupe state lives in memory, so it resets on restart.

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
