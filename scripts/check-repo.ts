// Fails when the repo ships a file or an npm script that nothing uses. Also fails when code
// names a repo path that does not exist, or a dependency has no exact version. Last, app code
// must keep the production rules below.
//
// Used means reachable. Every tracked text file outside the watched folders is a root. A watched
// file becomes used when a used file of the right kind names it as a whole path token.
// The kinds are listed here.
//   data/          read by code (.ts, .tsx, package.json).
//   scripts/       called by code, package.json, a workflow or a shell script.
// Comments in code do not count. An npm script is used when a doc shows `npm run <name>` as code,
// or another npm script calls it.
//
// The production rules, for every file under src/, apps/ and news/src/:
//   - No stand-in words (mock, fake, fallback, canned, stub, dummy). A teammate that pretends to
//     work teaches nothing; a missing key stops the process instead.
//   - process.env is read only in src/server/env.ts, so every setting has one place, and a missing
//     one fails there with its name.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { fileURLToPath } from "node:url";

const CODE = /\.(ts|tsx|mjs|js|sh|ya?ml)$|^package\.json$/;
const RULES: Array<{ folder: string; usedBy: RegExp }> = [
  { folder: "data/", usedBy: /\.(ts|tsx)$|^package\.json$/ },
  { folder: "scripts/", usedBy: /\.(ts|sh|ya?ml)$|^package\.json$/ },
];
// Scripts people run by habit, never named in a lesson.
const ENTRY_SCRIPTS = new Set(["dev", "build", "start", "typecheck", "check", "prepare"]);
const APP_CODE = /^(src|apps|news\/src)\//;
const STAND_IN_WORDS = /\b(mock(s|ed|ing)?|fake[sd]?|fallbacks?|canned|stubs?|stubbed|dummy)\b/i;
const ENV_FILE = "src/server/env.ts";
const TEXT = /\.(ts|tsx|mjs|js|md|json|ya?ml|sh|html|css)$/;

function stripComments(path: string, body: string): string {
  if (/\.(ts|tsx|mjs|js)$/.test(path)) return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  if (/\.(sh|ya?ml)$/.test(path)) return body.replace(/(^|\s)#.*$/gm, "$1");
  return body;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function names(body: string, token: string): boolean {
  return new RegExp(`(^|[^\\w.-])${escape(token)}(?![\\w-]|\\.\\w)`, "m").test(body);
}

// The code a markdown file shows: fenced blocks and inline code spans.
function codeIn(markdown: string): string {
  const fenced = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const inline = [...markdown.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...fenced, ...inline].join("\n");
}

function unusedFiles(files: Map<string, string>, bodies: Map<string, string>, tracked: string[]): string[] {
  const ruleFor = (path: string) => RULES.find((rule) => path.startsWith(rule.folder));
  const used = new Set(tracked.filter((path) => !ruleFor(path)));
  // `npm run check` runs tests by glob ('scripts/**/*.test.ts'), so a test under a glob folder is in use.
  const testFolders = [...(files.get("package.json") ?? "").matchAll(/'([\w/-]+)\/\*\*\/\*\.test\.ts'/g)].map((match) => `${match[1]}/`);
  for (const path of tracked) if (path.endsWith(".test.ts") && testFolders.some((folder) => path.startsWith(folder))) used.add(path);
  const tokensFor = (path: string) => {
    const tokens = [path, basename(path)];
    if (path.endsWith(".ts")) tokens.push(`./${basename(path, ".ts")}`, path.slice(0, -3));
    return tokens;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const path of tracked) {
      const rule = ruleFor(path);
      if (!rule || used.has(path)) continue;
      const reached = [...used].some(
        (user) => user !== path && rule.usedBy.test(basename(user)) && tokensFor(path).some((token) => names(bodies.get(user) ?? "", token)),
      );
      if (reached) {
        used.add(path);
        grew = true;
      }
    }
  }
  return tracked.filter((path) => ruleFor(path) && !used.has(path)).map((path) => `${path}: nothing in use reads, links or calls it. Use it or delete it.`);
}

function missingPaths(bodies: Map<string, string>, tracked: string[]): string[] {
  const problems: string[] = [];
  const known = new Set(tracked.flatMap((path) => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  for (const [path, body] of bodies) {
    // Test fixtures name made-up paths on purpose.
    if (!CODE.test(basename(path)) || path.endsWith(".test.ts")) continue;
    for (const match of body.matchAll(/["'`]((?:\.\.?\/)*(?:scripts|data|docs|src|apps|infra|news)\/[\w./-]+)["'`]/g)) {
      const raw = match[1];
      const target = raw.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), raw)) : raw;
      const clean = target.replace(/\/$/, "");
      const exists = ["", ".ts", ".tsx", ".json", "/index.ts"].some((ending) => known.has(clean + ending));
      if (!exists) problems.push(`${path}: names ${raw}, which does not exist.`);
    }
  }
  return problems;
}

function manifestProblems(files: Map<string, string>): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(files.get("package.json") ?? "{}");
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries<string>(manifest[field] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`package.json ${field} "${name}" is "${version}". Pin an exact version.`);
    }
  }
  // The Node version lives in package.json engines. CI reads it from there; the README quotes it.
  const node = manifest.engines?.node;
  const readme = files.get("README.md");
  if (readme !== undefined && !readme.includes(`Node \`${node}\``)) problems.push(`README.md: does not name the Node version from package.json engines (${node}).`);
  const scripts: Record<string, string> = manifest.scripts ?? {};
  const shown = [...files].filter(([path]) => path.endsWith(".md")).map(([, body]) => codeIn(body)).join("\n");
  const calls = Object.values(scripts).join("\n");
  for (const name of Object.keys(scripts)) {
    if (ENTRY_SCRIPTS.has(name)) continue;
    const token = escape(name);
    const named = new RegExp(`npm run ${token}(?![\\w:-])`).test(shown);
    const called = new RegExp(`npm(:| run )${token}(?![\\w:-])`).test(calls);
    if (!named && !called) problems.push(`package.json script "${name}": no doc shows it and no script calls it.`);
  }
  return problems;
}

// The production rules. Comments count here too: a comment that promises a stand-in is a claim.
function productionProblems(files: Map<string, string>, bodies: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, body] of files) {
    if (!APP_CODE.test(path) || path.endsWith(".test.ts")) continue;
    const word = STAND_IN_WORDS.exec(body);
    if (word) problems.push(`${path}: says "${word[0]}". App code does the real thing or stops with a clear error.`);
    if (path !== ENV_FILE && /\bprocess\.env\b/.test(bodies.get(path) ?? "")) {
      problems.push(`${path}: reads process.env. Settings are read only in ${ENV_FILE}.`);
    }
  }
  return problems;
}

// Docker Compose names a project after its folder when the file has no name. Two folders called
// langfuse then share one project, and starting one replaces the other's containers.
function composeProblems(files: Map<string, string>): string[] {
  const problems: string[] = [];
  for (const [path, body] of files) {
    if (!/(^|\/)docker-compose\.ya?ml$/.test(path)) continue;
    if (!/^name: teammates-[a-z-]+$/m.test(body)) problems.push(`${path}: has no "name: teammates-..." line, so it shares a project with any folder of the same name.`);
  }
  return problems;
}

export function findProblems(files: Map<string, string>, tracked: string[]): string[] {
  const bodies = new Map([...files].map(([path, body]) => [path, stripComments(path, body)]));
  const fileProblems = [...unusedFiles(files, bodies, tracked), ...missingPaths(bodies, tracked)];
  return [...fileProblems, ...manifestProblems(files), ...productionProblems(files, bodies), ...composeProblems(files)];
}

function main() {
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const files = new Map(
    tracked.filter((path) => TEXT.test(path) && path !== "package-lock.json").map((path) => [path, readFileSync(path, "utf8")]),
  );
  const problems = findProblems(files, tracked);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("check-repo: every watched file and npm script is in use, every named path exists, every dependency is pinned, app code has no stand-ins and reads settings in one place, every compose file has its own project name");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
