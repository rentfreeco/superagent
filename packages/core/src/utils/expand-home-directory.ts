import { homedir } from "node:os";
import path from "node:path";

export const expandHomeDirectory = (filePath: string): string =>
  filePath === "~" || filePath.startsWith("~/")
    ? path.join(homedir(), filePath.slice(1))
    : filePath;
