import { defineConfig } from "@repo/core/repos";

export default defineConfig({
  repos: {
    superagent: {
      github: "pakgin/superagent",
      path: "~/code/superagent",
      baseBranch: "main",
      description: "The Slack coding agent itself",
    },
  },
  channels: {
    C0123ABCD: "superagent",
  },
});
