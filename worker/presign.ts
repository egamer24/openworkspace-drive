import { AwsClient } from "aws4fetch";
import { z } from "zod";

/** How long an upload URL may start its PUT. */
export const UPLOAD_URL_SECONDS = 10 * 60;

const DriveS3 = z.object({
  endpoint: z.string(),
  bucketName: z.string(),
  region: z.string(),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
});

/**
 * A presigned PUT for exactly `size` bytes of `contentType` at `key` of the
 * Drive bucket (`DRIVE_S3`, from Alchemy's `S3Credentials`). Both headers
 * are signed, so R2 refuses any other length (SignatureDoesNotMatch): what
 * lands is the size the quota counted. Browsers send Content-Length on
 * their own; a page can't set it.
 */
export async function signUploadUrl(
  env: Pick<Env, "DRIVE_S3">,
  upload: { key: string; contentType: string; size: number }
) {
  const s3 = DriveS3.parse(JSON.parse(env.DRIVE_S3));

  const url = new URL(
    `${s3.endpoint}/${encodeURIComponent(s3.bucketName)}/${upload.key}`
  );

  url.searchParams.set("X-Amz-Expires", String(UPLOAD_URL_SECONDS));

  const client = new AwsClient({
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    service: "s3",
    region: s3.region,
  });

  const signed = await client.sign(url, {
    method: "PUT",
    headers: {
      "content-type": upload.contentType,
      "content-length": String(upload.size),
    },
    aws: { allHeaders: true, signQuery: true },
  });

  return signed.url;
}
