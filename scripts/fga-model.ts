import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WriteAuthorizationModelRequest } from "@openfga/sdk";

// The permission rules are written once, in infra/openfga/model.fga. The OpenFGA CLI (pinned
// here) turns them into the JSON the server takes. npm run setup and the tests both use this.

const FGA_CLI_IMAGE = "openfga/cli:v0.8.2";
const MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../infra/openfga");

function cli(args: string[]) {
  return ["run", "--rm", "-v", `${MODEL_DIR}:/w:ro`, FGA_CLI_IMAGE, ...args];
}

export function modelJson(): WriteAuthorizationModelRequest {
  const out = execFileSync("docker", cli(["model", "transform", "--file", "/w/model.fga"]), { encoding: "utf8" });
  return JSON.parse(out) as WriteAuthorizationModelRequest;
}

// Runs the model's own tests (infra/openfga/model.fga.yaml). The CLI exits non-zero when one fails.
export function testModel(): { ok: boolean; output: string } {
  const run = spawnSync("docker", cli(["model", "test", "--tests", "/w/model.fga.yaml"]), { encoding: "utf8" });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}
