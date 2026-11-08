import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createGitHubClient } from "./client.ts";

const respondWith = (status: number, body: unknown) =>
  vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
  );

describe("createGitHubClient", () => {
  it("asks GitHub's API with the token and parses the answer", async () => {
    const fetch = respondWith(200, {
      login: "superagent-bot",
      id: 7,
      extra: true,
    });
    const client = createGitHubClient({ token: "ghp_agent", fetch });

    const user = await client.get(
      "/user",
      z.object({ login: z.string(), id: z.number() }),
    );

    expect(user).toEqual({ login: "superagent-bot", id: 7 });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.github.com/user");
    expect(init?.headers).toMatchObject({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer ghp_agent",
      "X-GitHub-Api-Version": "2022-11-28",
    });
  });

  it("posts a JSON body", async () => {
    const fetch = respondWith(201, { id: 5, content: "eyes" });
    const client = createGitHubClient({ token: "ghp_agent", fetch });

    await client.post(
      "/repos/pakgin/scratch/issues/comments/31/reactions",
      { content: "eyes" },
      z.object({ id: z.number() }),
    );

    const [, init] = fetch.mock.calls[0] ?? [];
    expect(init).toMatchObject({
      method: "POST",
      body: '{"content":"eyes"}',
      headers: { "Content-Type": "application/json" },
    });
  });

  it("fails with GitHub's status and message", async () => {
    const client = createGitHubClient({
      token: "ghp_revoked",
      fetch: respondWith(401, { message: "Bad credentials" }),
    });

    await expect(client.get("/user", z.object({}))).rejects.toThrow(
      'github: GET /user answered 401: {"message":"Bad credentials"}',
    );
  });
});
