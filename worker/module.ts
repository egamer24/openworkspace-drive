import type { WorkspaceModule } from "@open-workspace/core/module";

import {
  DRIVE_MODULE,
  driveOauthScopes,
  drivePermissions,
} from "../shared/module";
import { drivePublicRoutes } from "./public";
import { driveAccountApi } from "./routes";

/** Drive's Worker half: `Drive()` points the generated Worker entry at this factory (../index.ts). */
export function drive(): WorkspaceModule {
  return {
    name: DRIVE_MODULE,
    accountApi: driveAccountApi,
    routes: drivePublicRoutes,
    permissions: drivePermissions,
    oauthScopes: driveOauthScopes,
    // Loaded with the first MCP request only.
    mcpTools: () => import("./mcp").then((tools) => tools.registerDriveTools),
  };
}
