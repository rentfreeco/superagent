import { describe, expect, it, vi } from "vitest";
import { type GitHubClient, GitHubRequestError } from "./client.ts";
import { createGitHubDelivery } from "./outbox-delivery.ts";

interface Call {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
}

const fakeClient = (
  answers: Record<string, unknown>,
  calls: Call[],
): GitHubClient => ({
  get: async (path, schema) => {
    calls.push({ method: "GET", path });
    return schema.parse(answers[path.split("?")[0] ?? path] ?? []);
  },
  post: async (path, body, schema) => {
    calls.push({ method: "POST", path, body });
    return schema.parse({ id: 1, body: null, user: { login: "pakgin-agent" } });
  },
  delete: async (path) => {
    calls.push({ method: "DELETE", path });
  },
});

const reaction = {
  repository: "pakgin/scratch",
  subject: "review-comment" as const,
  subjectId: 21,
  content: "eyes",
};

describe("createGitHubDelivery", () => {
  it("posts a comment with a marker that a retry can find, and finds only the agent's own", async () => {
    const calls: Call[] = [];
    const delivery = createGitHubDelivery({
      client: fakeClient(
        {
          "/repos/pakgin/scratch/issues/7/comments": [
            {
              id: 1,
              body: "Fixed.\n\n<!-- superagent:report:4:github -->",
              user: { login: "someone-else" },
            },
            {
              id: 2,
              body: "Fixed.\n\n<!-- superagent:report:5:github -->",
              user: { login: "pakgin-agent" },
            },
          ],
        },
        calls,
      ),
      agentLogin: "pakgin-agent",
    });
    const query = {
      repository: "pakgin/scratch",
      issueNumber: 7,
      postedAfter: 0,
    };

    await delivery.comment({
      ...query,
      text: "Fixed.",
      dedupeKey: "report:6:github",
    });

    expect(calls[0]).toEqual({
      method: "POST",
      path: "/repos/pakgin/scratch/issues/7/comments",
      body: { body: "Fixed.\n\n<!-- superagent:report:6:github -->" },
    });
    expect(
      await delivery.hasComment({ ...query, dedupeKey: "report:5:github" }),
    ).toBe(true);
    expect(
      await delivery.hasComment({ ...query, dedupeKey: "report:4:github" }),
    ).toBe(false);
  });

  it("reacts to a comment, and takes only the agent's own reaction off", async () => {
    const calls: Call[] = [];
    const delivery = createGitHubDelivery({
      client: fakeClient(
        {
          "/repos/pakgin/scratch/pulls/comments/21/reactions": [
            { id: 70, user: { login: "pakgin" } },
            { id: 71, user: { login: "pakgin-agent" } },
          ],
        },
        calls,
      ),
      agentLogin: "pakgin-agent",
    });

    await delivery.react({ ...reaction, content: "+1" });
    await delivery.unreact(reaction);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/repos/pakgin/scratch/pulls/comments/21/reactions",
        body: { content: "+1" },
      },
      {
        method: "GET",
        path: "/repos/pakgin/scratch/pulls/comments/21/reactions?content=eyes&per_page=100&page=1",
      },
      {
        method: "DELETE",
        path: "/repos/pakgin/scratch/pulls/comments/21/reactions/71",
      },
    ]);
  });

  it("retries rate limits, server errors, and network failures, and gives up on other refusals", () => {
    const delivery = createGitHubDelivery({
      client: fakeClient({}, []),
      agentLogin: "pakgin-agent",
    });
    const failure = (status: number) =>
      delivery.classifyFailure(
        new GitHubRequestError(`answered ${status}`, status),
      ).kind;

    expect([failure(404), failure(422)]).toEqual(["permanent", "permanent"]);
    expect([failure(403), failure(429), failure(502)]).toEqual([
      "transient",
      "transient",
      "transient",
    ]);
    expect(delivery.classifyFailure(new Error("socket hang up")).kind).toBe(
      "transient",
    );
    expect(vi.isMockFunction(delivery.react)).toBe(false);
  });
});
