# Policy Guide

`src/core/policy.ts` contains a conservative file and command policy engine. It is a reusable core module with unit coverage; the current CLI/MCP path does not include a `core/config.ts` loader or an active `codex-mimo.config.json` merge step.

Use this guide to understand the policy decisions available to callers that wire the module into a MiMoCode mediation path.

## Default Policy

Create the default policy with:

```typescript
import { defaultPolicy } from "./src/core/policy.js";

const policy = defaultPolicy(workspaceRoot);
```

### File Access

| Target | Read | Write |
| --- | --- | --- |
| Inside `workspaceRoot` | allow | ask |
| Outside `workspaceRoot` | deny | deny |
| `**/.env`, `**/.env.*` | deny | deny |
| `**/id_rsa`, `**/id_ed25519` | deny | deny |
| `**/.npmrc`, `**/.pypirc` | deny | deny |

`allowedReadGlobs` and `allowedWriteGlobs` can further narrow access. When those lists are present, a path must match the corresponding allow list after passing workspace containment and deny checks.

CI mode or non-interactive mode converts `ask` decisions to `deny`.

### Terminal Commands

| Pattern | Decision |
| --- | --- |
| `git status*`, `git diff*`, `git log*` | allow |
| `npm test*`, `npm run test*`, `npm run lint*`, `npm run typecheck*` | allow |
| `pnpm test*`, `pnpm lint*`, `pnpm typecheck*` | allow |
| `npm install*`, `pnpm install*` | ask |
| `npm run build*`, `pnpm build*` | ask |
| `rm *`, `del *`, `Remove-Item *` | deny |
| `git push*`, `git reset*`, `git checkout --*` | deny |
| `curl *`, `wget *`, `ssh *`, `scp *` | deny |
| Anything else | ask |

Command matching uses minimatch-style glob matching against the raw command line string.

## CI And Non-Interactive Mode

The policy object supports both `ciMode` and `nonInteractive`:

```typescript
const policy = {
  ...defaultPolicy(workspaceRoot),
  ciMode: true
};
```

In either mode, every `ask` result becomes `deny`, so unattended runs cannot block on approval.

## Audit Logger

`src/core/audit.ts` provides a standalone JSONL audit logger with rotation. Instantiate it directly:

```typescript
import { AuditLogger } from "./src/core/audit.js";

const audit = new AuditLogger({
  logDir: ".codex-mimo",
  maxFileSize: 10 * 1024 * 1024,
  maxFiles: 5
});

audit.log({ type: "session_start", workflow: "implement" });
```

The logger writes `audit.jsonl` and rotates to timestamped `audit.*.jsonl` files when the size limit is exceeded.

The current direct `mimo run --format json` execution path does not automatically mediate every MiMoCode file or terminal operation through this policy/audit layer. Direct runs rely on MiMoCode invocation settings, prompt rules, hook callbacks, and post-run checks.

## Practical Guidance

- Keep policy allow lists narrow when wiring this module into a mediated execution path.
- Deny secret files even when they live inside the workspace.
- Keep package installation as `ask` unless a caller has explicit approval handling.
- Keep destructive git and filesystem operations denied by default.
- Use Compose verification commands for normal tests instead of broad command permissions.
- Do not document `codex-mimo.config.json` as active behavior unless a config loader is reintroduced.
