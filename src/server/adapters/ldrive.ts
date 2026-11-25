import type { DriveFileInfo, FileSource } from "./types";
import { serviceClient } from "./http";

// LDrive, through its program API, with Mission Control's read-only key.

type LDriveFile = DriveFileInfo & { trashed: boolean };
type ChangePage = { changes: { kind: "added" | "removed"; file: LDriveFile }[]; nextPageToken?: string; newStartPageToken?: string };

export class LDrive implements FileSource {
  private readonly service;

  constructor(baseUrl: string, apiKey: string) {
    this.service = serviceClient("LDrive", baseUrl, apiKey);
  }

  async startPageToken() {
    return (await this.service.json<{ startPageToken: string }>("/api/v1/changes/startPageToken")).startPageToken;
  }

  // Reads every page, as Drive's changes.list asks: follow nextPageToken until newStartPageToken.
  async changes(pageToken: string) {
    const added: DriveFileInfo[] = [];
    let token = pageToken;
    for (;;) {
      const page = await this.service.json<ChangePage>(`/api/v1/changes?pageToken=${encodeURIComponent(token)}`);
      for (const change of page.changes) {
        if (change.kind === "added" && !change.file.trashed) added.push(fileInfo(change.file));
      }
      if (page.newStartPageToken) return { added, nextToken: page.newStartPageToken };
      token = page.nextPageToken!;
    }
  }

  async content(fileId: string) {
    const file = await this.service.json<LDriveFile>(`/api/v1/files/${encodeURIComponent(fileId)}`);
    const { bytes } = await this.service.bytes(`/api/v1/files/${encodeURIComponent(fileId)}/content`);
    return { file: fileInfo(file), bytes };
  }

  async watch(hooksAddress: string, token: string) {
    const channel = await this.service.json<{ id: string; expiration: string }>("/api/v1/changes/watch", {
      method: "POST",
      body: JSON.stringify({ address: hooksAddress, token }),
    });
    return { channelId: channel.id, expiration: channel.expiration };
  }

  async stopWatch(channelId: string) {
    const response = await this.service.call(`/api/v1/channels/${encodeURIComponent(channelId)}/stop`, { method: "POST" });
    if (!response.ok) throw await this.service.failure(response);
  }
}

function fileInfo(file: LDriveFile): DriveFileInfo {
  const { id, name, folder, contentType, size, uploadedBy } = file;
  return { id, name, folder, contentType, size, uploadedBy };
}
