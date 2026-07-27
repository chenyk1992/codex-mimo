import fs from "node:fs";
import path from "node:path";
import type { SliceDefinition, SliceManifest } from "../compose/slices.js";
import { renameWithWindowsRetry } from "./atomic-file.js";

export type SliceRuntimeState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "stalled"
  | "needs_input"
  | "blocked"
  | "cancelled"
  | "timeout";

export interface JobChainRecord {
  version: 1;
  chainId: string;
  rootJobId: string;
  latestContinuationJobId?: string;
  manifestPath: string;
  sliceStates: Record<string, SliceRuntimeState>;
  currentSliceId?: string;
  completedSliceIds: string[];
  childJobIds: Record<string, string>;
}

export function resolveChainPath(cwd: string, chainId: string): string {
  return path.join(cwd, ".codex-mimo", "jobs", `${chainId}.chain.json`);
}

export function resolveSliceManifestPath(cwd: string, rootJobId: string): string {
  return path.join(cwd, ".codex-mimo", "reports", `${rootJobId}.slices.json`);
}

export function readJobChain(cwd: string, chainId: string): JobChainRecord | null {
  const chainPath = resolveChainPath(cwd, chainId);
  if (!fs.existsSync(chainPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(chainPath, "utf8")) as JobChainRecord;
    if (parsed.version !== 1 || typeof parsed.chainId !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeJobChainAtomic(cwd: string, record: JobChainRecord): void {
  const chainPath = resolveChainPath(cwd, record.chainId);
  writeJsonAtomically(chainPath, record);
}

export function createJobChainFromManifest(input: {
  cwd: string;
  rootJobId: string;
  manifest: SliceManifest;
  manifestPath: string;
}): JobChainRecord {
  const sliceStates: Record<string, SliceRuntimeState> = {};
  for (const slice of input.manifest.slices) {
    sliceStates[slice.id] = "pending";
  }

  const record: JobChainRecord = {
    version: 1,
    chainId: input.manifest.chainId,
    rootJobId: input.rootJobId,
    manifestPath: normalizeStoredPath(input.manifestPath),
    sliceStates,
    completedSliceIds: [],
    childJobIds: {}
  };

  writeJobChainAtomic(input.cwd, record);
  return record;
}

export function markSliceRunning(
  cwd: string,
  chainId: string,
  sliceId: string,
  childJobId: string
): JobChainRecord {
  const record = requireJobChain(cwd, chainId);
  const next: JobChainRecord = {
    ...record,
    currentSliceId: sliceId,
    latestContinuationJobId: childJobId,
    sliceStates: {
      ...record.sliceStates,
      [sliceId]: "running"
    },
    childJobIds: {
      ...record.childJobIds,
      [sliceId]: childJobId
    }
  };
  writeJobChainAtomic(cwd, next);
  return next;
}

export function markSliceTerminal(
  cwd: string,
  chainId: string,
  sliceId: string,
  state: Exclude<SliceRuntimeState, "pending" | "running">
): JobChainRecord {
  const record = requireJobChain(cwd, chainId);
  const completedSliceIds = state === "completed" && !record.completedSliceIds.includes(sliceId)
    ? [...record.completedSliceIds, sliceId]
    : record.completedSliceIds;
  const next: JobChainRecord = {
    ...record,
    ...(record.currentSliceId === sliceId ? { currentSliceId: undefined } : {}),
    completedSliceIds,
    sliceStates: {
      ...record.sliceStates,
      [sliceId]: state
    }
  };
  writeJobChainAtomic(cwd, next);
  return next;
}

/** Mark every still-pending slice cancelled so cancelled roots cannot launch remaining work. */
export function markPendingSlicesCancelled(cwd: string, chainId: string): JobChainRecord {
  const record = requireJobChain(cwd, chainId);
  let changed = false;
  const sliceStates = { ...record.sliceStates };
  for (const [sliceId, state] of Object.entries(sliceStates)) {
    if (state !== "pending") continue;
    sliceStates[sliceId] = "cancelled";
    changed = true;
  }
  if (!changed) return record;
  const next: JobChainRecord = { ...record, sliceStates };
  writeJobChainAtomic(cwd, next);
  return next;
}

/** Resolve the live/current slice child job id for cancel cascade and recovery. */
export function resolveLiveChainChildJobId(chain: JobChainRecord): string | undefined {
  if (
    typeof chain.latestContinuationJobId === "string" &&
    chain.latestContinuationJobId.trim()
  ) {
    return chain.latestContinuationJobId;
  }
  if (
    typeof chain.currentSliceId === "string" &&
    chain.currentSliceId.trim()
  ) {
    const childId = chain.childJobIds[chain.currentSliceId];
    if (typeof childId === "string" && childId.trim()) return childId;
  }
  for (const [sliceId, state] of Object.entries(chain.sliceStates)) {
    if (state !== "running") continue;
    const childId = chain.childJobIds[sliceId];
    if (typeof childId === "string" && childId.trim()) return childId;
  }
  return undefined;
}

export function writeSliceManifestArtifact(input: {
  cwd: string;
  rootJobId: string;
  manifest: SliceManifest;
}): string {
  const manifestPath = resolveSliceManifestPath(input.cwd, input.rootJobId);
  writeJsonAtomically(manifestPath, input.manifest);
  return manifestPath;
}

export function selectNextReadySlice(
  manifest: SliceManifest,
  chain: JobChainRecord
): SliceDefinition | null {
  const completed = new Set(chain.completedSliceIds);
  for (const slice of manifest.slices) {
    if (chain.sliceStates[slice.id] !== "pending") {
      continue;
    }
    if (slice.dependsOn.every((dep) => completed.has(dep))) {
      return slice;
    }
  }
  return null;
}

/** Root jobs that own a chain and wait for child workers (no root MiMo process). */
export function isChainOrchestratorRoot(job: {
  chainId?: string | null;
  sliceId?: string | null;
  parentJobId?: string | null;
}): boolean {
  return Boolean(job.chainId) && !job.sliceId && !job.parentJobId;
}

export function isChainSliceChild(job: {
  chainId?: string | null;
  sliceId?: string | null;
  parentJobId?: string | null;
}): boolean {
  return Boolean(job.chainId && job.sliceId && job.parentJobId);
}

export function mapChildStatusToSliceState(
  status: string
): Exclude<SliceRuntimeState, "pending" | "running"> | null {
  switch (status) {
    case "completed":
    case "failed":
    case "stalled":
    case "needs_input":
    case "blocked":
    case "cancelled":
    case "timeout":
      return status;
    default:
      return null;
  }
}

/** True when any slice is still pending or running (durable chain work remains). */
export function isUnfinishedJobChain(chain: JobChainRecord): boolean {
  return Object.values(chain.sliceStates).some(
    (state) => state === "pending" || state === "running"
  );
}

export function listJobChains(cwd: string): JobChainRecord[] {
  const jobDir = path.join(cwd, ".codex-mimo", "jobs");
  if (!fs.existsSync(jobDir)) return [];
  const chains: JobChainRecord[] = [];
  for (const entry of fs.readdirSync(jobDir)) {
    if (!entry.endsWith(".chain.json")) continue;
    const chainId = entry.slice(0, -".chain.json".length);
    const record = readJobChain(cwd, chainId);
    if (record) chains.push(record);
  }
  return chains;
}

export function workspaceHasUnfinishedChain(cwd: string): boolean {
  return listJobChains(cwd).some(isUnfinishedJobChain);
}

const ATTENTION_SLICE_STATES = new Set<SliceRuntimeState>([
  "failed",
  "stalled",
  "needs_input",
  "blocked",
  "timeout"
]);

/** Locate the mid-chain attention slice that mimo_resume should continue. */
export function findChainAttentionSlice(chain: JobChainRecord): {
  sliceId: string;
  childJobId: string;
} | null {
  if (
    typeof chain.latestContinuationJobId === "string" &&
    chain.latestContinuationJobId.trim()
  ) {
    for (const [sliceId, childJobId] of Object.entries(chain.childJobIds)) {
      if (childJobId !== chain.latestContinuationJobId) continue;
      const state = chain.sliceStates[sliceId];
      if (state && ATTENTION_SLICE_STATES.has(state)) {
        return { sliceId, childJobId };
      }
    }
  }

  for (const [sliceId, state] of Object.entries(chain.sliceStates)) {
    if (!ATTENTION_SLICE_STATES.has(state)) continue;
    if (chain.completedSliceIds.includes(sliceId)) continue;
    const childJobId = chain.childJobIds[sliceId];
    if (childJobId) return { sliceId, childJobId };
  }
  return null;
}

export function unionChangedFiles(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const file of list) {
      const normalized = file.replace(/\\/g, "/");
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

export function readSliceManifestFromChain(
  cwd: string,
  chain: JobChainRecord
): SliceManifest | null {
  const candidates = [
    path.isAbsolute(chain.manifestPath) ? chain.manifestPath : path.join(cwd, chain.manifestPath),
    resolveSliceManifestPath(cwd, chain.rootJobId)
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8")) as SliceManifest;
    } catch {
      continue;
    }
  }
  return null;
}

function requireJobChain(cwd: string, chainId: string): JobChainRecord {
  const record = readJobChain(cwd, chainId);
  if (!record) {
    throw new Error(`Job chain "${chainId}" was not found.`);
  }
  return record;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    renameWithWindowsRetry(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function normalizeStoredPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
