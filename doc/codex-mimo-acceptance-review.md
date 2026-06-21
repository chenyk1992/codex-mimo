# Codex-MiMo Acceptance And Code Review

Date: 2026-06-21

Reviewed project: `E:\ideaProjects\codex-mimo`

## Verification Summary

Fresh verification commands were run in `E:\ideaProjects\codex-mimo`:

```text
npm run build
```

Result: passed. TypeScript compilation completed with exit code 0.

```text
npm test
```

Result: passed. Vitest reported 4 test files passed and 22 tests passed.

Git status at review time:

```text
?? .idea/vcs.xml
```

The untracked `.idea/vcs.xml` appears to be IDE metadata and was not treated as part of the implementation review.

## Findings

### P0: ACP protocol shapes do not match the ACP v1 spec, so the `mimo acp` bridge is unlikely to interoperate with a real ACP agent

Files:

- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:40`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:75`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:83`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:109`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:113`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:128`

The local ACP types are not aligned with ACP v1. The most important mismatches are:

- `InitializeResult` uses `capabilities` and `serverInfo`, while ACP v1 returns `agentCapabilities`, `agentInfo`, and `authMethods`.
- `SessionUpdate` expects local variants such as `{ type: "message" }`, `{ type: "tool" }`, and `{ type: "usage" }`, while ACP v1 uses an `update.sessionUpdate` discriminator such as `agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, and `usage_update`.
- `RequestPermissionParams` expects `operation` and `details`, while ACP v1 sends `toolCall` and `options`.
- `RequestPermissionResult` returns `{ outcome: "allow" | "deny" }`, while ACP v1 expects `{ outcome: { outcome: "selected", optionId } }` or `{ outcome: { outcome: "cancelled" } }`.
- `WriteTextFileResult` returns `{ bytes }`, while ACP v1 `fs/write_text_file` succeeds with `result: null`.
- `TerminalCreateParams` omits `args`, `env`, and `outputByteLimit`, and `TerminalOutputResult` returns `stdout/stderr/exitCode`, while ACP v1 expects `output`, `truncated`, and `exitStatus`.

Impact:

The TypeScript build passes because the implementation is internally consistent, but it is consistent with a local protocol, not ACP v1. A real `mimo acp` process may reject responses, fail to parse permission outcomes, miss updates, or be unable to execute terminal requests correctly.

Recommended fix:

Replace `src/mimo/acp-types.ts` with ACP v1-compatible request/result/update types, then update `acp-bridge.ts` and `acp-updates.ts` to convert real ACP messages into `CodexMimoEvent`.

Add fixture-based tests that feed actual ACP-shaped messages:

```json
{
  "sessionUpdate": "agent_message_chunk",
  "messageId": "msg_1",
  "content": { "type": "text", "text": "hello" }
}
```

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call_1",
  "title": "Running tests",
  "kind": "execute",
  "status": "pending"
}
```

### P0: Terminal command handling drops ACP `args` and validates only the command name, allowing policy bypass and broken command execution

Files:

- `E:\ideaProjects\codex-mimo\src\mimo\acp-types.ts:113`
- `E:\ideaProjects\codex-mimo\src\mimo\acp-bridge.ts`
- `E:\ideaProjects\codex-mimo\src\core\terminal.ts`

ACP terminal requests carry `command` and `args` separately. The bridge currently models only `command`, then passes only that value to `TerminalManager.create`. That means a request equivalent to `npm test -- session.test.ts` becomes just `npm`, and a dangerous request can also be misclassified because policy checks do not see the arguments.

Impact:

Safe commands may fail because arguments are lost. Dangerous commands may be incorrectly allowed or denied because the policy evaluates incomplete input. This breaks both functionality and the security model.

Recommended fix:

Represent terminal requests as:

```ts
interface TerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number;
}
```

Build a policy string from `command` plus safely quoted `args`, and spawn the process without shell interpolation when possible:

```ts
spawn(command, args ?? [], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
```

Add tests for:

- `npm test -- session.test.ts` is allowed and executed with args.
- `git push origin main` is denied when represented as `command: "git", args: ["push", "origin", "main"]`.
- `rm -rf dist` is denied when represented as `command: "rm", args: ["-rf", "dist"]`.

### P1: `ask` decisions are silently converted to allow in the ACP bridge

Files:

- `E:\ideaProjects\codex-mimo\src\mimo\acp-bridge.ts`
- `E:\ideaProjects\codex-mimo\src\core\policy.ts`

The policy layer can return `allow`, `ask`, or `deny`, but `handlePermissionRequest`, `handleFileWrite`, and `handleTerminalCreate` treat every non-`deny` result as executable. This means commands that should require confirmation, such as installs or builds, can run automatically in non-CI mode.

Impact:

The documented safety model says package installs and ordinary writes require approval, but the ACP bridge effectively auto-approves them. This is a security and trust issue for a tool whose main job is safely delegating code changes.

Recommended fix:

Define a bridge mode:

- Noninteractive mode: `ask` becomes `deny`.
- Interactive mode: `ask` calls an approval callback and returns the selected ACP permission option.
- CI mode: `ask` becomes `deny`.

Add tests for all three outcomes.

### P1: CLI flags are parsed but not applied, so documented MVP controls do not work

File:

- `E:\ideaProjects\codex-mimo\src\cli\main.ts`

The CLI parses `--file`, `--dry-run`, `--json`, and `--ci`, but the current command execution does not use those values. The extracted variables are not passed into `runPlan`, `runImplement`, `runReview`, `mimo run`, or the policy layer.

Impact:

Users can pass flags that appear supported but have no effect. This is especially risky for `--dry-run` and `--ci`, because users may expect those flags to prevent execution or harden permissions.

Recommended fix:

Either remove unsupported flags from the CLI until implemented, or wire them through:

- `--dry-run`: print the exact `mimo` command and exit without executing.
- `--json`: return structured wrapper output instead of inherited stdout only.
- `--file`: pass attached files into `buildMimoRunArgs`.
- `--ci`: load policy with CI mode and deny all `ask` actions.

Add CLI tests that spawn `dist/cli/main.js` with `--dry-run` and assert no `mimo` process is executed.

### P1: MCP tools report empty or generic results instead of parsing MiMoCode output or diff state

File:

- `E:\ideaProjects\codex-mimo\src\codex\tools.ts`

Tools such as `mimoPlan`, `mimoImplement`, `mimoReview`, `mimoFixCi`, and `mimoResume` execute MiMoCode but return static placeholders like `changedFiles: []`, `verification: []`, `findings: []`, or `"Review completed."`.

Impact:

Codex cannot reliably inspect what MiMoCode changed or what review findings MiMoCode produced from the MCP tool result. This weakens the intended orchestration model where Codex delegates work and then verifies it.

Recommended fix:

Capture and parse `mimo run --format json` output rather than inheriting stdout directly. At minimum, collect:

- session ID if present
- text summary
- tool calls
- changed files from `git diff --name-only`
- commands run
- errors or stop reason

For review, return parsed findings or raw review text instead of an empty findings array.

### P1: Config file access rules are partially ignored

File:

- `E:\ideaProjects\codex-mimo\src\core\config.ts`

`ConfigFile.fileAccess` supports `read`, `write`, and `deny`, but `configToPolicy` only applies `deny`. The `read` and `write` allowlists are not represented in `BridgePolicy`, so a user cannot narrow read/write access through config even though the config schema suggests they can.

Impact:

The documented policy model is stricter than the actual implementation. Users may believe they have limited bridge access to a subdirectory while the default workspace-wide behavior remains active.

Recommended fix:

Extend `BridgePolicy` with explicit read and write allowlists, apply them in `decideFileRead` and `decideFileWrite`, and test that a configured subdirectory allowlist blocks sibling paths.

### P2: Test coverage validates local abstractions but not the real integration contract

Files:

- `E:\ideaProjects\codex-mimo\test\unit\acp-client.test.ts`
- `E:\ideaProjects\codex-mimo\test\unit\acp-updates.test.ts`
- `E:\ideaProjects\codex-mimo\test\unit\policy.test.ts`

The current tests are useful but mostly assert the implementation's local shapes. They do not catch ACP spec mismatches, ignored CLI flags, terminal argument loss, or MCP placeholder responses.

Impact:

Build and tests can pass while the bridge remains incompatible with real MiMoCode ACP behavior.

Recommended fix:

Add tests at three layers:

- ACP fixtures: parse and respond to real ACP v1 messages.
- CLI behavior: dry-run, file attachment, JSON output, and CI mode.
- MCP tool behavior: verify changed files and review output are returned from tool calls.

## Acceptance Checklist

| Requirement | Status | Notes |
| --- | --- | --- |
| TypeScript project builds | Pass | `npm run build` exit code 0 |
| Unit tests pass | Pass | 22 tests passed |
| Script MVP exists | Partial | `plan`, `implement`, `review`, `healthcheck`, `sessions`, `resume` exist |
| Codex plugin manifest exists | Pass | `.codex-plugin/plugin.json` exists |
| MCP server exists | Pass | `src/codex/mcp-server.ts` exists |
| ACP bridge exists | Partial | Present, but ACP shapes do not match ACP v1 |
| Safe default policy exists | Partial | Policy exists, but `ask` is auto-allowed in bridge and config allowlists are ignored |
| MiMoCode output parsed into tool results | Partial | Tools execute MiMoCode but return placeholders |
| Session persistence implemented | Partial | `SessionStore` exists, but reviewed code did not show saving new session IDs from run/ACP flows |
| Documentation exists | Pass | README and docs exist |

## Recommended Fix Order

1. Align ACP types and responses with ACP v1 before investing more in ACP behavior.
2. Fix terminal `command + args` handling and policy evaluation.
3. Make `ask` deterministic: deny in noninteractive/CI, approve only through an explicit callback.
4. Wire or remove parsed CLI flags.
5. Parse `mimo run --format json` and return real MCP tool results.
6. Add fixture-based integration tests for ACP and CLI behavior.

## Overall Assessment

The project has a solid scaffold and passes its current build/test suite. The MVP direction is recognizable, and the codebase is organized in a way that should be straightforward to harden.

The main blocker is that the ACP bridge currently implements a local approximation of ACP rather than ACP v1 as documented. I would not treat the ACP/plugin path as production-ready until the protocol shapes, terminal handling, permission outcomes, and tool result parsing are corrected.

