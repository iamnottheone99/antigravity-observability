# Antigravity Observability Companion — Sidecar API Reference

This document outlines the internal HTTP API exposed by the `agent-observability` sidecar service (`main.mjs`). The sidecar runs as a local background daemon embedded within Antigravity and communicates with the Auxiliary Side Pane via `window.sidecar`.

---

## Service Endpoints

### 1. System Status
`GET /api/status`

Returns runtime metadata and health diagnostics.

#### Response Example:
```json
{
  "status": "ok",
  "version": "1.2.1",
  "node": "v22.5.0",
  "platform": "win32 10.0.26100",
  "uptimeSeconds": 142,
  "sqliteAvailable": true,
  "cachedTranscripts": 3
}
```

| Field | Type | Description |
| :--- | :--- | :--- |
| `status` | `string` | Always `"ok"` when running. |
| `version` | `string` | Sidecar semantic version (e.g. `"1.2.1"`). |
| `node` | `string` | Node.js runtime version. |
| `platform` | `string` | Host operating system and kernel release. |
| `uptimeSeconds` | `number` | Seconds elapsed since sidecar process boot. |
| `sqliteAvailable` | `boolean` | `true` if Node's native `node:sqlite` engine is loaded. |
| `cachedTranscripts` | `number` | Total transcript reports currently cached in memory. |

---

### 2. List Discoverable Sessions
`GET /api/sessions`

Returns the most recent Antigravity conversation sessions. If native SQLite is supported and `conversation_summaries.db` is present, human-readable session titles are extracted from the database. Otherwise, it falls back to scanning `~/.gemini/antigravity/brain/`.

#### Response Example:
```json
{
  "sessions": [
    {
      "id": "db66e817-f6a4-4e58-9db0-7e27d8c1bffe",
      "title": "Analyze project health",
      "stepCount": 24,
      "lastModified": 1728567120000
    }
  ]
}
```

---

### 3. Session Telemetry & Trace Analytics
`GET /api/telemetry`

Fetches real-time token metrics, latency, step history, and error logs for a session.

#### Query Parameters:
| Parameter | Type | Required | Description |
| :--- | :--- | :---: | :--- |
| `conversationId` | `string` | No | Target UUID, or `"auto"` (default). In auto mode, dynamically follows the most recently active session. |
| `force` | `boolean` | No | When `"true"`, forces bypass of session TTL and transcript caching for a clean disk reload. |

#### Response Example:
```json
{
  "status": "active",
  "conversationId": "db66e817-f6a4-4e58-9db0-7e27d8c1bffe",
  "activeTitle": "Analyze project health",
  "isAuto": true,
  "sessions": [...],
  "totalSteps": 12,
  "inputTokens": 3200,
  "cacheReadTokens": 14500,
  "totalPromptTokens": 17700,
  "outputTokens": 850,
  "totalTokens": 18550,
  "estimatedCost": "$0.0015",
  "cacheHitRate": "81.9%",
  "cacheSavings": "$0.0016",
  "latestContextTokens": 17700,
  "peakContextTokens": 24500,
  "contextLimit": 1000000,
  "contextLoadPercent": "1.8%",
  "compactionsCount": 1,
  "activeModel": "Gemini 2.5 Pro",
  "avgStepDuration": "2.1s",
  "toolSuccessRate": "98.5%",
  "subagentCalls": 1,
  "mcpCalls": 4,
  "mcpServers": {
    "engram": 3,
    "zvec_grep": 1
  },
  "activeSkills": [
    "engram",
    "zvec-grep"
  ],
  "artifactsCount": 2,
  "errorCount": 0,
  "loopDetected": null,
  "toolCounts": {
    "view_file": 6,
    "run_command": 2,
    "call_mcp_tool": 4
  },
  "filesTouched": [
    "c:/project/package.json"
  ],
  "failedSteps": [],
  "recentSteps": [
    {
      "stepIndex": 11,
      "source": "MODEL",
      "type": "PLANNER_RESPONSE",
      "status": "DONE",
      "createdAt": "2026-10-10T14:22:01.000Z",
      "durationSeconds": 1.4,
      "inputTokens": 120,
      "cacheReadTokens": 1400,
      "outputTokens": 80,
      "totalStepTokens": 1600,
      "stepCost": "$0.0001",
      "category": "file",
      "thinking": "Inspecting package.json dependencies...",
      "outputSnippet": "{\n  \"name\": \"antigravity-observability\"...\n}",
      "tools": [
        {
          "name": "view_file",
          "summary": "View package.json",
          "action": "Viewing file",
          "primaryArg": "c:/project/package.json",
          "category": "file",
          "args": {
            "AbsolutePath": "c:/project/package.json"
          },
          "output": "{\n  \"name\": \"antigravity-observability\"...\n}"
        }
      ]
    }
  ]
}
```

---

## Pricing & Math Models

### Prompt Cache Hit Rate
$$\text{Hit Rate} = \min\left(100\%, \frac{\text{Cache Read Tokens}}{\text{Fresh Input Tokens} + \text{Cache Read Tokens}} \times 100\%\right)$$

### Prompt Cache Dollar Savings
$$\text{Savings} = \text{Cache Read Tokens} \times (\$0.1500 - \$0.0375) \times 10^{-6} = \text{Cache Read Tokens} \times \$0.1125 \times 10^{-6}$$

### Cost Model (Gemini Pro/Flash Benchmark)
$$\text{Cost} = (\text{Input} \times \$0.15 \times 10^{-6}) + (\text{Cache} \times \$0.0375 \times 10^{-6}) + (\text{Output} \times \$0.60 \times 10^{-6})$$

### Context Window Utilization
$$\text{Load} = \frac{\text{Latest Step Context Tokens}}{1,000,000} \times 100\%$$

Amber load warning triggers at $\ge 70\%$, and critical red warning triggers at $\ge 85\%$.

### Tool Reliability Rate
$$\text{Reliability} = \left(1 - \frac{\text{Failed Tool Executions}}{\text{Total Tool Executions}}\right) \times 100\%$$

### Repetition Radar
Detects when any tool call signature (`<toolName>:<args>`) appears $\ge 3$ times within a sliding window of the last 8 tool invocations.
