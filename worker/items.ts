import { createDb } from "@open-workspace/core/module";
import type { users } from "@open-workspace/core/module";
import { eq, sql } from "drizzle-orm";

import {
  DEFAULT_QUOTA_BYTES,
  FILES_PREFIX,
  STAGING_PREFIX,
} from "../shared/module";
import type { DriveAccess } from "../shared/module";
import { filePreview } from "../shared/preview";
import { driveItems, driveQuotas, driveSettings } from "./schema";
import type { DriveItem } from "./schema";

// ponytail: tree walks stop this deep, so a cycle from two racing moves
// can't loop forever; nobody nests folders 256 deep.
const MAX_DEPTH = 256;

export function fileKey(id: string) {
  return `${FILES_PREFIX}${id}`;
}

export function stagingKey(id: string) {
  return `${STAGING_PREFIX}${id}`;
}

export function isLive(item: DriveItem) {
  return item.status === "ready" && !item.trashedAt;
}

export function canEdit(access: DriveAccess) {
  return access === "owner" || access === "editor";
}

export async function loadItem(env: Env, id: string) {
  const [item] = await createDb(env.DB)
    .select()
    .from(driveItems)
    .where(eq(driveItems.id, id));

  return item ?? null;
}

/** The workspace's default quota: what an administrator saved, or 5 GB. */
export async function defaultQuota(env: Env) {
  const [row] = await createDb(env.DB).select().from(driveSettings);

  return row?.defaultQuotaBytes ?? DEFAULT_QUOTA_BYTES;
}

export async function quotaOf(env: Env, userId: string) {
  const [row] = await createDb(env.DB)
    .select({ quotaBytes: driveQuotas.quotaBytes })
    .from(driveQuotas)
    .where(eq(driveQuotas.userId, userId));

  return row?.quotaBytes ?? defaultQuota(env);
}

/** Everything a person owns counts: pending uploads and the trash too. */
export const usedBytesSql = (userId: typeof users.id) =>
  sql<number>`(SELECT coalesce(sum(${driveItems.size}), 0) FROM ${driveItems} WHERE ${driveItems.ownerUserId} = ${userId})`;

export async function usageOf(env: Env, userId: string) {
  const row = await env.DB.prepare(
    "SELECT coalesce(sum(size), 0) AS used FROM drive_items WHERE owner_user_id = ?1"
  )
    .bind(userId)
    .first<{ used: number }>();

  return row?.used ?? 0;
}

/**
 * Inserts a pending upload if it fits its owner's quota, in one statement,
 * so two uploads at once can't both pass the check. False when it doesn't
 * fit; throws on a name conflict (isUniqueViolation).
 */
export async function reserveUpload(
  env: Env,
  item: {
    id: string;
    ownerUserId: string;
    parentId: string | null;
    name: string;
    size: number;
    contentType: string;
    createdByUserId: string;
  }
) {
  const quota = await quotaOf(env, item.ownerUserId);
  const now = Date.now();

  const result = await env.DB.prepare(
    `INSERT INTO drive_items
       (id, owner_user_id, parent_id, name, kind, status, size, content_type,
        created_by_user_id, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, 'file', 'pending', ?5, ?6, ?7, ?8, ?8
     WHERE (SELECT coalesce(sum(size), 0) FROM drive_items WHERE owner_user_id = ?2) + ?5 <= ?9`
  )
    .bind(
      item.id,
      item.ownerUserId,
      item.parentId,
      item.name,
      item.size,
      item.contentType,
      item.createdByUserId,
      now,
      quota
    )
    .run();

  return result.meta.changes > 0;
}

/** Whether D1 refused a write for a unique index: a name taken in that folder. */
export function isUniqueViolation(error: Error): boolean {
  return (
    error.message.includes("UNIQUE constraint failed") ||
    (error.cause instanceof Error && isUniqueViolation(error.cause))
  );
}

type ChainRow = {
  id: string;
  name: string;
  depth: number;
  /** 2 for an editor share of this person or one of their teams, 1 for a viewer one. */
  grant: number | null;
};

export type ItemContext = {
  item: DriveItem;
  access: DriveAccess;
  /** The folders above it the person may open, outermost first. */
  path: { id: string; name: string }[];
};

/**
 * What `userId` may do with an item: theirs, or shared with them or one of
 * their teams, on the item or a folder above it (the strongest share wins).
 * Null when they have no access, so routes answer 404 and never reveal that
 * the item exists. Nobody but the owner sees trashed or pending items.
 */
export async function itemContext(
  env: Env,
  userId: string,
  itemId: string
): Promise<ItemContext | null> {
  const item = await loadItem(env, itemId);

  if (!item) return null;

  const { results } = await env.DB.prepare(
    `WITH RECURSIVE chain(id, parent_id, name, depth) AS (
       SELECT id, parent_id, name, 0 FROM drive_items WHERE id = ?1
       UNION ALL
       SELECT d.id, d.parent_id, d.name, chain.depth + 1
       FROM drive_items d JOIN chain ON d.id = chain.parent_id
       WHERE chain.depth < ${MAX_DEPTH}
     )
     SELECT chain.id, chain.name, chain.depth,
       (SELECT max(CASE s.role WHEN 'editor' THEN 2 ELSE 1 END)
        FROM drive_shares s
        WHERE s.item_id = chain.id
          AND (s.user_id = ?2
               OR s.team_id IN (SELECT team_id FROM team_membership WHERE user_id = ?2))
       ) AS "grant"
     FROM chain ORDER BY chain.depth DESC`
  )
    .bind(itemId, userId)
    .all<ChainRow>();

  if (item.ownerUserId === userId) {
    return {
      item,
      access: "owner",
      path: results
        .filter((row) => row.depth > 0)
        .map(({ id, name }) => ({ id, name })),
    };
  }

  if (!isLive(item)) return null;
  const firstShared = results.findIndex((row) => row.grant !== null);

  if (firstShared === -1) return null;

  return {
    item,
    access: results.some((row) => row.grant === 2) ? "editor" : "viewer",
    // The path starts at the folder that was shared, never above it.
    path: results
      .slice(firstShared)
      .filter((row) => row.depth > 0)
      .map(({ id, name }) => ({ id, name })),
  };
}

/** Whether `candidateId` is `ancestorId` or below it. */
export async function isWithin(
  env: Env,
  candidateId: string,
  ancestorId: string
) {
  const row = await env.DB.prepare(
    `WITH RECURSIVE chain(id, parent_id, depth) AS (
       SELECT id, parent_id, 0 FROM drive_items WHERE id = ?1
       UNION ALL
       SELECT d.id, d.parent_id, chain.depth + 1
       FROM drive_items d JOIN chain ON d.id = chain.parent_id
       WHERE chain.depth < ${MAX_DEPTH}
     )
     SELECT 1 AS found FROM chain WHERE id = ?2 LIMIT 1`
  )
    .bind(candidateId, ancestorId)
    .first<{ found: number }>();

  return row !== null;
}

const SUBTREE = `WITH RECURSIVE subtree(id, depth) AS (
  SELECT id, 0 FROM drive_items WHERE id = ?1
  UNION ALL
  SELECT d.id, subtree.depth + 1 FROM drive_items d JOIN subtree ON d.parent_id = subtree.id
  WHERE subtree.depth < ${MAX_DEPTH}
)`;

/** Trashes an item and everything below it, with one timestamp so restore undoes exactly this. */
export async function trashSubtree(env: Env, itemId: string) {
  const now = Date.now();

  await env.DB.prepare(
    `${SUBTREE}
     UPDATE drive_items SET trashed_at = ?2, updated_at = ?2
     WHERE id IN (SELECT id FROM subtree) AND trashed_at IS NULL`
  )
    .bind(itemId, now)
    .run();
}

/**
 * Brings back what one trash action took. An item whose folder is still in
 * the trash comes back at its owner's top level. Throws on a name conflict.
 */
export async function restoreSubtree(
  env: Env,
  item: DriveItem,
  parentTrashed: boolean
) {
  const statements = [
    env.DB.prepare(
      `${SUBTREE}
       UPDATE drive_items SET trashed_at = NULL, updated_at = ?2
       WHERE id IN (SELECT id FROM subtree) AND trashed_at = ?3`
    ).bind(item.id, Date.now(), item.trashedAt?.getTime() ?? 0),
  ];

  if (parentTrashed) {
    statements.unshift(
      env.DB.prepare(
        "UPDATE drive_items SET parent_id = NULL WHERE id = ?1"
      ).bind(item.id)
    );
  }

  await env.DB.batch(statements);
}

/** R2 deletes at most 1000 keys per call. */
async function deleteObjects(env: Env, keys: string[]) {
  for (let offset = 0; offset < keys.length; offset += 1000) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one call per thousand keys, in order
    await env.DRIVE_STORAGE.delete(keys.slice(offset, offset + 1000));
  }
}

function objectKeys(ids: string[]) {
  return ids.flatMap((id) => [fileKey(id), stagingKey(id)]);
}

/**
 * Deletes an item and everything below it for good: the bytes first, so if
 * that fails the rows stay and the delete can be tried again.
 */
export async function deleteSubtree(env: Env, itemId: string) {
  const { results } = await env.DB.prepare(`${SUBTREE} SELECT id FROM subtree`)
    .bind(itemId)
    .all<{ id: string }>();

  await deleteObjects(env, objectKeys(results.map((row) => row.id)));
  await env.DB.prepare("DELETE FROM drive_items WHERE id = ?1")
    .bind(itemId)
    .run();
}

/**
 * Deletes everything a person owns, bytes first: their drive, for an
 * administrator erasing it. Items they made in other people's folders
 * belong to those people and stay.
 */
// ponytail: one request for the whole drive; tens of thousands of files can
// reach the Worker's subrequest limit, then a queue would spread it out.
export async function deleteDriveOf(env: Env, userId: string) {
  const rows = await createDb(env.DB)
    .select({ id: driveItems.id })
    .from(driveItems)
    .where(eq(driveItems.ownerUserId, userId));

  await deleteObjects(env, objectKeys(rows.map((row) => row.id)));
  await createDb(env.DB)
    .delete(driveItems)
    .where(eq(driveItems.ownerUserId, userId));

  return rows.length;
}

/** Uploads older than this that never completed give their quota and name back. */
export const STALE_UPLOAD_MS = 60 * 60 * 1000;

/** Drops a person's abandoned uploads, checked before each new one. */
export async function sweepStaleUploads(env: Env, ownerUserId: string) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM drive_items
     WHERE owner_user_id = ?1 AND status = 'pending' AND created_at < ?2 LIMIT 100`
  )
    .bind(ownerUserId, Date.now() - STALE_UPLOAD_MS)
    .all<{ id: string }>();

  if (results.length === 0) return;
  const ids = results.map((row) => row.id);

  await env.DRIVE_STORAGE.delete(ids.map(stagingKey));
  await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare("DELETE FROM drive_items WHERE id = ?1").bind(id)
    )
  );
}

/** One `bytes=` range of a file of `size` bytes, or null to send it whole. */
export function byteRange(header: string | undefined, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header?.trim() ?? "");

  if (!match || size === 0) return null;
  const [, from = "", to = ""] = match;

  if (!from && !to) return null;

  if (!from) {
    const length = Math.min(Number(to), size);

    return length > 0 ? { offset: size - length, length } : null;
  }

  const offset = Number(from);

  if (offset >= size) return null;
  const end = to ? Math.min(Number(to), size - 1) : size - 1;

  return end >= offset ? { offset, length: end - offset + 1 } : null;
}

/**
 * Serves a file without letting its bytes run on the app's origin. Inline
 * only as one of `filePreview`'s types (raster images, PDF, plain text,
 * audio, video), under that type; anything else, HTML and SVG among them,
 * is an attachment of type application/octet-stream. Every response is
 * nosniff and sandboxed; a PDF is the exception to the sandbox, because
 * browsers refuse to show a PDF in a sandboxed document, and a PDF's own
 * scripts run in the viewer, never on the page's origin.
 */
export async function fileResponse(
  env: Env,
  item: Pick<DriveItem, "id" | "name" | "contentType" | "size">,
  options: { inline: boolean; range?: string }
) {
  const range = byteRange(options.range, item.size);

  const object = await env.DRIVE_STORAGE.get(
    fileKey(item.id),
    range ? { range } : {}
  );

  if (!object) return null;
  const preview = options.inline ? filePreview(item) : null;

  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": preview?.contentType ?? "application/octet-stream",
    "content-disposition": `${preview ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
    "content-security-policy":
      preview?.kind === "pdf"
        ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'"
        : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  });

  if (!range) {
    headers.set("content-length", String(object.size));

    return new Response(object.body, { headers });
  }

  headers.set("content-length", String(range.length));
  headers.set(
    "content-range",
    `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`
  );

  return new Response(object.body, { status: 206, headers });
}

export function itemView(item: DriveItem) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    size: item.size,
    contentType: item.contentType,
    parentId: item.parentId,
    ownerUserId: item.ownerUserId,
    trashedAt: item.trashedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
