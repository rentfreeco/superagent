import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface ToolOutcome {
  isAccepted: boolean;
  /** What the tool tells the session. */
  reply: string;
}

export const toToolResult = ({
  isAccepted,
  reply,
}: ToolOutcome): CallToolResult => ({
  content: [{ type: "text", text: reply }],
  isError: !isAccepted,
});
