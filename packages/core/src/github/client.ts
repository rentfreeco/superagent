import type { z } from "zod";
import {
  GITHUB_API_URL,
  GITHUB_API_VERSION,
  GITHUB_ERROR_BODY_MAX_LENGTH,
  GITHUB_REQUEST_TIMEOUT_MS,
} from "../constants.ts";

export interface GitHubClientOptions {
  token: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

export interface GitHubClient {
  get<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
  ): Promise<z.output<Schema>>;
}

export const createGitHubClient = ({
  token,
  fetch = globalThis.fetch,
  baseUrl = GITHUB_API_URL,
}: GitHubClientOptions): GitHubClient => ({
  get: async (path, schema) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "superagent",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(
        0,
        GITHUB_ERROR_BODY_MAX_LENGTH,
      );
      throw new Error(
        `github: GET ${path} answered ${response.status}: ${body}`,
      );
    }
    return schema.parse(await response.json());
  },
});
