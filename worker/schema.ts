import { teams, users } from "@open-workspace/core/module";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = integer("created_at", { mode: "timestamp_ms" })
  .notNull()
  .default(sql`(unixepoch() * 1000)`);

/**
 * Files and folders. Each belongs to one person (`ownerUserId`), whose quota
 * it counts against, wherever it was uploaded from: a file an editor adds to
 * a shared folder is the folder owner's. A file's bytes are at
 * `files/<id>` in the Drive bucket once `status` is ready; a pending one is
 * an upload in progress, which already holds its size of the quota.
 *
 * Trashing an item trashes everything below it with the same `trashedAt`,
 * so restoring brings back exactly that. Names are unique per folder, case
 * aside, among items not in the trash. `bun run db:generate` writes the
 * migrations to ../migrations.
 */
export const driveItems = sqliteTable(
  "drive_items",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references(
      (): AnySQLiteColumn => driveItems.id,
      { onDelete: "cascade" }
    ),
    name: text("name").notNull(),
    kind: text("kind", { enum: ["file", "folder"] }).notNull(),
    status: text("status", { enum: ["pending", "ready"] })
      .notNull()
      .default("ready"),
    size: integer("size").notNull().default(0),
    contentType: text("content_type"),
    /** Who made it, if it was not the owner: an editor of a shared folder. */
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    trashedAt: integer("trashed_at", { mode: "timestamp_ms" }),
    createdAt,
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("drive_items_root_name_unique")
      .on(table.ownerUserId, sql`lower(${table.name})`)
      .where(sql`${table.parentId} IS NULL AND ${table.trashedAt} IS NULL`),
    uniqueIndex("drive_items_child_name_unique")
      .on(table.parentId, sql`lower(${table.name})`)
      .where(sql`${table.parentId} IS NOT NULL AND ${table.trashedAt} IS NULL`),
    index("drive_items_parent_idx").on(table.parentId),
    index("drive_items_owner_idx").on(table.ownerUserId, table.trashedAt),
  ]
);

/**
 * Who an item is shared with: one person or one team, as viewer or editor.
 * A share on a folder covers everything below it; the strongest share on
 * the way up wins. Team shares follow the team's membership as it is now.
 */
export const driveShares = sqliteTable(
  "drive_shares",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => driveItems.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    teamId: text("team_id").references(() => teams.id, {
      onDelete: "cascade",
    }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    createdAt,
  },
  (table) => [
    check(
      "drive_shares_one_target",
      sql`(${table.userId} IS NULL) <> (${table.teamId} IS NULL)`
    ),
    uniqueIndex("drive_shares_item_user_unique").on(table.itemId, table.userId),
    uniqueIndex("drive_shares_item_team_unique").on(table.itemId, table.teamId),
    index("drive_shares_user_idx").on(table.userId),
    index("drive_shares_team_idx").on(table.teamId),
  ]
);

/**
 * Public links to a file, `/d/<token>`. Only the token's hash is stored;
 * the link itself is shown once, when it is made.
 */
export const driveLinks = sqliteTable(
  "drive_links",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => driveItems.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    access: text("access", { enum: ["view", "download"] }).notNull(),
    /** PBKDF2 (worker/password.ts); null for a link without a password. */
    passwordHash: text("password_hash"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessedAt: integer("last_accessed_at", { mode: "timestamp_ms" }),
    createdAt,
  },
  (table) => [index("drive_links_item_idx").on(table.itemId)]
);

/** A person's quota, where an administrator set one; others get the default. */
export const driveQuotas = sqliteTable("drive_quotas", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  quotaBytes: integer("quota_bytes").notNull(),
});

/** The workspace's Drive settings: one row, id 1, once an administrator saved them. */
export const driveSettings = sqliteTable(
  "drive_settings",
  {
    id: integer("id").primaryKey(),
    defaultQuotaBytes: integer("default_quota_bytes").notNull(),
  },
  (table) => [check("drive_settings_one_row", sql`${table.id} = 1`)]
);

export type DriveItem = typeof driveItems.$inferSelect;
