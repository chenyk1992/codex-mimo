# ACP Message Flow

## Overview

ACP (Agent Communication Protocol) is a JSON-RPC protocol over stdio between a client and an agent.

## Lifecycle

```
Client                          Agent (MiMoCode)
  |                                |
  |--- initialize ---------------->|
  |<-- protocolVersion + caps -----|
  |                                |
  |--- session/new --------------->|
  |<-- sessionId ------------------|
  |                                |
  |--- session/prompt ------------>|
  |<-- session/update chunks ------|
  |<-- tool calls -----------------|
  |--- fs/read_text_file response->|
  |--- fs/write_text_file response>|
  |--- terminal/create response --->|
  |<-- session/prompt stop --------|
  |                                |
```

## Key Methods

### initialize

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

### session/new

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

### session/prompt

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "sess_abc123",
    "prompt": [{ "type": "text", "text": "Fix the failing test." }]
  }
}
```

## Client-Side Handlers

| ACP Method | Bridge Behavior |
|------------|-----------------|
| `session/request_permission` | Evaluate policy, auto-allow safe ops |
| `fs/read_text_file` | Normalize path, verify, return content |
| `fs/write_text_file` | Normalize path, verify write permission, write |
| `terminal/create` | Normalize cwd, validate command, start process |
| `terminal/output` | Return stdout/stderr and exit status |
| `terminal/wait_for_exit` | Await completion with timeout |
| `terminal/kill` | Stop process |
| `terminal/release` | Stop if running, release resources |

## Event Types

```typescript
type CodexMimoEvent =
  | { type: "message"; role: "agent" | "user"; text: string }
  | { type: "plan"; entries: Array<{ content: string; status: string }> }
  | { type: "tool"; id: string; title: string; kind: string; status: string }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; id: string; output: string; exitCode?: number }
  | { type: "usage"; used: number; size: number };
```
