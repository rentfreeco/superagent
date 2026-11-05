import path from "node:path";
import { pathToFileURL } from "node:url";
import { expandHomeDirectory } from "../utils/expand-home-directory.ts";
import { isGitCheckout } from "../utils/is-git-checkout.ts";
import { pathExists } from "../utils/path-exists.ts";
import { parseConfig, type Repo } from "./config.ts";

export const loadConfig = async (
  configPath: string,
): Promise<ReadonlyMap<string, Repo>> => {
  const absoluteConfigPath = path.resolve(configPath);
  if (!(await pathExists(absoluteConfigPath))) {
    throw new Error(
      `No superagent config at ${absoluteConfigPath}. Start from superagent.config.example.ts at the repository root.`,
    );
  }
  const configModule: { default?: unknown } = await import(
    pathToFileURL(absoluteConfigPath).href
  );
  if (configModule.default === undefined) {
    throw new Error(
      `${absoluteConfigPath} has no default export. Export the config with \`export default defineConfig({ ... })\`.`,
    );
  }
  const config = parseConfig(configModule.default);
  const configDirectory = path.dirname(absoluteConfigPath);

  const repos = new Map<string, Repo>(
    Object.entries(config.repos).map(([name, repoConfig]) => [
      name,
      {
        ...repoConfig,
        name,
        path: path.resolve(
          configDirectory,
          expandHomeDirectory(repoConfig.path),
        ),
      },
    ]),
  );

  const checkoutResults = await Promise.all(
    [...repos.values()].map(async (repo) => ({
      repo,
      isCheckout: await isGitCheckout(repo.path),
    })),
  );
  const missingCheckouts = checkoutResults
    .filter(({ isCheckout }) => !isCheckout)
    .map(({ repo }) => `  ${repo.name}: ${repo.path}`);
  if (missingCheckouts.length > 0) {
    throw new Error(
      `No git checkout at these repo paths in ${absoluteConfigPath}:\n${missingCheckouts.join("\n")}`,
    );
  }

  const channelRepos = new Map<string, Repo>();
  for (const [channelId, repoName] of Object.entries(config.channels)) {
    const repo = repos.get(repoName);
    if (repo) channelRepos.set(channelId, repo);
  }
  return channelRepos;
};
