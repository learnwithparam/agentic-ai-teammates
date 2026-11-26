// Fails when the repo ships a file or an npm script that nothing uses. Also fails when code
// names a repo path that does not exist, or a dependency has no exact version. Last, app code
// must keep the production rules below.
//
// Used means reachable. Every tracked text file outside the watched folders is a root. A watched
// file becomes used when a used file of the right kind names it as a whole path token.
// The kinds are listed here.
//   data/          read by code (.ts, .tsx, package.json), by path or by name without its extension.
//   scripts/       called by code, package.json, a workflow or a shell script.
// Comments in code do not count. An npm script is used when a doc shows `npm run <name>` as code,
// or another npm script calls it.
//
// The production rules, for every file under src/, apps/ and news/src/:
//   - No stand-in words (mock, fake, fallback, canned, stub, dummy). A teammate that pretends to
//     work teaches nothing; a missing key stops the process instead.
//   - process.env is read only in src/server/env.ts, so every setting has one place, and a missing
//     one fails there with its name.
//   - A colour is written only in src/client/styles/app.css. Every page then keeps one palette, and
//     the contrast checked there holds everywhere. The shadcn CLI's own files are left out: its chart
//     names Recharts' built-in greys only to find and restyle them.
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
const CLI_FOLDER = "src/client/components/ui/";
const COLOUR_FILE = "src/client/styles/app.css";
const COLOUR = /#[0-9a-f]{3,8}\b|\b(rgba?|hsla?|oklch)\(/i;
const TEXT = /\.(ts|tsx|mjs|js|md|json|ya?ml|sh|html|css)$|^\.node-version$|^\.githooks\/pre-push$/;
const NODE_PIN = ".node-version";
const PRE_PUSH = ".githooks/pre-push";
const HOOKS_ON = "git config core.hooksPath .githooks";
const WORKFLOW = /^\.github\/workflows\/.+\.ya?ml$/;

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
    // A generated data file is named by its case id, such as "01-northwind-paper" in cases.ts.
    if (path.startsWith("data/")) tokens.push(posix.parse(path).name);
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

// Folders a build writes, so git never tracks them. Code may name them.
const BUILT = ["news/dist"];

function missingPaths(bodies: Map<string, string>, tracked: string[]): string[] {
  const problems: string[] = [];
  const known = new Set([...BUILT, ...tracked].flatMap((path) => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  for (const [path, body] of bodies) {
    // Test fixtures name made-up paths on purpose.
    if (!CODE.test(basename(path)) || path.endsWith(".test.ts")) continue;
    // The news page names web addresses next to itself, such as data/today.json, not repo paths.
    if (path.startsWith("news/src/")) continue;
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
  // The news page is its own package, built by the Pages workflow, so its versions are pinned too.
  for (const path of ["package.json", "news/package.json"]) {
    const pinned = JSON.parse(files.get(path) ?? "{}");
    for (const field of ["dependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries<string>(pinned[field] ?? {})) {
        if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`${path} ${field} "${name}" is "${version}". Pin an exact version.`);
      }
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
    const colour = path.startsWith("src/client/") && !path.startsWith(CLI_FOLDER) && path !== COLOUR_FILE ? COLOUR.exec(bodies.get(path) ?? "") : null;
    if (colour) problems.push(`${path}: writes the colour "${colour[0]}". Colours live only in ${COLOUR_FILE}.`);
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

// CI runs one exact Node, named in .node-version. A range lets the runner pick any Node it has
// cached, so two runs of one workflow can differ. On 26 Nov 2026 one run got Node 26. Its npm
// skipped the install script of puppeteer, so Chrome never arrived and every diagram failed.
function nodePinProblems(files: Map<string, string>): string[] {
  const problems: string[] = [];
  const pin = files.get(NODE_PIN);
  if (pin === undefined) problems.push(`${NODE_PIN}: missing. CI needs one exact Node version, such as 24.22.3.`);
  else if (!/^\d+\.\d+\.\d+\n?$/.test(pin)) problems.push(`${NODE_PIN}: says "${pin.trim()}". Write one exact version, such as 24.22.3.`);
  for (const [path, body] of files) {
    if (!WORKFLOW.test(path) || !body.includes("actions/setup-node")) continue;
    const versions = [...body.matchAll(/^\s*(node-version(?:-file)?):\s*(\S+)/gm)].map((match) => `${match[1]}: ${match[2]}`);
    if (versions.length === 0 || versions.some((line) => line !== `node-version-file: ${NODE_PIN}`)) {
      problems.push(`${path}: sets up Node with "${versions.join(", ") || "no version"}". Use "node-version-file: ${NODE_PIN}", so every run gets the same Node.`);
    }
  }
  return problems;
}

// A push to main runs the gate first. Without the hook, a red commit reaches main and only CI
// notices, after the push.
function prePushProblems(files: Map<string, string>): string[] {
  const problems: string[] = [];
  const hook = files.get(PRE_PUSH);
  if (hook === undefined) problems.push(`${PRE_PUSH}: missing. A push to main must run npm run check first.`);
  else if (!/^\s*if ! npm run check; then$/m.test(hook)) problems.push(`${PRE_PUSH}: does not stop the push when npm run check fails.`);
  const prepare = JSON.parse(files.get("package.json") ?? "{}").scripts?.prepare ?? "";
  if (!prepare.includes(HOOKS_ON)) problems.push(`package.json: the prepare script must run "${HOOKS_ON}", so npm install turns the hook on.`);
  return problems;
}

export function findProblems(files: Map<string, string>, tracked: string[]): string[] {
  const bodies = new Map([...files].map(([path, body]) => [path, stripComments(path, body)]));
  const fileProblems = [...unusedFiles(files, bodies, tracked), ...missingPaths(bodies, tracked)];
  return [...fileProblems, ...manifestProblems(files), ...productionProblems(files, bodies), ...composeProblems(files), ...nodePinProblems(files), ...prePushProblems(files)];
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
  console.log("check-repo: every watched file and npm script is in use, every named path exists, every dependency is pinned, app code has no stand-ins and reads settings in one place, every compose file has its own project name, CI runs the one Node in .node-version, a push to main runs the check first");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
