import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function isS3Configured(): boolean {
  return !!(process.env.AWS_REGION && getS3Bucket());
}

let _s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!_s3Client) {
    _s3Client = new S3Client({
      region: process.env.AWS_REGION!,

    });
  }
  return _s3Client;
}

// Returns a presigned PUT URL valid for 5 minutes — browser uploads directly to S3
export async function createPresignedUploadUrl({
  key,
  contentType,
  fileSize,
}: {
  key: string;
  contentType: string;
  fileSize: number;
}): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: getS3Bucket(),
    Key: key,
    ContentType: contentType,
    ContentLength: fileSize,
    IfNoneMatch: "*",
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: 300, signableHeaders: new Set(["content-type", "content-length", "if-none-match"]) });
}

// Returns a presigned GET URL valid for 1 hour — for temporary playback
export async function createPresignedDownloadUrl(key: string): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: getS3Bucket(),
    Key: key,
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: 300 });
}

export function getS3Bucket(): string {
  return process.env.S3_VIDEO_BUCKET || process.env.AWS_S3_BUCKET || "";
}

export async function inspectUploadedObject(key: string) {
  const head = await getS3Client().send(new HeadObjectCommand({ Bucket: getS3Bucket(), Key: key }));
  const sample = await getS3Client().send(new GetObjectCommand({ Bucket: getS3Bucket(), Key: key, Range: "bytes=0-31" }));
  return { size: head.ContentLength, type: head.ContentType, bytes: await sample.Body?.transformToByteArray() };
}
