import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ensureBucket } from "./s3";

// Memory: the third primitive. Each teammate has a folder of plain text files on S3 that
// outlives every run. It holds only what cannot be looked up again: a person's instructions,
// and notes about past decisions. Facts that live in QuirkBooks or LMail stay there.
//
//   <company>/<teammate>/instructions.md      what a person wants this teammate to know, read each run
//   <company>/<teammate>/notes/<topic>.md      one note per topic, such as vendor-lumen-print-house

export const MEMORY_BUCKET = "teammates-memory";
export const INSTRUCTIONS = "instructions.md";
// A note keeps its newest lines. Older ones drop off, so a note never grows past what a prompt can hold.
export const NOTE_LINES = 30;
export const MAX_INSTRUCTIONS = 4000;

const TOPIC = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type MemoryScope = { company: string; teammate: string };

export function notePath(topic: string): string {
  if (!TOPIC.test(topic)) throw new Error(`"${topic}" is not a note name. Use lowercase letters, digits and dashes.`);
  return `notes/${topic}.md`;
}

// The topic for notes about one vendor: its name in lowercase, with dashes between words.
export function vendorTopic(vendorName: string): string {
  // Accents come off first, so "Ünder" becomes "under" and not "u-nder".
  const plain = vendorName.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const slug = plain.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 55);
  return `vendor-${slug || "unnamed"}`;
}

export class Memory {
  // The tests pass their own bucket, so they never touch a teammate's real memory.
  constructor(
    private readonly s3: S3Client,
    private readonly bucket = MEMORY_BUCKET,
  ) {}

  async ready() {
    await ensureBucket(this.s3, this.bucket);
  }

  // The text of a file, or null when the teammate has none yet.
  async read(scope: MemoryScope, path: string): Promise<string | null> {
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key(scope, path) }));
      return (await object.Body?.transformToString("utf8")) ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async setInstructions(scope: MemoryScope, text: string) {
    if (text.length > MAX_INSTRUCTIONS) throw new Error(`Instructions can be at most ${MAX_INSTRUCTIONS} characters.`);
    await this.put(scope, INSTRUCTIONS, text);
  }

  // Adds one line to a note, once. The same line again changes nothing, so a retried run never
  // writes it twice. One worker runs a teammate at a time, so two runs never write one note at once.
  async addLine(scope: MemoryScope, topic: string, line: string): Promise<{ added: boolean }> {
    const path = notePath(topic);
    const plain = line.replace(/\s+/g, " ").trim();
    const lines = ((await this.read(scope, path)) ?? "").split("\n").filter((existing) => existing.startsWith("- "));
    if (lines.includes(`- ${plain}`)) return { added: false };
    await this.put(scope, path, [...lines, `- ${plain}`].slice(-NOTE_LINES).join("\n") + "\n");
    return { added: true };
  }

  private async put(scope: MemoryScope, path: string, text: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key(scope, path), Body: text, ContentType: "text/markdown; charset=utf-8" }));
  }
}

export const NOTE_PATH = /^notes\/[a-z0-9][a-z0-9-]{0,62}\.md$/;

function key(scope: MemoryScope, path: string): string {
  if (path !== INSTRUCTIONS && !NOTE_PATH.test(path)) throw new Error(`"${path}" is not a memory file.`);
  for (const part of [scope.company, scope.teammate]) {
    if (!TOPIC.test(part)) throw new Error(`"${part}" cannot name a memory folder.`);
  }
  return `${scope.company}/${scope.teammate}/${path}`;
}
