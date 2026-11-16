import {
  createDb,
  hashToken,
  overRateLimit,
  users,
} from "@open-workspace/core/module";
import type { AppEnv } from "@open-workspace/core/module";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { html } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { z } from "zod";

import { DRIVE_LINK_PATH } from "../shared/module";
import { fileResponse, isLive } from "./items";
import { verifyPassword } from "./password";
import { driveItems, driveLinks } from "./schema";

const passwordFormSchema = z.object({
  password: z.string().catch(""),
});

const PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

type Body = HtmlEscapedString | Promise<HtmlEscapedString>;

function page(c: Context<AppEnv>, status: 401 | 404 | 429, body: Body) {
  c.header("content-security-policy", PAGE_CSP);
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");

  return c.html(
    html`<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta name="robots" content="noindex" />
          <title>Shared file</title>
          <style>
            body {
              font:
                15px system-ui,
                sans-serif;
              max-width: 24rem;
              margin: 15vh auto;
              padding: 0 1rem;
              color: #222;
            }
            input,
            button {
              font: inherit;
              padding: 0.5rem;
              width: 100%;
              box-sizing: border-box;
              margin-top: 0.5rem;
            }
            .error {
              color: #b00;
            }
          </style>
        </head>
        <body>
          ${body}
        </body>
      </html>`,
    status
  );
}

function gone(c: Context<AppEnv>) {
  return page(
    c,
    404,
    html`<p>This link doesn't work: it's wrong, expired, or was turned off.</p>`
  );
}

function passwordForm(c: Context<AppEnv>, name: string, error: string | null) {
  return page(
    c,
    401,
    html`<h1 style="font-size:1.1rem">${name}</h1>
      <form method="post">
        <label for="password">This file needs a password.</label>
        <input
          id="password"
          name="password"
          type="password"
          autocomplete="off"
          required
          autofocus
        />
        ${error ? html`<p class="error">${error}</p>` : ""}
        <button type="submit">Open</button>
      </form>`
  );
}

/**
 * Public links, `/d/<token>`, for anyone who has one, signed in or not. A
 * link works while it hasn't expired, its file is live (not in the trash),
 * and the file's owner is active: disabling the owner stops their links,
 * and enabling them again brings them back.
 */
export const drivePublicRoutes = new Hono<AppEnv>().on(
  ["GET", "POST"],
  `${DRIVE_LINK_PATH}/:token`,
  async (c) => {
    const db = createDb(c.env.DB);

    const [row] = await db
      .select({ link: driveLinks, item: driveItems })
      .from(driveLinks)
      .innerJoin(driveItems, eq(driveItems.id, driveLinks.itemId))
      .innerJoin(
        users,
        and(eq(users.id, driveItems.ownerUserId), eq(users.status, "active"))
      )
      .where(eq(driveLinks.tokenHash, await hashToken(c.req.param("token"))));

    if (
      !row ||
      (row.link.expiresAt && row.link.expiresAt.getTime() <= Date.now()) ||
      !isLive(row.item) ||
      row.item.kind !== "file"
    ) {
      return gone(c);
    }

    const { link, item } = row;

    if (link.passwordHash) {
      if (c.req.method !== "POST") return passwordForm(c, item.name, null);

      const ip = c.req.header("cf-connecting-ip") ?? "unknown";

      if (
        await overRateLimit(
          c,
          "RATE_LIMIT_10",
          "drive-link-password",
          `${link.id}:${ip}`
        )
      ) {
        return page(
          c,
          429,
          html`<p>Too many tries. Wait a minute and try again.</p>`
        );
      }

      const { password } = passwordFormSchema.parse(await c.req.parseBody());

      if (!(await verifyPassword(password, link.passwordHash))) {
        return passwordForm(c, item.name, "That password isn't right.");
      }
    }

    const response = await fileResponse(c.env, item, {
      inline: link.access === "view",
      range: c.req.header("range"),
    });

    if (!response) return gone(c);
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("x-robots-tag", "noindex");

    // A player fetching more of a video isn't another visit.
    if (
      !response.headers.get("content-range")?.startsWith("bytes 0-") &&
      response.status === 206
    ) {
      return response;
    }

    await db
      .update(driveLinks)
      .set({
        accessCount: sql`${driveLinks.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(driveLinks.id, link.id));

    return response;
  }
);
