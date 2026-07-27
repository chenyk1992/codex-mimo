import { normalizeDevelopmentAcceptancePlan } from "./acceptance.js";
import { extractFinalText, parseMimoJsonLines } from "./events.js";
import { slicePlanningPrompt } from "../core/prompt.js";
import type { BatchMode } from "../core/jobs.js";
import { SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE } from "../core/safety-contracts.js";
import { validateAllowedPathPattern } from "../core/path-scope.js";
import { preparePromptTransport } from "../mimo/prompt-transport.js";
import { buildMimoRunArgs } from "../mimo/run-json.js";
import { runMimoCliStreaming } from "../mimo/streaming-runner.js";
import type { DevelopmentAcceptanceInput } from "./workflow.js";

export interface SliceDefinition {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  contextFiles: string[];
  allowedPaths: string[];
  acceptance: DevelopmentAcceptanceInput;
}

export interface SliceManifest {
  version: 1;
  chainId: string;
  objective: string;
  repositoryFingerprint: string;
  slices: SliceDefinition[];
}

export type SliceManifestValidation =
  | { ok: true; manifest: SliceManifest }
  | { ok: false; code: "slice_plan_invalid"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(reason: string): SliceManifestValidation {
  return { ok: false, code: "slice_plan_invalid", reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isRepositoryRelativePath(pathValue: string): boolean {
  if (!pathValue.trim()) {
    return false;
  }
  if (/^[a-zA-Z]:[/\\]/.test(pathValue) || pathValue.startsWith("\\\\")) {
    return false;
  }
  if (pathValue.startsWith("/") || pathValue.startsWith("\\")) {
    return false;
  }
  const normalized = pathValue.replace(/\\/g, "/");
  return !normalized.split("/").some((segment) => segment === "..");
}

function normalizeAcceptanceInput(value: unknown): DevelopmentAcceptanceInput | null {
  if (!isRecord(value)) {
    return null;
  }
  const acceptance: DevelopmentAcceptanceInput = {};
  if (value.build !== undefined) {
    if (!isStringArray(value.build)) {
      return null;
    }
    acceptance.build = value.build;
  }
  if (value.test !== undefined) {
    if (!isStringArray(value.test)) {
      return null;
    }
    acceptance.test = value.test;
  }
  if (value.diffCheck !== undefined) {
    if (typeof value.diffCheck !== "boolean") {
      return null;
    }
    acceptance.diffCheck = value.diffCheck;
  }
  return acceptance;
}

function normalizeSliceDefinition(value: unknown): SliceDefinition | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.title) || !isNonEmptyString(value.objective)) {
    return null;
  }
  if (!isStringArray(value.dependsOn) || !isStringArray(value.contextFiles) || !isStringArray(value.allowedPaths)) {
    return null;
  }
  const acceptance = normalizeAcceptanceInput(value.acceptance);
  if (!acceptance) {
    return null;
  }
  return {
    id: value.id.trim(),
    title: value.title.trim(),
    objective: value.objective.trim(),
    dependsOn: value.dependsOn.map((dep) => dep.trim()).filter(Boolean),
    contextFiles: value.contextFiles,
    allowedPaths: value.allowedPaths,
    acceptance
  };
}

function validateRepositoryRelativePaths(paths: string[], fieldName: string): string | null {
  for (const pathValue of paths) {
    if (!isRepositoryRelativePath(pathValue)) {
      return `${fieldName} must contain repository-relative paths without absolute segments or ".." traversal (${pathValue}).`;
    }
  }
  return null;
}

function validateAllowedPathPatterns(paths: string[], fieldName: string): string | null {
  for (const pathValue of paths) {
    const patternError = validateAllowedPathPattern(pathValue);
    if (patternError) {
      return `${fieldName} ${patternError} (${pathValue}).`;
    }
  }
  return null;
}

function findDependencyCycle(slices: SliceDefinition[]): boolean {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): boolean {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    const slice = byId.get(id);
    if (slice) {
      for (const dep of slice.dependsOn) {
        if (visit(dep)) {
          return true;
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }

  for (const slice of slices) {
    if (visit(slice.id)) {
      return true;
    }
  }
  return false;
}

function validateSliceAcceptance(
  slice: SliceDefinition,
  cwd: string
): string | null {
  const plan = normalizeDevelopmentAcceptancePlan({
    cwd,
    acceptance: slice.acceptance,
    requireAcceptance: true
  });
  if ("missing" in plan) {
    return `Slice "${slice.id}" acceptance is invalid: ${plan.reason}`;
  }

  const buildStage = plan.stages.find((stage) => stage.stage === "build");
  const testStage = plan.stages.find((stage) => stage.stage === "test");
  const hasBuildDisposition =
    (buildStage?.commands.length ?? 0) > 0 || Boolean(buildStage?.notApplicableReason);
  const hasTestCommand = (testStage?.commands.length ?? 0) > 0;

  if (!hasBuildDisposition) {
    return `Slice "${slice.id}" acceptance is missing a build disposition.`;
  }
  if (!hasTestCommand) {
    return `Slice "${slice.id}" acceptance must include at least one targeted test command.`;
  }
  return null;
}

export function validateSliceManifest(
  input: unknown,
  options?: { minSlices?: number; maxSlices?: number; cwd?: string }
): SliceManifestValidation {
  const minSlices = options?.minSlices ?? 1;
  const maxSlices = options?.maxSlices ?? 8;
  const cwd = options?.cwd ?? process.cwd();

  if (!isRecord(input)) {
    return invalid("Slice manifest must be a JSON object.");
  }
  if (input.version !== 1) {
    return invalid("Slice manifest version must be 1.");
  }
  if (!isNonEmptyString(input.chainId)) {
    return invalid("Slice manifest chainId must be a non-empty string.");
  }
  if (!isNonEmptyString(input.objective)) {
    return invalid("Slice manifest objective must be a non-empty string.");
  }
  if (!isNonEmptyString(input.repositoryFingerprint)) {
    return invalid("Slice manifest repositoryFingerprint must be a non-empty string.");
  }
  if (!Array.isArray(input.slices)) {
    return invalid("Slice manifest slices must be an array.");
  }

  if (input.slices.length < minSlices || input.slices.length > maxSlices) {
    return invalid(`Slice manifest must contain between ${minSlices} and ${maxSlices} slices.`);
  }

  const slices: SliceDefinition[] = [];
  for (const rawSlice of input.slices) {
    const slice = normalizeSliceDefinition(rawSlice);
    if (!slice) {
      return invalid("Each slice must include id, title, objective, dependsOn, contextFiles, allowedPaths, and acceptance.");
    }
    slices.push(slice);
  }

  const ids = new Set<string>();
  for (const slice of slices) {
    if (ids.has(slice.id)) {
      return invalid(`Duplicate slice id "${slice.id}".`);
    }
    ids.add(slice.id);
  }

  const sliceIds = new Set(slices.map((slice) => slice.id));
  for (const slice of slices) {
    if (slice.allowedPaths.length === 0) {
      return invalid(`Slice "${slice.id}" must declare at least one allowedPaths entry.`);
    }

    const allowedPathError = validateAllowedPathPatterns(slice.allowedPaths, `Slice "${slice.id}" allowedPaths`);
    if (allowedPathError) {
      return invalid(allowedPathError);
    }

    const contextPathError = validateRepositoryRelativePaths(
      slice.contextFiles,
      `Slice "${slice.id}" contextFiles`
    );
    if (contextPathError) {
      return invalid(contextPathError);
    }

    for (const dep of slice.dependsOn) {
      if (!sliceIds.has(dep)) {
        return invalid(`Slice "${slice.id}" depends on unknown slice "${dep}".`);
      }
    }

    const acceptanceError = validateSliceAcceptance(slice, cwd);
    if (acceptanceError) {
      return invalid(acceptanceError);
    }
  }

  if (findDependencyCycle(slices)) {
    return invalid("Slice dependencies must be acyclic.");
  }

  return {
    ok: true,
    manifest: {
      version: 1,
      chainId: input.chainId.trim(),
      objective: input.objective.trim(),
      repositoryFingerprint: input.repositoryFingerprint.trim(),
      slices
    }
  };
}

function extractSliceManifestJsonCandidates(finalText: string): string[] {
  const candidates: string[] = [];
  for (const match of finalText.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1].trim());
  }
  for (const match of finalText.matchAll(/\{[\s\S]*?"version"\s*:[\s\S]*?"slices"\s*:[\s\S]*?\}/g)) {
    candidates.push(match[0]);
  }
  candidates.push(finalText.trim());
  return candidates;
}

function looksLikeSliceManifestEnvelope(value: unknown): boolean {
  return isRecord(value) && value.version === 1 && Array.isArray(value.slices);
}

export function parseSliceManifestFromText(finalText: string): unknown | null {
  for (const candidate of extractSliceManifestJsonCandidates(finalText)) {
    if (!candidate) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate);
      if (looksLikeSliceManifestEnvelope(parsed)) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function resolveSingleSliceAcceptance(input: {
  cwd: string;
  acceptance?: DevelopmentAcceptanceInput;
  legacyVerification?: string[];
}): DevelopmentAcceptanceInput | { ok: false; reason: string } {
  const plan = normalizeDevelopmentAcceptancePlan({
    cwd: input.cwd,
    acceptance: input.acceptance,
    legacyVerification: input.legacyVerification,
    requireAcceptance: true
  });
  if ("missing" in plan) {
    return { ok: false, reason: plan.reason };
  }

  const acceptance: DevelopmentAcceptanceInput = {};
  const buildStage = plan.stages.find((stage) => stage.stage === "build");
  const testStage = plan.stages.find((stage) => stage.stage === "test");
  if (buildStage && buildStage.commands.length > 0) {
    acceptance.build = buildStage.commands;
  }
  if (testStage && testStage.commands.length > 0) {
    acceptance.test = testStage.commands;
  }
  if (input.acceptance?.diffCheck !== undefined) {
    acceptance.diffCheck = input.acceptance.diffCheck;
  }
  return acceptance;
}

export async function planSliceManifest(input: {
  cwd: string;
  chainId: string;
  objective: string;
  batchMode: BatchMode;
  acceptance?: DevelopmentAcceptanceInput;
  legacyVerification?: string[];
  repositoryFingerprint: string;
  allowedPaths?: string[];
  signal?: AbortSignal;
  runMimo?: typeof runMimoCliStreaming;
}): Promise<SliceManifestValidation> {
  if (input.batchMode === "single") {
    const acceptance = resolveSingleSliceAcceptance(input);
    if ("ok" in acceptance) {
      return invalid(acceptance.reason);
    }

    try {
      const manifest = materializeSingleSliceManifest({
        chainId: input.chainId,
        objective: input.objective,
        repositoryFingerprint: input.repositoryFingerprint,
        acceptance,
        allowedPaths: input.allowedPaths,
        cwd: input.cwd
      });
      return { ok: true, manifest };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : String(error));
    }
  }

  const prompt = preparePromptTransport(slicePlanningPrompt(input.objective), { cwd: input.cwd });
  const args = buildMimoRunArgs({
    cwd: input.cwd,
    agent: "plan",
    message: prompt.message,
    title: "codex-mimo slice-planning",
    files: prompt.files
  });

  const runMimo = input.runMimo ?? runMimoCliStreaming;
  const run = await runMimo(input.cwd, args, { signal: input.signal });

  if (run.exitCode !== 0) {
    return invalid(`Slice planning MiMo process exited with code ${run.exitCode}`);
  }

  const finalText = extractFinalText(parseMimoJsonLines(run.stdout));
  const parsed = parseSliceManifestFromText(finalText);
  if (!parsed) {
    return invalid("Slice planning must end with a valid JSON SliceManifest envelope.");
  }

  const minSlices = input.batchMode === "sliced" ? 2 : 1;
  return validateSliceManifest(parsed, { cwd: input.cwd, minSlices });
}

export function materializeSingleSliceManifest(input: {
  chainId: string;
  objective: string;
  repositoryFingerprint: string;
  acceptance: DevelopmentAcceptanceInput;
  allowedPaths?: string[];
  contextFiles?: string[];
  cwd?: string;
}): SliceManifest {
  if (!input.allowedPaths || input.allowedPaths.length === 0) {
    throw new Error(SINGLE_MODE_ALLOWED_PATHS_REQUIRED_MESSAGE);
  }

  const manifest: SliceManifest = {
    version: 1,
    chainId: input.chainId,
    objective: input.objective,
    repositoryFingerprint: input.repositoryFingerprint,
    slices: [
      {
        id: "slice-1",
        title: input.objective.trim().slice(0, 120) || "Single slice",
        objective: input.objective,
        dependsOn: [],
        contextFiles: input.contextFiles ?? [],
        allowedPaths: input.allowedPaths,
        acceptance: input.acceptance
      }
    ]
  };

  const validation = validateSliceManifest(manifest, { cwd: input.cwd ?? process.cwd() });
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  return validation.manifest;
}
