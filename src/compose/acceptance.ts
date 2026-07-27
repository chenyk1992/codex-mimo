import fs from "node:fs";
import path from "node:path";

import type {
  AcceptanceOutcome,
  CompactAcceptanceResult,
  JobVerificationDetails
} from "../core/jobs.js";
import {
  captureGitCommitChanges,
  captureGitDiff,
  captureGitHead,
  captureGitStatus,
  type GitHeadSnapshot
} from "../git/diff.js";
import {
  parseGitStatusFiles,
  runDeterministicDiffAcceptance
} from "./post-checks.js";
import {
  detectVerificationCommands,
  runVerificationCommands,
  type VerificationCommandExecutor
} from "./verify.js";
import type { DevelopmentAcceptanceInput } from "./workflow.js";

export interface AcceptanceStagePlan {
  stage: "build" | "test" | "diff_check";
  commands: string[];
  notApplicableReason?: string;
  required: boolean;
}

export interface DevelopmentAcceptancePlan {
  stages: AcceptanceStagePlan[];
  source: "explicit" | "detected" | "legacy_verification" | "mixed";
}

export interface AcceptanceStageResult {
  stage: "build" | "test" | "diff_check";
  outcome: "passed" | "failed" | "not_applicable" | "skipped";
  command?: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  reason?: string;
  failedTests?: string[];
  suggestion?: string;
}

export interface DevelopmentAcceptanceResult {
  stages: AcceptanceStageResult[];
  passed: boolean;
  errorCode?: "build_failed" | "tests_failed" | "diff_check_failed" | "delivery_contract_missing";
  failedStage?: "build" | "test" | "diff_check";
  failedCommand?: string;
  failedTests?: string[];
  suggestion?: string;
  compactTests: CompactAcceptanceResult[];
  verificationDetails: JobVerificationDetails[];
}

export interface DiffAcceptanceSummary {
  changedFileCount: number;
  samplePaths: string[];
  lineCounts?: Record<string, number>;
}

export interface DiffAcceptanceResult extends AcceptanceStageResult {
  summary?: DiffAcceptanceSummary;
}

export interface DiffCheckOptions {
  cwd: string;
  allowedPaths?: string[];
  expectedWritesAllowed?: boolean;
  forbidCommits?: boolean;
  gitHeadBefore?: GitHeadSnapshot;
  signal?: AbortSignal;
  captureStatus?: typeof captureGitStatus;
  captureDiff?: typeof captureGitDiff;
  captureHead?: typeof captureGitHead;
  captureCommitChanges?: typeof captureGitCommitChanges;
  runDeterministic?: typeof runDeterministicDiffAcceptance;
}

export const BUILD_NOT_APPLICABLE_REASON = "non_compiled_or_no_build_tooling";

type BuildDisposition =
  | { kind: "commands"; commands: string[]; source: "explicit" | "detected" }
  | { kind: "not_applicable"; reason: string; source: "detected" }
  | { kind: "missing" };

type TestDisposition =
  | { kind: "commands"; commands: string[]; source: "explicit" | "legacy_verification" | "detected" }
  | { kind: "missing" };

function readPackageJson(cwd: string): { scripts?: Record<string, string> } | undefined {
  const packagePath = path.join(cwd, "package.json");
  if (!fs.existsSync(packagePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8")) as { scripts?: Record<string, string> };
  } catch {
    return undefined;
  }
}

function hasPackageBuildScript(cwd: string): boolean {
  const pkg = readPackageJson(cwd);
  return typeof pkg?.scripts?.build === "string" && pkg.scripts.build.length > 0;
}

function isRecognizedNonCompiledTree(cwd: string): boolean {
  if (fs.existsSync(path.join(cwd, "pyproject.toml"))) {
    return true;
  }
  if (fs.existsSync(path.join(cwd, "package.json")) && !hasPackageBuildScript(cwd)) {
    return !fs.existsSync(path.join(cwd, "tsconfig.json"));
  }
  return false;
}

function detectBuildCommands(cwd: string): string[] {
  if (hasPackageBuildScript(cwd)) {
    return ["npm run build"];
  }
  if (fs.existsSync(path.join(cwd, "tsconfig.json"))) {
    return ["tsc -p tsconfig.json --noEmit"];
  }
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    return ["cargo build"];
  }
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    return ["go build ./..."];
  }
  if (fs.existsSync(path.join(cwd, "pom.xml"))) {
    return ["mvn -q package -DskipTests"];
  }
  if (
    fs.existsSync(path.join(cwd, "build.gradle")) ||
    fs.existsSync(path.join(cwd, "build.gradle.kts"))
  ) {
    return ["gradle build -x test"];
  }
  return [];
}

function resolveBuildDisposition(
  cwd: string,
  acceptance?: DevelopmentAcceptanceInput
): BuildDisposition {
  if (acceptance?.build && acceptance.build.length > 0) {
    return { kind: "commands", commands: acceptance.build, source: "explicit" };
  }

  const detected = detectBuildCommands(cwd);
  if (detected.length > 0) {
    return { kind: "commands", commands: detected, source: "detected" };
  }

  if (isRecognizedNonCompiledTree(cwd)) {
    return {
      kind: "not_applicable",
      reason: BUILD_NOT_APPLICABLE_REASON,
      source: "detected"
    };
  }

  return { kind: "missing" };
}

function resolveTestDisposition(
  cwd: string,
  acceptance: DevelopmentAcceptanceInput | undefined,
  legacyVerification: string[] | undefined
): TestDisposition {
  if (acceptance?.test && acceptance.test.length > 0) {
    return { kind: "commands", commands: acceptance.test, source: "explicit" };
  }
  if (legacyVerification && legacyVerification.length > 0) {
    return { kind: "commands", commands: legacyVerification, source: "legacy_verification" };
  }
  const detected = detectVerificationCommands(cwd);
  if (detected.length > 0) {
    return { kind: "commands", commands: detected, source: "detected" };
  }
  return { kind: "missing" };
}

function resolvePlanSource(
  build: BuildDisposition,
  test: TestDisposition
): DevelopmentAcceptancePlan["source"] {
  const sources = new Set<string>();
  if (build.kind === "commands") {
    sources.add(build.source);
  } else if (build.kind === "not_applicable") {
    sources.add(build.source);
  }
  if (test.kind === "commands") {
    sources.add(test.source);
  }
  if (sources.size === 0) {
    return "detected";
  }
  if (sources.size === 1) {
    const [only] = sources;
    if (only === "explicit") return "explicit";
    if (only === "legacy_verification") return "legacy_verification";
    return "detected";
  }
  return "mixed";
}

export function normalizeDevelopmentAcceptancePlan(input: {
  cwd: string;
  acceptance?: DevelopmentAcceptanceInput;
  legacyVerification?: string[];
  requireAcceptance: boolean;
}): DevelopmentAcceptancePlan | { missing: true; reason: string; code: "acceptance_config_missing" } {
  const build = resolveBuildDisposition(input.cwd, input.acceptance);
  const test = resolveTestDisposition(input.cwd, input.acceptance, input.legacyVerification);

  if (input.requireAcceptance) {
    if (build.kind === "missing") {
      return {
        missing: true,
        code: "acceptance_config_missing",
        reason: "Could not establish a build command or not-applicable disposition for this project."
      };
    }
    if (test.kind === "missing") {
      return {
        missing: true,
        code: "acceptance_config_missing",
        reason: "No targeted test command was provided or detected for development acceptance."
      };
    }
  }

  const stages: AcceptanceStagePlan[] = [];

  if (build.kind === "commands") {
    stages.push({
      stage: "build",
      commands: build.commands,
      required: input.requireAcceptance
    });
  } else if (build.kind === "not_applicable") {
    stages.push({
      stage: "build",
      commands: [],
      notApplicableReason: build.reason,
      required: false
    });
  } else {
    stages.push({
      stage: "build",
      commands: [],
      required: false
    });
  }

  if (test.kind === "commands") {
    stages.push({
      stage: "test",
      commands: test.commands,
      required: input.requireAcceptance
    });
  } else {
    stages.push({
      stage: "test",
      commands: [],
      required: false
    });
  }

  const diffCheckEnabled = input.acceptance?.diffCheck !== false;
  if (diffCheckEnabled) {
    stages.push({
      stage: "diff_check",
      commands: [],
      required: input.requireAcceptance
    });
  }

  return {
    stages,
    source: resolvePlanSource(build, test)
  };
}

function collapsePerStage(tests: CompactAcceptanceResult[]): CompactAcceptanceResult[] {
  const order: string[] = [];
  const byStage = new Map<string, CompactAcceptanceResult>();

  for (const test of tests) {
    if (!byStage.has(test.stage)) {
      order.push(test.stage);
      byStage.set(test.stage, test);
      continue;
    }
    const existing = byStage.get(test.stage)!;
    if (test.outcome === "failed" && existing.outcome !== "failed") {
      byStage.set(test.stage, test);
    }
  }

  return order.map((stage) => byStage.get(stage)!);
}

function extractTypeScriptLocation(output: string): string | undefined {
  const colonMatch = output.match(/([^\s(]+\.tsx?):(\d+):(\d+)/);
  if (colonMatch) {
    return `${colonMatch[1]}:${colonMatch[2]}`;
  }
  const parenMatch = output.match(/([^\s(]+\.tsx?)\((\d+),\d+\)/);
  if (parenMatch) {
    return `${parenMatch[1]}:${parenMatch[2]}`;
  }
  return undefined;
}

export function extractFailedTests(command: string, stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`;
  const tests: string[] = [];

  for (const line of combined.split("\n")) {
    const vitestMatch = line.match(/^\s*[×✕✗]\s+(.+?)\s*$/);
    if (vitestMatch) {
      tests.push(vitestMatch[1].trim());
      continue;
    }

    const jestFailMatch = line.match(/^\s*(?:FAIL|●)\s+.+\s+>\s+(.+?)\s*$/);
    if (jestFailMatch) {
      tests.push(jestFailMatch[1].trim());
      continue;
    }

    const pytestMatch = line.match(/FAILED\s+(\S+)/);
    if (pytestMatch) {
      tests.push(pytestMatch[1].trim());
      continue;
    }

    const cargoMatch = line.match(/^test\s+(.+?)\s+\.\.\.\s+FAILED/);
    if (cargoMatch) {
      tests.push(cargoMatch[1].trim());
      continue;
    }

    const goMatch = line.match(/^--- FAIL:\s+(\S+)/);
    if (goMatch) {
      tests.push(goMatch[1].trim());
      continue;
    }
  }

  void command;
  return [...new Set(tests)].slice(0, 10);
}

function parseDiffStatLineCounts(diffStat: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of diffStat.split("\n")) {
    const match = line.match(/^\s*(.+?)\s+\|\s+(\d+)\s/);
    if (match) {
      counts[match[1].trim()] = Number.parseInt(match[2], 10);
    }
  }
  return counts;
}

function buildDiffAcceptanceSummary(
  changedFiles: string[],
  diffStat: string
): DiffAcceptanceSummary {
  const lineCounts = parseDiffStatLineCounts(diffStat);
  return {
    changedFileCount: changedFiles.length,
    samplePaths: changedFiles.slice(0, 5),
    ...(Object.keys(lineCounts).length > 0 ? { lineCounts } : {})
  };
}

export async function runDiffAcceptanceSelfCheck(
  options: DiffCheckOptions
): Promise<DiffAcceptanceResult> {
  const captureStatus = options.captureStatus ?? captureGitStatus;
  const captureDiff = options.captureDiff ?? captureGitDiff;
  const captureHead = options.captureHead ?? captureGitHead;
  const captureCommitChanges = options.captureCommitChanges ?? captureGitCommitChanges;
  const runDeterministic = options.runDeterministic ?? runDeterministicDiffAcceptance;
  const writesAllowed = options.expectedWritesAllowed !== false;

  const [status, diffSnapshot, headAfter] = await Promise.all([
    captureStatus(options.cwd, { signal: options.signal }),
    captureDiff(options.cwd, "HEAD", { signal: options.signal }),
    captureHead(options.cwd, { signal: options.signal })
  ]);

  const statusFiles = [...parseGitStatusFiles(status.short)];
  const changedFiles =
    diffSnapshot.changedFiles.length > 0 ? diffSnapshot.changedFiles : statusFiles;
  const summary = buildDiffAcceptanceSummary(changedFiles, diffSnapshot.diffStat);

  const commitChanges = options.gitHeadBefore
    ? await captureCommitChanges(options.cwd, options.gitHeadBefore, headAfter, {
        signal: options.signal
      })
    : { commits: [], changedFiles: [] };

  if (!writesAllowed) {
    if (status.dirty || changedFiles.length > 0) {
      const sample = changedFiles.slice(0, 3);
      return {
        stage: "diff_check",
        outcome: "failed",
        reason: `Workspace has ${changedFiles.length} unexpected change(s): ${sample.join(", ")}`,
        suggestion:
          sample.length > 0
            ? `Remove out-of-scope change ${sample[0]}, then rerun the diff check.`
            : "Revert unexpected workspace changes, then rerun the diff check.",
        summary
      };
    }
    return { stage: "diff_check", outcome: "passed" };
  }

  if (changedFiles.length === 0 && !status.dirty) {
    return { stage: "diff_check", outcome: "passed" };
  }

  const deterministic = await runDeterministic({
    cwd: options.cwd,
    changedFiles,
    allowedPaths: options.allowedPaths,
    gitHeadBefore: options.gitHeadBefore,
    gitHeadAfter: headAfter,
    commitChanges,
    diffText: diffSnapshot.diff,
    signal: options.signal,
    forbidCommits: options.forbidCommits
  });

  return {
    ...deterministic,
    summary
  };
}

export function buildAcceptanceSuggestion(input: {
  stage: "build" | "test" | "diff_check";
  command: string;
  failedTests?: string[];
  stdout?: string;
  stderr?: string;
}): string {
  if (input.stage === "test" && input.failedTests && input.failedTests.length > 0) {
    const testName = input.failedTests[0];
    return `Fix ${testName} test "${testName}", then rerun ${input.command}.`;
  }

  if (input.stage === "build") {
    const location = extractTypeScriptLocation(`${input.stdout ?? ""}\n${input.stderr ?? ""}`);
    if (location) {
      return `Fix the first TypeScript error at ${location}, then rerun ${input.command}.`;
    }
  }

  return `Fix the first error in the report, then rerun ${input.command}.`;
}

function toCompactTests(stages: AcceptanceStageResult[]): CompactAcceptanceResult[] {
  return collapsePerStage(
    stages
      .filter((stage) => stage.outcome !== "skipped")
      .map((stage) => ({
        stage: stage.stage,
        command: stage.command ?? "",
        outcome: stage.outcome as AcceptanceOutcome
      }))
  );
}

export async function runDevelopmentAcceptance(
  cwd: string,
  plan: DevelopmentAcceptancePlan,
  options: {
    signal?: AbortSignal;
    runDiffCheck?: (cwd: string, signal?: AbortSignal) => Promise<AcceptanceStageResult>;
    execute?: VerificationCommandExecutor;
  } = {}
): Promise<DevelopmentAcceptanceResult> {
  const stages: AcceptanceStageResult[] = [];
  const verificationDetails: JobVerificationDetails[] = [];
  let passed = true;
  let errorCode: DevelopmentAcceptanceResult["errorCode"];
  let failedStage: DevelopmentAcceptanceResult["failedStage"];
  let failedCommand: string | undefined;
  let failedTests: string[] | undefined;
  let suggestion: string | undefined;
  let skipRemaining = false;

  for (const stagePlan of plan.stages) {
    if (skipRemaining) {
      stages.push({ stage: stagePlan.stage, outcome: "skipped" });
      continue;
    }

    if (stagePlan.stage === "diff_check") {
      if (!options.runDiffCheck) {
        stages.push({ stage: "diff_check", outcome: "passed" });
        continue;
      }

      const diffResult = await options.runDiffCheck(cwd, options.signal);
      stages.push(diffResult);
      if (diffResult.outcome === "failed") {
        passed = false;
        errorCode = diffResult.reason === "delivery_contract_missing"
          ? "delivery_contract_missing"
          : "diff_check_failed";
        failedStage = "diff_check";
        failedCommand = diffResult.command;
        failedTests = diffResult.failedTests;
        suggestion = diffResult.suggestion;
        skipRemaining = true;
      }
      continue;
    }

    if (stagePlan.notApplicableReason) {
      stages.push({
        stage: stagePlan.stage,
        outcome: "not_applicable",
        reason: stagePlan.notApplicableReason
      });
      continue;
    }

    if (stagePlan.commands.length === 0) {
      stages.push({ stage: stagePlan.stage, outcome: "passed" });
      continue;
    }

    const results = await runVerificationCommands(cwd, stagePlan.commands, {
      signal: options.signal,
      execute: options.execute
    });

    let stageFailed = false;
    for (const result of results) {
      verificationDetails.push({
        command: result.command,
        exitCode: result.exitCode,
        passed: result.passed,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr
      });

      const stageResult: AcceptanceStageResult = {
        stage: stagePlan.stage,
        outcome: result.passed ? "passed" : "failed",
        command: result.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs
      };

      if (!result.passed) {
        const extracted = extractFailedTests(result.command, result.stdout, result.stderr);
        if (extracted.length > 0) {
          stageResult.failedTests = extracted;
        }
        stageResult.suggestion = buildAcceptanceSuggestion({
          stage: stagePlan.stage,
          command: result.command,
          failedTests: stageResult.failedTests,
          stdout: result.stdout,
          stderr: result.stderr
        });
        passed = false;
        errorCode = stagePlan.stage === "build" ? "build_failed" : "tests_failed";
        failedStage = stagePlan.stage;
        failedCommand = result.command;
        failedTests = stageResult.failedTests;
        suggestion = stageResult.suggestion;
        skipRemaining = true;
        stageFailed = true;
      }

      stages.push(stageResult);
      if (stageFailed) {
        break;
      }
    }
  }

  return {
    stages,
    passed,
    errorCode,
    failedStage,
    failedCommand,
    failedTests,
    suggestion,
    compactTests: toCompactTests(stages),
    verificationDetails
  };
}
