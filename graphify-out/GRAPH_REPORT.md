# Graph Report - antigravity-observability  (2026-10-17)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 137 nodes · 218 edges · 9 communities (8 shown, 1 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 8 edges (avg confidence: 0.91)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `6029fd9c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- package.json
- test.mjs
- app.js
- classifier.mjs
- compilerOptions
- main.mjs
- panel/package.json
- install.mjs
- API /api/status

## God Nodes (most connected - your core abstractions)
1. `parseTranscript()` - 14 edges
2. `refreshTelemetry()` - 12 edges
3. `setupTabsAndControls()` - 10 edges
4. `keywords` - 9 edges
5. `escapeHtml()` - 8 edges
6. `renderWaterfall()` - 8 edges
7. `compilerOptions` - 8 edges
8. `analyzeSessionCognition()` - 7 edges
9. `detectSemanticLoop()` - 7 edges
10. `renderErrorClustersFilter()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `Waterfall Trace Timeline` --implements--> `renderWaterfall()`  [INFERRED]
  README.md → plugin/sidecars/panel/app.js
- `Prompt Cache Hit Rate` --implements--> `calculateCacheHitRate()`  [INFERRED]
  README.md → plugin/sidecars/panel/telemetry.mjs
- `Gemini Cost Benchmark Model` --implements--> `calculateCost()`  [INFERRED]
  docs/API.md → plugin/sidecars/panel/telemetry.mjs
- `Loop & Stall Radar` --implements--> `detectRepetitionLoop()`  [INFERRED]
  README.md → plugin/sidecars/panel/telemetry.mjs
- `API /api/telemetry` --calls--> `parseTranscript()`  [EXTRACTED]
  docs/API.md → plugin/sidecars/panel/telemetry.mjs

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Telemetry Analytics Pipeline** — docs_api_telemetry_endpoint, plugin_sidecars_panel_telemetry_parsetranscript, plugin_sidecars_panel_telemetry_calculatecost, plugin_sidecars_panel_telemetry_calculatecachehitrate [INFERRED 0.95]

## Communities (9 total, 1 thin omitted)

### Community 0 - "package.json"
Cohesion: 0.07
Nodes (27): author, bugs, url, description, engines, node, homepage, keywords (+19 more)

### Community 1 - "test.mjs"
Cohesion: 0.14
Nodes (25): Changelog v1.0.1 Release, Gemini Cost Benchmark Model, API /api/telemetry, Multi-OS Multi-Node CI Matrix, PHASE_METADATA, calculateAgentHealth(), calculateCacheHitRate(), calculateCacheSavings() (+17 more)

### Community 2 - "app.js"
Cohesion: 0.23
Nodes (21): copySessionReport(), escapeHtml(), formatTokens(), getToolCategory(), refreshTelemetry(), renderCognitiveSpectrum(), renderErrorClustersFilter(), renderErrorTaxonomy() (+13 more)

### Community 3 - "classifier.mjs"
Cohesion: 0.19
Nodes (16): analyzeSessionCognition(), classifyStepPhase(), COGNITIVE_PHASES, computeNgramSimilarity(), computeSemanticSimilarityAsync(), cosineSimilarity(), detectSemanticLoop(), findZvecFactoryUrl() (+8 more)

### Community 4 - "compilerOptions"
Cohesion: 0.12
Nodes (15): compilerOptions, allowJs, checkJs, module, moduleResolution, noEmit, strict, target (+7 more)

### Community 5 - "main.mjs"
Cohesion: 0.13
Nodes (12): Zero Dependency Policy, API /api/sessions, Telemetry Radar SVG Icon, Auxiliary Pane 4-Tab Interface, app, BRAIN_DIR, DB_PATH, getRecentSessions() (+4 more)

### Community 6 - "panel/package.json"
Cohesion: 0.40
Nodes (4): description, name, type, version

### Community 7 - "install.mjs"
Cohesion: 0.40
Nodes (4): HERE, SOURCE, TARGET, TARGET_BASE

## Knowledge Gaps
- **66 isolated node(s):** `author`, `url`, `description`, `node`, `homepage` (+61 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Auxiliary Pane 4-Tab Interface` connect `main.mjs` to `app.js`?**
  _High betweenness centrality (0.152) - this node is a cross-community bridge._
- **Why does `parseTranscript()` connect `test.mjs` to `classifier.mjs`, `main.mjs`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `setupTabsAndControls()` (e.g. with `copySessionReport()` and `toggleMonitoring()`) actually correct?**
  _`setupTabsAndControls()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `author`, `url`, `description` to the rest of the system?**
  _66 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.07142857142857142 - nodes in this community are weakly interconnected._
- **Should `test.mjs` be split into smaller, more focused modules?**
  _Cohesion score 0.1396011396011396 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.125 - nodes in this community are weakly interconnected._