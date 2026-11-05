import { fileURLToPath } from "node:url";

export const CONFIG_PATH = fileURLToPath(
  new URL("../../../superagent.config.ts", import.meta.url),
);
