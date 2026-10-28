import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { logger } from './logger.js';

// Fail-fast at first use rather than a cryptic downstream error — same
// principle as the rest of the app's required config, just applied at the
// point these particular vars are actually needed instead of a central
// startup validator (there isn't one in this codebase yet; not introducing
// one here is a deliberate scope call, see CLAUDE.md's "Environment &
// secrets" convention).
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

// forcePathStyle is required for MinIO — it doesn't support the
// virtual-hosted-style bucket addressing the AWS SDK defaults to.
const s3 = new S3Client({
  endpoint: requiredEnv('S3_ENDPOINT'),
  region: process.env.S3_REGION ?? 'us-east-1', // MinIO ignores the value; the SDK still requires one
  forcePathStyle: true,
  credentials: {
    accessKeyId: requiredEnv('S3_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv('S3_SECRET_ACCESS_KEY')
  }
});

const REQUEST_TIMEOUT_MS = 10_000;

// Idempotent — safe to call on every backend startup. Swallows "already
// exists" so repeated boots don't fail; anything else propagates to the
// caller (see index.ts, which logs and degrades rather than crashing the
// whole backend over a non-critical-path dependency).
export async function ensureBucket(bucket: string): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return;
  } catch {
    // Doesn't exist (or a transient error) — fall through and try to
    // create it; a genuine connectivity problem will fail there too.
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }), {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    logger.info({ bucket }, 'object storage bucket created');
  } catch (err) {
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (code === 'BucketAlreadyOwnedByYou' || code === 'BucketAlreadyExists') return;
    throw err;
  }
}

export async function uploadObject(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }
  );
}

export interface StoredObject {
  stream: Readable;
  sizeBytes: number;
}

// Returns null for "doesn't exist" (a normal, expected outcome the caller
// turns into a 404) — every other failure propagates as a real error.
export async function getObject(bucket: string, key: string): Promise<StoredObject | null> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    return {
      stream: result.Body as Readable,
      sizeBytes: result.ContentLength ?? 0
    };
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw err;
  }
}
