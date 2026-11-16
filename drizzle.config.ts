import { defineConfig } from "drizzle-kit";

// The module's D1 tables. Migrations ship with the package and run on deploy,
// recorded as modules/drive/<file>: never rename the module or its files.
export default defineConfig({
  schema: "./worker/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
});
