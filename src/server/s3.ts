import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { setting } from "./env";

// One S3 client for LDrive's files and the teammates' memory: MinIO here, R2 or S3 in production.
export function createS3(): S3Client {
  return new S3Client({
    endpoint: setting("S3_ENDPOINT"),
    region: setting("S3_REGION"),
    credentials: { accessKeyId: setting("S3_ACCESS_KEY_ID"), secretAccessKey: setting("S3_SECRET_ACCESS_KEY") },
    // MinIO and R2 serve buckets as a path, not as a subdomain.
    forcePathStyle: true,
  });
}

export async function ensureBucket(s3: S3Client, bucket: string) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
