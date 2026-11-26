// Every lesson page in docs/learner has the same shape, and what it promises is real.
// The headings come in one order.
// "How it works" has a sequence diagram that shows a failure, not only the happy path.
// "Break it" names a code file and a test (file and title) that exist.
// So the guard it asks you to remove and the test that catches it cannot drift from the code.
// Every image is there, every diagram renders, and the README links each lesson once by its title.
// Rendering uses mmdc: npm i -g @mermaid-js/mermaid-cli@11.6.0
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const LESSONS = "docs/learner";

export const SHAPE = ["## Why", "## Goal", "## Starting point", "## How it works", "## Run it", "## Break it", "## What you have now"];

// Headings outside code blocks: a "## Heading" inside a fenced sample is not one.
export function headingsOf(markdown: string): string[] {
  let inFence = false;
  const found: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && /^#{1,3} /.test(line)) found.push(line.trim());
  }
  return found;
}

// The text under a "## " heading, up to the next "## ".
export function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return "";
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

export function mermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

// A failure path: an alt, else or break block, or a message that refuses, holds or fails.
const FAILURE = /\b(refus\w*|den(y|ied)|reject\w*|fail\w*|held|hold\w*|stop\w*|waits?|401|403|422|timeout|cannot)\b/i;
export function hasFailurePath(block: string): boolean {
  return /^\s*(alt|else|break)\b/m.test(block) || block.split("\n").some((line) => /->>|-->>|-x|--x/.test(line) && FAILURE.test(line));
}

// "Break it" names the file to change in backticks, and the test as `path.test.ts` then "its title".
export function breakItProblems(file: string, section: string, read: (path: string) => string | null): string[] {
  const problems: string[] = [];
  const paths = [...section.matchAll(/`([\w./-]+\.tsx?)`/g)].map((match) => match[1]);
  const code = paths.filter((path) => !path.endsWith(".test.ts"));
  const tests = paths.filter((path) => path.endsWith(".test.ts"));
  if (!code.length) problems.push(`${file}: "Break it" must name the file you change, in backticks`);
  if (!tests.length) problems.push(`${file}: "Break it" must name the test file that catches it, in backticks`);
  for (const path of paths) if (read(path) === null) problems.push(`${file}: "Break it" names ${path}, which does not exist`);
  // The line it tells you to find must still be in a file it names, or the next refactor breaks the step silently.
  for (const [, snippet] of section.matchAll(/\bfind `([^`\n]+)`/g)) {
    if (!code.some((path) => (read(path) ?? "").includes(snippet))) problems.push(`${file}: "Break it" says to find \`${snippet}\`, which no named file holds`);
  }
  const titles = [...section.matchAll(/"([^"\n]{12,})"/g)].map((match) => match[1]);
  if (!titles.length) problems.push(`${file}: "Break it" must quote the title of the test that fails`);
  for (const title of titles) {
    const found = tests.some((path) => (read(path) ?? "").includes(`"${title}"`));
    if (!found) problems.push(`${file}: "Break it" quotes the test "${title}", which no named test file holds`);
  }
  return problems;
}

// Every bash block is followed by an "Expect:" line, so the reader knows what success looks like.
export function expectProblems(file: string, page: string): string[] {
  const lines = page.split("\n");
  return lines.flatMap((line, index) => {
    if (line.trim() !== "```bash") return [];
    const close = lines.findIndex((next, at) => at > index && next.trim() === "```");
    const after = lines.slice(close + 1).find((next) => next.trim() !== "");
    return after?.startsWith("Expect:") ? [] : [`${file}: the bash block on line ${index + 1} needs an "Expect:" line after it`];
  });
}

export function shapeProblems(file: string, page: string, read: (path: string) => string | null): string[] {
  const problems: string[] = [];
  problems.push(...expectProblems(file, page));
  const headings = headingsOf(page);
  if (!(headings[0] ?? "").startsWith("# ")) problems.push(`${file}: the first heading must be "# <what you can do after it>"`);
  const shaped = headings.filter((line) => SHAPE.includes(line));
  if (shaped.join("|") !== SHAPE.join("|")) problems.push(`${file}: the "## " headings must be, in order: ${SHAPE.map((h) => h.slice(3)).join(", ")}`);
  if (!mermaidBlocks(sectionOf(page, "## How it works")).some((block) => block.trim().startsWith("sequenceDiagram"))) {
    problems.push(`${file}: "How it works" needs a sequence diagram of one real event`);
  }
  for (const block of mermaidBlocks(page)) {
    if (block.trim().startsWith("sequenceDiagram") && !hasFailurePath(block)) problems.push(`${file}: a sequence diagram shows only the happy path; draw a refusal or failure too`);
  }
  problems.push(...breakItProblems(file, sectionOf(page, "## Break it"), read));
  for (const [, src] of page.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (!/^https?:/.test(src) && read(join(dirname(file), src)) === null) problems.push(`${file}: image ${src} does not exist`);
  }
  return problems;
}

// The README's lesson table is the one list of lessons: each lesson linked once, by its own title.
export function readmeProblems(readme: string, pages: Array<{ file: string; page: string }>): string[] {
  const problems: string[] = [];
  for (const { file, page } of pages) {
    const title = (headingsOf(page)[0] ?? "").replace(/^# /, "");
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const links = [...readme.matchAll(new RegExp(`\\[([^\\]]+)\\]\\(\\./${escaped}\\)`, "g"))];
    if (links.length !== 1) problems.push(`README.md: links ${file} ${links.length} times; link it once in the lesson table`);
    else if (links[0][1] !== title) problems.push(`README.md: ${file} is linked as "${links[0][1]}", but its title is "${title}"`);
  }
  return problems;
}

const PUPPETEER = join(import.meta.dirname, "mermaid-puppeteer.json");

function renderProblems(file: string, page: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "mmd-"));
  return mermaidBlocks(page).flatMap((source, index) => {
    const input = join(dir, `block-${index + 1}.mmd`);
    writeFileSync(input, source);
    try {
      execFileSync("mmdc", ["-q", "-p", PUPPETEER, "-i", input, "-o", join(dir, `block-${index + 1}.svg`)], { stdio: "pipe" });
      return [];
    } catch (error) {
      const detail = String((error as { stderr?: Buffer }).stderr ?? (error as Error).message).split("\n").find((line) => line.trim()) ?? "render failed";
      return [`${file}: diagram ${index + 1} does not render: ${detail.trim()}`];
    }
  });
}

export function lessonFiles(): string[] {
  return readdirSync(LESSONS).filter((name) => name.endsWith(".md")).sort().map((name) => `${LESSONS}/${name}`);
}

const readIfThere = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

if (import.meta.main) {
  try {
    execFileSync("mmdc", ["--version"], { stdio: "pipe" });
  } catch {
    console.error("mmdc is not installed. Run: npm i -g @mermaid-js/mermaid-cli@11.6.0");
    process.exit(1);
  }
  const pages = lessonFiles().map((file) => ({ file, page: readFileSync(file, "utf8") }));
  const problems = [
    ...(pages.length ? [] : [`${LESSONS} has no lesson pages`]),
    ...pages.flatMap(({ file, page }) => [...shapeProblems(file, page, readIfThere), ...renderProblems(file, page)]),
    ...readmeProblems(readFileSync("README.md", "utf8"), pages),
  ];
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`${problems.length} lesson problems.`);
    process.exit(1);
  }
  console.log(`Every lesson has its shape, its diagrams and a real test to break: ${pages.length} pages.`);
}
