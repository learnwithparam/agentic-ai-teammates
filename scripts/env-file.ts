import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Writes settings into a .env file: replaces a line that names the setting, or adds one. The
// file is readable by its owner only, and no value is ever printed.
export function setEnv(values: Record<string, string>, file: string) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at >= 0) lines[at] = `${name}=${value}`;
    else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${name}=${value}`);
  }
  writeFileSync(file, `${lines.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
}
