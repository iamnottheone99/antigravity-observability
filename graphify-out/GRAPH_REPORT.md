# Graph Report - antigravity-observability  (2026-10-10)

## Corpus Check
- Corpus is ~6,832 words - fits in a single context window. You may not need a graph.

## Summary
- 81 nodes · 104 edges · 8 communities (7 shown, 1 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 9 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Telemetry & Analytics Engine
- Auxiliary Panel UI Logic
- Sidecar Runtime & SQLite Backend
- Root Package & Engines Config
- Observability Metadata & Keywords
- Sidecar Package Configuration
- Plugin Installation & Distribution
- System Health & Diagnostics

## God Nodes (most connected - your core abstractions)
1. `keywords` - 9 edges
2. `refreshTelemetry()` - 8 edges
3. `parseTranscript()` - 7 edges
4. `setupTabsAndControls()` - 6 edges
5. `renderWaterfall()` - 5 edges
6. `showToast()` - 4 edges
7. `escapeHtml()` - 4 edges
8. `sendSteerMessage()` - 4 edges
9. `copySessionReport()` - 4 edges
10. `toggleMonitoring()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `Waterfall Trace Timeline` --implements--> `renderWaterfall()`  [INFERRED]
  README.md → plugin/sidecars/panel/app.js
- `Human-in-the-Loop Steering` --implements--> `sendSteerMessage()`  [INFERRED]
  README.md → plugin/sidecars/panel/app.js
- `Prompt Cache Hit Rate` --implements--> `calculateCacheHitRate()`  [INFERRED]
  README.md → plugin/sidecars/panel/telemetry.mjs
- `Gemini Cost Benchmark Model` --implements--> `calculateCost()`  [INFERRED]
  docs/API.md → plugin/sidecars/panel/telemetry.mjs
- `Loop & Stall Radar` --implements--> `detectRepetitionLoop()`  [INFERRED]
  README.md → plugin/sidecars/panel/telemetry.mjs

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Telemetry Analytics Pipeline** — docs_api_telemetry_endpoint, plugin_sidecars_panel_telemetry_parsetranscript, plugin_sidecars_panel_telemetry_calculatecost, plugin_sidecars_panel_telemetry_calculatecachehitrate [INFERRED 0.95]

## Communities (8 total, 1 thin omitted)

### Community 0 - "Telemetry & Analytics Engine"
Cohesion: 0.18
Nodes (15): Changelog v1.0.1 Release, Gemini Cost Benchmark Model, API /api/telemetry, Multi-OS Multi-Node CI Matrix, calculateCacheHitRate(), calculateCost(), detectRepetitionLoop(), parseTranscript() (+7 more)

### Community 1 - "Auxiliary Panel UI Logic"
Cohesion: 0.26
Nodes (16): copySessionReport(), escapeHtml(), formatTokens(), getToolCategory(), knownSessions, refreshTelemetry(), renderFiles(), renderToolSpectrum() (+8 more)

### Community 2 - "Sidecar Runtime & SQLite Backend"
Cohesion: 0.14
Nodes (11): Zero Dependency Policy, API /api/sessions, Telemetry Radar SVG Icon, Auxiliary Pane 4-Tab Interface, app, BRAIN_DIR, DB_PATH, getRecentSessions() (+3 more)

### Community 3 - "Root Package & Engines Config"
Cohesion: 0.15
Nodes (12): author, description, engines, node, license, main, name, scripts (+4 more)

### Community 4 - "Observability Metadata & Keywords"
Cohesion: 0.22
Nodes (9): keywords, ai-agent, antigravity, gemini, google-antigravity, observability, prompt-caching, sidecar (+1 more)

### Community 5 - "Sidecar Package Configuration"
Cohesion: 0.40
Nodes (4): description, name, type, version

### Community 6 - "Plugin Installation & Distribution"
Cohesion: 0.40
Nodes (4): HERE, SOURCE, TARGET, TARGET_BASE

## Knowledge Gaps
- **46 isolated node(s):** `name`, `version`, `description`, `type`, `main` (+41 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Auxiliary Pane 4-Tab Interface` connect `Sidecar Runtime & SQLite Backend` to `Auxiliary Panel UI Logic`?**
  _High betweenness centrality (0.171) - this node is a cross-community bridge._
- **Why does `parseTranscript()` connect `Telemetry & Analytics Engine` to `Sidecar Runtime & SQLite Backend`?**
  _High betweenness centrality (0.080) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `setupTabsAndControls()` (e.g. with `copySessionReport()` and `toggleMonitoring()`) actually correct?**
  _`setupTabsAndControls()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _46 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Sidecar Runtime & SQLite Backend` be split into smaller, more focused modules?**
  _Cohesion score 0.14285714285714285 - nodes in this community are weakly interconnected._