import { stat } from "node:fs/promises";
import path from "node:path";

export const isGitCheckout = async (directory: string): Promise<boolean> => {
  try {
    await stat(path.join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
};
