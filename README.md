# Drive for OpenWorkspace

A community module for [OpenWorkspace](https://github.com/iivankin/openworkspace).
It adds **Drive** to the app switcher, at `/drive`: folders and files in an R2
bucket of its own, a storage quota per person, sharing with people and teams
as viewer or editor, and public links. Images, PDFs, text, audio and video
open in the browser. Apps reach it through the API and MCP tools, with
`drive.read` and `drive.write` OAuth scopes. Administrators set quotas under
**Administration → Drive**.

## Compatibility

Developed and tested against `@open-workspace/core` and `@open-workspace/email`
from iivankin/openworkspace@8d61918 (`master` after 0.4.2). `package.json`
declares `"@open-workspace/core": ">=0.4.3"`, the first release that will
contain that code. Drive only uses module APIs that 0.4.2 already exports
(`WorkspaceModuleInfra.env`/`routes`, `requirePermission`, `teamMembership`,
`runBinaryResourceTool`, ...), so it may well work on 0.4.2, but that hasn't
been tested.

Drive doesn't need the mail module.

## Install

In your deployment project:

```sh
bun add openworkspace-drive
```

List the module in `alchemy.run.ts`:

```ts
import { Email } from "@open-workspace/email/alchemy";
import { Drive } from "openworkspace-drive";

OpenWorkspace({
  hostname: "mail.acme.com",
  mailDomains: ["acme.com"],
  modules: [Email(), Drive()],
});
```

Then run `bun run deploy`. The deploy creates the `DriveStorage` R2 bucket, an
API token that can only read and write that bucket (for presigned uploads),
and the bucket's CORS rule for your app's origin. The package already contains
its migration (`migrations/0000_drive.sql`), which core applies as
`modules/drive/…`.

Removing `Drive()` later stops the app and its routes, and Alchemy deletes the
resources the stack no longer declares, the bucket among them. (Whether that
delete goes through while the bucket still holds files hasn't been tested.)
Export what you want to keep first.

## How it works

### Storage and quota

- Each file and folder is a row in `drive_items` (D1). A file's bytes are at
  `files/<id>` in the Drive bucket.
- Everything belongs to one person, its **owner**, and counts against the
  owner's quota. A file that an editor adds to a shared folder belongs to the
  folder's owner and uses the owner's quota.
- The quota is 5 GB per person unless an administrator changes the default or
  sets a person's own quota. Pending uploads and the trash count toward it.
  Folders are free. Lowering a quota below what someone already stores only
  stops new uploads; nothing is deleted.

### Uploads

1. The browser asks `POST /api/drive/uploads` with the name, type and size,
   up to 100 MB per file. The Worker checks that the person may write in the
   target folder. In the same SQL statement, it reserves the size against the
   owner's quota and inserts a pending row. Then it returns a presigned R2
   PUT URL for `staging/<id>`, valid for 10 minutes.
2. The URL signs `Content-Type` and `Content-Length`, so R2 accepts exactly
   the declared size, which is the size the quota counted. The browser PUTs
   the file directly to R2, not through the Worker.
3. `POST /api/drive/uploads/:id/complete` **checks write access again**. If
   the person lost it meanwhile (an editor whose share was revoked, or whose
   folder went to the trash), the upload is dropped: its bytes and row are
   deleted and the quota is released. Otherwise the Worker checks that the
   staged object has the declared size and copies it to `files/<id>`, where
   the upload URL can't reach, so a replayed URL can't swap the bytes.
   Then it marks the file ready.

An upload URL issued before a revocation can still put bytes into `staging/`
until it expires. Those bytes never become a file. Uploads that nobody
completes are swept from D1 after an hour, the next time the owner uploads,
and a bucket lifecycle rule deletes `staging/` objects after a day.

### Sharing

The owner shares a file or folder with a **person**, by their workspace
address, or with a **team they're in**. The share is either:

- **viewer**: can open and download, or
- **editor**: can also upload, create folders, rename, move within the
  owner's drive, and trash.

A share on a folder covers everything inside it. If several shares apply, the
strongest one wins. A team share follows the team's current membership: people
who join the team get access, and people who leave it lose access right away.
Removing a share also takes effect at once. Only the owner can share, create
links, restore from the trash or delete for good. To anyone else, an item that
isn't shared with them looks like it doesn't exist (404).

### Public links

The owner can create `/d/<token>` links to files (not folders). Each link
either opens the file in the browser, if it's a previewable type, or
downloads it. A link can have an expiry and a password. Passwords are hashed
with PBKDF2, and wrong guesses are rate-limited to 10 a minute per link and
address. The link and its token are shown once; only a SHA-256 hash of the
token is stored. The owner sees how often each link was opened, and can turn
it off.

A link stops working when it expires, when it's turned off, when its file
goes to the trash, and **while its owner is disabled**. It works again if the
owner is enabled again.

### Previews and safety

User content never runs on the app's origin:

- Only raster images, PDFs, plain text (including JSON, XML, CSV and
  Markdown, all served as `text/plain`), audio and video are ever served
  inline.
- Everything else, including HTML, SVG, scripts and Office files, is served as
  an `application/octet-stream` attachment, whatever its name or declared type
  says.
- Every response carries `X-Content-Type-Options: nosniff` and a
  `Content-Security-Policy` with `sandbox` and `default-src 'none'`.
- PDFs are the one exception to `sandbox`, because browsers refuse to render
  a PDF in a sandboxed document. They keep `default-src 'none'`, and a PDF's
  own scripts run inside the browser's viewer, not on the page.

Range requests are supported, for video seeking and for MCP's chunked reads.

## Data and privacy (GDPR)

**What Drive stores:**

- **Files' bytes**, in the Drive bucket. These can be anything people upload,
  so treat them as personal data, possibly special-category data.
- **Metadata per item**, in D1: name, size, type, owner, the person who
  created it, parent folder, timestamps, and when it was trashed.
- **Shares**: who each item is shared with (a person or a team) and the role.
- **Public links**: a hash of the token, a password hash if there is one, the
  expiry, an access count and the time of the last access. Drive doesn't
  store the IP addresses or user agents of people who open a link. Core's
  rate limiter counts attempts per address in Cloudflare's rate-limiting
  service and keeps nothing in D1.
- **Quotas and the default quota.**

**Public links expose files.** Anyone who has a link can download the file
without signing in, until the link expires or is turned off, the file is
trashed, or its owner is disabled. A link can be forwarded, and can end up in
browser histories, chats and logs outside the workspace. Links send
`Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, but neither stops
people from passing a link on. Use an expiry and a password for anything
sensitive. Administrators can't see or list other people's links.

**Retention and deletion:**

| What happens                                       | Result                                                                                                                                                                                                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The owner moves an item to the trash               | Its bytes and rows stay, and keep counting toward the quota, until the owner deletes them. There is no automatic purge of the trash.                                                                                                                                                |
| The owner deletes an item for good                 | Its bytes are deleted from R2 first, then its rows, along with everything inside it and every share and link on it.                                                                                                                                                                 |
| A person is **disabled**                           | Nothing is deleted. Their files stay, still count toward their quota, and stay available to the people and teams they were shared with. Their public links stop working.                                                                                                            |
| An administrator uses **Delete files** on a person | Everything the person owns is deleted for good (bytes first), including the trash, shares and links. This is the erasure path for a right-to-erasure request. Files the person added to other people's folders belong to those people and stay; their creator field is not cleared. |
| A user row is deleted from D1                      | Core has no route for this today; it only disables people. If it happens, the foreign keys delete the person's items, shares, quota and the shares made to them, but **not the bytes in R2**. Use **Delete files** first.                                                           |
| A team is deleted                                  | Its shares go with it (foreign key).                                                                                                                                                                                                                                                |
| The module is removed from `alchemy.run.ts`        | The next deploy tries to delete the bucket (see Install); the D1 tables stay.                                                                                                                                                                                                       |

Drive records nothing in core's audit trails or webhooks, and sends no data
outside your Cloudflare account.

### Backups

**Drive doesn't take part in core's backups.** A backup batch stores objects
through `snapshot.putObject(bytes)`, which takes a file's whole contents in
memory. Files of up to 100 MB, and many of them, don't fit the Worker's
128 MB memory and the few hundred subrequests per batch that core asks for.
Backing up only the metadata would restore rows whose bytes are missing.

A core restore leaves Drive's tables and bucket as they are. If you need
backups of Drive, copy the `DriveStorage` bucket with R2's own tools (for
example, `rclone` against its S3 endpoint, or a second bucket kept in sync),
and include D1's `drive_*` tables in a D1 export.

## Permissions and scopes

The administrator permission **Manage Drive** (`manage_drive`, OAuth scope
`admin.drive`) lets a member open **Administration → Drive**. There they can see
each person's usage, set the default and per-person quotas, and delete a
person's files. It doesn't let them open anyone's files. Administrators always
have it.

OAuth scopes for apps and MCP clients:

| Scope         | Allows                                                                                     | Default |
| ------------- | ------------------------------------------------------------------------------------------ | ------- |
| `drive.read`  | Listing, searching and downloading the person's files and the ones shared with them        | yes     |
| `drive.write` | Uploading, creating folders, renaming, moving, trashing, deleting, sharing, creating links | no      |

## API

All routes are under `/api/drive`. They need a signed-in person: a browser
session, or an OAuth token with the scope shown.

| Method and path                | Scope   | Does                                                                                                  |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------- |
| `GET /status`                  | `read`  | `{ usedBytes, quotaBytes }`                                                                           |
| `GET /teams`                   | `read`  | The teams the person is in, which they can share with                                                 |
| `GET /items`                   | `read`  | `?view=files\|shared\|trash&parentId&search&sort=name\|date\|size&order`: up to 500 items             |
| `GET /items/:id`               | `read`  | One item, the person's `access` (owner, editor or viewer) and its folder path                         |
| `GET /items/:id/content`       | `read`  | The bytes; `?inline=true` to show a previewable type; supports `Range`                                |
| `POST /folders`                | `write` | `{ name, parentId }`                                                                                  |
| `POST /uploads`                | `write` | `{ name, parentId, contentType, size }`: reserves quota, returns `{ item, upload: { url, headers } }` |
| `POST /uploads/:id/complete`   | `write` | Finishes an upload after the PUT                                                                      |
| `PATCH /items/:id`             | `write` | `{ name?, parentId? }`: rename or move within the owner's drive                                       |
| `POST /items/:id/trash`        | `write` | Moves the item, and everything in it, to the owner's trash                                            |
| `POST /items/:id/restore`      | `write` | Owner only                                                                                            |
| `DELETE /items/:id`            | `write` | Owner only, from the trash; or cancels your own pending upload                                        |
| `GET /items/:id/shares`        | `read`  | Owner only: `{ shares, links }`                                                                       |
| `POST /items/:id/shares`       | `write` | `{ email \| teamId, role }`: adds a share, or changes its role                                        |
| `DELETE /items/:id/shares/:id` | `write` | Removes a share                                                                                       |
| `POST /items/:id/links`        | `write` | `{ access: view\|download, expiresAt (ms) \| null, password \| null }`: returns the URL once          |
| `DELETE /links/:id`            | `write` | Turns a link off                                                                                      |

Administration routes are under `/api/admin/drive`, need **Manage Drive**, and
take `admin.drive` for tokens: `GET /`, `PUT /settings { defaultQuotaBytes }`,
`PUT /quotas/:userId { quotaBytes | null }` and
`DELETE /people/:userId/files`.

MCP tools: `list_drive_items`, `get_drive_item` and `read_drive_file` (read, in
chunks of 1 MB), and `create_drive_folder`, `update_drive_item`,
`trash_drive_item`, `share_drive_item` and `create_drive_link` (write).

## Not included

These parts of the original Drive feature (iivankin/openworkspace#17) were
left out of the module, or changed:

- **Save to Drive from the mail reader.** It needs a hook in the mail module
  that doesn't exist yet. The maintainer plans to add one.
- **The on/off switch** under Administration. Installing the module is the
  switch now.
- **Uploads through the Worker** when R2 S3 credentials are missing. `Drive()`
  always binds credentials, including under `alchemy dev`.
- Still out of scope, as before: folder links, uploads over 100 MB (multipart),
  Office previews, automatic trash purge, versioning, and paging past 500
  items per folder. Search covers your own files only.

## Developing

Until core 0.4.3 is on npm, the dev dependencies on `@open-workspace/core` and
`@open-workspace/email` (email is only for the dev demo) point at tarballs in
`.core/`, which is gitignored. To build them from an installed checkout of
iivankin/openworkspace at 8d61918 or later, run:

```sh
bun scripts/pack-core.ts ../openworkspace
bun install
```

Then:

```sh
bun run typecheck
bun run lint && bun run format:check   # upstream's oxlint/oxfmt config
bun run test:unit                      # previews, ranges, passwords, upload signing, names
bun run test:stack                     # core + this module on Alchemy's local runtime
bun run dev                            # http://localhost:5192, "Open seeded local demo"
```

## License

Apache-2.0, like OpenWorkspace. `tools/oxlint/anti-slop` is vendored from
upstream under its MIT license.
