import { defineConfig } from "@repo/core/repos";

export default defineConfig({
  repos: {
    superagent: {
      github: "pakgin/superagent",
      path: "~/code/superagent",
      baseBranch: "main",
    },
  },
  channels: {
    C0123ABCD: "superagent",
  },
});
