import { apiFetch, responseJson } from "@open-workspace/core/ui";
import { hc } from "hono/client";

import type { DriveAppType } from "../worker/routes";

/** Typed client for the module's routes; `apiFetch` keeps D1 reads consistent with this tab's writes. */
export const driveApi = hc<DriveAppType>(window.location.origin, {
  fetch: apiFetch,
});

/** Query keys the screens share; everything under ["drive"] refreshes after a change. */
export const driveKeys = {
  all: ["drive"] as const,
  status: ["drive", "status"] as const,
  teams: ["drive", "teams"] as const,
  shares: (id: string) => ["drive", "shares", id] as const,
  admin: ["admin", "drive"] as const,
};

export type ListQuery = NonNullable<
  Parameters<typeof driveApi.api.drive.items.$get>[0]
>["query"];

export async function listItems(query: ListQuery) {
  return responseJson(await driveApi.api.drive.items.$get({ query }));
}

export type DriveEntry = Awaited<ReturnType<typeof listItems>>["items"][number];

/** URL of a file's bytes, shown in the browser or downloaded. */
export function contentUrl(id: string, inline = false) {
  return `/api/drive/items/${encodeURIComponent(id)}/content${inline ? "?inline=true" : ""}`;
}

const units = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;

  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function formatDate(value: string) {
  return dateFormat.format(new Date(value));
}

/**
 * PUTs a file to its presigned upload URL, reporting progress (0 to 1).
 * fetch() can't report upload progress, so this is an XMLHttpRequest.
 */
export function putFile(
  upload: { url: string; headers: Record<string, string> },
  file: File,
  onProgress: (progress: number) => void
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", upload.url);

    for (const [name, value] of Object.entries(upload.headers)) {
      request.setRequestHeader(name, value);
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Upload failed (${request.status})`));
    });
    request.addEventListener("error", () => reject(new Error("Upload failed")));
    request.send(file);
  });
}
