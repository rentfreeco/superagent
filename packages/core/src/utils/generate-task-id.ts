import { randomBytes } from "node:crypto";
import { TASK_ID_ALPHABET, TASK_ID_LENGTH } from "../constants.ts";

export const generateTaskId = (): string =>
  [...randomBytes(TASK_ID_LENGTH)]
    .map((randomByte) =>
      TASK_ID_ALPHABET.charAt(randomByte % TASK_ID_ALPHABET.length),
    )
    .join("");
