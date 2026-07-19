import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execa: vi.fn()
}));

vi.mock("execa", () => ({ execa: mocks.execa }));

import { runDoctor } from "../../src/cli/doctor.js";
import { createJobStore, resolveJobPaths } from "../../src/core/job-store.js";
import { mimoHealthcheck } from "../../src/codex/tools.js";
import { enqueueDelivery } from "../../src/notify/outbox.js";

const temporaryRoots: string[] = [];

function createWorkspaceWithWebhookSecret(secretEnv: string): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "codex-mimo-version-probe-"));
  temporaryRoots.push(cwd);
  createJobStore(cwd).create({
    kind: "plan",
    task: "Do not expose the webhook secret.",
    request: {},
    notificationTarget: {
      type: "webhook",
      url: "https://example.test/hook",
      secretEnv
    }
  });
  return cwd;
}

async function createWorkspaceWithRetainedOutboxSecret(secretEnv: string): Promise<string> {
  const cwd = mkdtempSync(path.join(tmpdir(), "codex-mimo-version-probe-outbox-"));
  temporaryRoots.push(cwd);
  const job = createJobStore(cwd).create({
    kind: "plan",
    task: "Keep the webhook secret only in the outbox.",
    request: {},
    notificationTarget: {
      type: "webhook",
      url: "https://example.test/hook",
      secretEnv
    }
  });
  await enqueueDelivery(job.notificationOutboxFile, {
    jobId: job.id,
    signalCursor: 1,
    target: job.notificationTarget!,
    createdAt: "2026-07-18T00:00:00.000Z"
  });
  rmSync(resolveJobPaths(cwd, job.id).jobFile, { force: true });
  return cwd;
}

function createPluginRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-mimo-version-doctor-"));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(path.join(root, "skills", "mimocode"), { recursive: true });
  mkdirSync(path.join(root, "dist", "codex"), { recursive: true });
  writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), "{}", "utf-8");
  writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "codex-mimocode": { type: "stdio", command: "node", args: ["dist/codex/mcp-server.js"] }
    }
  }), "utf-8");
  writeFileSync(path.join(root, "skills", "mimocode", "SKILL.md"), "---\nname: mimocode\n---\n", "utf-8");
  writeFileSync(path.join(root, "dist", "codex", "mcp-server.js"), "export {};\n", "utf-8");
  return root;
}

function expectProbeEnvironmentToOmit(secretEnv: string, secretValue: string): void {
  const options = mocks.execa.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
  expect(options?.env).toBeDefined();
  expect(options?.env?.SAFE_VERSION_PROBE_VALUE).toBe("retained");
  expect(Object.entries(options?.env ?? {}).filter(([name]) =>
    name.toLowerCase() === secretEnv.toLowerCase()
  )).toEqual([]);
  expect(JSON.stringify(options?.env)).not.toContain(secretValue);
}

afterEach(() => {
  vi.unstubAllEnvs();
  mocks.execa.mockReset();
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe("MiMo version probes", () => {
  it("does not select a persisted CODEX_MIMO_COMMAND secret for mimo_healthcheck", async () => {
    const secretEnv = "CODEX_MIMO_COMMAND";
    const secretValue = "healthcheck-command-secret";
    const cwd = createWorkspaceWithWebhookSecret(secretEnv);
    vi.stubEnv(secretEnv, secretValue);
    mocks.execa.mockResolvedValue({ stdout: "mimo 0.5.0\n" });

    await mimoHealthcheck({ cwd });

    expect(mocks.execa.mock.calls[0]?.[0]).toBe("mimo");
    expect(JSON.stringify(mocks.execa.mock.calls[0])).not.toContain(secretValue);
  });

  it("does not select or persist a persisted MIMO_COMMAND secret for the doctor probe", async () => {
    const secretEnv = "MIMO_COMMAND";
    const secretValue = "doctor-command-secret";
    const cwd = createWorkspaceWithWebhookSecret(secretEnv);
    const pluginRoot = createPluginRoot();
    vi.stubEnv(secretEnv, secretValue);
    mocks.execa.mockImplementation(async (command: string) => {
      throw new Error(`spawn ${command} ENOENT`);
    });

    const report = await runDoctor(
      { cwd, pluginRoot },
      { probeMcpTools: vi.fn().mockResolvedValue([]) }
    );

    expect(mocks.execa.mock.calls[0]?.[0]).toBe("mimo");
    expect(JSON.stringify(report)).not.toContain(secretValue);
  });

  it("does not pass a persisted webhook secret to mimo_healthcheck", async () => {
    const secretEnv = "MIMO_HEALTHCHECK_SECRET";
    const secretValue = "healthcheck-secret-value";
    const cwd = createWorkspaceWithWebhookSecret(secretEnv);
    vi.stubEnv(secretEnv, secretValue);
    vi.stubEnv("SAFE_VERSION_PROBE_VALUE", "retained");
    mocks.execa.mockResolvedValue({ stdout: "mimo 0.5.0\n" });

    await mimoHealthcheck({ cwd });

    expectProbeEnvironmentToOmit(secretEnv, secretValue);
  });

  it("does not pass a persisted webhook secret to the doctor MiMo probe", async () => {
    const secretEnv = "MIMO_DOCTOR_SECRET";
    const secretValue = "doctor-secret-value";
    const cwd = createWorkspaceWithWebhookSecret(secretEnv);
    const pluginRoot = createPluginRoot();
    vi.stubEnv(secretEnv, secretValue);
    vi.stubEnv("SAFE_VERSION_PROBE_VALUE", "retained");
    mocks.execa.mockResolvedValue({ stdout: "mimo 0.5.0\n", stderr: "", exitCode: 0 });

    await runDoctor(
      { cwd, pluginRoot },
      { probeMcpTools: vi.fn().mockResolvedValue([]) }
    );

    expectProbeEnvironmentToOmit(secretEnv, secretValue);
  });

  it("does not pass an outbox-retained webhook secret after its job file is deleted", async () => {
    const secretEnv = "MIMO_RETAINED_OUTBOX_SECRET";
    const secretValue = "retained-outbox-secret-value";
    const cwd = await createWorkspaceWithRetainedOutboxSecret(secretEnv);
    vi.stubEnv(secretEnv, secretValue);
    vi.stubEnv("SAFE_VERSION_PROBE_VALUE", "retained");
    mocks.execa.mockResolvedValue({ stdout: "mimo 0.5.0\n" });

    await mimoHealthcheck({ cwd });

    expectProbeEnvironmentToOmit(secretEnv, secretValue);
  });
});
