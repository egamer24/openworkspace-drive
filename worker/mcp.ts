import {
  apiPath,
  entityIdSchema,
  runBinaryResourceTool,
  runTool,
} from "@open-workspace/core/module";
import type { McpToolRegistrar } from "@open-workspace/core/module";
import { z } from "zod";

import { DRIVE_READ_SCOPE, DRIVE_WRITE_SCOPE } from "../shared/module";
import { linkSchema, listQuerySchema, nameSchema, shareSchema } from "./routes";

const write = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const read = { ...write, readOnlyHint: true, idempotentHint: true };

const item = (id: string, rest = "") =>
  `/drive/items/${encodeURIComponent(id)}${rest}`;

/** At most this much of a file per read_drive_file call; the rest comes with nextOffsetBytes. */
const READ_CHUNK_BYTES = 1_000_000;

/**
 * Drive as MCP tools. Each is registered through `tool(scope)` and calls
 * the module's own routes in-process (`api`), which check the person's
 * access to each item again.
 */
export const registerDriveTools: McpToolRegistrar = (tool, { api }) => {
  tool(DRIVE_READ_SCOPE)(
    "list_drive_items",
    {
      title: "List or search Drive",
      description:
        "List a Drive folder (the user's top level when parentId is left out), the items shared with the user (view shared), the trash, or search the user's own files by name. Folders come first.",
      inputSchema: listQuerySchema,
      annotations: read,
    },
    (input) => runTool(() => api.json(apiPath("/drive/items", input)))
  );

  tool(DRIVE_READ_SCOPE)(
    "get_drive_item",
    {
      title: "Get a Drive item",
      description:
        "One file or folder: its name, size and type, the user's access (owner, editor or viewer) and the folders above it.",
      inputSchema: z.object({ itemId: entityIdSchema }),
      annotations: read,
    },
    ({ itemId }) => runTool(() => api.json(item(itemId)))
  );

  tool(DRIVE_READ_SCOPE)(
    "read_drive_file",
    {
      title: "Read a Drive file",
      description: `A file's bytes, up to ${READ_CHUNK_BYTES} at a time from offsetBytes; nextOffsetBytes says where the next part starts.`,
      inputSchema: z.object({
        itemId: entityIdSchema,
        offsetBytes: z.number().int().min(0).default(0),
      }),
      annotations: read,
    },
    ({ itemId, offsetBytes }) =>
      runBinaryResourceTool({
        action: () =>
          api.binary(item(itemId, "/content"), {
            offsetBytes,
            maxBytes: READ_CHUNK_BYTES,
          }),
        uri: `drive://items/${encodeURIComponent(itemId)}`,
        fallbackFilename: itemId,
      })
  );

  tool(DRIVE_WRITE_SCOPE)(
    "create_drive_folder",
    {
      title: "Create a Drive folder",
      description:
        "Create a folder at the user's top level, or in a folder they own or edit.",
      inputSchema: z.object({
        name: nameSchema,
        parentId: entityIdSchema.nullable().default(null),
      }),
      annotations: write,
    },
    (input) =>
      runTool(() => api.json("/drive/folders", { method: "POST", json: input }))
  );

  tool(DRIVE_WRITE_SCOPE)(
    "update_drive_item",
    {
      title: "Rename or move a Drive item",
      description:
        "Rename an item, move it into another folder of the same owner's drive (parentId null: the top level), or both. Needs owner or editor access.",
      inputSchema: z.object({
        itemId: entityIdSchema,
        name: nameSchema.optional(),
        parentId: entityIdSchema.nullable().optional(),
      }),
      annotations: { ...write, idempotentHint: true },
    },
    ({ itemId, ...changes }) =>
      runTool(() => api.json(item(itemId), { method: "PATCH", json: changes }))
  );

  tool(DRIVE_WRITE_SCOPE)(
    "trash_drive_item",
    {
      title: "Move a Drive item to the trash",
      description:
        "Move a file or folder, with everything in it, to its owner's trash, where the owner can restore it.",
      inputSchema: z.object({ itemId: entityIdSchema }),
      annotations: { ...write, destructiveHint: true, idempotentHint: true },
    },
    ({ itemId }) =>
      runTool(() => api.json(item(itemId, "/trash"), { method: "POST" }))
  );

  tool(DRIVE_WRITE_SCOPE)(
    "share_drive_item",
    {
      title: "Share a Drive item",
      description:
        "Share a file or folder the user owns with a person (by their workspace address) or a team the user is in, as viewer or editor. Sharing again changes the role.",
      inputSchema: shareSchema.safeExtend({ itemId: entityIdSchema }),
      annotations: { ...write, idempotentHint: true },
    },
    ({ itemId, ...share }) =>
      runTool(() =>
        api.json(item(itemId, "/shares"), { method: "POST", json: share })
      )
  );

  tool(DRIVE_WRITE_SCOPE)(
    "create_drive_link",
    {
      title: "Create a public link",
      description:
        "Create a public /d/<token> link to a file the user owns: anyone with it can open the file, without signing in. expiresAt is a Unix time in milliseconds. The URL is returned once.",
      inputSchema: linkSchema.extend({ itemId: entityIdSchema }),
      annotations: { ...write, openWorldHint: true },
    },
    ({ itemId, ...link }) =>
      runTool(() =>
        api.json(item(itemId, "/links"), { method: "POST", json: link })
      )
  );
};
