import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

import { ignoredPaths } from "./tools/ignores.ts";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [...ultracite.ignorePatterns, ...ignoredPaths],
  // Keep the docs' hand-wrapped prose; ultracite's "never" would unwrap every paragraph.
  proseWrap: "preserve",
});
