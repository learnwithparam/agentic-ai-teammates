import type { Pool } from "pg";
import { DRIVE_API, googleClient, startCursor } from "./google";
import type { DriveFileInfo, FileSource } from "./types";

// Google Drive, through its REST API, for the one account the refresh token signs in as. It
// answers the same questions as LDrive. A file's folder is the name of its parent folder.

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  trashed?: boolean;
  parents?: string[];
  lastModifyingUser?: { emailAddress?: string };
};
type ChangePage = { changes: { removed?: boolean; file?: DriveFile }[]; nextPageToken?: string; newStartPageToken?: string };

const FILE_FIELDS = "id,name,mimeType,size,trashed,parents,lastModifyingUser(emailAddress)";

export class GoogleDrive implements FileSource {
  private readonly api;
  // Folder ids to names. A folder renamed while the gateway runs keeps its old name until restart.
  private readonly folders = new Map<string, string>();

  constructor(
    accessToken: () => Promise<string>,
    private readonly pool: Pool,
    // The subscriptions row for this account, such as gdrive:bramble.
    private readonly source: string,
    baseUrl = DRIVE_API,
  ) {
    this.api = googleClient("Google Drive", baseUrl, accessToken);
  }

  async startPageToken() {
    return (await this.api.json<{ startPageToken: string }>("changes/startPageToken")).startPageToken;
  }

  // Reads every page: follow nextPageToken until Drive gives newStartPageToken.
  async changes(pageToken: string) {
    let token = pageToken === "0" ? await startCursor(this.pool, this.source, "Google Drive") : pageToken;
    const added: DriveFileInfo[] = [];
    for (;;) {
      const query = new URLSearchParams({ pageToken: token, fields: `nextPageToken,newStartPageToken,changes(removed,file(${FILE_FIELDS}))` });
      const page = await this.api.json<ChangePage>(`changes?${query}`);
      for (const change of page.changes) {
        if (!change.removed && change.file && !change.file.trashed) added.push(await this.info(change.file));
      }
      if (page.newStartPageToken) return { added, nextToken: page.newStartPageToken };
      token = page.nextPageToken!;
    }
  }

  async content(fileId: string) {
    const id = encodeURIComponent(fileId);
    const file = await this.api.json<DriveFile>(`files/${id}?${new URLSearchParams({ fields: FILE_FIELDS })}`);
    const response = await this.api.call(`files/${id}?alt=media`);
    if (!response.ok) throw await this.api.failure(response);
    return { file: await this.info(file), bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  // Drive needs both the channel id and the resource id to stop a channel, so both are kept.
  async watch(hooksAddress: string, token: string) {
    const query = new URLSearchParams({ pageToken: await this.startPageToken() });
    const channel = await this.api.json<{ id: string; resourceId: string; expiration: string }>(`changes/watch?${query}`, {
      method: "POST",
      body: JSON.stringify({ id: crypto.randomUUID(), type: "web_hook", address: hooksAddress, token }),
    });
    return { channelId: `${channel.id}/${channel.resourceId}`, expiration: new Date(Number(channel.expiration)).toISOString() };
  }

  async stopWatch(channelId: string) {
    const [id, resourceId] = channelId.split("/");
    const response = await this.api.call("channels/stop", { method: "POST", body: JSON.stringify({ id, resourceId }) });
    if (!response.ok) throw await this.api.failure(response);
  }

  private async info(file: DriveFile): Promise<DriveFileInfo> {
    return {
      id: file.id,
      name: file.name,
      folder: file.parents?.[0] ? await this.folderName(file.parents[0]) : "",
      contentType: file.mimeType,
      size: Number(file.size ?? 0),
      uploadedBy: file.lastModifyingUser?.emailAddress?.toLowerCase() ?? "",
    };
  }

  private async folderName(folderId: string): Promise<string> {
    const known = this.folders.get(folderId);
    if (known !== undefined) return known;
    const folder = await this.api.json<{ name: string }>(`files/${encodeURIComponent(folderId)}?fields=name`);
    this.folders.set(folderId, folder.name);
    return folder.name;
  }
}
