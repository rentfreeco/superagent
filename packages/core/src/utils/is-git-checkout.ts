import path from "node:path";
import { pathExists } from "./path-exists.ts";

export const isGitCheckout = (directory: string): Promise<boolean> =>
  pathExists(path.join(directory, ".git"));
