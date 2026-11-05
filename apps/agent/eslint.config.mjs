import { config } from "@repo/eslint-config/base";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...config,
  {
    files: ["**/*.ts"],
    // The Babel parser's scope analysis can't see type-only bindings, so these
    // flag every interface and type import. tsc checks both (see tsconfig.json).
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
];
