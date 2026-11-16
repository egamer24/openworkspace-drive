import { beforeAll, describe, expect, it } from "bun:test";

import { required } from "@open-workspace/core/shared";
import {
  bucket,
  env as coreEnv,
  mcpAccessToken,
  useFreshWorkspace,
  worker,
} from "@open-workspace/core/testing";
import { z } from "zod";

useFreshWorkspace();

const env = { ...coreEnv, DRIVE_STORAGE: bucket("DRIVE_STORAGE") };
const origin = "http://example.test";

type Person = { id: string; cookie: string; email: string };

let admin: Person;
let owner: Person;
let viewer: Person;
let editor: Person;
let stranger: Person;
let teammate: Person;
let teamId = "";

const itemSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  size: z.number(),
  parentId: z.string().nullable(),
});

const itemBody = z.object({ item: itemSchema });

const listBody = z.object({
  access: z.string(),
  items: z.array(itemSchema.extend({ access: z.string() })),
});

const uploadBody = z.object({
  item: itemSchema,
  upload: z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()),
  }),
});

const errorBody = z.object({ error: z.object({ message: z.string() }) });

async function call(
  person: Person | null,
  path: string,
  init: {
    method?: string;
    json?: unknown;
    headers?: Record<string, string>;
  } = {}
) {
  const headers = new Headers({ origin, "content-type": "application/json" });

  if (person) headers.set("cookie", person.cookie);

  for (const [name, value] of Object.entries(init.headers ?? {})) {
    headers.set(name, value);
  }

  const response = await worker.fetch(
    new Request(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    })
  );

  return response;
}

async function json<S extends z.ZodType>(
  response: Response,
  schema: S,
  status = 200
) {
  const text = await response.text();

  expect(response.status, text).toBe(status);

  return schema.parse(JSON.parse(text));
}

/** A public link as an outsider opens it: no cookie, a form post for the password. */
function openLink(path: string, password?: string) {
  return worker.fetch(
    new Request(
      `${origin}${path}`,
      password === undefined
        ? {}
        : {
            method: "POST",
            headers: {
              origin,
              "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ password }),
          }
    )
  );
}

function sessionCookie(response: Response) {
  return required(
    response.headers
      .getSetCookie()
      .map((header) => header.split(";", 1)[0] ?? "")
      .find((pair) => pair.startsWith("op_session_dev=")),
    "signing in sets a session cookie"
  );
}

async function login(userId: string) {
  const response = await worker.fetch(
    new Request(`${origin}/api/auth/mock/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    })
  );

  expect(response.status).toBe(200);

  return sessionCookie(response);
}

async function primaryAddress(userId: string) {
  return required(
    await env.DB.prepare(
      "SELECT local_part || '@' || domain AS address FROM mailboxes WHERE owner_user_id = ? AND is_primary = 1"
    )
      .bind(userId)
      .first<{ address: string }>(),
    "a person has a primary address"
  ).address;
}

async function invite(name: string): Promise<Person> {
  const invited = await call(admin, "/api/admin/invitations", {
    method: "POST",
    json: { name, email: `${name.toLowerCase()}@example.test` },
  });

  const { userId } = z
    .object({ accessLink: z.object({ userId: z.string() }) })
    .parse(await invited.json()).accessLink;

  await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?")
    .bind(userId)
    .run();

  return {
    id: userId,
    cookie: await login(userId),
    email: await primaryAddress(userId),
  };
}

async function folder(
  person: Person,
  name: string,
  parentId: string | null = null
) {
  return (
    await json(
      await call(person, "/api/drive/folders", {
        method: "POST",
        json: { name, parentId },
      }),
      itemBody,
      201
    )
  ).item;
}

function reserve(
  person: Person,
  input: {
    name: string;
    size: number;
    parentId?: string | null;
    contentType?: string;
  }
) {
  return call(person, "/api/drive/uploads", {
    method: "POST",
    json: { parentId: null, contentType: "text/plain", ...input },
  });
}

/** An upload the way the browser does it, with the PUT going straight into the bucket. */
async function upload(
  person: Person,
  name: string,
  content: string,
  input: { parentId?: string | null; contentType?: string } = {}
) {
  const bytes = new TextEncoder().encode(content);

  const { item } = await json(
    await reserve(person, { name, size: bytes.byteLength, ...input }),
    uploadBody,
    201
  );

  await env.DRIVE_STORAGE.put(`staging/${item.id}`, bytes);

  return (
    await json(
      await call(person, `/api/drive/uploads/${item.id}/complete`, {
        method: "POST",
      }),
      itemBody
    )
  ).item;
}

function share(
  item: string,
  body: { email?: string; teamId?: string; role: string }
) {
  return call(owner, `/api/drive/items/${item}/shares`, {
    method: "POST",
    json: body,
  });
}

async function shares(item: string) {
  return json(
    await call(owner, `/api/drive/items/${item}/shares`),
    z.object({
      shares: z.array(
        z.object({
          id: z.string(),
          userId: z.string().nullable(),
          teamId: z.string().nullable(),
        })
      ),
      links: z.array(
        z.object({
          id: z.string(),
          accessCount: z.number(),
          hasPassword: z.boolean(),
        })
      ),
    })
  );
}

async function createLink(
  item: string,
  body: { access?: string; expiresAt?: number; password?: string } = {}
) {
  const created = await json(
    await call(owner, `/api/drive/items/${item}/links`, {
      method: "POST",
      json: body,
    }),
    z.object({ url: z.string(), link: z.object({ id: z.string() }) }),
    201
  );

  return { path: new URL(created.url).pathname, id: created.link.id };
}

async function usedBytes(person: Person) {
  return await json(
    await call(person, "/api/drive/status"),
    z.object({ usedBytes: z.number(), quotaBytes: z.number() })
  );
}

beforeAll(async () => {
  const bootstrap = await worker.fetch(
    new Request(`${origin}/api/auth/mock/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Admin", email: "admin@example.test" }),
    })
  );

  expect(bootstrap.status).toBe(200);

  const adminId = required(
    await env.DB.prepare("SELECT id FROM users WHERE role = 'admin'").first<{
      id: string;
    }>(),
    "the bootstrap creates an admin"
  ).id;

  admin = {
    id: adminId,
    cookie: sessionCookie(bootstrap),
    email: "admin@example.test",
  };
  owner = await invite("Olive");
  viewer = await invite("Vera");
  editor = await invite("Eddie");
  stranger = await invite("Stan");
  teammate = await invite("Tess");

  const team = await call(admin, "/api/admin/teams", {
    method: "POST",
    json: {
      name: "Design",
      slug: "design",
      description: null,
      everyone: false,
      members: [
        { userId: owner.id, canSend: true },
        { userId: teammate.id, canSend: true },
      ],
    },
  });

  ({ teamId } = z.object({ teamId: z.string() }).parse(await team.json()));
});

describe("uploads", () => {
  it("sign the declared size into the upload URL, and finish into an immutable key", async () => {
    const reserved = await json(
      await reserve(owner, { name: "signed.txt", size: 5 }),
      uploadBody,
      201
    );

    const url = new URL(reserved.upload.url);

    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type"])
    );
    expect(url.pathname).toEndWith(`/staging/${reserved.item.id}`);
    expect(reserved.upload.headers).toEqual({ "content-type": "text/plain" });

    // Not finished: a short object is refused and dropped.
    await env.DRIVE_STORAGE.put(`staging/${reserved.item.id}`, "abc");

    const short = await call(
      owner,
      `/api/drive/uploads/${reserved.item.id}/complete`,
      { method: "POST" }
    );

    expect(short.status).toBe(422);
    expect(
      await env.DRIVE_STORAGE.head(`staging/${reserved.item.id}`)
    ).toBeNull();

    await env.DRIVE_STORAGE.put(`staging/${reserved.item.id}`, "hello");
    await json(
      await call(owner, `/api/drive/uploads/${reserved.item.id}/complete`, {
        method: "POST",
      }),
      itemBody
    );
    expect(
      await env.DRIVE_STORAGE.head(`staging/${reserved.item.id}`)
    ).toBeNull();

    // A replayed upload URL can only refill staging, never the file.
    await env.DRIVE_STORAGE.put(`staging/${reserved.item.id}`, "HACKS");

    const download = await call(
      owner,
      `/api/drive/items/${reserved.item.id}/content`
    );

    expect(await download.text()).toBe("hello");
    expect(download.headers.get("content-disposition")).toStartWith(
      "attachment;"
    );
  });

  it("refuse name clashes, case aside, and list folders first", async () => {
    const docs = await folder(owner, "Docs");

    await upload(owner, "notes.txt", "notes", { parentId: docs.id });
    expect(
      (
        await call(owner, "/api/drive/folders", {
          method: "POST",
          json: { name: "DOCS" },
        })
      ).status
    ).toBe(409);
    expect(
      (await reserve(owner, { name: "NOTES.txt", size: 1, parentId: docs.id }))
        .status
    ).toBe(409);

    const listed = await json(
      await call(owner, `/api/drive/items?parentId=${docs.id}`),
      listBody
    );

    expect(listed.items.map((item) => item.name)).toEqual(["notes.txt"]);

    const top = await json(await call(owner, "/api/drive/items"), listBody);

    expect(top.items[0]?.name).toBe("Docs");

    const found = await json(
      await call(owner, "/api/drive/items?search=NOTE"),
      listBody
    );

    expect(found.items.map((item) => item.name)).toEqual(["notes.txt"]);
  });

  it("go straight to the bucket, which takes exactly the declared size", async () => {
    const bytes = new TextEncoder().encode("direct");

    const reserved = await json(
      await reserve(owner, { name: "direct.txt", size: bytes.byteLength }),
      uploadBody,
      201
    );

    const tooLong = await fetch(reserved.upload.url, {
      method: "PUT",
      headers: reserved.upload.headers,
      body: new TextEncoder().encode("direct, and then some"),
    });

    expect(tooLong.ok).toBe(false);

    const put = await fetch(reserved.upload.url, {
      method: "PUT",
      headers: reserved.upload.headers,
      body: bytes,
    });

    expect(put.status, await put.text()).toBe(200);
    await json(
      await call(owner, `/api/drive/uploads/${reserved.item.id}/complete`, {
        method: "POST",
      }),
      itemBody
    );
    expect(
      await (
        await call(owner, `/api/drive/items/${reserved.item.id}/content`)
      ).text()
    ).toBe("direct");
  });
});

describe("quota", () => {
  it("is reserved before the upload URL is issued, pending and trashed files included", async () => {
    const quotaUser = await invite("Quinn");

    await call(admin, `/api/admin/drive/quotas/${quotaUser.id}`, {
      method: "PUT",
      json: { quotaBytes: 10 },
    });

    expect(
      (await reserve(quotaUser, { name: "big.txt", size: 11 })).status
    ).toBe(413);
    expect(
      (await reserve(quotaUser, { name: "fits.txt", size: 10 })).status
    ).toBe(201);
    // The pending upload already holds its 10 bytes.
    expect(
      (await reserve(quotaUser, { name: "more.txt", size: 1 })).status
    ).toBe(413);
    expect(await usedBytes(quotaUser)).toEqual({
      usedBytes: 10,
      quotaBytes: 10,
    });
    // Folders are free.
    await folder(quotaUser, "Still fine");

    // Back to the default, which an administrator can change.
    await call(admin, `/api/admin/drive/quotas/${quotaUser.id}`, {
      method: "PUT",
      json: { quotaBytes: null },
    });
    expect((await usedBytes(quotaUser)).quotaBytes).toBe(5_000_000_000);
    await call(admin, "/api/admin/drive/settings", {
      method: "PUT",
      json: { defaultQuotaBytes: 12 },
    });
    expect((await usedBytes(quotaUser)).quotaBytes).toBe(12);
    expect(
      (await reserve(quotaUser, { name: "more.txt", size: 3 })).status
    ).toBe(413);
    expect(
      (await reserve(quotaUser, { name: "more.txt", size: 2 })).status
    ).toBe(201);
    await call(admin, "/api/admin/drive/settings", {
      method: "PUT",
      json: { defaultQuotaBytes: 5_000_000_000 },
    });
  });

  it("charges what an editor adds to a shared folder to the folder's owner", async () => {
    const shared = await folder(owner, "Team uploads");

    await share(shared.id, { email: editor.email, role: "editor" });

    const before = (await usedBytes(owner)).usedBytes;
    const editorBefore = (await usedBytes(editor)).usedBytes;

    await upload(editor, "by-editor.txt", "123456789", { parentId: shared.id });
    expect((await usedBytes(owner)).usedBytes).toBe(before + 9);
    expect((await usedBytes(editor)).usedBytes).toBe(editorBefore);
  });

  it("is only an administrator's (or a Manage Drive member's) to change", async () => {
    expect((await call(owner, "/api/admin/drive")).status).toBe(403);
    expect(
      (
        await call(owner, `/api/admin/drive/quotas/${owner.id}`, {
          method: "PUT",
          json: { quotaBytes: 1e12 },
        })
      ).status
    ).toBe(403);
    expect((await call(admin, "/api/admin/drive")).status).toBe(200);
  });
});

describe("sharing", () => {
  it("gives viewers read access and editors write access, inherited from the folder", async () => {
    const project = await folder(owner, "Project");

    const plan = await upload(owner, "plan.txt", "plan", {
      parentId: project.id,
    });

    expect(
      (await share(project.id, { email: viewer.email, role: "viewer" })).status
    ).toBe(200);
    expect(
      (await share(project.id, { email: editor.email, role: "editor" })).status
    ).toBe(200);

    const sharedWithViewer = await json(
      await call(viewer, "/api/drive/items?view=shared"),
      listBody
    );

    expect(
      sharedWithViewer.items.map((item) => [item.id, item.access])
    ).toContainEqual([project.id, "viewer"]);
    expect(
      (await call(viewer, `/api/drive/items?parentId=${project.id}`)).status
    ).toBe(200);
    expect(
      await (await call(viewer, `/api/drive/items/${plan.id}/content`)).text()
    ).toBe("plan");
    expect(
      (
        await call(viewer, `/api/drive/items/${plan.id}`, {
          method: "PATCH",
          json: { name: "x.txt" },
        })
      ).status
    ).toBe(403);
    expect(
      (
        await call(viewer, `/api/drive/items/${plan.id}/trash`, {
          method: "POST",
        })
      ).status
    ).toBe(403);
    expect(
      (await reserve(viewer, { name: "v.txt", size: 1, parentId: project.id }))
        .status
    ).toBe(404);
    expect(
      (await call(viewer, `/api/drive/items/${project.id}/shares`)).status
    ).toBe(404);
    expect(
      (
        await call(viewer, `/api/drive/items/${plan.id}/links`, {
          method: "POST",
          json: {},
        })
      ).status
    ).toBe(404);

    expect(
      (
        await call(editor, `/api/drive/items/${plan.id}`, {
          method: "PATCH",
          json: { name: "plan-v2.txt" },
        })
      ).status
    ).toBe(200);

    // Editors can't move things out of the owner's drive, or share them on.
    expect(
      (
        await call(editor, `/api/drive/items/${plan.id}`, {
          method: "PATCH",
          json: { parentId: null },
        })
      ).status
    ).toBe(422);
    expect(
      (await call(editor, `/api/drive/items/${plan.id}/shares`)).status
    ).toBe(404);

    // Someone it isn't shared with can't tell it exists.
    const strangerSees = await Promise.all(
      [
        `/api/drive/items/${plan.id}`,
        `/api/drive/items/${plan.id}/content`,
        `/api/drive/items?parentId=${project.id}`,
      ].map(async (path) => (await call(stranger, path)).status)
    );

    expect(strangerSees).toEqual([404, 404, 404]);

    expect(
      (
        await json(
          await call(stranger, "/api/drive/items?view=shared"),
          listBody
        )
      ).items
    ).toEqual([]);
    expect(
      (await call(null, `/api/drive/items/${plan.id}/content`)).status
    ).toBe(401);
  });

  it("stops at once when a share is removed", async () => {
    const memo = await upload(owner, "memo.txt", "memo");

    await share(memo.id, { email: viewer.email, role: "viewer" });
    expect(
      (await call(viewer, `/api/drive/items/${memo.id}/content`)).status
    ).toBe(200);

    const { shares: list } = await shares(memo.id);

    const viewerShare = required(
      list.find((entry) => entry.userId === viewer.id),
      "the share exists"
    );

    await call(owner, `/api/drive/items/${memo.id}/shares/${viewerShare.id}`, {
      method: "DELETE",
    });
    expect(
      (await call(viewer, `/api/drive/items/${memo.id}/content`)).status
    ).toBe(404);
  });

  it("with a team follows the team's members, and only with the owner's teams", async () => {
    const board = await upload(owner, "board.txt", "board");

    expect((await share(board.id, { teamId, role: "viewer" })).status).toBe(
      200
    );
    expect(
      await (
        await call(teammate, `/api/drive/items/${board.id}/content`)
      ).text()
    ).toBe("board");
    expect(
      (await call(stranger, `/api/drive/items/${board.id}/content`)).status
    ).toBe(404);

    // Stan isn't in Design, so he can't share with it.
    const stansFile = await upload(stranger, "stan.txt", "stan");

    const refused = await call(
      stranger,
      `/api/drive/items/${stansFile.id}/shares`,
      {
        method: "POST",
        json: { teamId, role: "viewer" },
      }
    );

    expect(refused.status).toBe(404);

    const leaves = await call(admin, `/api/admin/teams/person/${teammate.id}`, {
      method: "PUT",
      json: { teamIds: [] },
    });

    expect(leaves.status).toBe(200);
    expect(
      (await call(teammate, `/api/drive/items/${board.id}/content`)).status
    ).toBe(404);
  });

  it("does not let an editor whose share was revoked fill or finish a reserved upload", async () => {
    const dropbox = await folder(owner, "Dropbox");

    await share(dropbox.id, { email: editor.email, role: "editor" });

    const reserved = await json(
      await reserve(editor, {
        name: "late.txt",
        size: 4,
        parentId: dropbox.id,
      }),
      uploadBody,
      201
    );

    const editorShare = required(
      (await shares(dropbox.id)).shares.find(
        (entry) => entry.userId === editor.id
      ),
      "the editor's share"
    );

    const ownerUsed = (await usedBytes(owner)).usedBytes;

    await call(
      owner,
      `/api/drive/items/${dropbox.id}/shares/${editorShare.id}`,
      { method: "DELETE" }
    );

    // The bytes reached staging with the URL issued before the revocation…
    await env.DRIVE_STORAGE.put(`staging/${reserved.item.id}`, "late");

    // …but completion checks write access again, and drops the upload.
    const complete = await call(
      editor,
      `/api/drive/uploads/${reserved.item.id}/complete`,
      { method: "POST" }
    );

    expect(complete.status).toBe(404);
    expect(
      await env.DRIVE_STORAGE.head(`staging/${reserved.item.id}`)
    ).toBeNull();
    expect(
      await env.DRIVE_STORAGE.head(`files/${reserved.item.id}`)
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM drive_items WHERE id = ?")
        .bind(reserved.item.id)
        .first()
    ).toBeNull();
    expect((await usedBytes(owner)).usedBytes).toBe(ownerUsed - 4);
  });

  it("does not let someone else finish another person's upload", async () => {
    const reserved = await json(
      await reserve(owner, { name: "mine.txt", size: 2 }),
      uploadBody,
      201
    );

    await env.DRIVE_STORAGE.put(`staging/${reserved.item.id}`, "ok");
    expect(
      (
        await call(
          stranger,
          `/api/drive/uploads/${reserved.item.id}/complete`,
          { method: "POST" }
        )
      ).status
    ).toBe(404);
    // Still the owner's to finish.
    await json(
      await call(owner, `/api/drive/uploads/${reserved.item.id}/complete`, {
        method: "POST",
      }),
      itemBody
    );
  });
});

describe("public links", () => {
  it("serve the file with a password, expiry, revocation and an access count", async () => {
    const file = await upload(owner, "public.txt", "public bytes");
    const plain = await createLink(file.id);
    const opened = await openLink(plain.path);

    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe("public bytes");
    expect(opened.headers.get("content-disposition")).toStartWith(
      "attachment;"
    );
    expect(opened.headers.get("referrer-policy")).toBe("no-referrer");

    const locked = await createLink(file.id, { password: "correct horse" });
    const form = await openLink(locked.path);

    expect(form.status).toBe(401);
    expect(await form.text()).toContain("<form");
    expect((await openLink(locked.path, "nope")).status).toBe(401);

    const unlocked = await openLink(locked.path, "correct horse");

    expect(unlocked.status).toBe(200);
    expect(await unlocked.text()).toBe("public bytes");

    const expiring = await createLink(file.id, {
      expiresAt: Date.now() + 60_000,
    });

    await env.DB.prepare("UPDATE drive_links SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expiring.id)
      .run();
    expect((await openLink(expiring.path)).status).toBe(404);
    expect(
      (
        await call(owner, `/api/drive/items/${file.id}/links`, {
          method: "POST",
          json: { expiresAt: Date.now() - 1 },
        })
      ).status
    ).toBe(422);

    const { links } = await shares(file.id);

    expect(links.find((link) => link.id === plain.id)).toMatchObject({
      accessCount: 1,
      hasPassword: false,
    });
    expect(links.find((link) => link.id === locked.id)).toMatchObject({
      accessCount: 1,
      hasPassword: true,
    });
    expect(JSON.stringify(links)).not.toContain("pbkdf2");

    expect(
      (await call(owner, `/api/drive/links/${plain.id}`, { method: "DELETE" }))
        .status
    ).toBe(200);
    expect((await openLink(plain.path)).status).toBe(404);
    expect((await openLink("/d/not-a-real-token")).status).toBe(404);

    // Only the owner makes or turns off links.
    expect(
      (
        await call(stranger, `/api/drive/links/${locked.id}`, {
          method: "DELETE",
        })
      ).status
    ).toBe(404);

    // A file in the trash isn't public.
    await call(owner, `/api/drive/items/${file.id}/trash`, { method: "POST" });
    expect((await openLink(locked.path, "correct horse")).status).toBe(404);
  });

  it("stop while the owner is disabled, and work again once re-enabled", async () => {
    const person = await invite("Paula");
    const file = await upload(person, "owned.txt", "owned bytes");

    const created = await json(
      await call(person, `/api/drive/items/${file.id}/links`, {
        method: "POST",
        json: {},
      }),
      z.object({ url: z.string() }),
      201
    );

    const path = new URL(created.url).pathname;

    expect((await openLink(path)).status).toBe(200);

    const setStatus = (status: string) =>
      call(admin, `/api/admin/users/${person.id}`, {
        method: "PATCH",
        json: { status },
      });

    expect((await setStatus("disabled")).status).toBe(200);
    expect((await openLink(path)).status).toBe(404);
    expect((await setStatus("active")).status).toBe(200);
    expect((await openLink(path)).status).toBe(200);
  });

  it("show only safe types in the browser, and never HTML or SVG", async () => {
    const html = await upload(owner, "page.html", "<script>alert(1)</script>", {
      contentType: "text/html",
    });

    const svg = await upload(
      owner,
      "logo.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
      { contentType: "image/svg+xml" }
    );

    const disguised = await upload(owner, "evil.txt", "<script>1</script>", {
      contentType: "text/html",
    });

    const png = await upload(owner, "pixel.png", "png", {
      contentType: "image/png",
    });

    const text = await upload(owner, "readme.txt", "<b>hi</b>", {
      contentType: "text/plain",
    });

    const risky = await Promise.all(
      [html, svg, disguised].map((item) =>
        call(owner, `/api/drive/items/${item.id}/content?inline=true`)
      )
    );

    for (const response of risky) {
      expect(response.headers.get("content-disposition")).toStartWith(
        "attachment;"
      );
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream"
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-security-policy")).toStartWith(
        "sandbox;"
      );
    }

    const image = await call(
      owner,
      `/api/drive/items/${png.id}/content?inline=true`
    );

    expect(image.headers.get("content-disposition")).toStartWith("inline;");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-security-policy")).toStartWith(
      "sandbox;"
    );

    const plain = await call(
      owner,
      `/api/drive/items/${text.id}/content?inline=true`
    );

    expect(plain.headers.get("content-type")).toBe("text/plain; charset=utf-8");

    const part = await call(owner, `/api/drive/items/${text.id}/content`, {
      headers: { range: "bytes=3-4" },
    });

    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 3-4/9");
    expect(await part.text()).toBe("hi");

    const view = await createLink(html.id, { access: "view" });
    const outside = await openLink(view.path);

    expect(outside.headers.get("content-disposition")).toStartWith(
      "attachment;"
    );
    expect(outside.headers.get("content-security-policy")).toStartWith(
      "sandbox;"
    );
  });
});

describe("trash", () => {
  it("restores what it took, and deleting for good removes the bytes", async () => {
    const parent = await folder(owner, "Archive");

    const child = await upload(owner, "inside.txt", "inside", {
      parentId: parent.id,
    });

    expect(await env.DRIVE_STORAGE.head(`files/${child.id}`)).not.toBeNull();
    expect(
      (await call(owner, `/api/drive/items/${parent.id}`, { method: "DELETE" }))
        .status
    ).toBe(409);
    await call(owner, `/api/drive/items/${parent.id}/trash`, {
      method: "POST",
    });

    const trash = await json(
      await call(owner, "/api/drive/items?view=trash"),
      listBody
    );

    expect(trash.items.map((item) => item.id)).toContain(parent.id);
    expect(trash.items.map((item) => item.id)).not.toContain(child.id);

    // The name is free meanwhile; restoring then reports the clash.
    const clash = await folder(owner, "Archive");

    expect(
      (
        await call(owner, `/api/drive/items/${parent.id}/restore`, {
          method: "POST",
        })
      ).status
    ).toBe(409);
    await call(owner, `/api/drive/items/${clash.id}/trash`, { method: "POST" });
    await call(owner, `/api/drive/items/${clash.id}`, { method: "DELETE" });
    expect(
      (
        await call(owner, `/api/drive/items/${parent.id}/restore`, {
          method: "POST",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await json(
          await call(owner, `/api/drive/items?parentId=${parent.id}`),
          listBody
        )
      ).items.map((item) => item.id)
    ).toEqual([child.id]);

    const used = (await usedBytes(owner)).usedBytes;

    await call(owner, `/api/drive/items/${parent.id}/trash`, {
      method: "POST",
    });
    expect(
      (await call(owner, `/api/drive/items/${parent.id}`, { method: "DELETE" }))
        .status
    ).toBe(200);
    expect(await env.DRIVE_STORAGE.head(`files/${child.id}`)).toBeNull();
    expect((await usedBytes(owner)).usedBytes).toBe(used - 6);
  });

  it("can't take a folder into itself", async () => {
    const outer = await folder(owner, "Outer");
    const inner = await folder(owner, "Inner", outer.id);

    const moved = await call(owner, `/api/drive/items/${outer.id}`, {
      method: "PATCH",
      json: { parentId: inner.id },
    });

    expect(moved.status).toBe(422);
    expect((await json(moved, errorBody, 422)).error.message).toContain(
      "itself"
    );
  });
});

describe("erasing a person's drive", () => {
  it("deletes everything they own, bytes included, and nothing of anyone else's", async () => {
    const leaver = await invite("Leo");
    const box = await folder(leaver, "Box");

    const file = await upload(leaver, "cv.pdf", "pdf", {
      parentId: box.id,
      contentType: "application/pdf",
    });

    const kept = await upload(owner, "kept.txt", "kept");

    expect(
      (
        await call(owner, `/api/admin/drive/people/${leaver.id}/files`, {
          method: "DELETE",
        })
      ).status
    ).toBe(403);

    const erased = await json(
      await call(admin, `/api/admin/drive/people/${leaver.id}/files`, {
        method: "DELETE",
      }),
      z.object({ deleted: z.number() })
    );

    expect(erased.deleted).toBe(2);
    expect(await env.DRIVE_STORAGE.head(`files/${file.id}`)).toBeNull();
    expect((await usedBytes(leaver)).usedBytes).toBe(0);
    expect(await env.DRIVE_STORAGE.head(`files/${kept.id}`)).not.toBeNull();
  });
});

describe("MCP", () => {
  const toolList = z.object({
    result: z.looseObject({
      tools: z.array(z.looseObject({ name: z.string() })),
    }),
  });

  function mcp(
    token: string,
    method: string,
    params: { name?: string; arguments?: Record<string, string> } = {}
  ) {
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
    });

    if (params.name) headers.set("mcp-name", params.name);

    return worker.fetch(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "drive-test",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      })
    );
  }

  async function toolNames(token: string) {
    return (
      await json(await mcp(token, "tools/list"), toolList)
    ).result.tools.map((tool) => tool.name);
  }

  it("gives read tools with drive.read and write tools only with drive.write", async () => {
    const reader = await mcpAccessToken(owner.cookie, { scope: "drive.read" });

    const writer = await mcpAccessToken(owner.cookie, {
      scope: "drive.read drive.write",
    });

    const readTools = await toolNames(reader.accessToken);

    expect(readTools).toEqual(
      expect.arrayContaining([
        "list_drive_items",
        "get_drive_item",
        "read_drive_file",
      ])
    );
    expect(readTools).not.toContain("create_drive_link");
    expect(await toolNames(writer.accessToken)).toEqual(
      expect.arrayContaining([
        "create_drive_folder",
        "share_drive_item",
        "create_drive_link",
        "trash_drive_item",
      ])
    );

    // The routes check the scope too, whatever a token calls.
    const folderByReader = await worker.fetch(
      new Request(`${origin}/api/drive/folders`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${reader.accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "Nope" }),
      })
    );

    expect(folderByReader.status).toBe(403);

    const file = await upload(owner, "mcp.txt", "read me over MCP");

    const read = await json(
      await mcp(reader.accessToken, "tools/call", {
        name: "read_drive_file",
        arguments: { itemId: file.id },
      }),
      z.object({
        result: z.looseObject({
          structuredContent: z.looseObject({
            totalBytes: z.number(),
            complete: z.boolean(),
          }),
          content: z.array(z.looseObject({ type: z.string() })),
        }),
      })
    );

    expect(read.result.structuredContent).toMatchObject({
      totalBytes: 16,
      complete: true,
    });
  });
});
