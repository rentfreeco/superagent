import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createGitHubClient,
  createGitHubDelivery,
  createPullRequestWatcher,
  resolveAgentAccount,
} from "@repo/core/github";
import { createOutboxSender } from "@repo/core/outbox";
import {
  recoverAfterRestart,
  type RecoveryReport,
  takeRecoverySnapshot,
} from "@repo/core/recovery";
import { loadConfig, type Repo } from "@repo/core/repos";
import { createRouter, createRouterSessionStarter } from "@repo/core/router";
import { SlackGateway } from "@repo/core/slack";
import { openStore } from "@repo/core/store";
import { createClaudeSessionStarter, createTaskRunner } from "@repo/core/tasks";
import {
  CONFIG_PATH,
  ROUTER_DIRECTORY_NAME,
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
  const { repos, channelRepos } = await loadConfig(CONFIG_PATH);
  const gitHubClient =
    environment.gitHub === undefined
      ? undefined
      : createGitHubClient({ token: environment.gitHub.token });
  const gitHubAccount =
    environment.gitHub === undefined || gitHubClient === undefined
      ? undefined
      : await resolveAgentAccount({
          client: gitHubClient,
          token: environment.gitHub.token,
          ownerLogin: environment.gitHub.ownerLogin,
        });
  console.log(
    gitHubAccount === undefined
      ? "superagent: no SUPERAGENT_GITHUB_TOKEN, so workers use this machine's GitHub logins and pull requests aren't watched"
      : `superagent: workers act on GitHub as ${gitHubAccount.login}, and their pull requests are watched`,
  );
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
    repos,
    worktreesDirectory,
    startSession: createClaudeSessionStarter({
      sandbox: environment.workerSandbox,
      gitHubAccount,
    }),
    wakeOutbox: outboxSender.wake,
    wakeRouter: () => router.wake(),
    logger: console,
    ownerUserId: environment.slackOwnerId,
  });
  const routerDirectory = path.join(
    environment.dataDirectory,
    ROUTER_DIRECTORY_NAME,
  );
  await mkdir(routerDirectory, { recursive: true });
  const router = createRouter({
    store,
    repos,
    channelRepos,
    startSession: environment.router
      ? createRouterSessionStarter({
          workingDirectory: routerDirectory,
          repos,
          channelRepos,
        })
      : undefined,
    wakeOutbox: outboxSender.wake,
    wakeTaskRunner: taskRunner.wake,
    logger: console,
  });
  const pullRequestWatcher =
    gitHubClient === undefined ||
    gitHubAccount === undefined ||
    environment.gitHub === undefined
      ? undefined
      : createPullRequestWatcher({
          store,
          client: gitHubClient,
          repos,
          agentLogin: gitHubAccount.login,
          ownerLogin: environment.gitHub.ownerLogin,
          wakeOutbox: outboxSender.wake,
          wakeTaskRunner: taskRunner.wake,
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
        store,
        wakeOutbox: outboxSender.wake,
        wakeTaskRunner: taskRunner.wake,
        wakeRouter: router.wake,
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
  outboxSender.start(
    slack,
    gitHubClient === undefined || gitHubAccount === undefined
      ? undefined
      : createGitHubDelivery({
          client: gitHubClient,
          agentLogin: gitHubAccount.login,
        }),
  );
  console.log(
    `superagent: connected as ${slack.identity.userId}, listening to ${environment.slackOwnerId}. Channels: ${describeChannels(channelRepos)}. Store: ${storePath}. Worktrees: ${worktreesDirectory}`,
  );

  const disconnect = async (signal: NodeJS.Signals): Promise<void> => {
    console.log(`superagent: ${signal} received, disconnecting`);
    router.stop();
    await pullRequestWatcher?.stop();
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
  router.start();
  pullRequestWatcher?.start();
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
