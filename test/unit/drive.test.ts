import { describe, expect, it } from "bun:test";

import { filePreview } from "../../shared/preview";
import { byteRange } from "../../worker/items";
import { hashPassword, verifyPassword } from "../../worker/password";
import { signUploadUrl } from "../../worker/presign";
import { nameSchema } from "../../worker/routes";

describe("filePreview", () => {
  it("shows raster images, PDFs, text, audio and video", () => {
    expect(filePreview({ name: "a.png", contentType: "image/png" })).toEqual({
      kind: "image",
      contentType: "image/png",
    });
    expect(
      filePreview({ name: "a", contentType: "application/pdf" })?.kind
    ).toBe("pdf");
    expect(filePreview({ name: "song.mp3", contentType: null })?.kind).toBe(
      "audio"
    );
    expect(filePreview({ name: "clip.webm", contentType: "" })?.kind).toBe(
      "video"
    );
  });

  it("shows structured text as plain text", () => {
    for (const contentType of ["application/json", "text/xml", "text/csv"]) {
      expect(filePreview({ name: "x", contentType })).toEqual({
        kind: "text",
        contentType: "text/plain; charset=utf-8",
      });
    }
  });

  it("never shows HTML, SVG or scripts, whatever the name says", () => {
    for (const file of [
      { name: "page.html", contentType: "text/html" },
      { name: "evil.txt", contentType: "text/html" },
      { name: "logo.svg", contentType: "image/svg+xml" },
      { name: "logo.svg", contentType: null },
      { name: "app.js", contentType: "text/javascript" },
      { name: "doc.docx", contentType: "application/octet-stream" },
    ]) {
      expect(filePreview(file)).toBeNull();
    }
  });
});

describe("byteRange", () => {
  it("reads one bytes= range within the file", () => {
    expect(byteRange("bytes=0-99", 1000)).toEqual({ offset: 0, length: 100 });
    expect(byteRange("bytes=900-", 1000)).toEqual({ offset: 900, length: 100 });
    expect(byteRange("bytes=-100", 1000)).toEqual({ offset: 900, length: 100 });
    expect(byteRange("bytes=990-5000", 1000)).toEqual({
      offset: 990,
      length: 10,
    });
  });

  it("sends the whole file for anything else", () => {
    for (const header of [
      undefined,
      "",
      "bytes=-",
      "bytes=1000-",
      "bytes=5-2",
      "items=0-1",
      "bytes=0-1,4-5",
    ]) {
      expect(byteRange(header, 1000)).toBeNull();
    }
  });
});

describe("link passwords", () => {
  it("verify only the password they were made from", async () => {
    const stored = await hashPassword("correct horse");

    expect(stored).toMatch(/^pbkdf2\$100000\$[\w-]+\$[\w-]+$/u);
    expect(await verifyPassword("correct horse", stored)).toBe(true);
    expect(await verifyPassword("correct horsf", stored)).toBe(false);
    expect(await verifyPassword("correct horse", "plain")).toBe(false);
    expect(await hashPassword("correct horse")).not.toBe(stored);
  });
});

describe("upload URLs", () => {
  it("sign the content length, so R2 takes exactly the declared size", async () => {
    const url = new URL(
      await signUploadUrl(
        {
          DRIVE_S3: JSON.stringify({
            endpoint: "https://account.r2.cloudflarestorage.com",
            bucketName: "drive",
            region: "auto",
            accessKeyId: "key",
            secretAccessKey: "secret",
          }),
        },
        { key: "staging/drv_1", contentType: "text/plain", size: 42 }
      )
    );

    expect(url.pathname).toBe("/drive/staging/drv_1");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(
      expect.arrayContaining(["content-length", "content-type"])
    );
  });
});

describe("names", () => {
  it("refuse slashes, control characters and dot names", () => {
    expect(nameSchema.parse("  Report 2026.pdf ")).toBe("Report 2026.pdf");

    for (const name of [
      "a/b",
      "a\\b",
      "line\nbreak",
      ".",
      "..",
      "",
      "x".repeat(256),
    ]) {
      expect(nameSchema.safeParse(name).success).toBe(false);
    }
  });
});
