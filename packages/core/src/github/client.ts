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
  post<Schema extends z.ZodType>(
    path: string,
    body: unknown,
    schema: Schema,
  ): Promise<z.output<Schema>>;
}

export const createGitHubClient = ({
  token,
  fetch = globalThis.fetch,
  baseUrl = GITHUB_API_URL,
}: GitHubClientOptions): GitHubClient => {
  const request = async (
    method: "GET" | "POST",
    path: string,
    body: unknown,
  ): Promise<unknown> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "superagent",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(
        0,
        GITHUB_ERROR_BODY_MAX_LENGTH,
      );
      throw new Error(
        `github: ${method} ${path} answered ${response.status}: ${text}`,
      );
    }
    return response.json();
  };
  return {
    get: async (path, schema) =>
      schema.parse(await request("GET", path, undefined)),
    post: async (path, body, schema) =>
      schema.parse(await request("POST", path, body)),
  };
};
