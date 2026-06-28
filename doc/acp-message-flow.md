# ACP Message Flow Reference

This document describes the ACP protocol shape that `codex-mimo` could use if a future implementation talks to MiMoCode through `mimo acp`.

## Current Status

The active implementation in this repository does not call `mimo acp`, and the current source tree does not contain `src/mimo/acp-*` files. Direct tools, foreground Compose, and background Compose call `mimo run --format json` and consume JSONL output plus `session.post` hook callbacks.

Treat this ACP document as a protocol reference for a future or experimental ACP path, not as the currently exercised runtime path.

## Overview

ACP is a JSON-RPC protocol transported over stdio. An ACP implementation would start the MiMoCode ACP process, initialize the protocol, create a session, send prompts, and answer file or terminal requests through a local policy layer.

The current `mimo run --format json` path is the production path for direct commands and Compose execution in this repository. ACP remains a structured lifecycle model for agent-style sessions and terminal/file mediation if that path is reintroduced.

## Lifecycle

```text
codex-mimo                         MiMoCode ACP process
  |                                      |
  |--- initialize --------------------->|
  |<-- protocolVersion + capabilities --|
  |                                      |
  |--- session/new -------------------->|
  |<-- sessionId -----------------------|
  |                                      |
  |--- session/prompt ----------------->|
  |<-- session/update chunks -----------|
  |<-- tool or permission requests -----|
  |--- fs/read_text_file response ----->|
  |--- fs/write_text_file response ---->|
  |--- terminal/create response ------->|
  |<-- session/prompt stop -------------|
  |                                      |
```

## Core JSON-RPC Methods

### `initialize`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true
    },
    "clientInfo": {
      "name": "codex-mimo",
      "title": "Codex MiMoCode Bridge",
      "version": "0.1.0"
    }
  }
}
```

### `session/new`

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "E:/ideaProjects/example-app",
    "mcpServers": []
  }
}
```

### `session/prompt`

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [{ "type": "text", "text": "Fix the failing login test." }]
  }
}
```

## Potential Client-Side Request Handling

| ACP method | Expected bridge behavior if ACP is reintroduced |
| --- | --- |
| `session/request_permission` | Evaluate the local policy and return allow, ask, or deny |
| `fs/read_text_file` | Normalize the path, enforce read policy, and return file content |
| `fs/write_text_file` | Normalize the path, enforce write policy, and write the requested content |
| `terminal/create` | Normalize the working directory, enforce command policy, and start a managed process |
| `terminal/output` | Return stdout, stderr, and exit state for a managed process |
| `terminal/wait_for_exit` | Wait for process completion with a timeout |
| `terminal/kill` | Stop a managed process |
| `terminal/release` | Stop a running process if needed and release local resources |

## Potential Normalized Event Shape

ACP updates should be normalized before they are logged or rendered:

```typescript
type CodexMimoEvent =
  | { type: "message"; role: "agent" | "user"; text: string }
  | { type: "plan"; entries: Array<{ content: string; status: string }> }
  | { type: "tool"; id: string; title: string; kind: string; status: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; id: string; output: string; exitCode?: number }
  | { type: "usage"; used: number; size: number };
```

## Policy Boundary

If ACP is reintroduced, it should not bypass the bridge policy. File reads, file writes, and terminal commands should be checked by the conservative policy model documented in `doc/policy-guide.md`.
