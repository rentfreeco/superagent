import path from "node:path";
import { createOutboxSender } from "@repo/core/outbox";
import {
  recoverAfterRestart,
  type RecoveryReport,
  takeRecoverySnapshot,
} from "@repo/core/recovery";
import { loadConfig, type Repo } from "@repo/core/repos";
import { SlackGateway } from "@repo/core/slack";
import { openStore } from "@repo/core/store";
import {
  createClaudeSessionStarter,
  createTaskRunner,
  startTask,
} from "@repo/core/tasks";
import {
  CONFIG_PATH,
  STORE_FILE_NAME,
  WORKTREES_DIRECTORY_NAME,
} from "./constants.ts";
import { parseEnvironment } from "./environment.ts";
import { createMessageHandler } from "./handle-message.ts";
import { createReactionHandler } from "./handle-reaction.ts";

const describeChannels = (channelRepos: ReadonlyMap<string, Repo>): string =>
  [...channelRepos]
    .map(([channelId, repo]) => `${channelId} → ${repo.name}`)
    .join(", ") || "none mapped";

const describeRecovery = ({
  replayedEvents,
  restartedTasks,
  caughtUpMessages,
  conversationsWithoutHistory,
  failures,
}: RecoveryReport): string =>
  [
    `replayed ${replayedEvents} unfinished event(s)`,
    `told ${restartedTasks} running task(s) about the restart`,
    `caught up on ${caughtUpMessages} missed message(s)`,
    ...(conversationsWithoutHistory.length > 0
      ? [`no history yet for ${conversationsWithoutHistory.join(", ")}`]
      : []),
    ...(failures > 0 ? [`${failures} failure(s), logged above`] : []),
  ].join("; ");

const main = async (): Promise<void> => {
  const environment = parseEnvironment(process.env);
  const channelRepos = await loadConfig(CONFIG_PATH);
  const storePath = path.join(environment.dataDirectory, STORE_FILE_NAME);
  const store = openStore({ path: storePath });
  const recoverySnapshot = takeRecoverySnapshot({
    store,
    ownerUserId: environment.slackOwnerId,
    channels: [...channelRepos.keys()],
  });
  const outboxSender = createOutboxSender({
    outbox: store.outbox,
    logger: console,
  });
  const worktreesDirectory = path.join(
    environment.dataDirectory,
    WORKTREES_DIRECTORY_NAME,
  );
  const taskRunner = createTaskRunner({
    store,
    repos: new Map([...channelRepos.values()].map((repo) => [repo.name, repo])),
    worktreesDirectory,
    startSession: createClaudeSessionStarter(),
    wakeOutbox: outboxSender.wake,
    logger: console,
    ownerUserId: environment.slackOwnerId,
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
        startTask,
        store,
        wakeOutbox: outboxSender.wake,
        wakeTaskRunner: taskRunner.wake,
      }),
      onReaction: createReactionHandler({
        store,
        wakeOutbox: outboxSender.wake,
        wakeTaskRunner: taskRunner.wake,
      }),
      isFollowedThread: (channel, threadTs) =>
        Boolean(store.threads.owner(channel, threadTs)?.taskId),
    });
  const slack = await connectToSlack().catch((error: unknown) => {
    store.close();
    throw error;
  });
  outboxSender.start(slack);
  console.log(
    `superagent: connected as ${slack.identity.userId}, listening to ${environment.slackOwnerId}. Channels: ${describeChannels(channelRepos)}. Store: ${storePath}. Worktrees: ${worktreesDirectory}`,
  );

  const disconnect = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`superagent: ${signal} received, disconnecting`);
    await taskRunner.stop();
    await outboxSender.stop();
    await slack.close();
    store.close();
    process.exit();
  };
  process.once("SIGINT", disconnect);
  process.once("SIGTERM", disconnect);

  const recovery = await recoverAfterRestart({
    store,
    slack,
    snapshot: recoverySnapshot,
    logger: console,
  });
  console.log(`superagent: recovery ${describeRecovery(recovery)}`);
  taskRunner.start(slack);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
