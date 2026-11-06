import { describe, expect, it } from "vitest";
import { openTestStore } from "../store/open-test-store.ts";
import { recordReport, type WorkerReport } from "./record-report.ts";

const setup = () => {
  const { store } = openTestStore();
  const task = store.tasks.create({
    title: "Fix the flaky test",
    repo: "superagent",
    originChannel: "C0MAPPED",
    originTs: "100.000001",
  });
  store.tasks.transition(task.id, "running");
  const report = (workerReport: WorkerReport) =>
    recordReport({ store, taskId: task.id, report: workerReport });
  const queuedPosts = () =>
    store.outbox.pending().map(({ dedupeKey, channel, threadTs, message }) => ({
      dedupeKey,
      channel,
      threadTs,
      message,
    }));
  return { queuedPosts, report, store, task };
};

describe("recordReport", () => {
  it("records a ready report, keeps the PR number, and posts the summary with the PR link in the thread", () => {
    const { queuedPosts, report, store, task } = setup();

    expect(
      report({
        state: "ready",
        summary: "Retried the flaky request.\nAdded a regression test.",
        prUrl: "https://github.com/pakgin/superagent/pull/42",
      }),
    ).toEqual({
      isAccepted: true,
      reply: expect.stringContaining("End your turn"),
    });

    expect(store.tasks.get(task.id)).toMatchObject({
      state: "ready",
      prNumber: 42,
    });
    expect(store.reports.latest(task.id)).toMatchObject({
      state: "ready",
      summary: "Retried the flaky request.\nAdded a regression test.",
      question: null,
    });
    expect(queuedPosts()).toEqual([
      {
        dedupeKey: `report:${store.reports.latest(task.id)?.id}`,
        channel: "C0MAPPED",
        threadTs: "100.000001",
        message: {
          kind: "post",
          text: "Retried the flaky request.\nAdded a regression test.\n<https://github.com/pakgin/superagent/pull/42|Pull request #42>",
        },
      },
    ]);
  });

  it("posts the question of a waiting report", () => {
    const { queuedPosts, report, store, task } = setup();

    report({
      state: "waiting",
      summary: "Two tests share a port.",
      question: "Should I give each its own port, or run them serially?",
    });

    expect(store.tasks.get(task.id)?.state).toBe("waiting");
    expect(queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: "Two tests share a port.\n\n*Question:* Should I give each its own port, or run them serially?",
    });
  });

  it("marks blocked and failed reports in the post", () => {
    const blocked = setup();
    blocked.report({ state: "blocked", summary: "gh isn't logged in." });
    const failed = setup();
    failed.report({ state: "failed", summary: "The repo doesn't build." });

    expect(blocked.queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: "*Blocked:* gh isn't logged in.",
    });
    expect(failed.queuedPosts()[0]?.message).toEqual({
      kind: "post",
      text: "*Failed:* The repo doesn't build.",
    });
  });

  it("turns down a waiting report without a question, or a ready one without a pull request URL, and changes nothing", () => {
    const { queuedPosts, report, store, task } = setup();

    expect(
      report({ state: "waiting", summary: "Which way?", question: " " }),
    ).toMatchObject({
      isAccepted: false,
      reply: expect.stringContaining("question"),
    });
    for (const prUrl of [
      undefined,
      "42",
      "https://github.com/pakgin/superagent/issues/42",
    ]) {
      expect(report({ state: "ready", summary: "Done.", prUrl })).toMatchObject(
        {
          isAccepted: false,
          reply: expect.stringContaining("pull request's URL"),
        },
      );
    }

    expect(store.tasks.get(task.id)?.state).toBe("running");
    expect(store.reports.latest(task.id)).toBeUndefined();
    expect(queuedPosts()).toEqual([]);
  });

  it("turns down a report once the task isn't running, so a stopped task stays quiet", () => {
    const { queuedPosts, report, store, task } = setup();
    store.tasks.transition(task.id, "stopped");

    expect(report({ state: "done", summary: "Finished anyway." })).toEqual({
      isAccepted: false,
      reply:
        "Not posted: this task is stopped. Stop working and end your turn.",
    });
    expect(store.tasks.get(task.id)?.state).toBe("stopped");
    expect(queuedPosts()).toEqual([]);
  });
});
