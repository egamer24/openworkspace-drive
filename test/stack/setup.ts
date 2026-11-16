import { deployTestStack } from "@open-workspace/core/testing";

// Preloaded by `bun run test:stack`: core and this module, deployed once for the run.
await deployTestStack(() => import("./stack.ts"));
