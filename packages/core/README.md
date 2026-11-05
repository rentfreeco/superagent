# @repo/core

Core logic for superagent. Each module is a subpath export, consumed as TypeScript source (no build step). Node 24 runs it directly.

## `@repo/core/slack`

The bot's Socket Mode connection to Slack.

```ts
import { SlackGateway } from "@repo/core/slack";

const slack = await SlackGateway.connect({
  botToken: process.env.SLACK_BOT_TOKEN!, // xoxb-…
  appToken: process.env.SLACK_APP_TOKEN!, // xapp-…
  ownerUserId: process.env.SLACK_OWNER_ID!, // U…
  onMessage: async (message) => {
    const history = await slack.fetchThread(message.channel, message.threadTs);
    // hand off to the task runner
  },
});
```

What reaches `onMessage`:

- DMs to the bot, and @-mentions of it in channels. A thread reply in a channel needs the @-mention too.
- Only from `ownerUserId`. Everyone else is dropped, including other bots.
- Never the bot's own posts, edits, deletions, or a redelivered event. Redeliveries are recognised by `event_id`, and a message Slack sends as both `message` and `app_mention` is passed on once.

Every event is acked as soon as it arrives (Bolt does this before any middleware runs), so a slow handler doesn't trigger Slack retries. Dedupe state lives in memory, so it resets on restart.

`message.threadTs` is the thread's root ts, which is a stable key for "one task per thread". `fetchThread` reads the whole thread from Slack on each call and marks the bot's own posts with `fromSelf`.

### Slack app setup

1. Create an app at api.slack.com/apps → **From a manifest**, and paste [`slack-app-manifest.json`](./slack-app-manifest.json).
2. **Basic Information → App-Level Tokens**: create one with the `connections:write` scope. This is the `xapp-` token.
3. **Install App**: install it to the workspace and copy the Bot User OAuth Token (`xoxb-`).
4. Your user ID: in Slack, open your profile → ⋯ → **Copy member ID**.

`chat:write` is in the manifest for posting replies, which this module doesn't do yet.
