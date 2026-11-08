import type { z } from "zod";
import { GITHUB_MAX_PAGES, GITHUB_PAGE_SIZE } from "../constants.ts";
import type { GitHubClient } from "./client.ts";

/**
 * Every item of a paged GitHub list. A list longer than GITHUB_MAX_PAGES
 * pages throws, so a cut-off list never passes for the whole of it.
 */
export const getAllPages = async <Page extends z.ZodType, Item>(
  client: GitHubClient,
  path: string,
  pageSchema: Page,
  itemsOf: (page: z.output<Page>) => readonly Item[],
): Promise<Item[]> => {
  const separator = path.includes("?") ? "&" : "?";
  const items: Item[] = [];
  for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
    const pageItems = itemsOf(
      await client.get(
        `${path}${separator}per_page=${GITHUB_PAGE_SIZE}&page=${page}`,
        pageSchema,
      ),
    );
    items.push(...pageItems);
    if (pageItems.length < GITHUB_PAGE_SIZE) return items;
  }
  throw new Error(
    `github: ${path} has more than ${GITHUB_MAX_PAGES * GITHUB_PAGE_SIZE} items`,
  );
};
