import type { PermissionDefinition } from "@open-workspace/core/shared";

/**
 * The module's id, repeated by its three halves: `Drive()` (its migrations
 * are recorded as `modules/drive/…`, so it never changes), the Worker's
 * `WorkspaceModule.name` and the browser's `ClientModule.name`.
 */
export const DRIVE_MODULE = "drive";

/** Where the app lives in the browser. */
export const DRIVE_PATH = "/drive";

/** Public links: `/d/<token>`, served by the Worker before the app's assets. */
export const DRIVE_LINK_PATH = "/d";

/** Lets a member see everyone's usage, set quotas and erase a person's files. */
export const MANAGE_DRIVE = "manage_drive";

/** The OAuth scope that hands an app MANAGE_DRIVE. */
export const MANAGE_DRIVE_SCOPE = "admin.drive";

export const drivePermissions: PermissionDefinition[] = [
  {
    id: MANAGE_DRIVE,
    label: "Manage Drive",
    description:
      "See everyone's Drive usage, set storage quotas and delete a person's files.",
    scope: MANAGE_DRIVE_SCOPE,
  },
];

/** What an app (an MCP client) may do with the files the person can open. */
export const DRIVE_READ_SCOPE = "drive.read";
export const DRIVE_WRITE_SCOPE = "drive.write";

/** The scopes as the consent screen lists them. An app that asks for nothing may read. */
export const driveOauthScopes = {
  group: "drive",
  title: "Drive",
  scopes: [
    {
      id: DRIVE_READ_SCOPE,
      label: "See and download your files and the ones shared with you",
      byDefault: true,
    },
    {
      id: DRIVE_WRITE_SCOPE,
      label: "Organize, share and delete your files, and create public links",
    },
  ],
};

/**
 * One upload is one presigned PUT, and completing it copies the bytes
 * through the Worker to their final key; 100 MB keeps that copy quick.
 */
export const MAX_UPLOAD_BYTES = 100_000_000;

/** What a person may store until an administrator says otherwise. */
export const DEFAULT_QUOTA_BYTES = 5_000_000_000;

/** Where a file's bytes are in the bucket: `files/<id>`, once its upload is complete. */
export const FILES_PREFIX = "files/";

/** Unfinished uploads, `staging/<id>`; the bucket expires them after a day. */
export const STAGING_PREFIX = "staging/";

export const MAX_NAME_LENGTH = 255;

/** Items a folder listing returns; larger folders show the first ones. */
export const MAX_LIST_ITEMS = 500;

export const driveRoles = ["viewer", "editor"] as const;

export type DriveRole = (typeof driveRoles)[number];

/** What the signed-in person may do with an item: theirs, or shared with them. */
export type DriveAccess = "owner" | DriveRole;

/** A public link either shows the file in the browser (if it can be) or downloads it. */
export const linkAccess = ["view", "download"] as const;

export const driveSorts = ["name", "date", "size"] as const;

export const driveViews = ["files", "shared", "trash"] as const;
