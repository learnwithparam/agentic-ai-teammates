// npm run check runs this: the code must read like plain English.
//
// Names are whole words, comments are short sentences in everyday words, and a line of code
// does not chain too many steps. It reads every .ts and .tsx file in the repo. Files the shadcn and assistant-ui CLIs write (components/ui/ and
// components/assistant-ui/) are skipped: the CLI owns them, and `npx shadcn add` rewrites them.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LONGEST_SENTENCE = 25;
const MOST_CALLS_IN_ONE_LINE = 5;
const CLI_FOLDERS = ["components/ui", "components/assistant-ui", "node_modules", "dist"];

const SHORT_NAMES_THAT_ARE_FINE = ["i", "id", "ok", "ui", "cn", "db", "to", "at", "on", "up"];
const ABBREVIATIONS = ["ctx", "cfg", "tmp", "res", "req", "resp", "obj", "arr", "val", "str", "num"];
const ABBREVIATIONS_2 = ["idx", "cnt", "msg", "fn", "cb", "evt", "buf", "acc", "elem", "mgr", "svc"];
const HARD_WORDS = ["utilize", "facilitate", "commence", "subsequently", "approximately", "prior to", "leverage"];

export type Problem = { file: string; line: number; message: string };

// Remove the text inside quotes so a "?" in a message is not mistaken for code.
function withoutStrings(line: string): string {
  return line
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function isComment(line: string): boolean {
  return line.trim().startsWith("//");
}

function namesDeclaredOn(line: string): string[] {
  const names: string[] = [];
  const patterns = [
    /\b(?:const|let|function|type|interface|class)\s+([A-Za-z_$][\w$]*)/g,
    /\bfor\s*\((?:const|let)\s+([A-Za-z_]\w*)\s+(?:in|of)\b/g,
    /\(([A-Za-z_$][\w$]*)\)\s*=>/g,
  ];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) names.push(match[1]);
  }
  return names;
}

function nameProblem(name: string): string | undefined {
  if (name.startsWith("_")) return undefined;
  if (ABBREVIATIONS.includes(name) || ABBREVIATIONS_2.includes(name)) return `"${name}" is an abbreviation; write the whole word`;
  if (name.length <= 2 && !SHORT_NAMES_THAT_ARE_FINE.includes(name)) return `"${name}" is too short; name what it holds in a whole word`;
  return undefined;
}

function sentenceProblems(text: string): string[] {
  const problems: string[] = [];
  for (const sentence of text.split(/[.!?:;]\s/)) {
    const words = sentence.split(/\s+/).filter((word) => word.length > 0);
    if (words.length > LONGEST_SENTENCE) problems.push(`sentence has ${words.length} words; keep it under ${LONGEST_SENTENCE + 1}`);
  }
  for (const word of HARD_WORDS) {
    if (text.toLowerCase().includes(word)) problems.push(`"${word}" is a hard word; use a simpler one`);
  }
  return problems;
}

// A comment block is read as one paragraph, so a sentence that wraps over lines is one sentence.
export function problemsIn(file: string, text: string): Problem[] {
  const problems: Problem[] = [];
  const lines = text.split("\n");
  let paragraph: string[] = [];
  let paragraphStart = 0;
  const closeParagraph = () => {
    for (const message of sentenceProblems(paragraph.join(" "))) problems.push({ file, line: paragraphStart + 1, message });
    paragraph = [];
  };
  for (const [index, line] of lines.entries()) {
    if (isComment(line)) {
      const words = line.trim().slice(2).trim();
      if (paragraph.length === 0) paragraphStart = index;
      if (words === "") closeParagraph();
      else paragraph.push(words);
      continue;
    }
    closeParagraph();
    const code = withoutStrings(line);
    for (const name of namesDeclaredOn(code)) {
      const message = nameProblem(name);
      if (message) problems.push({ file, line: index + 1, message });
    }
    if ((code.match(/\.\w+\(/g) || []).length > MOST_CALLS_IN_ONE_LINE) problems.push({ file, line: index + 1, message: "too many steps on one line; name a step" });
  }
  closeParagraph();
  return problems;
}

// Every .ts and .tsx file git tracks or would track, so a new app folder is read the day it lands.
function sourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  return listed
    .split("\n")
    .filter((path) => /\.tsx?$/.test(path) && !path.endsWith(".d.ts"))
    .filter((path) => !CLI_FOLDERS.some((skip) => path.includes(`${skip}/`)));
}

function main() {
  const problems: Problem[] = [];
  for (const path of sourceFiles()) problems.push(...problemsIn(path, readFileSync(path, "utf8")));
  for (const problem of problems) console.error(`${problem.file}:${problem.line}: ${problem.message}`);
  if (problems.length > 0) {
    console.error(`${problems.length} readability problems.`);
    process.exit(1);
  }
  console.log("readable: the code reads like plain English.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
