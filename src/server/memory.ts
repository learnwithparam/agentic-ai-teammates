import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { ensureBucket } from "./s3";

// Memory: the third primitive. Each teammate has a folder of plain text files on S3 that
// outlives every run. It holds only what cannot be looked up again. Facts that live in
// QuirkBooks or LMail stay there. The four kinds follow the article's layout:
//
//   instructions.md         what a person wants this teammate to know. Read every run.
//   index.md                one line per note, so a run knows what it can look up. Read every run.
//   reported.md             what the teammate already told each person. Read every run.
//   notes/<topic>.md        one note per topic, such as vendor-v-007. Read when needed.
//   progress/<task>.md      where a task that spans runs got to. Read when needed.
//
// The gateway writes every file. index.md is kept by addLine itself, never by a model.

export const MEMORY_BUCKET = "teammates-memory";
export const INSTRUCTIONS = "instructions.md";
export const INDEX = "index.md";
export const REPORTED = "reported.md";
// The files a run reads before it starts. Everything else is read on demand.
export const ALWAYS_READ = [INSTRUCTIONS, INDEX, REPORTED] as const;
// A note keeps its newest lines. Older ones drop off, so a note never grows past what a prompt can hold.
export const NOTE_LINES = 30;
export const MAX_INSTRUCTIONS = 4000;

const TOPIC = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type MemoryScope = { company: string; teammate: string };

export function notePath(topic: string): string {
  if (!TOPIC.test(topic)) throw new Error(`"${topic}" is not a note name. Use lowercase letters, digits and dashes.`);
  return `notes/${topic}.md`;
}

export function progressPath(task: string): string {
  if (!TOPIC.test(task)) throw new Error(`"${task}" is not a task name. Use lowercase letters, digits and dashes.`);
  return `progress/${task}.md`;
}

// The topic for notes about one vendor, named by its QuirkBooks id. An invoice can claim any
// vendor name, so a note is only ever found through the vendor record QuirkBooks matched.
export function vendorTopic(vendorId: string): string {
  const topic = `vendor-${vendorId.toLowerCase()}`;
  notePath(topic);
  return topic;
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
    const { added, created } = await this.append(scope, path, line);
    // A new note gets one line in the index, so the next run knows it is there.
    if (created) await this.append(scope, INDEX, path);
    return { added };
  }

  // Adds one line to a task's progress file, once.
  async addProgress(scope: MemoryScope, task: string, line: string): Promise<{ added: boolean }> {
    return { added: (await this.append(scope, progressPath(task), line)).added };
  }

  // Records what was told to a person. The same thing told twice is refused, so the caller
  // can stay silent instead of repeating itself.
  async report(scope: MemoryScope, person: string, line: string): Promise<{ added: boolean }> {
    return { added: (await this.append(scope, REPORTED, `${person}: ${line}`)).added };
  }

  // Replaces a note's lines with a curated set. The weekly tidy calls this, after a person released it.
  async replaceNote(scope: MemoryScope, topic: string, lines: string[]) {
    const path = notePath(topic);
    const kept = [...new Set(lines.map(plainLine).filter(Boolean))].slice(-NOTE_LINES);
    await this.put(scope, path, kept.map((line) => `- ${line}`).join("\n") + (kept.length ? "\n" : ""));
  }

  private async append(scope: MemoryScope, path: string, line: string): Promise<{ added: boolean; created: boolean }> {
    const plain = plainLine(line);
    const existing = await this.read(scope, path);
    const lines = (existing ?? "").split("\n").filter((item) => item.startsWith("- "));
    if (lines.includes(`- ${plain}`)) return { added: false, created: false };
    await this.put(scope, path, [...lines, `- ${plain}`].slice(-NOTE_LINES).join("\n") + "\n");
    return { added: true, created: existing === null };
  }

  private async put(scope: MemoryScope, path: string, text: string) {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key(scope, path), Body: text, ContentType: "text/markdown; charset=utf-8" }));
  }
}

export const NOTE_PATH = /^notes\/[a-z0-9][a-z0-9-]{0,62}\.md$/;
export const PROGRESS_PATH = /^progress\/[a-z0-9][a-z0-9-]{0,62}\.md$/;

export function isMemoryPath(path: string): boolean {
  return (ALWAYS_READ as readonly string[]).includes(path) || NOTE_PATH.test(path) || PROGRESS_PATH.test(path);
}

function plainLine(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

function key(scope: MemoryScope, path: string): string {
  if (!isMemoryPath(path)) throw new Error(`"${path}" is not a memory file.`);
  for (const part of [scope.company, scope.teammate]) {
    if (!TOPIC.test(part)) throw new Error(`"${part}" cannot name a memory folder.`);
  }
  return `${scope.company}/${scope.teammate}/${path}`;
}
