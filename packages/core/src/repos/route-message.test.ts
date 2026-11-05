import { describe, expect, it } from "vitest";
import type { Repo } from "./config.ts";
import { routeMessage } from "./route-message.ts";

const superagentRepo: Repo = {
  name: "superagent",
  github: "pakgin/superagent",
  path: "/code/superagent",
  baseBranch: "main",
};

const repo2: Repo = {
  name: "repo2",
  github: "pakgin/repo2",
  path: "/code/repo2",
  baseBranch: "main",
};

const channelRepos = new Map([
  ["C0123ABCD", superagentRepo],
  ["C0456EFGH", repo2],
]);

describe("routeMessage", () => {
  it("routes a mention in a mapped channel to that channel's repo", () => {
    expect(
      routeMessage(channelRepos, { channel: "C0456EFGH", via: "mention" }),
    ).toEqual({ kind: "repo", repo: repo2 });
  });

  it("answers a DM by pointing at the repo channels", () => {
    expect(
      routeMessage(channelRepos, { channel: "D0123ABCD", via: "dm" }),
    ).toEqual({
      kind: "reply",
      text: "DMs don't map to a repo. Mention me in a repo channel instead: <#C0123ABCD> (superagent), <#C0456EFGH> (repo2).",
    });
  });

  it("answers a DM when no channels are mapped yet", () => {
    const route = routeMessage(new Map(), { channel: "D0123ABCD", via: "dm" });
    expect(route.kind).toBe("reply");
    expect(route).toHaveProperty(
      "text",
      expect.stringContaining("no channels are mapped yet"),
    );
  });

  it("answers a mention in an unmapped channel with the line to add", () => {
    const route = routeMessage(channelRepos, {
      channel: "C0999ZZZZ",
      via: "mention",
    });
    expect(route.kind).toBe("reply");
    expect(route).toHaveProperty(
      "text",
      expect.stringContaining('`C0999ZZZZ: "<repo name>"`'),
    );
  });
});
