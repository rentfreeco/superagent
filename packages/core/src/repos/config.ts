import { z } from "zod";

export interface RepoConfig {
  github: string;
  path: string;
  baseBranch: string;
}

export interface SuperagentConfig {
  repos: Record<string, RepoConfig>;
  channels: Record<string, string>;
}

export interface Repo extends RepoConfig {
  name: string;
}

const repoConfigSchema = z.strictObject({
  github: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/name, like pakgin/superagent"),
  path: z.string().min(1),
  baseBranch: z.string().min(1),
});

const configSchema = z
  .strictObject({
    repos: z.record(z.string().min(1), repoConfigSchema),
    channels: z.record(z.string().regex(/^[CG][A-Z0-9]+$/), z.string(), {
      error: (issue) =>
        issue.code === "invalid_key"
          ? "must be a Slack channel ID, like C0123ABCD"
          : undefined,
    }),
  })
  .superRefine((config, context) => {
    for (const [channelId, repoName] of Object.entries(config.channels)) {
      if (Object.hasOwn(config.repos, repoName)) continue;
      context.addIssue({
        code: "custom",
        path: ["channels", channelId],
        message: `points at "${repoName}", which is not defined under repos`,
      });
    }
  });

export const defineConfig = (config: SuperagentConfig): SuperagentConfig =>
  config;

export const parseConfig = (value: unknown): SuperagentConfig => {
  const result = configSchema.safeParse(value);
  if (result.success) return result.data;
  throw new Error(
    `Invalid superagent config:\n${z.prettifyError(result.error)}`,
  );
};
