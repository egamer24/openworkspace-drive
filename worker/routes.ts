import {
  apiError,
  createDb,
  createId,
  emailSchema,
  hashToken,
  mailboxAddressPredicate,
  mailboxAddressSql,
  mailboxes,
  oauthScope,
  overRateLimit,
  randomToken,
  rateLimitedResponse,
  requireAuth,
  requirePermission,
  teamMembership,
  teams,
  users,
  zValidator,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { required } from "@open-workspace/core/shared";
import { and, asc, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import {
  DRIVE_LINK_PATH,
  DRIVE_READ_SCOPE,
  DRIVE_WRITE_SCOPE,
  driveRoles,
  driveSorts,
  driveViews,
  linkAccess,
  MANAGE_DRIVE,
  MANAGE_DRIVE_SCOPE,
  MAX_LIST_ITEMS,
  MAX_NAME_LENGTH,
  MAX_UPLOAD_BYTES,
} from "../shared/module";
import type { DriveAccess } from "../shared/module";
import {
  canEdit,
  defaultQuota,
  deleteDriveOf,
  deleteSubtree,
  fileKey,
  fileResponse,
  isLive,
  isUniqueViolation,
  isWithin,
  itemContext,
  itemView,
  loadItem,
  quotaOf,
  reserveUpload,
  restoreSubtree,
  stagingKey,
  sweepStaleUploads,
  trashSubtree,
  usageOf,
  usedBytesSql,
} from "./items";
import { hashPassword } from "./password";
import { signUploadUrl } from "./presign";
import {
  driveItems,
  driveLinks,
  driveQuotas,
  driveSettings,
  driveShares,
} from "./schema";
import type { DriveItem } from "./schema";

const idSchema = z.string().trim().min(1).max(64);

/** Names end up in paths, breadcrumbs and Content-Disposition headers. */
export const nameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(MAX_NAME_LENGTH)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
      !/[/\\\u0000-\u001F]/u.test(value),
    "Names can't contain slashes or control characters"
  );

export const listQuerySchema = z.object({
  view: z.enum(driveViews).default("files"),
  parentId: idSchema.optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(driveSorts).default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
});

const folderSchema = z.object({
  parentId: idSchema.nullable().default(null),
  name: nameSchema,
});

const uploadSchema = z.object({
  parentId: idSchema.nullable().default(null),
  name: nameSchema,
  contentType: z.string().trim().max(255).default(""),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

const updateSchema = z
  .object({
    name: nameSchema.optional(),
    // null: the owner's top level.
    parentId: idSchema.nullable().optional(),
  })
  .refine(
    (value) => value.name !== undefined || value.parentId !== undefined,
    "Nothing to update"
  );

export const shareSchema = z
  .object({
    email: emailSchema.optional(),
    teamId: idSchema.optional(),
    role: z.enum(driveRoles),
  })
  .refine(
    (value) => (value.email === undefined) !== (value.teamId === undefined),
    "Share with a person's address or a team"
  );

export const linkSchema = z.object({
  access: z.enum(linkAccess).default("download"),
  /** Milliseconds since the epoch; null never expires. */
  expiresAt: z.number().int().positive().nullable().default(null),
  password: z.string().min(4).max(128).nullable().default(null),
});

const quotaSchema = z.object({
  // null: back to the workspace's default.
  quotaBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
});

const settingsSchema = z.object({
  defaultQuotaBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const NOT_FOUND = "Item not found";
const NAME_TAKEN = "Something with this name is already here";

function notFound(c: Context<AppEnv>, message = NOT_FOUND) {
  return apiError(c, 404, "NOT_FOUND", message);
}

/**
 * A content type safe to sign and to send back: `type/subtype` without
 * parameters, else application/octet-stream.
 */
function uploadContentType(value: string) {
  const type = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  return /^[\w.+-]+\/[\w.+-]+$/u.test(type) ? type : "application/octet-stream";
}

/**
 * Where a new item may go and whose drive it is in: the person's own top
 * level, or a folder they own or edit, which isn't in the trash.
 */
async function writableParent(
  env: Env,
  userId: string,
  parentId: string | null
) {
  if (!parentId) return { ownerUserId: userId, parentId: null };
  const context = await itemContext(env, userId, parentId);

  if (
    !context ||
    context.item.kind !== "folder" ||
    !isLive(context.item) ||
    !canEdit(context.access)
  ) {
    return null;
  }

  return { ownerUserId: context.item.ownerUserId, parentId };
}

/**
 * A pending upload may only be finished by the person who started it, while
 * they may still write where it lands: an editor whose share was revoked
 * meanwhile, or whose folder went to the trash, can't.
 */
async function canFinishUpload(env: Env, userId: string, item: DriveItem) {
  if (item.createdByUserId !== userId) return false;
  const parent = await writableParent(env, userId, item.parentId);

  return parent?.ownerUserId === item.ownerUserId;
}

/** Shares of this person, or of a team they are in. */
const sharedWithSql = (userId: string) => sql`(
  ${driveShares.userId} = ${userId}
  OR ${driveShares.teamId} IN (SELECT ${teamMembership.teamId} FROM ${teamMembership} WHERE ${teamMembership.userId} = ${userId})
)`;

/** The strongest share of an item with this person, for the "Shared with me" list. */
const sharedAccessSql = (userId: string) => sql<DriveAccess>`(
  SELECT CASE max(CASE ${driveShares.role} WHEN 'editor' THEN 2 ELSE 1 END) WHEN 2 THEN 'editor' ELSE 'viewer' END
  FROM ${driveShares}
  WHERE ${driveShares.itemId} = ${driveItems.id} AND ${sharedWithSql(userId)}
)`;

// The trash shows what someone trashed, not each item that went with it.
const trashTopSql = sql`NOT EXISTS (
  SELECT 1 FROM drive_items AS parent
  WHERE parent.id = ${driveItems.parentId} AND parent.trashed_at = ${driveItems.trashedAt}
)`;

function linkView(link: typeof driveLinks.$inferSelect) {
  return {
    id: link.id,
    itemId: link.itemId,
    access: link.access,
    hasPassword: link.passwordHash !== null,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    accessCount: link.accessCount,
    lastAccessedAt: link.lastAccessedAt?.toISOString() ?? null,
    createdAt: link.createdAt.toISOString(),
  };
}

/** The owner's own live item, the only kind its shares and links are managed on. */
async function ownLiveItem(env: Env, userId: string, id: string) {
  const item = await loadItem(env, id);

  return item && item.ownerUserId === userId && isLive(item) ? item : null;
}

/**
 * The signed-in person's drive and what is shared with them, for the
 * browser and, through the MCP server, for apps: reading needs drive.read,
 * everything else drive.write. Every route checks access to the item again
 * and answers 404 for items the person can't open.
 */
const driveRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/status", oauthScope(DRIVE_READ_SCOPE), async (c) => {
    const userId = c.get("user").id;

    const [usedBytes, quotaBytes] = await Promise.all([
      usageOf(c.env, userId),
      quotaOf(c.env, userId),
    ]);

    return c.json({ ok: true as const, usedBytes, quotaBytes });
  })
  .get("/teams", oauthScope(DRIVE_READ_SCOPE), async (c) => {
    // Items can be shared with the teams the person is in.
    const rows = await createDb(c.env.DB)
      .select({ id: teams.id, name: teams.name })
      .from(teamMembership)
      .innerJoin(teams, eq(teams.id, teamMembership.teamId))
      .where(eq(teamMembership.userId, c.get("user").id))
      .orderBy(asc(teams.name));

    return c.json({ ok: true as const, teams: rows });
  })
  .get(
    "/items",
    oauthScope(DRIVE_READ_SCOPE),
    zValidator("query", listQuerySchema),
    async (c) => {
      const userId = c.get("user").id;
      const query = c.req.valid("query");
      const db = createDb(c.env.DB);
      const conditions: SQL[] = [eq(driveItems.status, "ready")];
      let folder: ReturnType<typeof itemView> | null = null;
      let path: { id: string; name: string }[] = [];
      let access: DriveAccess = "owner";

      if (query.view === "trash") {
        conditions.push(
          eq(driveItems.ownerUserId, userId),
          isNotNull(driveItems.trashedAt),
          trashTopSql
        );
      } else if (query.view === "shared" && !query.parentId) {
        conditions.push(
          ne(driveItems.ownerUserId, userId),
          isNull(driveItems.trashedAt),
          sql`EXISTS (SELECT 1 FROM ${driveShares} WHERE ${driveShares.itemId} = ${driveItems.id} AND ${sharedWithSql(userId)})`
        );
      } else if (query.search) {
        // ponytail: searches the person's own drive; searching shared
        // folders too needs an access check per row.
        const pattern = `%${query.search.toLowerCase().replaceAll(/[\\%_]/gu, "\\$&")}%`;

        conditions.push(
          eq(driveItems.ownerUserId, userId),
          isNull(driveItems.trashedAt),
          sql`lower(${driveItems.name}) LIKE ${pattern} ESCAPE '\\'`
        );
      } else if (query.parentId) {
        const context = await itemContext(c.env, userId, query.parentId);

        if (
          !context ||
          context.item.kind !== "folder" ||
          !isLive(context.item)
        ) {
          return notFound(c);
        }

        folder = itemView(context.item);
        ({ path, access } = context);
        conditions.push(
          eq(driveItems.parentId, query.parentId),
          isNull(driveItems.trashedAt)
        );
      } else {
        conditions.push(
          eq(driveItems.ownerUserId, userId),
          isNull(driveItems.parentId),
          isNull(driveItems.trashedAt)
        );
      }

      const direction = query.order === "desc" ? desc : asc;

      const sortColumn = {
        name: sql`lower(${driveItems.name})`,
        date: driveItems.updatedAt,
        size: driveItems.size,
      }[query.sort];

      const sharedTop = query.view === "shared" && !query.parentId;

      // ponytail: the first 500, no paging; add a cursor when folders outgrow it.
      const rows = await db
        .select({
          item: driveItems,
          ownerName: users.name,
          shared: sharedTop ? sharedAccessSql(userId) : sql<null>`NULL`,
        })
        .from(driveItems)
        .innerJoin(users, eq(users.id, driveItems.ownerUserId))
        .where(and(...conditions))
        .orderBy(
          sql`${driveItems.kind} = 'file'`,
          direction(sortColumn),
          asc(driveItems.id)
        )
        .limit(MAX_LIST_ITEMS);

      return c.json({
        ok: true as const,
        folder,
        path,
        access,
        items: rows.map((row) => ({
          ...itemView(row.item),
          ownerName: row.ownerName,
          access: row.shared ?? access,
        })),
      });
    }
  )
  .get("/items/:id", oauthScope(DRIVE_READ_SCOPE), async (c) => {
    const context = await itemContext(
      c.env,
      c.get("user").id,
      c.req.param("id")
    );

    if (!context || context.item.status !== "ready") return notFound(c);

    return c.json({
      ok: true as const,
      item: itemView(context.item),
      access: context.access,
      path: context.path,
    });
  })
  .get("/items/:id/content", oauthScope(DRIVE_READ_SCOPE), async (c) => {
    const context = await itemContext(
      c.env,
      c.get("user").id,
      c.req.param("id")
    );

    if (!context || !isLive(context.item) || context.item.kind !== "file") {
      return notFound(c);
    }

    const response = await fileResponse(c.env, context.item, {
      inline: c.req.query("inline") === "true",
      range: c.req.header("range"),
    });

    return response ?? notFound(c, "The file's bytes are missing");
  })
  .post(
    "/folders",
    oauthScope(DRIVE_WRITE_SCOPE),
    zValidator("json", folderSchema),
    async (c) => {
      const userId = c.get("user").id;
      const input = c.req.valid("json");
      const parent = await writableParent(c.env, userId, input.parentId);

      if (!parent) return notFound(c, "Folder not found");

      try {
        // Folders take no quota: someone over it can still tidy up.
        const [item] = await createDb(c.env.DB)
          .insert(driveItems)
          .values({
            id: createId("drv"),
            ownerUserId: parent.ownerUserId,
            parentId: parent.parentId,
            name: input.name,
            kind: "folder",
            createdByUserId: userId,
          })
          .returning();

        return c.json(
          {
            ok: true as const,
            item: itemView(required(item, "the insert returns the folder")),
          },
          201
        );
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          return apiError(c, 409, "CONFLICT", NAME_TAKEN);
        }

        throw error;
      }
    }
  )
  .post(
    "/uploads",
    oauthScope(DRIVE_WRITE_SCOPE),
    zValidator("json", uploadSchema),
    async (c) => {
      const userId = c.get("user").id;
      const input = c.req.valid("json");

      if (await overRateLimit(c, "RATE_LIMIT_60", "drive-upload", userId)) {
        return rateLimitedResponse(
          c,
          "Too many uploads; try again in a minute"
        );
      }

      const parent = await writableParent(c.env, userId, input.parentId);

      if (!parent) return notFound(c, "Folder not found");
      await sweepStaleUploads(c.env, parent.ownerUserId);

      const id = createId("drv");
      const contentType = uploadContentType(input.contentType);

      try {
        const reserved = await reserveUpload(c.env, {
          id,
          ownerUserId: parent.ownerUserId,
          parentId: parent.parentId,
          name: input.name,
          size: input.size,
          contentType,
          createdByUserId: userId,
        });

        if (!reserved) {
          return apiError(
            c,
            413,
            "TOO_LARGE",
            parent.ownerUserId === userId
              ? "This file doesn't fit in your Drive storage"
              : "This file doesn't fit in the folder owner's Drive storage"
          );
        }
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          return apiError(c, 409, "CONFLICT", NAME_TAKEN);
        }

        throw error;
      }

      const url = await signUploadUrl(c.env, {
        key: stagingKey(id),
        contentType,
        size: input.size,
      });

      const item = required(
        await loadItem(c.env, id),
        "the upload was just reserved"
      );

      return c.json(
        {
          ok: true as const,
          item: itemView(item),
          upload: {
            url,
            method: "PUT" as const,
            headers: { "content-type": contentType },
          },
        },
        201
      );
    }
  )
  .post("/uploads/:id/complete", oauthScope(DRIVE_WRITE_SCOPE), async (c) => {
    const userId = c.get("user").id;
    const item = await loadItem(c.env, c.req.param("id"));

    if (!item || item.kind !== "file") return notFound(c, "Upload not found");

    if (item.status === "ready") {
      // Completing twice answers the same, to whoever may see the file.
      return (await itemContext(c.env, userId, item.id))
        ? c.json({ ok: true as const, item: itemView(item) })
        : notFound(c, "Upload not found");
    }

    if (!(await canFinishUpload(c.env, userId, item))) {
      if (item.createdByUserId === userId) {
        // Write access is gone: drop the bytes and give the quota back.
        await deleteSubtree(c.env, item.id);
      }

      return notFound(c, "Upload not found");
    }

    const staged = await c.env.DRIVE_STORAGE.get(stagingKey(item.id));

    if (staged?.size !== item.size) {
      if (staged) await c.env.DRIVE_STORAGE.delete(stagingKey(item.id));

      return apiError(c, 422, "UNPROCESSABLE", "The upload is incomplete");
    }

    // The bytes move out of the staging key the upload URL names, so the URL
    // can't swap them once they are a file.
    await c.env.DRIVE_STORAGE.put(fileKey(item.id), staged.body, {
      httpMetadata: {
        contentType: item.contentType ?? "application/octet-stream",
      },
    });
    await c.env.DRIVE_STORAGE.delete(stagingKey(item.id));

    const [ready] = await createDb(c.env.DB)
      .update(driveItems)
      .set({ status: "ready", updatedAt: new Date() })
      .where(and(eq(driveItems.id, item.id), eq(driveItems.status, "pending")))
      .returning();

    return c.json({ ok: true as const, item: itemView(ready ?? item) });
  })
  .patch(
    "/items/:id",
    oauthScope(DRIVE_WRITE_SCOPE),
    zValidator("json", updateSchema),
    async (c) => {
      const userId = c.get("user").id;
      const input = c.req.valid("json");
      const context = await itemContext(c.env, userId, c.req.param("id"));

      if (!context || !isLive(context.item)) return notFound(c);

      if (!canEdit(context.access)) {
        return apiError(c, 403, "FORBIDDEN", "Editor access is required");
      }

      const { item } = context;
      const changes: Partial<DriveItem> = { updatedAt: new Date() };

      if (input.name !== undefined) changes.name = input.name;

      if (input.parentId !== undefined && input.parentId !== item.parentId) {
        const target = await writableParent(c.env, userId, input.parentId);

        if (!target) return notFound(c, "Folder not found");

        if (target.ownerUserId !== item.ownerUserId) {
          return apiError(
            c,
            422,
            "UNPROCESSABLE",
            "Items can only move within their owner's drive"
          );
        }

        if (
          input.parentId &&
          (await isWithin(c.env, input.parentId, item.id))
        ) {
          return apiError(
            c,
            422,
            "UNPROCESSABLE",
            "A folder can't move into itself"
          );
        }

        changes.parentId = input.parentId;
      }

      try {
        const [updated] = await createDb(c.env.DB)
          .update(driveItems)
          .set(changes)
          .where(eq(driveItems.id, item.id))
          .returning();

        return c.json({
          ok: true as const,
          item: itemView(required(updated, "the item exists")),
        });
      } catch (error) {
        if (error instanceof Error && isUniqueViolation(error)) {
          return apiError(c, 409, "CONFLICT", NAME_TAKEN);
        }

        throw error;
      }
    }
  )
  .post("/items/:id/trash", oauthScope(DRIVE_WRITE_SCOPE), async (c) => {
    const context = await itemContext(
      c.env,
      c.get("user").id,
      c.req.param("id")
    );

    if (!context || !isLive(context.item)) return notFound(c);

    if (!canEdit(context.access)) {
      return apiError(c, 403, "FORBIDDEN", "Editor access is required");
    }

    await trashSubtree(c.env, context.item.id);

    return c.json({ ok: true as const });
  })
  .post("/items/:id/restore", oauthScope(DRIVE_WRITE_SCOPE), async (c) => {
    const item = await loadItem(c.env, c.req.param("id"));

    if (!item || item.ownerUserId !== c.get("user").id || !item.trashedAt) {
      return notFound(c);
    }

    const parent = item.parentId ? await loadItem(c.env, item.parentId) : null;

    try {
      await restoreSubtree(c.env, item, Boolean(parent?.trashedAt));
    } catch (error) {
      if (error instanceof Error && isUniqueViolation(error)) {
        return apiError(c, 409, "CONFLICT", NAME_TAKEN);
      }

      throw error;
    }

    const restored = required(
      await loadItem(c.env, item.id),
      "it was just restored"
    );

    return c.json({ ok: true as const, item: itemView(restored) });
  })
  .delete("/items/:id", oauthScope(DRIVE_WRITE_SCOPE), async (c) => {
    const userId = c.get("user").id;
    const item = await loadItem(c.env, c.req.param("id"));

    const cancelsUpload =
      item?.status === "pending" && item.createdByUserId === userId;

    if (!item || (!cancelsUpload && item.ownerUserId !== userId)) {
      return notFound(c);
    }

    if (!cancelsUpload && !item.trashedAt) {
      return apiError(c, 409, "CONFLICT", "Move it to the trash first");
    }

    await deleteSubtree(c.env, item.id);

    return c.json({ ok: true as const });
  })
  .get("/items/:id/shares", oauthScope(DRIVE_READ_SCOPE), async (c) => {
    const item = await ownLiveItem(c.env, c.get("user").id, c.req.param("id"));

    if (!item) return notFound(c);
    const db = createDb(c.env.DB);

    const [shares, links] = await Promise.all([
      db
        .select({
          id: driveShares.id,
          role: driveShares.role,
          userId: driveShares.userId,
          teamId: driveShares.teamId,
          name: sql<string>`coalesce(${users.name}, ${teams.name})`,
          email: mailboxAddressSql,
        })
        .from(driveShares)
        .leftJoin(users, eq(users.id, driveShares.userId))
        .leftJoin(teams, eq(teams.id, driveShares.teamId))
        .leftJoin(
          mailboxes,
          and(
            eq(mailboxes.ownerUserId, driveShares.userId),
            eq(mailboxes.isPrimary, true)
          )
        )
        .where(eq(driveShares.itemId, item.id))
        .orderBy(asc(driveShares.createdAt)),
      db
        .select()
        .from(driveLinks)
        .where(eq(driveLinks.itemId, item.id))
        .orderBy(desc(driveLinks.createdAt)),
    ]);

    return c.json({ ok: true as const, shares, links: links.map(linkView) });
  })
  .post(
    "/items/:id/shares",
    oauthScope(DRIVE_WRITE_SCOPE),
    zValidator("json", shareSchema),
    async (c) => {
      const userId = c.get("user").id;
      const input = c.req.valid("json");
      const item = await ownLiveItem(c.env, userId, c.req.param("id"));

      if (!item) return notFound(c);
      const db = createDb(c.env.DB);

      if (input.teamId) {
        // Only with a team the owner is in.
        const [team] = await db
          .select({ teamId: teamMembership.teamId })
          .from(teamMembership)
          .where(
            and(
              eq(teamMembership.teamId, input.teamId),
              eq(teamMembership.userId, userId)
            )
          );

        if (!team) return notFound(c, "You aren't in that team");

        await db
          .insert(driveShares)
          .values({
            id: createId("dsh"),
            itemId: item.id,
            teamId: team.teamId,
            role: input.role,
          })
          .onConflictDoUpdate({
            target: [driveShares.itemId, driveShares.teamId],
            set: { role: input.role },
          });

        return c.json({ ok: true as const });
      }

      const [person] = await db
        .select({ id: users.id })
        .from(mailboxes)
        .innerJoin(users, eq(users.id, mailboxes.ownerUserId))
        .where(
          and(
            mailboxAddressPredicate(
              required(input.email, "the schema asks for one")
            ),
            eq(mailboxes.isPrimary, true),
            eq(users.status, "active")
          )
        );

      if (!person) {
        return notFound(c, "Nobody in the workspace has that address");
      }

      if (person.id === userId) {
        return apiError(c, 422, "UNPROCESSABLE", "It's already yours");
      }

      await db
        .insert(driveShares)
        .values({
          id: createId("dsh"),
          itemId: item.id,
          userId: person.id,
          role: input.role,
        })
        .onConflictDoUpdate({
          target: [driveShares.itemId, driveShares.userId],
          set: { role: input.role },
        });

      return c.json({ ok: true as const });
    }
  )
  .delete(
    "/items/:id/shares/:shareId",
    oauthScope(DRIVE_WRITE_SCOPE),
    async (c) => {
      const item = await loadItem(c.env, c.req.param("id"));

      if (!item || item.ownerUserId !== c.get("user").id) return notFound(c);

      const deleted = await createDb(c.env.DB)
        .delete(driveShares)
        .where(
          and(
            eq(driveShares.id, c.req.param("shareId")),
            eq(driveShares.itemId, item.id)
          )
        )
        .returning({ id: driveShares.id });

      if (deleted.length === 0) return notFound(c, "Share not found");

      return c.json({ ok: true as const });
    }
  )
  .post(
    "/items/:id/links",
    oauthScope(DRIVE_WRITE_SCOPE),
    zValidator("json", linkSchema),
    async (c) => {
      const input = c.req.valid("json");

      const item = await ownLiveItem(
        c.env,
        c.get("user").id,
        c.req.param("id")
      );

      if (!item) return notFound(c);

      // ponytail: files only; a folder link needs a public folder browser.
      if (item.kind !== "file") {
        return apiError(
          c,
          422,
          "UNPROCESSABLE",
          "Only files can have public links"
        );
      }

      if (input.expiresAt !== null && input.expiresAt <= Date.now()) {
        return apiError(
          c,
          422,
          "UNPROCESSABLE",
          "The expiry must be in the future"
        );
      }

      const token = randomToken();

      const [link] = await createDb(c.env.DB)
        .insert(driveLinks)
        .values({
          id: createId("dlk"),
          itemId: item.id,
          tokenHash: await hashToken(token),
          access: input.access,
          passwordHash: input.password
            ? await hashPassword(input.password)
            : null,
          expiresAt:
            input.expiresAt === null ? null : new Date(input.expiresAt),
        })
        .returning();

      return c.json(
        {
          ok: true as const,
          link: linkView(required(link, "the insert returns the link")),
          // Shown once: only the token's hash is kept.
          url: new URL(`${DRIVE_LINK_PATH}/${token}`, c.req.url).toString(),
        },
        201
      );
    }
  )
  .delete("/links/:id", oauthScope(DRIVE_WRITE_SCOPE), async (c) => {
    const [link] = await createDb(c.env.DB)
      .select({ id: driveLinks.id })
      .from(driveLinks)
      .innerJoin(driveItems, eq(driveItems.id, driveLinks.itemId))
      .where(
        and(
          eq(driveLinks.id, c.req.param("id")),
          eq(driveItems.ownerUserId, c.get("user").id)
        )
      );

    if (!link) return notFound(c, "Link not found");
    await createDb(c.env.DB)
      .delete(driveLinks)
      .where(eq(driveLinks.id, link.id));

    return c.json({ ok: true as const });
  });

/**
 * Administration → Drive, under /api/admin/drive, for members given
 * "Manage Drive" (administrators always are). Core leaves a module's
 * /api/admin/<section> to the module, so these routes check it themselves.
 */
const adminRoutes = new Hono<AppEnv>()
  .use(
    "/drive",
    requireAuth,
    requirePermission(MANAGE_DRIVE),
    oauthScope(MANAGE_DRIVE_SCOPE)
  )
  .use(
    "/drive/*",
    requireAuth,
    requirePermission(MANAGE_DRIVE),
    oauthScope(MANAGE_DRIVE_SCOPE)
  )
  .get("/drive", async (c) => {
    const [defaultQuotaBytes, people] = await Promise.all([
      defaultQuota(c.env),
      createDb(c.env.DB)
        .select({
          userId: users.id,
          name: users.name,
          status: users.status,
          quotaBytes: driveQuotas.quotaBytes,
          usedBytes: usedBytesSql(users.id),
        })
        .from(users)
        .leftJoin(driveQuotas, eq(driveQuotas.userId, users.id))
        .orderBy(asc(users.name)),
    ]);

    return c.json({ ok: true as const, defaultQuotaBytes, people });
  })
  .put("/drive/settings", zValidator("json", settingsSchema), async (c) => {
    const { defaultQuotaBytes } = c.req.valid("json");

    await createDb(c.env.DB)
      .insert(driveSettings)
      .values({ id: 1, defaultQuotaBytes })
      .onConflictDoUpdate({
        target: driveSettings.id,
        set: { defaultQuotaBytes },
      });

    return c.json({ ok: true as const, defaultQuotaBytes });
  })
  .put("/drive/quotas/:userId", zValidator("json", quotaSchema), async (c) => {
    const userId = c.req.param("userId");
    const { quotaBytes } = c.req.valid("json");
    const db = createDb(c.env.DB);

    const [person] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));

    if (!person) return notFound(c, "Person not found");

    // A quota below what someone stores stops their uploads; nothing is deleted.
    if (quotaBytes === null) {
      await db.delete(driveQuotas).where(eq(driveQuotas.userId, userId));
    } else {
      await db
        .insert(driveQuotas)
        .values({ userId, quotaBytes })
        .onConflictDoUpdate({
          target: driveQuotas.userId,
          set: { quotaBytes },
        });
    }

    return c.json({ ok: true as const, quotaBytes });
  })
  .delete("/drive/people/:userId/files", async (c) => {
    const deleted = await deleteDriveOf(c.env, c.req.param("userId"));

    return c.json({ ok: true as const, deleted });
  });

/** Routes under /api: the browser's, and the MCP tools' backend. */
export const driveAccountApi = new Hono<AppEnv>()
  .route("/drive", driveRoutes)
  .route("/admin", adminRoutes);

/** The module's routes as the browser's typed client sees them. */
export const driveBrowserApi = new Hono<AppEnv>().route(
  "/api",
  driveAccountApi
);

export type DriveAppType = typeof driveBrowserApi;
