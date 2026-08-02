import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SliceManifest } from "../../../src/compose/slices.js";
import {
  createJobChainFromManifest,
  isUnfinishedJobChain,
  markSliceRunning,
  markSliceTerminal,
  readJobChain,
  resolveChainPath,
  resolveSliceManifestPath,
  selectNextReadySlice,
  unionChangedFiles,
  writeJobChainAtomic,
  writeSliceManifestArtifact,
  workspaceHasUnfinishedChain
} from "../../../src/core/job-chain.js";
import {
  advanceJobChainAfterChild,
  bootstrapWriteJobChain,
  continueJobChainOrchestration
} from "../../../src/core/job-definitions.js";
import { createJobStore, listJobs, readJob, updateJobAuthoritative } from "../../../src/core/job-store.js";
import { transitionJob } from "../../../src/core/job-transition.js";
import { readDeliveries } from "../../../src/notify/outbox.js";
import { recoverUnfinishedJobChains } from "../../../src/core/job-recovery.js";
import { captureScopedWorkspaceManifest } from "../../../src/core/changed-files.js";
import { readJobCheckpoint, writeJobCheckpoint } from "../../../src/core/job-checkpoint.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can briefly lock temp dirs after git/status probes.
    }
  }
});

function tempWorkspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-chain-"));
  tempDirs.push(cwd);
  return cwd;
}

function sampleManifest(overrides: Partial<SliceManifest> = {}): SliceManifest {
  return {
    version: 1,
    chainId: "chain-root",
    objective: "Implement slice chain",
    repositoryFingerprint: "fp-abc123",
    slices: [
      {
        id: "slice-a",
        title: "Add schema",
        objective: "Add schema only",
        dependsOn: [],
        contextFiles: ["src/schema.ts"],
        allowedPaths: ["src/schema.ts"],
        acceptance: { build: ["npm run build"], test: ["npm test -- schema.test.ts"] }
      },
      {
        id: "slice-b",
        title: "Add callback",
        objective: "Add callback only",
        dependsOn: ["slice-a"],
        contextFiles: ["src/callback.ts"],
        allowedPaths: ["src/callback.ts"],
        acceptance: { build: ["npm run build"], test: ["npm test -- callback.test.ts"] }
      },
      {
        id: "slice-c",
        title: "Add tests",
        objective: "Add focused tests",
        dependsOn: ["slice-b"],
        contextFiles: ["test/callback.test.ts"],
        allowedPaths: ["test/callback.test.ts"],
        acceptance: { build: ["npm run build"], test: ["npm test -- callback.test.ts"] }
      }
    ],
    ...overrides
  };
}

describe("writeJobChainAtomic", () => {
  it("atomically writes chain.json under .codex-mimo/jobs", () => {
    const cwd = tempWorkspace();
    const manifest = sampleManifest();
    const manifestPath = resolveSliceManifestPath(cwd, "root-job-1");
    const record = createJobChainFromManifest({
      cwd,
      rootJobId: "root-job-1",
      manifest,
      manifestPath
    });

    const chainPath = resolveChainPath(cwd, manifest.chainId);
    expect(fs.existsSync(chainPath)).toBe(true);
    expect(readJobChain(cwd, manifest.chainId)).toEqual(record);
    expect(record.version).toBe(1);
    expect(record.rootJobId).toBe("root-job-1");
    expect(record.manifestPath).toBe(manifestPath.replace(/\\/g, "/"));
    expect(record.sliceStates).toEqual({
      "slice-a": "pending",
      "slice-b": "pending",
      "slice-c": "pending"
    });
    expect(record.completedSliceIds).toEqual([]);
    expect(record.childJobIds).toEqual({});
  });
});

describe("writeSliceManifestArtifact", () => {
  it("writes .codex-mimo/reports/<rootId>.slices.json atomically", () => {
    const cwd = tempWorkspace();
    const manifest = sampleManifest();
    const writtenPath = writeSliceManifestArtifact({
      cwd,
      rootJobId: "root-job-1",
      manifest
    });

    const expectedPath = resolveSliceManifestPath(cwd, "root-job-1");
    expect(writtenPath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(expectedPath, "utf8"))).toEqual(manifest);
  });
});

describe("markSliceRunning", () => {
  it("marks a slice running and records the child job id", () => {
    const cwd = tempWorkspace();
    const manifest = sampleManifest();
    const manifestPath = resolveSliceManifestPath(cwd, "root-job-1");
    createJobChainFromManifest({
      cwd,
      rootJobId: "root-job-1",
      manifest,
      manifestPath
    });

    const updated = markSliceRunning(cwd, manifest.chainId, "slice-a", "child-job-a");

    expect(updated.currentSliceId).toBe("slice-a");
    expect(updated.latestContinuationJobId).toBe("child-job-a");
    expect(updated.sliceStates["slice-a"]).toBe("running");
    expect(updated.childJobIds["slice-a"]).toBe("child-job-a");
    expect(readJobChain(cwd, manifest.chainId)).toEqual(updated);
  });
});

describe("markSliceTerminal", () => {
  it("marks a slice completed and appends completedSliceIds", () => {
    const cwd = tempWorkspace();
    const manifest = sampleManifest();
    const manifestPath = resolveSliceManifestPath(cwd, "root-job-1");
    createJobChainFromManifest({
      cwd,
      rootJobId: "root-job-1",
      manifest,
      manifestPath
    });
    markSliceRunning(cwd, manifest.chainId, "slice-a", "child-job-a");

    const updated = markSliceTerminal(cwd, manifest.chainId, "slice-a", "completed");

    expect(updated.sliceStates["slice-a"]).toBe("completed");
    expect(updated.completedSliceIds).toEqual(["slice-a"]);
    expect(updated.currentSliceId).toBeUndefined();
    expect(readJobChain(cwd, manifest.chainId)).toEqual(updated);
  });

  it("marks a slice failed without adding completedSliceIds", () => {
    const cwd = tempWorkspace();
    const manifest = sampleManifest();
    const manifestPath = resolveSliceManifestPath(cwd, "root-job-1");
    createJobChainFromManifest({
      cwd,
      rootJobId: "root-job-1",
      manifest,
      manifestPath
    });
    markSliceRunning(cwd, manifest.chainId, "slice-a", "child-job-a");

    const updated = markSliceTerminal(cwd, manifest.chainId, "slice-a", "failed");

    expect(updated.sliceStates["slice-a"]).toBe("failed");
    expect(updated.completedSliceIds).toEqual([]);
    expect(updated.currentSliceId).toBeUndefined();
  });
});

describe("selectNextReadySlice", () => {
  it("returns the first pending slice with satisfied dependencies", () => {
    const manifest = sampleManifest();
    const chain = {
      version: 1 as const,
      chainId: manifest.chainId,
      rootJobId: "root-job-1",
      manifestPath: ".codex-mimo/reports/root-job-1.slices.json",
      sliceStates: {
        "slice-a": "pending" as const,
        "slice-b": "pending" as const,
        "slice-c": "pending" as const
      },
      completedSliceIds: [] as string[],
      childJobIds: {}
    };

    expect(selectNextReadySlice(manifest, chain)?.id).toBe("slice-a");
  });

  it("returns the next slice only after dependencies complete", () => {
    const manifest = sampleManifest();
    const chain = {
      version: 1 as const,
      chainId: manifest.chainId,
      rootJobId: "root-job-1",
      manifestPath: ".codex-mimo/reports/root-job-1.slices.json",
      sliceStates: {
        "slice-a": "completed" as const,
        "slice-b": "pending" as const,
        "slice-c": "pending" as const
      },
      completedSliceIds: ["slice-a"],
      childJobIds: { "slice-a": "child-job-a" }
    };

    expect(selectNextReadySlice(manifest, chain)?.id).toBe("slice-b");
  });

  it("returns null when no pending slice has satisfied dependencies", () => {
    const manifest = sampleManifest();
    const chain = {
      version: 1 as const,
      chainId: manifest.chainId,
      rootJobId: "root-job-1",
      manifestPath: ".codex-mimo/reports/root-job-1.slices.json",
      sliceStates: {
        "slice-a": "completed" as const,
        "slice-b": "pending" as const,
        "slice-c": "pending" as const
      },
      completedSliceIds: [] as string[],
      childJobIds: {}
    };

    expect(selectNextReadySlice(manifest, chain)).toBeNull();
  });

  it("skips non-pending slices even when dependencies are satisfied", () => {
    const manifest = sampleManifest();
    const chain = {
      version: 1 as const,
      chainId: manifest.chainId,
      rootJobId: "root-job-1",
      manifestPath: ".codex-mimo/reports/root-job-1.slices.json",
      sliceStates: {
        "slice-a": "running" as const,
        "slice-b": "pending" as const,
        "slice-c": "pending" as const
      },
      completedSliceIds: [] as string[],
      childJobIds: { "slice-a": "child-job-a" }
    };

    expect(selectNextReadySlice(manifest, chain)).toBeNull();
  });
});

describe("writeJobChainAtomic round-trip", () => {
  it("persists arbitrary chain updates atomically", () => {
    const cwd = tempWorkspace();
    const record = {
      version: 1 as const,
      chainId: "chain-round-trip",
      rootJobId: "root-job-1",
      manifestPath: ".codex-mimo/reports/root-job-1.slices.json",
      sliceStates: { "slice-a": "pending" as const },
      completedSliceIds: [] as string[],
      childJobIds: {}
    };

    writeJobChainAtomic(cwd, record);
    expect(readJobChain(cwd, "chain-round-trip")).toEqual(record);
  });
});

describe("unionChangedFiles / unfinished chain", () => {
  it("unions changed files without duplicates", () => {
    expect(unionChangedFiles(["a.ts", "b.ts"], ["b.ts", "c.ts"])).toEqual([
      "a.ts",
      "b.ts",
      "c.ts"
    ]);
  });

  it("detects unfinished chains with pending slices", () => {
    const cwd = tempWorkspace();
    const manifest = sampleManifest({
      slices: sampleManifest().slices.slice(0, 2)
    });
    writeSliceManifestArtifact({ cwd, rootJobId: "root-1", manifest });
    createJobChainFromManifest({
      cwd,
      rootJobId: "root-1",
      manifest,
      manifestPath: resolveSliceManifestPath(cwd, "root-1")
    });
    expect(workspaceHasUnfinishedChain(cwd)).toBe(true);
    markSliceTerminal(cwd, manifest.chainId, "slice-a", "completed");
    markSliceTerminal(cwd, manifest.chainId, "slice-b", "completed");
    const finished = readJobChain(cwd, manifest.chainId)!;
    expect(isUnfinishedJobChain(finished)).toBe(false);
    expect(workspaceHasUnfinishedChain(cwd)).toBe(false);
  });
});

describe("advanceJobChainAfterChild", () => {
  const acceptance = {
    build: ["npm run build"],
    test: ["npm test -- focused.test.ts"]
  };

  function twoSliceManifest(chainId: string): SliceManifest {
    return {
      version: 1,
      chainId,
      objective: "Implement feature",
      repositoryFingerprint: "fp-test",
      slices: [
        {
          id: "slice-1",
          title: "Slice 1",
          objective: "Do work for slice-1",
          dependsOn: [],
          contextFiles: [],
          allowedPaths: ["src/**"],
          acceptance
        },
        {
          id: "slice-2",
          title: "Slice 2",
          objective: "Do work for slice-2",
          dependsOn: ["slice-1"],
          contextFiles: [],
          allowedPaths: ["src/**"],
          acceptance
        }
      ]
    };
  }

  async function seedTwoSliceChain(cwd: string) {
    const root = createJobStore(cwd).create({
      kind: "implement",
      task: "Implement feature",
      request: {
        cwd,
        task: "Implement feature",
        allowWrite: true,
        acceptance,
        batchMode: "sliced"
      },
      notificationTarget: { type: "codex", threadId: "thread-root" }
    });
    await updateJobAuthoritative(cwd, root.id, { status: "running", phase: "editing" });

    const boot = await bootstrapWriteJobChain(readJob(cwd, root.id)!, {
      spawnJobSupervisor: () => 1,
      captureRepositoryFingerprint: async () => "fp-test",
      planSliceManifest: async (input) => ({
        ok: true,
        manifest: twoSliceManifest(input.chainId)
      })
    });
    expect(boot.status).toBe("bootstrapped");
    if (boot.status !== "bootstrapped") throw new Error("bootstrap failed");
    return boot;
  }

  it("advances to the next slice after the first child completes", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const child = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, child.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, child.id, {
      status: "completed",
      summary: "Slice 1 done.",
      changedFiles: ["src/a.ts"],
      verification: [{ command: "npm test", exitCode: 0, passed: true }],
      acceptance: {
        stages: [{ stage: "test", outcome: "passed", command: "npm test" }]
      }
    });
    const terminalChild = readJob(cwd, child.id)!;

    const advanced = await advanceJobChainAfterChild(
      { cwd, child: terminalChild },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );

    expect(advanced.ignored).toBeUndefined();
    expect(advanced.rootTerminal).toBe(false);
    expect(advanced.startedChildId).toBeTruthy();
    expect(advanced.root.status).toBe("running");
    expect(advanced.root.changedFiles).toEqual(["src/a.ts"]);
    expect(advanced.root.summary).toBe("Executing slice 2/2: Slice 2");
    expect(advanced.deliveryCreated).toBe(false);

    const nextChild = readJob(cwd, advanced.startedChildId!)!;
    expect(nextChild.notificationTarget).toBeUndefined();
    expect(nextChild.parentJobId).toBe(boot.root.id);
    expect(nextChild.sliceId).toBe("slice-2");

    const chain = readJobChain(cwd, boot.chainId)!;
    expect(chain.sliceStates["slice-1"]).toBe("completed");
    expect(chain.sliceStates["slice-2"]).toBe("running");
    expect(chain.completedSliceIds).toEqual(["slice-1"]);

    expect(readDeliveries(nextChild.notificationOutboxFile)).toHaveLength(0);
    expect(readDeliveries(advanced.root.notificationOutboxFile)).toHaveLength(0);
  });

  it("aggregates source changes and artifacts separately onto the root when the last slice completes", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const first = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, first.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, first.id, {
      status: "completed",
      summary: "Slice 1 done.",
      changedFiles: ["src/a.ts"],
      artifactFiles: ["build/a.js"]
    });
    const afterFirst = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, first.id)! },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );
    const second = readJob(cwd, afterFirst.startedChildId!)!;
    await transitionJob(cwd, second.id, {
      status: "running",
      summary: "running slice 2",
      phase: "editing"
    });
    await transitionJob(cwd, second.id, {
      status: "completed",
      summary: "Slice 2 done.",
      changedFiles: ["src/b.ts", "src/a.ts"],
      artifactFiles: ["build/b.js", "build/a.js"]
    });

    const advanced = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, second.id)! },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );

    expect(advanced.rootTerminal).toBe(true);
    expect(advanced.root.status).toBe("completed");
    expect(advanced.root.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(advanced.root.artifactFiles).toEqual(["build/a.js", "build/b.js"]);
    expect(advanced.root.changedFiles).not.toContain("build/a.js");
    expect(advanced.root.changedFiles).not.toContain("build/b.js");
    expect(advanced.deliveryCreated).toBe(true);
    expect(readDeliveries(advanced.root.notificationOutboxFile).some(
      (delivery) => delivery.jobId === advanced.root.id
    )).toBe(true);
    expect(second.notificationTarget).toBeUndefined();
  });

  it("keeps two slice artifact sets stable across duplicate terminal delivery and recovery", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const first = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, first.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, first.id, {
      status: "completed",
      summary: "Slice 1 done.",
      changedFiles: ["src/a.ts"],
      artifactFiles: ["build/a.js"]
    });
    const afterFirst = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, first.id)! },
      { writeRootCheckpoint: async () => undefined, spawnJobSupervisor: () => 1 }
    );
    const second = readJob(cwd, afterFirst.startedChildId!)!;
    await transitionJob(cwd, second.id, {
      status: "running",
      summary: "running slice 2",
      phase: "editing"
    });
    await transitionJob(cwd, second.id, {
      status: "completed",
      summary: "Slice 2 done.",
      changedFiles: ["src/b.ts"],
      artifactFiles: ["build/b.js"]
    });

    const completed = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, second.id)! },
      { writeRootCheckpoint: async () => undefined, spawnJobSupervisor: () => 1 }
    );
    const duplicate = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, second.id)! },
      { writeRootCheckpoint: async () => undefined, spawnJobSupervisor: () => 1 }
    );
    const recovered = await continueJobChainOrchestration(
      { cwd, chain: readJobChain(cwd, boot.chainId)! },
      { writeRootCheckpoint: async () => undefined, spawnJobSupervisor: () => 1 }
    );

    for (const result of [completed, duplicate, recovered]) {
      expect(result.root.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
      expect(result.root.artifactFiles).toEqual(["build/a.js", "build/b.js"]);
      expect(result.root.changedFiles).not.toContain("build/a.js");
      expect(result.root.changedFiles).not.toContain("build/b.js");
    }
  });

  it("serializes concurrent terminal and recovery advances without dropping a child file", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const first = readJob(cwd, boot.childJobId)!;
    const second = createJobStore(cwd).create({
      kind: "implement",
      task: "Slice 2",
      request: { cwd, task: "Slice 2", allowWrite: true, acceptance },
      parentJobId: boot.root.id,
      chainId: boot.chainId,
      sliceId: "slice-2"
    });
    markSliceRunning(cwd, boot.chainId, "slice-2", second.id);

    for (const [child, file, artifact] of [
      [first, "src/a.ts", "build/a.js"],
      [second, "src/b.ts", "build/b.js"]
    ] as const) {
      await transitionJob(cwd, child.id, {
        status: "running",
        summary: `running ${child.sliceId}`,
        phase: "editing"
      });
      await transitionJob(cwd, child.id, {
        status: "completed",
        summary: `${child.sliceId} done`,
        changedFiles: [file],
        artifactFiles: [artifact]
      });
    }

    let firstCheckpointReached!: () => void;
    const firstCheckpoint = new Promise<void>((resolve) => {
      firstCheckpointReached = resolve;
    });
    let releaseFirstCheckpoint!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirstCheckpoint = resolve;
    });
    let checkpointCalls = 0;
    const writeRootCheckpoint = async () => {
      if (checkpointCalls++ === 0) {
        firstCheckpointReached();
        await release;
      }
    };
    const dependencies = { writeRootCheckpoint, spawnJobSupervisor: () => 1 };

    const firstAdvance = advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, first.id)! },
      dependencies
    );
    await firstCheckpoint;
    const secondAdvance = advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, second.id)! },
      dependencies
    );
    releaseFirstCheckpoint();
    await Promise.all([firstAdvance, secondAdvance]);

    const root = readJob(cwd, boot.root.id)!;
    expect(root.status).toBe("completed");
    expect(root.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(root.artifactFiles).toEqual(["build/a.js", "build/b.js"]);
    expect(root.changedFiles).not.toContain("build/a.js");
    expect(root.changedFiles).not.toContain("build/b.js");
    expect(readJobChain(cwd, boot.chainId)?.completedSliceIds.sort())
      .toEqual(["slice-1", "slice-2"]);
  });

  it("on child failure leaves later slices pending, sets slice_failed, and notifies only the root", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const child = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, child.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, child.id, {
      status: "failed",
      summary: "Slice 1 failed.",
      error: "build broke",
      errorCode: "build_failed",
      changedFiles: ["src/a.ts"],
      acceptance: {
        stages: [{ stage: "build", outcome: "failed", command: "npm run build" }],
        failedStage: "build",
        failedCommand: "npm run build",
        suggestion: "Fix the first build error."
      }
    });

    const advanced = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, child.id)! },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );

    expect(advanced.rootTerminal).toBe(true);
    expect(advanced.root.status).toBe("failed");
    expect(advanced.root.errorCode).toBe("slice_failed");
    expect(advanced.root.changedFiles).toEqual(["src/a.ts"]);
    expect(advanced.root.acceptance).toMatchObject({
      failedStage: "build",
      failedCommand: "npm run build",
      suggestion: "Fix the first build error."
    });
    expect(advanced.root.failureCauses).toEqual([
      expect.objectContaining({
        code: "build_failed",
        stage: "build",
        command: "npm run build",
        suggestion: "Fix the first build error."
      })
    ]);
    expect(advanced.startedChildId).toBeUndefined();
    expect(advanced.deliveryCreated).toBe(true);

    const chain = readJobChain(cwd, boot.chainId)!;
    expect(chain.sliceStates["slice-1"]).toBe("failed");
    expect(chain.sliceStates["slice-2"]).toBe("pending");
    expect(chain.completedSliceIds).toEqual([]);

    const deliveries = readDeliveries(advanced.root.notificationOutboxFile);
    expect(deliveries.every((delivery) => delivery.jobId === advanced.root.id)).toBe(true);
    expect(deliveries.some((delivery) => delivery.jobId === child.id)).toBe(false);
  });

  it("preserves a non-resumable child failure and cancels remaining slices", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const child = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, child.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, child.id, {
      status: "failed",
      summary: "MiMoCode prompt identity did not match the job query.",
      error: "MiMoCode prompt identity did not match the job query.",
      errorCode: "prompt_identity_mismatch",
      sessionId: "ses-identity",
      failureCauses: [{ code: "prompt_identity_mismatch", stage: "prompt" }]
    });

    const advanced = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, child.id)! },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );

    expect(advanced.rootTerminal).toBe(true);
    expect(advanced.root).toMatchObject({
      status: "failed",
      errorCode: "prompt_identity_mismatch",
      sessionId: "ses-identity",
      failureCauses: [{ code: "prompt_identity_mismatch", stage: "prompt" }]
    });

    const chain = readJobChain(cwd, boot.chainId)!;
    expect(chain.sliceStates).toMatchObject({
      "slice-1": "failed",
      "slice-2": "cancelled"
    });
  });

  it("ignores non-chain children", async () => {
    const cwd = tempWorkspace();
    const job = createJobStore(cwd).create({
      kind: "implement",
      task: "solo",
      request: { cwd, task: "solo", allowWrite: true, acceptance }
    });
    await transitionJob(cwd, job.id, {
      status: "running",
      summary: "go",
      phase: "editing"
    });
    await transitionJob(cwd, job.id, {
      status: "completed",
      summary: "done"
    });

    const advanced = await advanceJobChainAfterChild({
      cwd,
      child: readJob(cwd, job.id)!
    });
    expect(advanced.ignored).toBe(true);
  });

  it("does not spawn the next slice when the root is cancelled", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const child = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, child.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, child.id, {
      status: "completed",
      summary: "Slice 1 done.",
      changedFiles: ["src/a.ts"]
    });
    await transitionJob(cwd, boot.root.id, {
      status: "cancelled",
      summary: `Cancelled ${boot.root.id}.`,
      errorCode: "cancelled"
    });

    const beforeJobs = listJobs(cwd).map((job) => job.id).sort();
    const advanced = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, child.id)! },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );

    expect(advanced.startedChildId).toBeUndefined();
    expect(advanced.root.status).toBe("cancelled");
    expect(listJobs(cwd).map((job) => job.id).sort()).toEqual(beforeJobs);
    const chain = readJobChain(cwd, boot.chainId)!;
    expect(chain.sliceStates["slice-1"]).toBe("completed");
    expect(chain.sliceStates["slice-2"]).toBe("cancelled");
  });

  it("does not spawn the next slice when cancellation was requested on the root", async () => {
    const cwd = tempWorkspace();
    const boot = await seedTwoSliceChain(cwd);
    const child = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, child.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, child.id, {
      status: "completed",
      summary: "Slice 1 done.",
      changedFiles: ["src/a.ts"]
    });
    await updateJobAuthoritative(cwd, boot.root.id, {
      cancellationRequestedAt: new Date().toISOString()
    });

    const beforeJobs = listJobs(cwd).map((job) => job.id).sort();
    const advanced = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, child.id)! },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );

    expect(advanced.startedChildId).toBeUndefined();
    expect(advanced.root.status).toBe("cancelled");
    expect(listJobs(cwd).map((job) => job.id).sort()).toEqual(beforeJobs);
    expect(readJobChain(cwd, boot.chainId)?.sliceStates["slice-2"]).toBe("cancelled");
  });
});

describe("chain crash recovery", () => {
  const acceptance = {
    build: ["npm run build"],
    test: ["npm test -- focused.test.ts"]
  };

  it("marks a dead running slice stalled and mirrors root attention without relaunching completed slices", async () => {
    const cwd = tempWorkspace();
    const boot = await (async () => {
      const root = createJobStore(cwd).create({
        kind: "implement",
        task: "Implement feature",
        request: {
          cwd,
          task: "Implement feature",
          allowWrite: true,
          acceptance,
          batchMode: "sliced"
        },
        notificationTarget: { type: "codex", threadId: "thread-root" }
      });
      await updateJobAuthoritative(cwd, root.id, { status: "running", phase: "editing" });
      return bootstrapWriteJobChain(readJob(cwd, root.id)!, {
        spawnJobSupervisor: () => 1,
        captureRepositoryFingerprint: async () => "fp-test",
        planSliceManifest: async (input) => ({
          ok: true,
          manifest: {
            version: 1 as const,
            chainId: input.chainId,
            objective: "Implement feature",
            repositoryFingerprint: "fp-test",
            slices: [
              {
                id: "slice-1",
                title: "Slice 1",
                objective: "Do work for slice-1",
                dependsOn: [],
                contextFiles: [],
                allowedPaths: ["src/**"],
                acceptance
              },
              {
                id: "slice-2",
                title: "Slice 2",
                objective: "Do work for slice-2",
                dependsOn: ["slice-1"],
                contextFiles: [],
                allowedPaths: ["src/**"],
                acceptance
              }
            ]
          }
        })
      });
    })();
    expect(boot.status).toBe("bootstrapped");
    if (boot.status !== "bootstrapped") throw new Error("bootstrap failed");

    const first = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, first.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, first.id, {
      status: "completed",
      summary: "Slice 1 done.",
      changedFiles: ["src/a.ts"]
    });
    const afterFirst = await advanceJobChainAfterChild(
      { cwd, child: readJob(cwd, first.id)! },
      {
        writeRootCheckpoint: async () => undefined,
        spawnJobSupervisor: () => 1
      }
    );
    const secondId = afterFirst.startedChildId!;
    await transitionJob(cwd, secondId, {
      status: "running",
      summary: "running slice 2",
      phase: "editing",
      pid: 4242,
      processIdentity: "start-4242"
    });
    const secondBeforeWrite = readJob(cwd, secondId)!;
    const checkpointPaths = await writeJobCheckpoint({
      job: secondBeforeWrite,
      objective: secondBeforeWrite.task,
      workspaceManifestBefore: captureScopedWorkspaceManifest(cwd, ["src/**"])
    });
    await updateJobAuthoritative(cwd, secondId, { reportPaths: checkpointPaths });
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "b.ts"), "broken partial write\n", "utf8");

    const beforeJobs = listJobs(cwd).map((job) => job.id).sort();
    await recoverUnfinishedJobChains(cwd, {
      processIsRunning: () => false,
      workerOwnershipIsHeld: async () => false,
      writeRootCheckpoint: async () => undefined,
      spawnJobSupervisor: () => 1
    });

    const second = readJob(cwd, secondId)!;
    expect(second.status).toBe("stalled");
    expect(second.errorCode).toBe("worker_lost");
    expect(second.changedFiles).toEqual(["src/b.ts"]);
    expect(second.reconciliation).toMatchObject({
      status: "complete",
      changeDetection: {
        status: "complete",
        sources: ["scope_manifest"]
      }
    });
    expect(readJobCheckpoint(second.reportPaths?.checkpoint ?? "")?.changedFiles)
      .toEqual(["src/b.ts"]);
    expect(readJob(cwd, boot.root.id)).toMatchObject({
      status: "stalled",
      errorCode: "worker_lost",
      changedFiles: ["src/a.ts", "src/b.ts"]
    });
    const chain = readJobChain(cwd, boot.chainId)!;
    expect(chain.sliceStates["slice-1"]).toBe("completed");
    expect(chain.sliceStates["slice-2"]).toBe("stalled");
    expect(chain.completedSliceIds).toEqual(["slice-1"]);
    expect(listJobs(cwd).map((job) => job.id).sort()).toEqual(beforeJobs);
    expect(listJobs(cwd).filter((job) => job.sliceId === "slice-1")).toHaveLength(1);
  });

  it("leaves a live owned running slice alone", async () => {
    const cwd = tempWorkspace();
    const boot = await (async () => {
      const root = createJobStore(cwd).create({
        kind: "implement",
        task: "Implement feature",
        request: {
          cwd,
          task: "Implement feature",
          allowWrite: true,
          acceptance,
          batchMode: "single",
          allowedPaths: ["src/**"]
        },
        notificationTarget: { type: "codex", threadId: "thread-root" }
      });
      await updateJobAuthoritative(cwd, root.id, { status: "running", phase: "editing" });
      return bootstrapWriteJobChain(readJob(cwd, root.id)!, {
        spawnJobSupervisor: () => 1,
        captureRepositoryFingerprint: async () => "fp-test"
      });
    })();
    expect(boot.status).toBe("bootstrapped");
    if (boot.status !== "bootstrapped") throw new Error("bootstrap failed");
    await transitionJob(cwd, boot.childJobId, {
      status: "running",
      summary: "running",
      phase: "editing",
      pid: 5151,
      processIdentity: "start-5151"
    });

    await recoverUnfinishedJobChains(cwd, {
      processIsRunning: () => true,
      workerOwnershipIsHeld: async () => true,
      verifyProcess: () => ({ status: "match" as const, evidence: "live" })
    });

    expect(readJob(cwd, boot.childJobId)).toMatchObject({ status: "running", pid: 5151 });
    expect(readJobChain(cwd, boot.chainId)?.sliceStates["slice-1"]).toBe("running");
    expect(readJob(cwd, boot.root.id)?.status).toBe("running");
  });

  it("starts the next ready slice when recovery finds completed current and no live child", async () => {
    const cwd = tempWorkspace();
    const boot = await (async () => {
      const root = createJobStore(cwd).create({
        kind: "implement",
        task: "Implement feature",
        request: {
          cwd,
          task: "Implement feature",
          allowWrite: true,
          acceptance,
          batchMode: "sliced"
        },
        notificationTarget: { type: "codex", threadId: "thread-root" }
      });
      await updateJobAuthoritative(cwd, root.id, { status: "running", phase: "editing" });
      return bootstrapWriteJobChain(readJob(cwd, root.id)!, {
        spawnJobSupervisor: () => 1,
        captureRepositoryFingerprint: async () => "fp-test",
        planSliceManifest: async (input) => ({
          ok: true,
          manifest: {
            version: 1 as const,
            chainId: input.chainId,
            objective: "Implement feature",
            repositoryFingerprint: "fp-test",
            slices: [
              {
                id: "slice-1",
                title: "Slice 1",
                objective: "Do work for slice-1",
                dependsOn: [],
                contextFiles: [],
                allowedPaths: ["src/**"],
                acceptance
              },
              {
                id: "slice-2",
                title: "Slice 2",
                objective: "Do work for slice-2",
                dependsOn: ["slice-1"],
                contextFiles: [],
                allowedPaths: ["src/**"],
                acceptance
              }
            ]
          }
        })
      });
    })();
    expect(boot.status).toBe("bootstrapped");
    if (boot.status !== "bootstrapped") throw new Error("bootstrap failed");

    const first = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, first.id, {
      status: "running",
      summary: "running slice 1",
      phase: "editing"
    });
    await transitionJob(cwd, first.id, {
      status: "completed",
      summary: "Slice 1 done.",
      changedFiles: ["src/a.ts"]
    });
    // Simulate crash after markSliceTerminal(completed) before spawning slice-2.
    markSliceTerminal(cwd, boot.chainId, "slice-1", "completed");
    const chainBefore = readJobChain(cwd, boot.chainId)!;
    expect(chainBefore.sliceStates["slice-1"]).toBe("completed");
    expect(chainBefore.sliceStates["slice-2"]).toBe("pending");
    expect(chainBefore.currentSliceId).toBeUndefined();

    const recovered = await recoverUnfinishedJobChains(cwd, {
      processIsRunning: () => false,
      workerOwnershipIsHeld: async () => false,
      writeRootCheckpoint: async () => undefined,
      spawnJobSupervisor: () => 1
    });

    expect(recovered.recoveredChildIds.length).toBeGreaterThanOrEqual(1);
    const chain = readJobChain(cwd, boot.chainId)!;
    expect(chain.sliceStates["slice-1"]).toBe("completed");
    expect(chain.sliceStates["slice-2"]).toBe("running");
    expect(chain.latestContinuationJobId).toBeTruthy();
    expect(readJob(cwd, chain.latestContinuationJobId!)?.sliceId).toBe("slice-2");
    expect(readJob(cwd, boot.root.id)?.status).toBe("running");
  });

  it("finalizes the root when recovery finds all slices completed with no live child", async () => {
    const cwd = tempWorkspace();
    const boot = await (async () => {
      const root = createJobStore(cwd).create({
        kind: "implement",
        task: "Implement feature",
        request: {
          cwd,
          task: "Implement feature",
          allowWrite: true,
          acceptance,
          batchMode: "sliced"
        },
        notificationTarget: { type: "codex", threadId: "thread-root" }
      });
      await updateJobAuthoritative(cwd, root.id, { status: "running", phase: "editing" });
      return bootstrapWriteJobChain(readJob(cwd, root.id)!, {
        spawnJobSupervisor: () => 1,
        captureRepositoryFingerprint: async () => "fp-test",
        planSliceManifest: async (input) => ({
          ok: true,
          manifest: {
            version: 1 as const,
            chainId: input.chainId,
            objective: "Implement feature",
            repositoryFingerprint: "fp-test",
            slices: [
              {
                id: "slice-1",
                title: "Slice 1",
                objective: "Do work for slice-1",
                dependsOn: [],
                contextFiles: [],
                allowedPaths: ["src/**"],
                acceptance
              }
            ]
          }
        })
      });
    })();
    expect(boot.status).toBe("bootstrapped");
    if (boot.status !== "bootstrapped") throw new Error("bootstrap failed");

    const child = readJob(cwd, boot.childJobId)!;
    await transitionJob(cwd, child.id, {
      status: "running",
      summary: "running",
      phase: "editing"
    });
    await transitionJob(cwd, child.id, {
      status: "completed",
      summary: "done",
      changedFiles: ["src/a.ts"]
    });
    markSliceTerminal(cwd, boot.chainId, "slice-1", "completed");
    await updateJobAuthoritative(cwd, boot.root.id, {
      changedFiles: ["src/a.ts"],
      summary: "Executing slice 1/1: Slice 1"
    });

    await recoverUnfinishedJobChains(cwd, {
      processIsRunning: () => false,
      workerOwnershipIsHeld: async () => false,
      writeRootCheckpoint: async () => undefined,
      spawnJobSupervisor: () => 1
    });

    expect(readJob(cwd, boot.root.id)?.status).toBe("completed");
    expect(isUnfinishedJobChain(readJobChain(cwd, boot.chainId)!)).toBe(false);
  });
});
