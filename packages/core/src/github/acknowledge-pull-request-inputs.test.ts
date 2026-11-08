import { describe, expect, it, vi } from "vitest";
import {
  acknowledgePullRequestInputs,
  reactionPathFor,
} from "./acknowledge-pull-request-inputs.ts";
import type { GitHubClient } from "./client.ts";

describe("acknowledgePullRequestInputs", () => {
  it("puts 👀 on comments and review comments, and skips reviews and check runs, which can't take a reaction", async () => {
    const post = vi.fn(async (_path: string, _body: unknown) => ({ id: 1 }));
    const client: GitHubClient = {
      get: async () => {
        throw new Error("only posts");
      },
      post: async (path, body, schema) => schema.parse(await post(path, body)),
    };

    const acknowledged = await acknowledgePullRequestInputs({
      client,
      repository: "pakgin/scratch",
      refs: [
        "github:comment:31",
        "github:review-comment:21",
        "github:review:11",
        "github:check-run:9",
      ],
    });

    expect(acknowledged).toEqual([
      "github:comment:31",
      "github:review-comment:21",
    ]);
    expect(post.mock.calls.map(([path, body]) => [path, body])).toEqual([
      [
        "/repos/pakgin/scratch/issues/comments/31/reactions",
        { content: "eyes" },
      ],
      [
        "/repos/pakgin/scratch/pulls/comments/21/reactions",
        { content: "eyes" },
      ],
    ]);
  });

  it("knows where a reaction goes only for comment refs", () => {
    expect(
      reactionPathFor("pakgin/scratch", "github:comment:31x"),
    ).toBeUndefined();
    expect(reactionPathFor("pakgin/scratch", "Ev123")).toBeUndefined();
  });
});
