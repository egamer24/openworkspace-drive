import { demoSeed, devWorkspaceStack } from "@open-workspace/core/dev";
import { Email } from "@open-workspace/email/alchemy";

import { Drive } from "./alchemy.ts";

/**
 * The workspace on your machine with core's demo (`bun run dev`): no
 * Cloudflare account, the demo sign-in, mail, and Drive in the app switcher.
 */
const { stack, stackName } = devWorkspaceStack({
  stack: "DriveModuleDev",
  modules: [Email(), Drive()],
  seed: [demoSeed],
  port: Number(process.env.PORT ?? 5192),
});

export { stackName };

export default stack;
