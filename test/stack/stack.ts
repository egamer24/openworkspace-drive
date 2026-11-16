import path from "node:path";

import { testWorkspaceStack } from "@open-workspace/core/testing";

import { Drive } from "../../alchemy.ts";

/** Core and this module, wrapped by worker.ts. Drive needs no mail. */
export const { stack, stackName } = testWorkspaceStack({
  stack: "DriveModuleTest",
  wrap: { entry: path.join(import.meta.dirname, "worker.ts") },
  modules: [Drive()],
});
