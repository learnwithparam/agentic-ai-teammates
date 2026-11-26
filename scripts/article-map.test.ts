import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { lessonFiles } from "./lessons";

// docs/article-map.md ties each of the article's primitives to a lesson and a file. A renamed
// file, a new lesson with no row, or a primitive with no lesson fails here.

const ROOT = path.join(import.meta.dirname, "..");
const MAP = readFileSync(path.join(ROOT, "docs/article-map.md"), "utf8");
const PRIMITIVES = ["Inbox", "Timers", "Memory", "Permissions", "Outbox"];
const rows = MAP.split("\n").filter((line) => /^\| [A-Z]\w+ \| /.test(line) && !line.startsWith("| Primitive"));

test("every file the article map names exists", () => {
  const files = rows.flatMap((row) => [...row.matchAll(/`([\w./-]+)`/g)].map((match) => match[1]));
  assert.ok(files.length >= rows.length);
  assert.deepEqual(files.filter((file) => !existsSync(path.join(ROOT, file))), []);
});

test("the article map has every lesson and all five primitives", () => {
  const linked = new Set(rows.flatMap((row) => [...row.matchAll(/\]\(learner\/([^)]+)\)/g)].map((match) => `docs/learner/${match[1]}`)));
  const lessons = lessonFiles().map((file) => file.replace(/^\.\//, ""));
  assert.deepEqual(lessons.filter((file) => !linked.has(file)), []);
  assert.deepEqual([...linked].filter((file) => !lessons.includes(file)), []);
  const named = new Set(rows.map((row) => row.split("|")[1].trim()));
  assert.deepEqual(PRIMITIVES.filter((primitive) => !named.has(primitive)), []);
});
