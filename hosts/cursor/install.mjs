#!/usr/bin/env node
/**
 * Install Cursor companion hooks for codex-mimo.
 *
 * Usage:
 *   node hosts/cursor/install.mjs --project [targetDir]
 *   node hosts/cursor/install.mjs --user
 *
 * Requires a built repo: npm run build  (dist/companion/cli.js)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliJs = path.join(repoRoot, "dist", "companion", "cli.js");

function usage() {
  process.stderr.write(
    "Usage:\n  node hosts/cursor/install.mjs --project [targetDir]\n  node hosts/cursor/install.mjs --user\n"
  );
  process.exit(2);
}

function assertBuilt() {
  if (!fs.existsSync(cliJs)) {
    process.stderr.write(`Missing ${cliJs}. Run: npm run build\n`);
    process.exit(1);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hookConfig() {
  const command = `node ${JSON.stringify(cliJs)}`;
  return {
    version: 1,
    hooks: {
      afterMCPExecution: [
        {
          command: `${command} after-mcp`,
          matcher: "mimo_plan|mimo_implement|mimo_review|mimo_fix_ci|mimo_resume|mimo_compose"
        }
      ],
      stop: [
        {
          command: `${command} stop`,
          loop_limit: 5,
          timeout: 1860
        }
      ]
    }
  };
}

function installProject(targetDir) {
  assertBuilt();
  const root = path.resolve(targetDir);
  const hooksJson = path.join(root, ".cursor", "hooks.json");
  writeJson(hooksJson, hookConfig());
  process.stdout.write(`Installed project hooks in ${hooksJson}\n`);
  process.stdout.write(`CLI: ${cliJs}\n`);
}

function installUser() {
  assertBuilt();
  const hooksJson = path.join(os.homedir(), ".cursor", "hooks.json");
  let existing = { version: 1, hooks: {} };
  try {
    existing = JSON.parse(fs.readFileSync(hooksJson, "utf8"));
  } catch {
    // create new
  }
  const next = hookConfig();
  existing.version = 1;
  if (!existing.hooks || typeof existing.hooks !== "object") existing.hooks = {};
  existing.hooks.afterMCPExecution = next.hooks.afterMCPExecution;
  existing.hooks.stop = next.hooks.stop;
  writeJson(hooksJson, existing);
  process.stdout.write(`Installed user hooks in ${hooksJson}\n`);
  process.stdout.write(`CLI: ${cliJs}\n`);
}

const mode = process.argv[2];
if (mode === "--project") {
  installProject(process.argv[3] ?? process.cwd());
} else if (mode === "--user") {
  installUser();
} else {
  usage();
}
