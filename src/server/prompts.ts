import { readFileSync } from "node:fs";

// Every instruction a model reads is a Markdown file in a prompts folder beside the code that
// sends it. Changing the wording never means editing a graph, and a missing file stops startup.
export function prompt(moduleUrl: string, name: string): string {
  const file = new URL(`./prompts/${name}.md`, moduleUrl);
  return readFileSync(file, "utf8").trimEnd();
}
