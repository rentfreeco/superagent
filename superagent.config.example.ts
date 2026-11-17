import { defineConfig } from "@repo/core/repos";

export default defineConfig({
  repos: {
    superagent: {
      github: "rentfreeco/superagent",
      path: "~/code/superagent",
      baseBranch: "main",
      description: "The Slack coding agent itself",
    },
  },
  channels: {
    C0123ABCD: "superagent",
  },
});
