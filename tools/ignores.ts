/** Generated and vendored paths that oxlint and oxfmt leave alone. */
export const ignoredPaths = [
  "**/.alchemy",
  "**/dist",
  "**/node_modules",
  // Drizzle output: SQL migrations, snapshots and the bundled `migrations.js`.
  "**/migrations",
  // Vendored third-party lint rules, kept identical to upstream.
  "tools/oxlint/anti-slop",
  "**/playwright-report",
  "**/test-results",
  ".core",
];
