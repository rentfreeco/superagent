import { describe, expect, it, vi } from "vitest";
import type { Repo } from "../repos/config.ts";
import { openTestStore } from "../store/open-test-store.ts";
import type { GitHubClient } from "./client.ts";
import { createPullRequestWatcher } from "./pull-request-watcher.ts";
import type { PullRequest } from "./read-pull-request.ts";

const scratchRepo: Repo = {
  name: "scratch",
  github: "pakgin/scratch",
  path: "/code/scratch",
  baseBranch: "main",
};

const owner = { login: "pakgin", type: "User" };

interface FakeGitHub {
  pulls: Map<number, PullRequest>;
  comments: Map<number, unknown[]>;
  failing: Set<number>;
}

const fakeClient = (github: FakeGitHub, requests: string[]): GitHubClient => ({
  post: async () => {
    throw new Error("the watcher only reads");
  },
  get: async (path, schema) => {
    requests.push(path);
    const number = Number(path.match(/\/(?:pulls|issues)\/(\d+)/)?.[1]);
    if (github.failing.has(number)) throw new Error("github: answered 502");
    if (path.includes("/check-runs")) return schema.parse({ check_runs: [] });
    if (path.includes("/issues/") && path.includes("/comments")) {
      return schema.parse(
        path.includes("page=1") ? (github.comments.get(number) ?? []) : [],
      );
    }
    if (path.includes("/reviews") || path.includes("/comments")) {
      return schema.parse([]);
    }
    return schema.parse(github.pulls.get(number));
  },
});

const pullRequestFor = (
  taskId: string,
  number: number,
  fields: Partial<PullRequest> = {},
): PullRequest => ({
  number,
  state: "open",
  merged: false,
  updated_at: "2026-11-07T10:00:00Z",
  html_url: `https://github.com/pakgin/scratch/pull/${number}`,
  head: {
    ref: `agent/${taskId}`,
    sha: "1111111",
    repo: { full_name: "pakgin/scratch" },
  },
  base: { repo: { full_name: "pakgin/scratch" } },
  ...fields,
});

const setup = () => {
  const { store } = openTestStore();
  const github: FakeGitHub = {
    pulls: new Map(),
    comments: new Map(),
    failing: new Set(),
  };
  const requests: string[] = [];
  const wakeOutbox = vi.fn();
  const wakeTaskRunner = vi.fn();
  const logger = { info: vi.fn(), error: vi.fn() };
  const watcher = createPullRequestWatcher({
    store,
    client: fakeClient(github, requests),
    repos: new Map([["scratch", scratchRepo]]),
    agentLogin: "superagent-bot",
    ownerLogin: "pakgin",
    wakeOutbox,
    wakeTaskRunner,
    logger,
  });
  let nextOrigin = 1;
  const readyTaskWithPullRequest = (number: number) => {
    nextOrigin += 1;
    const task = store.tasks.create({
      title: "Fix add",
      repo: "scratch",
      originChannel: "C0MAPPED",
      originTs: `${nextOrigin}00.000001`,
    });
    store.tasks.transition(task.id, "running");
    store.tasks.update(task.id, {
      prNumber: number,
      branch: `agent/${task.id}`,
    });
    store.tasks.transition(task.id, "ready");
    github.pulls.set(number, pullRequestFor(task.id, number));
    return task;
  };
  const posts = () =>
    store.outbox.pending().map(({ dedupeKey, threadTs, message }) => ({
      dedupeKey,
      threadTs,
      text: message.kind === "post" ? message.text : "",
    }));
  return {
    github,
    logger,
    posts,
    readyTaskWithPullRequest,
    requests,
    store,
    wakeOutbox,
    wakeTaskRunner,
    watcher,
  };
};

describe("createPullRequestWatcher", () => {
  it("gives the owner's comment to the task and wakes the runner, then polls only the pull request while nothing changes", async () => {
    const {
      github,
      readyTaskWithPullRequest,
      requests,
      store,
      wakeTaskRunner,
      watcher,
    } = setup();
    const task = readyTaskWithPullRequest(7);
    github.comments.set(7, [
      {
        id: 31,
        user: owner,
        body: "Rename add to sum.",
        html_url: "https://github.com/pakgin/scratch/pull/7#issuecomment-31",
      },
    ]);

    await watcher.poll();
    const requestsAfterFirstPoll = requests.length;
    await watcher.poll();

    expect(store.inputs.unread(task.id)).toEqual([
      expect.objectContaining({
        source: "github",
        ref: "github:comment:31",
        text: "The owner commented on pull request #7: Rename add to sum.\nhttps://github.com/pakgin/scratch/pull/7#issuecomment-31",
      }),
    ]);
    expect(wakeTaskRunner).toHaveBeenCalledOnce();
    expect(requests.length - requestsAfterFirstPoll).toBe(1);
  });

  it("posts once and closes the task when its pull request is merged, then stops polling it", async () => {
    const {
      github,
      posts,
      readyTaskWithPullRequest,
      requests,
      store,
      watcher,
    } = setup();
    const task = readyTaskWithPullRequest(7);
    store.inputs.add({
      taskId: task.id,
      source: "slack",
      ref: "Ev1",
      text: "one more thing",
    });
    github.pulls.set(
      7,
      pullRequestFor(task.id, 7, { state: "closed", merged: true }),
    );

    await watcher.poll();
    const requestsAfterMerge = requests.length;
    await watcher.poll();

    expect(store.tasks.get(task.id)?.state).toBe("done");
    expect(store.inputs.unread(task.id)).toEqual([]);
    expect(posts()).toEqual([
      {
        dedupeKey: `pull-request-closed:${task.id}:7`,
        threadTs: task.originTs,
        text: "Pull request #7 was merged, so this task is done.",
      },
    ]);
    expect(requests.length).toBe(requestsAfterMerge);
  });

  it("tells the owner once about a pull request that isn't the task's, and leaves it alone", async () => {
    const { github, posts, readyTaskWithPullRequest, requests, watcher } =
      setup();
    const task = readyTaskWithPullRequest(7);
    github.pulls.set(
      7,
      pullRequestFor(task.id, 7, {
        head: {
          ref: "someone-elses-branch",
          sha: "1",
          repo: { full_name: "pakgin/scratch" },
        },
      }),
    );

    await watcher.poll();
    const requestsAfterFirstPoll = requests.length;
    await watcher.poll();

    expect(posts().map(({ dedupeKey }) => dedupeKey)).toEqual([
      `pull-request-foreign:${task.id}:7`,
    ]);
    expect(requests.length).toBe(requestsAfterFirstPoll);
  });

  it("keeps polling the other pull requests when one fails", async () => {
    const { github, logger, readyTaskWithPullRequest, store, watcher } =
      setup();
    const broken = readyTaskWithPullRequest(7);
    const working = readyTaskWithPullRequest(8);
    github.failing.add(7);
    github.pulls.set(
      8,
      pullRequestFor(working.id, 8, { state: "closed", merged: false }),
    );

    await watcher.poll();

    expect(logger.error).toHaveBeenCalledWith(
      `github: polling ${broken.id}'s pull request #7 failed: github: answered 502`,
    );
    expect(store.tasks.get(working.id)?.state).toBe("done");
  });
});
