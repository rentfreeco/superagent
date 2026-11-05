import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./load-config.ts";

let workspaceDirectory = "";

const writeConfig = async (source: string): Promise<string> => {
  const configPath = path.join(workspaceDirectory, "superagent.config.ts");
  await writeFile(configPath, source);
  return configPath;
};

const makeCheckout = async (directory: string): Promise<void> => {
  await mkdir(path.join(directory, ".git"), { recursive: true });
};

beforeEach(async () => {
  workspaceDirectory = await mkdtemp(path.join(tmpdir(), "superagent-config-"));
});

afterEach(async () => {
  await rm(workspaceDirectory, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("maps each channel to its repo, with paths resolved from the config file", async () => {
    const elsewhere = path.join(workspaceDirectory, "elsewhere", "repo2");
    await makeCheckout(path.join(workspaceDirectory, "superagent"));
    await makeCheckout(elsewhere);
    const configPath = await writeConfig(`export default {
      repos: {
        superagent: { github: "pakgin/superagent", path: "./superagent", baseBranch: "main" },
        repo2: { github: "pakgin/repo2", path: ${JSON.stringify(elsewhere)}, baseBranch: "trunk" },
      },
      channels: { C0123ABCD: "superagent", C0456EFGH: "repo2", C0789IJKL: "repo2" },
    };`);

    const channelRepos = await loadConfig(configPath);

    expect([...channelRepos.keys()]).toEqual([
      "C0123ABCD",
      "C0456EFGH",
      "C0789IJKL",
    ]);
    expect(channelRepos.get("C0123ABCD")).toEqual({
      name: "superagent",
      github: "pakgin/superagent",
      path: path.join(workspaceDirectory, "superagent"),
      baseBranch: "main",
    });
    expect(channelRepos.get("C0789IJKL")).toBe(channelRepos.get("C0456EFGH"));
    expect(channelRepos.get("C0456EFGH")?.path).toBe(elsewhere);
  });

  it("names every repo path that isn't a git checkout", async () => {
    await mkdir(path.join(workspaceDirectory, "plain-directory"));
    const configPath = await writeConfig(`export default {
      repos: {
        plain: { github: "pakgin/plain", path: "./plain-directory", baseBranch: "main" },
        missing: { github: "pakgin/missing", path: "./missing", baseBranch: "main" },
      },
      channels: {},
    };`);

    await expect(loadConfig(configPath)).rejects.toThrow(
      /plain: .*plain-directory[\s\S]*missing: .*missing/,
    );
  });

  it("explains a config file without a default export", async () => {
    const configPath = await writeConfig(
      `export const config = { repos: {}, channels: {} };`,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      /has no default export/,
    );
  });

  it("rejects an invalid config before touching the filesystem", async () => {
    const configPath = await writeConfig(
      `export default { repos: {}, channels: { general: "superagent" } };`,
    );
    await expect(loadConfig(configPath)).rejects.toThrow(
      /Invalid superagent config/,
    );
  });

  it("points at the example when the config file doesn't exist", async () => {
    await expect(
      loadConfig(path.join(workspaceDirectory, "superagent.config.ts")),
    ).rejects.toThrow(
      /No superagent config at .*superagent\.config\.example\.ts/,
    );
  });
});
