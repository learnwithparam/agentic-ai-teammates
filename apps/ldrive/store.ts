import { createHash, randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Pool } from "pg";
import { inTransaction } from "../../src/server/db";
import { HttpError } from "../shared/server";
import type { WebhookSender } from "../shared/webhooks";

// Where LDrive keeps files: the bytes in S3, the rest in Postgres. Every add or removal is a
// row in the change log. A watcher keeps a page token, the id of the last change it read.
// It asks for the changes after it, as with Google Drive's changes.list.

export const BUCKET = "ldrive";
const CHANNEL_HOURS = 24;
const MAX_BYTES = 15 * 1024 * 1024;

export type DriveFile = {
  id: string;
  folderId: string;
  folder: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  trashed: boolean;
  createdAt: string;
};

export type Change = { changeId: string; kind: "added" | "removed"; file: DriveFile };

export class DriveStore {
  constructor(
    private readonly pool: Pool,
    private readonly s3: S3Client,
    private readonly webhooks: WebhookSender,
  ) {}

  async folders() {
    const { rows } = await this.pool.query<{ id: string; name: string; files: number }>(
      "SELECT f.id, f.name, (SELECT count(*) FROM files x WHERE x.folder_id = f.id AND NOT x.trashed)::int AS files FROM folders f ORDER BY f.name",
    );
    return rows;
  }

  async list(folderId: string): Promise<DriveFile[]> {
    const { rows } = await this.pool.query(`${FILE_QUERY} WHERE x.folder_id = $1 AND NOT x.trashed ORDER BY x.created_at DESC`, [folderId]);
    return rows.map(driveFile);
  }

  async get(id: string): Promise<DriveFile | null> {
    const { rows } = await this.pool.query(`${FILE_QUERY} WHERE x.id = $1`, [id]);
    return rows[0] ? driveFile(rows[0]) : null;
  }

  async upload(folderId: string, name: string, contentType: string, content: Buffer, uploadedBy: string): Promise<DriveFile> {
    if (content.length === 0) throw new HttpError(400, "The file is empty.");
    if (content.length > MAX_BYTES) throw new HttpError(413, "Files up to 15 MB only.");
    const { rowCount } = await this.pool.query("SELECT 1 FROM folders WHERE id = $1", [folderId]);
    if (rowCount !== 1) throw new HttpError(404, "No such folder.");
    const id = randomUUID();
    const objectKey = `files/${id}`;
    const sha256 = createHash("sha256").update(content).digest("hex");
    await this.s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: objectKey, Body: content, ContentType: contentType }));
    await inTransaction(this.pool, async (client) => {
      await client.query(
        "INSERT INTO files (id, folder_id, name, content_type, size, sha256, object_key, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [id, folderId, name, contentType, content.length, sha256, objectKey, uploadedBy],
      );
      await client.query("INSERT INTO changes (file_id, kind) VALUES ($1, 'added')", [id]);
    });
    await this.notify();
    return (await this.get(id))!;
  }

  async trash(id: string): Promise<void> {
    const file = await this.get(id);
    if (!file) throw new HttpError(404, "No such file.");
    if (file.trashed) return;
    await inTransaction(this.pool, async (client) => {
      await client.query("UPDATE files SET trashed = true WHERE id = $1", [id]);
      await client.query("INSERT INTO changes (file_id, kind) VALUES ($1, 'removed')", [id]);
    });
    const { rows } = await this.pool.query<{ object_key: string }>("SELECT object_key FROM files WHERE id = $1", [id]);
    await this.s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: rows[0].object_key }));
    await this.notify();
  }

  async content(id: string): Promise<{ file: DriveFile; bytes: Buffer }> {
    const file = await this.get(id);
    if (!file || file.trashed) throw new HttpError(404, "No such file.");
    const { rows } = await this.pool.query<{ object_key: string }>("SELECT object_key FROM files WHERE id = $1", [id]);
    const object = await this.s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: rows[0].object_key }));
    return { file, bytes: Buffer.from(await object.Body!.transformToByteArray()) };
  }

  // The token for "from now on": the id of the newest change.
  async startPageToken(): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>("SELECT coalesce(max(id), 0)::text AS id FROM changes");
    return rows[0].id;
  }

  async changes(pageToken: string, pageSize = 100): Promise<{ changes: Change[]; newStartPageToken?: string; nextPageToken?: string }> {
    const { rows } = await this.pool.query(
      `SELECT c.id AS change_id, c.kind, ${FILE_COLUMNS} FROM changes c JOIN files x ON x.id = c.file_id JOIN folders f ON f.id = x.folder_id
       WHERE c.id > $1 ORDER BY c.id LIMIT $2`,
      [pageToken, pageSize + 1],
    );
    const page = rows.slice(0, pageSize);
    const changes = page.map((row) => ({ changeId: String(row.change_id), kind: row.kind, file: driveFile(row) }));
    const last = changes.at(-1)?.changeId ?? pageToken;
    // Like Drive: a full page means there is more, the last page hands back the token to keep.
    return rows.length > pageSize ? { changes, nextPageToken: last } : { changes, newStartPageToken: last };
  }

  async watch(address: string, token: string, client: string) {
    const id = randomUUID();
    const { rows } = await this.pool.query<{ expires_at: Date }>(
      `INSERT INTO channels (id, address, token, client, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(hours => ${CHANNEL_HOURS}))
       RETURNING expires_at`,
      [id, address, token, client],
    );
    return { id, resourceId: "changes", expiration: rows[0].expires_at.toISOString() };
  }

  async stopChannel(id: string, client: string) {
    await this.pool.query("DELETE FROM channels WHERE id = $1 AND client = $2", [id, client]);
  }

  // One notice per live channel. Like Drive, the notice says only that something changed; the
  // watcher reads the change log to learn what.
  private async notify() {
    const { rows } = await this.pool.query<{ id: string; address: string; token: string; expires_at: Date; message_number: string }>(
      "UPDATE channels SET message_number = message_number + 1 WHERE expires_at > now() RETURNING id, address, token, expires_at, message_number",
    );
    for (const channel of rows) {
      await this.webhooks.enqueue({
        url: channel.address,
        type: "drive.changed",
        body: { kind: "drive#changes" },
        headers: {
          "X-Goog-Channel-ID": channel.id,
          "X-Goog-Channel-Token": channel.token,
          "X-Goog-Channel-Expiration": channel.expires_at.toUTCString(),
          "X-Goog-Resource-ID": "changes",
          "X-Goog-Resource-State": "change",
          "X-Goog-Message-Number": channel.message_number,
        },
      });
    }
  }
}

const FILE_COLUMNS = `x.id, x.folder_id, f.name AS folder, x.name, x.content_type, x.size, x.sha256, x.uploaded_by, x.trashed, x.created_at`;
const FILE_QUERY = `SELECT ${FILE_COLUMNS} FROM files x JOIN folders f ON f.id = x.folder_id`;

function driveFile(row: Record<string, unknown>): DriveFile {
  return {
    id: String(row.id),
    folderId: String(row.folder_id),
    folder: String(row.folder),
    name: String(row.name),
    contentType: String(row.content_type),
    size: Number(row.size),
    sha256: String(row.sha256),
    uploadedBy: String(row.uploaded_by),
    trashed: Boolean(row.trashed),
    createdAt: (row.created_at as Date).toISOString(),
  };
}
