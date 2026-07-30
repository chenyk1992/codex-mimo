import fs from "node:fs";
import path from "node:path";
import type {
  ContextOverheadMetrics,
  JobOutputLevel,
  JobRecord
} from "./jobs.js";
import type { NotificationDelivery } from "../notify/types.js";

interface ContextInitEvent {
  version: 1;
  type: "init";
  timestamp: string;
}

interface ContextToolCallEvent {
  version: 1;
  type: "tool_call";
  timestamp: string;
  tool: "status" | "result";
  level: JobOutputLevel;
  compactResultBytes?: number;
}

type ContextOverheadEvent = ContextInitEvent | ContextToolCallEvent;

export interface CurrentContextToolCall {
  tool: "status" | "result";
  level: JobOutputLevel;
}

export function resolveContextOverheadFile(cwd: string, jobId: string): string {
  return path.join(cwd, ".codex-mimo", "jobs", `${jobId}.context.jsonl`);
}

export function initializeContextOverhead(
  cwd: string,
  jobId: string,
  now: () => Date = () => new Date()
): void {
  appendEvent(resolveContextOverheadFile(cwd, jobId), {
    version: 1,
    type: "init",
    timestamp: now().toISOString()
  });
}

export function recordContextToolCall(
  cwd: string,
  jobId: string,
  call: CurrentContextToolCall,
  compactResultBytes?: number,
  now: () => Date = () => new Date()
): void {
  appendEvent(resolveContextOverheadFile(cwd, jobId), {
    version: 1,
    type: "tool_call",
    timestamp: now().toISOString(),
    tool: call.tool,
    level: call.level,
    ...(compactResultBytes === undefined ? {} : { compactResultBytes })
  });
}

export function collectContextOverheadMetrics(
  selected: JobRecord,
  jobs: readonly JobRecord[],
  deliveries: readonly NotificationDelivery[],
  currentCall?: CurrentContextToolCall
): ContextOverheadMetrics {
  const family = logicalJobFamily(selected, jobs);
  const eventGroups = family.map((job) => readEvents(resolveContextOverheadFile(job.cwd, job.id)));
  const events = eventGroups.flat();
  const initializedJobs = eventGroups.filter((group) =>
    group.some((event) => event.type === "init")
  ).length;
  const toolCalls = events.filter(
    (event): event is ContextToolCallEvent => event.type === "tool_call"
  ).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const observedCalls = currentCall
    ? [...toolCalls, {
        version: 1 as const,
        type: "tool_call" as const,
        timestamp: "",
        ...currentCall
      }]
    : toolCalls;
  const complete = initializedJobs === family.length;
  const tracking = complete
    ? "complete" as const
    : events.length > 0 || currentCall
      ? "partial" as const
      : "unavailable" as const;
  const codexJobIds = new Set(family.map((job) => job.id));
  const callbackAttempts = deliveries
    .filter((delivery) =>
      codexJobIds.has(delivery.jobId) && delivery.target.type === "codex"
    )
    .reduce((total, delivery) => total + delivery.attempts, 0);
  const compactBytes = toolCalls
    .filter((event) =>
      event.tool === "result" &&
      event.level === "compact" &&
      event.compactResultBytes !== undefined
    )
    .at(-1)?.compactResultBytes ?? null;

  return {
    tracking,
    statusCalls: tracking === "unavailable"
      ? null
      : observedCalls.filter((event) => event.tool === "status").length,
    resultCalls: tracking === "unavailable"
      ? null
      : observedCalls.filter((event) => event.tool === "result").length,
    heartbeatCalls: null,
    compactResultBytes: compactBytes,
    callbackAttempts,
    requestedStandardOrFull: tracking === "unavailable"
      ? null
      : observedCalls.some((event) => event.level !== "compact"),
    needsInput: family.some((job) =>
      job.status === "needs_input" || job.errorCode === "acceptance_config_missing"
    ),
    resumeCount: family.filter((job) => job.kind === "resume").length,
    relaunchCount: null
  };
}

function logicalJobFamily(selected: JobRecord, jobs: readonly JobRecord[]): JobRecord[] {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  byId.set(selected.id, selected);
  let root = selected;
  const visited = new Set<string>();
  while (root.parentJobId && !visited.has(root.id)) {
    visited.add(root.id);
    const parent = byId.get(root.parentJobId);
    if (!parent) break;
    root = parent;
  }

  const family = new Map<string, JobRecord>([[root.id, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of byId.values()) {
      if (family.has(job.id) || !job.parentJobId || !family.has(job.parentJobId)) continue;
      family.set(job.id, job);
      changed = true;
    }
  }
  return [...family.values()];
}

function appendEvent(file: string, event: ContextOverheadEvent): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  } catch {
    // Best-effort metrics must never change job execution or tool outcomes.
  }
}

function readEvents(file: string): ContextOverheadEvent[] {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return contents
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return [];
      try {
        const event = parseEvent(JSON.parse(line) as unknown);
        return event ? [event] : [];
      } catch {
        return [];
      }
    });
}

function parseEvent(value: unknown): ContextOverheadEvent | undefined {
  if (!isRecord(value) || value.version !== 1 || !isTimestamp(value.timestamp)) return undefined;
  if (value.type === "init") {
    return { version: 1, type: "init", timestamp: value.timestamp };
  }
  if (
    value.type !== "tool_call" ||
    (value.tool !== "status" && value.tool !== "result") ||
    (value.level !== "compact" && value.level !== "standard" && value.level !== "full") ||
    (value.compactResultBytes !== undefined &&
      (typeof value.compactResultBytes !== "number" ||
        !Number.isInteger(value.compactResultBytes) ||
        value.compactResultBytes < 0))
  ) {
    return undefined;
  }
  return {
    version: 1,
    type: "tool_call",
    timestamp: value.timestamp,
    tool: value.tool,
    level: value.level,
    ...(typeof value.compactResultBytes === "number"
      ? { compactResultBytes: value.compactResultBytes }
      : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
