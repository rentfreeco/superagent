import { expect, it } from "vitest";
import { compareSlackTs } from "./compare-slack-ts.ts";

it("orders Slack timestamps by seconds, then by the microseconds after the dot", () => {
  expect(
    ["1700000000.000010", "1700000000.000009", "1699999999.999999"].sort(
      compareSlackTs,
    ),
  ).toEqual(["1699999999.999999", "1700000000.000009", "1700000000.000010"]);
  expect(compareSlackTs("1700000000.000001", "1700000000.000001")).toBe(0);
  expect(compareSlackTs("1700000000.1", "1700000000.000002")).toBeGreaterThan(
    0,
  );
});
