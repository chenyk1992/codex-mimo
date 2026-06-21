import { minimatch } from "minimatch";
import { isPathInside, normalizePath } from "./paths.js";

export type Decision = "allow" | "ask" | "deny";

export interface BridgePolicy {
  workspaceRoot: string;
  deniedFileGlobs: string[];
  allowedReadGlobs?: string[];
  allowedWriteGlobs?: string[];
  allowedCommands: string[];
  askCommands: string[];
  deniedCommands: string[];
  ciMode?: boolean;
  nonInteractive?: boolean;
}

export const defaultPolicy = (workspaceRoot: string): BridgePolicy => ({
  workspaceRoot: normalizePath(workspaceRoot),
  deniedFileGlobs: [
    "**/.env",
    "**/.env.*",
    "**/id_rsa",
    "**/id_ed25519",
    "**/.npmrc",
    "**/.pypirc"
  ],
  allowedCommands: [
    "git status*",
    "git diff*",
    "git log*",
    "npm test*",
    "npm run test*",
    "npm run lint*",
    "npm run typecheck*",
    "pnpm test*",
    "pnpm lint*",
    "pnpm typecheck*"
  ],
  askCommands: ["npm install*", "pnpm install*", "npm run build*", "pnpm build*"],
  deniedCommands: [
    "rm *",
    "del *",
    "Remove-Item *",
    "git push*",
    "git reset*",
    "git checkout --*",
    "curl *",
    "wget *",
    "ssh *",
    "scp *"
  ]
});

function resolveDecision(policy: BridgePolicy, decision: Decision): Decision {
  if ((policy.ciMode || policy.nonInteractive) && decision === "ask") return "deny";
  return decision;
}

export function decideFileRead(policy: BridgePolicy, filePath: string): Decision {
  const normalized = normalizePath(filePath);
  if (!isPathInside(policy.workspaceRoot, normalized)) return "deny";
  if (policy.deniedFileGlobs.some((glob) => minimatch(normalized, glob))) return "deny";
  if (policy.allowedReadGlobs && !policy.allowedReadGlobs.some((glob) => minimatch(normalized, glob))) return "deny";
  return "allow";
}

export function decideFileWrite(policy: BridgePolicy, filePath: string): Decision {
  const normalized = normalizePath(filePath);
  if (!isPathInside(policy.workspaceRoot, normalized)) return "deny";
  if (policy.deniedFileGlobs.some((glob) => minimatch(normalized, glob))) return "deny";
  if (policy.allowedWriteGlobs && !policy.allowedWriteGlobs.some((glob) => minimatch(normalized, glob))) return "deny";
  return resolveDecision(policy, "ask");
}

export function decideCommand(policy: BridgePolicy, commandLine: string): Decision {
  if (policy.deniedCommands.some((glob) => minimatch(commandLine, glob))) return "deny";
  if (policy.allowedCommands.some((glob) => minimatch(commandLine, glob))) return "allow";
  if (policy.askCommands.some((glob) => minimatch(commandLine, glob))) return resolveDecision(policy, "ask");
  return resolveDecision(policy, "ask");
}
