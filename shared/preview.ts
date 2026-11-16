/**
 * How a file may be shown in the browser, if at all: the Worker serves it
 * inline only as one of these, with the type given here, and the Drive app
 * picks its viewer by `kind`. Everything else (HTML, SVG, scripts, Office
 * files, archives) is only ever downloaded.
 */
export type Preview = {
  kind: "image" | "pdf" | "text" | "audio" | "video";
  contentType: string;
};

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/** Structured text is shown as plain text, never parsed as a document. */
const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
]);

const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/flac",
]);

const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/ogg"]);

/** For uploads without a type, or with application/octet-stream. */
const EXTENSION_TYPES = new Map([
  ["pdf", "application/pdf"],
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["txt", "text/plain"],
  ["log", "text/plain"],
  ["md", "text/markdown"],
  ["csv", "text/csv"],
  ["tsv", "text/tab-separated-values"],
  ["json", "application/json"],
  ["xml", "application/xml"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["ogg", "audio/ogg"],
  ["wav", "audio/wav"],
  ["flac", "audio/flac"],
  ["mp4", "video/mp4"],
  ["webm", "video/webm"],
]);

export function filePreview(file: {
  name: string;
  contentType: string | null;
}): Preview | null {
  let type = file.contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

  if (!type || type === "application/octet-stream") {
    const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
    type = EXTENSION_TYPES.get(extension) ?? "";
  }

  if (type === "application/pdf") return { kind: "pdf", contentType: type };

  if (IMAGE_TYPES.has(type)) return { kind: "image", contentType: type };

  if (AUDIO_TYPES.has(type)) return { kind: "audio", contentType: type };

  if (VIDEO_TYPES.has(type)) return { kind: "video", contentType: type };

  if (TEXT_TYPES.has(type)) {
    return { kind: "text", contentType: "text/plain; charset=utf-8" };
  }

  return null;
}
