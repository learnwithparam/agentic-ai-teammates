import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import type { Card } from "./tools";
import { ensureBucket } from "./s3";

// Keeps each company's news editions on S3, where Mission Control serves them at /news/.
// This is the default place news goes. It needs no account beyond the stack's own storage.
//
//   <company>/<day>.json     one edition per day
//   <company>/today.json     the newest edition
//   <company>/days.json      the list of days, newest first

export type Edition = { day: string; publishedAt: string; cards: Card[] };

// Where an edition goes: this shelf, or a GitHub repo whose Pages site shows it.
export type NewsPublisher = { publish(company: string, edition: Edition): Promise<{ url: string; commit?: string | null }> };

export const NEWS_BUCKET = "teammates-news";
export const NEWS_FILE = /^(today|days|\d{4}-\d{2}-\d{2})\.json$/;
const Days = z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

export class NewsShelf implements NewsPublisher {
  // The tests pass their own bucket, so they never touch a company's real editions.
  constructor(
    private readonly s3: S3Client,
    private readonly appUrl: string,
    private readonly bucket = NEWS_BUCKET,
  ) {}

  async ready() {
    await ensureBucket(this.s3, this.bucket);
  }

  // The file's text, or null when there is none yet.
  async read(company: string, file: string): Promise<string | null> {
    if (!NEWS_FILE.test(file)) return null;
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: `${company}/${file}` }));
      return (await object.Body?.transformToString("utf8")) ?? null;
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  // Writes the day's edition, then today.json and the list of days. Publishing the same day
  // again replaces that day and lists it once.
  async publish(company: string, edition: Edition): Promise<{ url: string }> {
    const listed = await this.read(company, "days.json");
    const days = [...new Set([...(listed ? Days.parse(JSON.parse(listed)) : []), edition.day])].sort().reverse();
    await this.put(company, `${edition.day}.json`, edition);
    if (days[0] === edition.day) await this.put(company, "today.json", edition);
    await this.put(company, "days.json", days);
    return { url: `${this.appUrl}/news/?day=${edition.day}` };
  }

  private async put(company: string, file: string, value: unknown) {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: `${company}/${file}`, Body: `${JSON.stringify(value, null, 2)}\n`, ContentType: "application/json" }),
    );
  }
}
