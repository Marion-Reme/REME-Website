import "server-only";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getServerEnv } from "@/lib/env";

type R2Handle = { bucket: string; client: S3Client };

// The client holds no per-request state, so build it once per isolate rather
// than on every signing call.
let handle: R2Handle | null = null;

function r2(): R2Handle {
  if (handle) return handle;
  const env = getServerEnv();
  if (!env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.R2_BUCKET) {
    throw new Error("R2 is not configured");
  }
  handle = {
    bucket: env.R2_BUCKET,
    client: new S3Client({
      region: "auto",
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    }),
  };
  return handle;
}

// contentLength is signed, not merely advertised: R2 rejects a PUT whose
// content-length header differs from the value the signature was built with. A
// browser therefore cannot spend more storage than the server authorised, which
// a bare presigned PUT would have allowed.
export async function signUpload(
  key: string,
  contentType: string,
  contentLength: number,
  expiresIn = 300,
) {
  const { client, bucket } = r2();
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    }),
    { expiresIn },
  );
}

export async function signDownload(key: string, expiresIn = 120) {
  const { client, bucket } = r2();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
}

export type StoredObject = { size: number; contentType: string | null };

// Authoritative check that an object really landed, and how big it actually is.
// Returns null when the key is absent so callers can reject a "completed"
// upload that never happened.
export async function statObject(key: string): Promise<StoredObject | null> {
  const { client, bucket } = r2();
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { size: head.ContentLength ?? 0, contentType: head.ContentType ?? null };
  } catch {
    return null;
  }
}

// Single-object deletes rather than DeleteObjects: the batch call requires a
// request checksum, and single deletes keep this independent of which checksum
// headers the SDK and R2 happen to agree on. Returns the keys that failed.
export async function deleteObjects(keys: string[], concurrency = 8): Promise<string[]> {
  const { client, bucket } = r2();
  const failed: string[] = [];
  for (let start = 0; start < keys.length; start += concurrency) {
    const batch = keys.slice(start, start + concurrency);
    const results = await Promise.allSettled(
      batch.map((key) => client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") failed.push(batch[index]);
    });
  }
  return failed;
}
