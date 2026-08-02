import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMimoJsonLines } from "../../src/compose/events.js";
import { createComposeReport, writeComposeReport } from "../../src/compose/report.js";
import { buildComposePrompt, getComposeWorkflow } from "../../src/compose/workflow.js";
import { preparePromptTransport } from "../../src/mimo/prompt-transport.js";
import {
  buildMimoExecutionEnv,
  MimoExecutionEnvironmentError,
  omitEnvironmentVariables,
  withUtf8ProcessEnv
} from "../../src/core/encoding.js";

describe("Windows UTF-8 encoding regressions", () => {
  const sample = "基于 Windows 本地执行器 — 🎬";

  it("tells Windows workflows to read text and run Python with UTF-8", () => {
    const prompt = buildComposePrompt({
      workflow: getComposeWorkflow("fix"),
      task: "Read a UTF-8 report and diagnose it."
    });

    expect(prompt).toContain("Get-Content -Encoding UTF8");
    expect(prompt).not.toContain("Get-Content | Measure-Object");
    expect(prompt).toContain("PYTHONUTF8=1");
    expect(prompt).toContain("PYTHONIOENCODING=utf-8");
  });

  it("preserves UTF-8 prompt files without persisting MiMo message text in reports", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-utf8-"));
    const prompt = `Objective: ${sample}`;
    const transported = preparePromptTransport(prompt, { cwd, forceFile: true });
    const promptFile = transported.files[0];

    expect(fs.readFileSync(promptFile)).toEqual(Buffer.from(prompt, "utf-8"));
    expect(fs.readFileSync(promptFile, "utf-8")).toBe(prompt);
    expect(transported.message).toContain("UTF-8");
    expect(transported.message).not.toMatch(/[\r\n]/);
    expect(transported.message).not.toContain(cwd);

    const report = createComposeReport({
      id: "utf8-run",
      createdAt: "2026-06-29T00:00:00.000Z",
      cwd,
      workflow: "fix",
      requestedSkills: ["compose:debug", "compose:tdd", "compose:verify", "compose:feedback"],
      events: parseMimoJsonLines(`${JSON.stringify({ type: "message", text: sample })}\n`),
      diff: { changedFiles: [], diffStat: "", diff: "" },
      verification: [],
      reportDir: path.join(cwd, ".codex-mimo", "reports"),
      eventsDir: path.join(cwd, ".codex-mimo", "events"),
      diffsDir: path.join(cwd, ".codex-mimo", "diffs"),
      status: "passed"
    });

    writeComposeReport(report);

    expect(fs.readFileSync(report.reportPaths.markdown, "utf-8")).not.toContain(sample);
    expect(fs.readFileSync(report.reportPaths.eventsJsonl, "utf-8")).not.toContain(sample);
    expect(fs.readFileSync(report.reportPaths.eventsJsonl, "utf-8")).toContain('"type":"message"');
  });
});

describe("process environment omission semantics", () => {
  it("omits a lower-case Windows secret when its configured name is upper-case", () => {
    const source = { webhook_secret: "secret", UNRELATED_VALUE: "kept" };
    const result = omitEnvironmentVariables(source, ["WEBHOOK_SECRET"], { caseInsensitive: true });

    expect(result).toEqual({ UNRELATED_VALUE: "kept" });
    expect(source).toEqual({ webhook_secret: "secret", UNRELATED_VALUE: "kept" });
  });

  it("omits every Windows casing when the configured secret name is lower-case", () => {
    const source = {
      WEBHOOK_SECRET: "upper-secret",
      WebHook_Secret: "mixed-secret",
      webhook_secret: "lower-secret",
      CODEX_MIMO_CALLBACK_TOKEN: "callback-token"
    };
    const base = { webhook_secret: "base-secret", BASE_VALUE: "kept" };
    const beforeProcessEnv = { ...process.env };
    const result = withUtf8ProcessEnv(source, {
      base,
      omit: ["webhook_secret"],
      platform: "win32"
    });

    expect(Object.keys(result).filter((key) => key.toLowerCase() === "webhook_secret")).toEqual([]);
    expect(result.CODEX_MIMO_CALLBACK_TOKEN).toBe("callback-token");
    expect(result).toMatchObject({ PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
    expect(source).toEqual({
      WEBHOOK_SECRET: "upper-secret",
      WebHook_Secret: "mixed-secret",
      webhook_secret: "lower-secret",
      CODEX_MIMO_CALLBACK_TOKEN: "callback-token"
    });
    expect(base).toEqual({ webhook_secret: "base-secret", BASE_VALUE: "kept" });
    expect(process.env).toEqual(beforeProcessEnv);
  });

  it("keeps POSIX environment omission case-sensitive", () => {
    const result = withUtf8ProcessEnv(
      { WEBHOOK_SECRET: "keep-upper", webhook_secret: "remove-lower" },
      { base: {}, omit: ["webhook_secret"], platform: "linux" }
    );

    expect(result.WEBHOOK_SECRET).toBe("keep-upper");
    expect(result.webhook_secret).toBeUndefined();
  });
});

describe("MiMo execution environment", () => {
  it("keeps bridge configuration and known provider credentials in compat mode without inheriting host secrets", () => {
    const base = {
      PATH: "C:/Windows/System32",
      HOME: "/home/mimo",
      OPENAI_API_KEY: "provider-key",
      MIMOCODE_CONFIG_DIR: "/home/mimo/.config/mimocode",
      WEBHOOK_SECRET: "notification-secret",
      GITHUB_TOKEN: "github-secret",
      RANDOM_TOKEN: "unrelated-secret",
      AWS_ACCESS_KEY_ID: "cloud-key",
      CODEX_MIMO_COMMAND: "mimo-private-command"
    };
    const additions = {
      CODEX_MIMO_CALLBACK_ENDPOINT: "http://127.0.0.1:1234/mimo-hook",
      CODEX_MIMO_CALLBACK_TOKEN: "one-run-token",
      MIMOCODE_CONFIG_CONTENT: "{}"
    };

    const result = buildMimoExecutionEnv(base, additions, { platform: "linux" });

    expect(result.env).toMatchObject({
      PATH: "C:/Windows/System32",
      HOME: "/home/mimo",
      OPENAI_API_KEY: "provider-key",
      MIMOCODE_CONFIG_DIR: "/home/mimo/.config/mimocode",
      CODEX_MIMO_CALLBACK_ENDPOINT: "http://127.0.0.1:1234/mimo-hook",
      CODEX_MIMO_CALLBACK_TOKEN: "one-run-token"
    });
    expect(result.env).not.toHaveProperty("WEBHOOK_SECRET");
    expect(result.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(result.env).not.toHaveProperty("RANDOM_TOKEN");
    expect(result.env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(result.env).not.toHaveProperty("CODEX_MIMO_COMMAND");
    expect(result.audit).toMatchObject({ policy: "compat" });
    expect(result.audit.passedNames).toContain("OPENAI_API_KEY");
    expect(result.audit.omittedCount).toBeGreaterThanOrEqual(5);
    expect(base.WEBHOOK_SECRET).toBe("notification-secret");
    expect(additions.CODEX_MIMO_CALLBACK_TOKEN).toBe("one-run-token");
  });

  it("keeps only a selected provider credential in strict mode and fails closed when it is absent", () => {
    const result = buildMimoExecutionEnv({
      PATH: "/bin",
      OPENAI_API_KEY: "openai-key",
      ANTHROPIC_API_KEY: "anthropic-key",
      MIMOCODE_CONFIG_CONTENT: JSON.stringify({ provider: "openai" })
    }, {
      CODEX_MIMO_CALLBACK_TOKEN: "callback"
    }, { platform: "linux", policy: "strict" });

    expect(result.env).toMatchObject({ PATH: "/bin", OPENAI_API_KEY: "openai-key" });
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.audit).toMatchObject({ policy: "strict", provider: "openai" });

    expect(() => buildMimoExecutionEnv({ PATH: "/bin" }, {}, {
      platform: "linux",
      policy: "strict",
      provider: "openai"
    })).toThrow(MimoExecutionEnvironmentError);
    try {
      buildMimoExecutionEnv({ PATH: "/bin" }, {}, {
        platform: "linux",
        policy: "strict",
        provider: "openai"
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "strict_credentials_missing",
        variableNames: ["OPENAI_API_KEY"]
      });
      expect(String(error)).not.toContain("openai-key");
    }
  });

  it("passes an explicit MiMo provider selection through to the child", () => {
    const result = buildMimoExecutionEnv({
      PATH: "/bin",
      MIMOCODE_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-key"
    }, {}, { platform: "linux", policy: "strict" });

    expect(result.env).toMatchObject({
      MIMOCODE_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-key"
    });
    expect(result.audit).toMatchObject({ provider: "openai" });
  });

  it("requires a reliable provider selection in strict mode", () => {
    expect(() => buildMimoExecutionEnv({ PATH: "/bin", OPENAI_API_KEY: "present" }, {}, {
      platform: "linux",
      policy: "strict"
    })).toThrow(/requires a known explicitly selected provider/i);
  });

  it("deduplicates Windows environment names and retains required system variables", () => {
    const result = buildMimoExecutionEnv({
      Path: "old-path",
      PATH: "new-path",
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      TEMP: "C:\\Temp",
      USERPROFILE: "C:\\Users\\mimo",
      openai_api_key: "provider-key"
    }, {}, { platform: "win32" });

    expect(Object.keys(result.env).filter((key) => key.toUpperCase() === "PATH")).toHaveLength(1);
    expect(result.env.PATH).toBe("new-path");
    expect(result.env.SystemRoot).toBe("C:\\Windows");
    expect(result.env.windir).toBe("C:\\Windows");
    expect(result.env.ComSpec).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(result.env.openai_api_key).toBe("provider-key");
  });

  it("does not let allowEnv reintroduce notification, command, or arbitrary secret variables", () => {
    const result = buildMimoExecutionEnv({
      PATH: "/bin",
      WEBHOOK_SECRET: "notification",
      UNRELATED_TOKEN: "token",
      UNRELATED_API_KEY: "api-key",
      CODEX_MIMO_COMMAND: "host-command",
      SAFE_SETTING: "safe"
    }, {}, {
      platform: "linux",
      allowEnv: ["WEBHOOK_SECRET", "UNRELATED_TOKEN", "UNRELATED_API_KEY", "CODEX_MIMO_COMMAND", "SAFE_SETTING"]
    });

    expect(result.env.SAFE_SETTING).toBe("safe");
    expect(result.env.WEBHOOK_SECRET).toBeUndefined();
    expect(result.env.UNRELATED_TOKEN).toBeUndefined();
    expect(result.env.UNRELATED_API_KEY).toBeUndefined();
    expect(result.env.CODEX_MIMO_COMMAND).toBeUndefined();
  });

  it("keeps proxy, CA, Git and npm configuration while continuing to reject credential variables", () => {
    const result = buildMimoExecutionEnv({
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.test:8080",
      http_proxy: "http://lower-proxy.test:8080",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/certs/company.pem",
      SSL_CERT_FILE: "/certs/ca.pem",
      GIT_CONFIG_GLOBAL: "/home/mimo/.gitconfig",
      GIT_SSH_COMMAND: "ssh -F /home/mimo/.ssh/config",
      GIT_ASKPASS: "/private/askpass",
      NPM_CONFIG_REGISTRY: "https://registry.test",
      npm_config_cache: "/home/mimo/.npm-cache",
      NPM_CONFIG_USERCONFIG: "/home/mimo/.npmrc",
      NPM_TOKEN: "npm-token",
      NODE_TLS_REJECT_UNAUTHORIZED: "0"
    }, {}, { platform: "linux" });

    expect(result.env).toMatchObject({
      HTTPS_PROXY: "http://proxy.test:8080",
      http_proxy: "http://lower-proxy.test:8080",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/certs/company.pem",
      SSL_CERT_FILE: "/certs/ca.pem",
      GIT_CONFIG_GLOBAL: "/home/mimo/.gitconfig",
      GIT_SSH_COMMAND: "ssh -F /home/mimo/.ssh/config",
      NPM_CONFIG_REGISTRY: "https://registry.test",
      npm_config_cache: "/home/mimo/.npm-cache",
      NPM_CONFIG_USERCONFIG: "/home/mimo/.npmrc"
    });
    expect(result.env.GIT_ASKPASS).toBeUndefined();
    expect(result.env.NPM_TOKEN).toBeUndefined();
    expect(result.env.NODE_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
  });

  it("discovers a strict provider from a JSONC config directory without exposing its content", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-mimo-provider-config-"));
    try {
      fs.writeFileSync(path.join(configDir, "mimocode.jsonc"), [
        "// local MiMo configuration",
        "{",
        '  "provider": "anthropic",',
        "}"
      ].join("\n"), "utf8");
      const result = buildMimoExecutionEnv({
        PATH: "/bin",
        MIMOCODE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: "anthropic-key",
        MIMOCODE_API_KEY: "mimo-key"
      }, {}, { platform: "linux", policy: "strict" });

      expect(result.audit).toMatchObject({ policy: "strict", provider: "anthropic" });
      expect(result.env.ANTHROPIC_API_KEY).toBe("anthropic-key");
      expect(result.env.MIMOCODE_API_KEY).toBe("mimo-key");
      expect(JSON.stringify(result.audit)).not.toContain("anthropic-key");
      expect(JSON.stringify(result.audit)).not.toContain(configDir);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
