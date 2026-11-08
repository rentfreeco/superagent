import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GITHUB_MAX_PAGES, GITHUB_PAGE_SIZE } from "../constants.ts";
import type { GitHubClient } from "./client.ts";
import { getAllPages } from "./get-all-pages.ts";

const pagedClient = (
  itemCount: number,
  requestedPaths: string[],
): GitHubClient => ({
  get: async (path, schema) => {
    requestedPaths.push(path);
    const page = Number(path.match(/[?&]page=(\d+)/)?.[1]);
    const firstIndex = (page - 1) * GITHUB_PAGE_SIZE;
    const pageItems = Array.from(
      {
        length: Math.max(0, Math.min(GITHUB_PAGE_SIZE, itemCount - firstIndex)),
      },
      (_item, offset) => ({ id: firstIndex + offset + 1 }),
    );
    return schema.parse(pageItems);
  },
  post: async () => {
    throw new Error("getAllPages only reads");
  },
  delete: async () => {
    throw new Error("getAllPages only reads");
  },
});

const itemSchema = z.array(z.object({ id: z.number() }));

describe("getAllPages", () => {
  it("reads every page until a short one, keeping a query the path already has", async () => {
    const requestedPaths: string[] = [];

    const items = await getAllPages(
      pagedClient(GITHUB_PAGE_SIZE + 5, requestedPaths),
      "/repos/pakgin/scratch/issues/7/comments?since=2026-11-07T09:00:00.000Z",
      itemSchema,
      (page) => page,
    );

    expect(items).toHaveLength(GITHUB_PAGE_SIZE + 5);
    expect(requestedPaths).toEqual([
      `/repos/pakgin/scratch/issues/7/comments?since=2026-11-07T09:00:00.000Z&per_page=${GITHUB_PAGE_SIZE}&page=1`,
      `/repos/pakgin/scratch/issues/7/comments?since=2026-11-07T09:00:00.000Z&per_page=${GITHUB_PAGE_SIZE}&page=2`,
    ]);
  });

  it("throws instead of passing a list cut off at the page cap for the whole of it", async () => {
    await expect(
      getAllPages(
        pagedClient(GITHUB_MAX_PAGES * GITHUB_PAGE_SIZE + 1, []),
        "/repos/pakgin/scratch/commits/abc/check-runs",
        itemSchema,
        (page) => page,
      ),
    ).rejects.toThrow("has more than");
  });
});
