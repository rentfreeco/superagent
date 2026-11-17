# `@repo/eslint-config`

The repository's shared ESLint flat config, exported as `@repo/eslint-config/base`. Each workspace's `eslint.config.mjs` spreads it and turns off the two rules Babel can't apply to TypeScript, as `packages/core/eslint.config.mjs` does:

```js
import { config } from "@repo/eslint-config/base";

export default [
  ...config,
  {
    files: ["**/*.ts"],
    rules: { "no-undef": "off", "no-unused-vars": "off" },
  },
];
```

- **Parser:** `@babel/eslint-parser` with `@babel/preset-typescript`, so TypeScript is linted without type information. Babel can't see type-only bindings, so `tsc` checks undefined and unused names instead, through `noUnusedLocals` and `noUnusedParameters`.
- **Rules:** `@eslint/js` recommended, `eslint-config-prettier` so formatting is Prettier's alone, and `turbo/no-undeclared-env-vars`. `eslint-plugin-only-warn` turns errors into warnings, and each workspace's lint script fails on any warning with `--max-warnings 0`.

The parser runs in a worker thread, so its options must be structured-cloneable: `base.js` passes the TypeScript preset as a resolved path string, never an imported module. After changing this config, also run ESLint without pnpm's wrapper, as [`AGENTS.md`](../../AGENTS.md) describes.
