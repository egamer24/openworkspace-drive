import type { ClientModule } from "@open-workspace/core/ui";
import { HardDrive } from "lucide-react";
import { lazy } from "react";

import { DRIVE_MODULE, DRIVE_PATH, MANAGE_DRIVE } from "../shared/module";

/**
 * Drive's part of the browser app; `Drive()` points the build here. The
 * entry stays light: each screen is its own lazy chunk.
 */
const drive: ClientModule = {
  name: DRIVE_MODULE,
  app: { label: "Drive", Icon: HardDrive, path: DRIVE_PATH },
  routes: [
    {
      path: DRIVE_PATH,
      Component: lazy(() =>
        import("./drive-page").then((module) => ({ default: module.DrivePage }))
      ),
    },
  ],
  admin: [
    {
      id: "drive",
      label: "Drive",
      Icon: HardDrive,
      permission: MANAGE_DRIVE,
      title: "Drive",
      description:
        "Storage quotas, and each person's usage. Trash and unfinished uploads count until they're gone.",
      Component: lazy(() =>
        import("./drive-admin").then((module) => ({
          default: module.DriveAdmin,
        }))
      ),
    },
  ],
};

export default drive;
