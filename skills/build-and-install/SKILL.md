---
name: build-and-install
description: Build the codex-mimo TypeScript project and locate the Codex plugin directory for installation. Use when the user asks to build, compile, package, or refresh the Codex plugin.
---

# Build & Install Codex Plugin

Builds the codex-mimo TypeScript project and prepares it for Codex plugin installation.

## Prerequisites

- Node.js and npm available in PATH
- Project root contains `package.json` with `"build": "tsc -p tsconfig.json"`

## Steps

### 1. Install dependencies (if needed)

```bash
npm install
```

**Gotcha:** Do NOT use `npx tsc` — it installs a wrong `tsc` package (tsc@2.x, not TypeScript). Always use `npm run build` which invokes the local `typescript` devDependency.

### 2. Build

```bash
npm run build
```

This runs `tsc -p tsconfig.json` and outputs to `dist/`.

### 3. Verify build output

Check that key entry points exist:

```bash
dir dist\cli\main.js
dir dist\codex\mcp-server.js
```

### 4. Locate Codex plugin directory

The Codex plugin cache is at:

```
C:\Users\<username>\.codex\plugins\
```

Key subdirectories:
- `cache/openai-curated/` — curated plugin cache
- `.plugin-appserver/` — app server plugins

### 5. Install/refresh the plugin

The codex-mimo plugin manifest is at `.codex-plugin/plugin.json`. To install into Codex:

```bash
# List installed plugins (requires codex CLI in PATH)
codex plugin list
```

If `codex` CLI is not in PATH, the executable is typically at:
```
C:\Users\<username>\AppData\Local\OpenAI\Codex\bin\...\codex.exe
```

### 6. Validate

```bash
npm test          # run all tests
npm run lint      # type-check without emit
```

## Common Errors

| Error | Cause | Fix |
|---|---|---|
| `tsc: command not found` or wrong tsc version | Used `npx tsc` instead of `npm run build` | Run `npm install` first, then `npm run build` |
| `Cannot find module` at runtime | Build output missing or stale | Rebuild with `npm run build` |
| Codex plugin not found | Wrong plugin directory | Check `C:\Users\<username>\.codex\plugins\` |
