import path from "node:path";
import { createOutboxSender } from "@repo/core/outbox";
import { loadConfig, type Repo } from "@repo/core/repos";
import { SlackGateway } from "@repo/core/slack";
import { openStore } from "@repo/core/store";
import { acknowledgeTask } from "./acknowledge-task.ts";
import { CONFIG_PATH, STORE_FILE_NAME } from "./constants.ts";
import { parseEnvironment } from "./environment.ts";
import { createMessageHandler } from "./handle-message.ts";

const describeChannels = (channelRepos: ReadonlyMap<string, Repo>): string =>
  [...channelRepos]
    .map(([channelId, repo]) => `${channelId} → ${repo.name}`)
    .join(", ") || "none mapped";

const main = async (): Promise<void> => {
  const environment = parseEnvironment(process.env);
  const channelRepos = await loadConfig(CONFIG_PATH);
  const storePath = path.join(environment.dataDirectory, STORE_FILE_NAME);
  const store = openStore({ path: storePath });
  const outboxSender = createOutboxSender({
    outbox: store.outbox,
    logger: console,
  });

  const connectToSlack = () =>
    SlackGateway.connect({
      botToken: environment.slackBotToken,
      appToken: environment.slackAppToken,
      ownerUserId: environment.slackOwnerId,
      logLevel: environment.logLevel,
      eventLog: store.events,
      onMessage: createMessageHandler({
        channelRepos,
        startTask: acknowledgeTask,
        store,
        wakeOutbox: outboxSender.wake,
      }),
    });
  const slack = await connectToSlack().catch((error: unknown) => {
    store.close();
    throw error;
  });
  outboxSender.start(slack);
  console.log(
    `superagent: connected as ${slack.identity.userId}, listening to ${environment.slackOwnerId}. Channels: ${describeChannels(channelRepos)}. Store: ${storePath}`,
  );

  const disconnect = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`superagent: ${signal} received, disconnecting`);
    await outboxSender.stop();
    await slack.close();
    store.close();
    process.exit();
  };
  process.once("SIGINT", disconnect);
  process.once("SIGTERM", disconnect);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
