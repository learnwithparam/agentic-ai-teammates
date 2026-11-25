import { randomBytes } from "node:crypto";
import { DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { Memory } from "./memory";
import { createS3 } from "./s3";

// The tests run against the real S3 from npm run setup: MinIO. Each test file gets its own bucket,
// emptied and removed at the end, so a test never reads or writes a teammate's real memory.
export async function testMemory(): Promise<{ memory: Memory; close: () => Promise<void> }> {
  const storage = createS3();
  const bucket = `test-memory-${randomBytes(6).toString("hex")}`;
  const memory = new Memory(storage, bucket);
  await memory.ready();
  const close = async () => {
    const { Contents = [] } = await storage.send(new ListObjectsV2Command({ Bucket: bucket }));
    if (Contents.length) await storage.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: Contents.map((item) => ({ Key: item.Key! })) } }));
    await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
    storage.destroy();
  };
  return { memory, close };
}
