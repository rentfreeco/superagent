import { homedir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { expandHomeDirectory } from "./expand-home-directory.ts";

it("expands a leading ~ and leaves every other path alone", () => {
  expect(expandHomeDirectory("~")).toBe(homedir());
  expect(expandHomeDirectory("~/code/superagent")).toBe(
    path.join(homedir(), "code/superagent"),
  );
  expect(expandHomeDirectory("./superagent")).toBe("./superagent");
  expect(expandHomeDirectory("/code/~/superagent")).toBe("/code/~/superagent");
  expect(expandHomeDirectory("~someone/code")).toBe("~someone/code");
});
