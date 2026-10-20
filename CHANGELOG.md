# Changelog

All notable changes to the Antigravity Observability Companion will be documented in this file.

## [1.4.0] - 2026-10-17

### Added
- **Automated Agent Efficiency & Health Scorecard**: Implemented a 0–100 composite session evaluation score evaluating agent execution cleanliness and stability across 4 weighted pillars:
  - **Tool Reliability (30%)**: Tool success rate combined with error recovery bonus credit.
  - **Loop Radar (25%)**: Detection of consecutive repetition loops and semantic action cycles.
  - **Phase Balance (25%)**: Proportional progress across exploration, execution, and verification, penalizing unverified changes and churn.
  - **Context Economy (20%)**: Monitoring compaction frequency and context window headroom saturation.
  - Diagnostic grade classifications: `Optimal` ($\ge 90$), `Healthy` (75–89), `Attention` (60–74), and `Degraded` ($< 60$).
- **Error Taxonomy & Root-Cause Breakdown**: Standardized classification of tool and execution errors into 8 distinct root-cause clusters:
  - `path_not_found`: Target file or directory does not exist on disk.
  - `edit_conflict`: Target text chunk could not be matched for replacement.
  - `command_failed`: Subprocess or terminal script terminated with non-zero exit status.
  - `mcp_error`: External MCP server returned protocol error or unrecognized context.
  - `validation`: Tool invocation rejected due to invalid schema arguments.
  - `permission`: Operation blocked by workspace boundaries or OS access controls.
  - `timeout`: Subprocess deadline exceeded or operation aborted.
  - `runtime`: General uncategorized runtime exceptions.
- **Overview Root Causes Distribution Bar**: Color-coded segmented distribution bar and interactive legend in the Overview tab.
- **Interactive Error Drill-Down**: Clicking an error cluster pill or category legend in Overview instantly navigates to the Traces tab filtered to that specific root cause.
- **Traces Error Cluster Filters**: Added `#error-clusters-filter` sub-filter chips container in the Traces tab for rapid one-click root-cause filtering.
- **Per-Step Root-Cause Badges & Diagnostics**: Integrated color-coded root-cause badges and formatted error cards in trace cards and detail drawers.

### Fixed
- **Antigravity 2.0 Tool Call Recognition**: Added full support for modern tool names (`read_file`, `edit_file`, `write_file` with parameter `Path`) across tool categorizers, primary argument extractors, `filesTouched` tracking, and cognitive phase assignment.
- **Compaction Detection Guard**: Constrained `<CONTEXT_SUMMARY>` detection strictly to user input steps (`step.type === 'USER_INPUT'` or `step.source === 'USER_EXPLICIT'`) to prevent false positives when assistant text mentions compaction.
- **Empty Session Fallback**: Unified the sidecar `waiting_for_transcript` fallback with `parseTranscript('', ...)`, ensuring `healthScorecard` and `errorTaxonomy` are always fully populated.
- **Status Version Alignment**: Corrected the `/api/status` endpoint version output to `1.4.0`.

## [1.3.0] - 2026-10-14

### Added
- **Cognitive Phase Classification Engine**: Classifies agent actions into 5 canonical phases (`EXPLORATION`, `SYNTHESIS`, `EXECUTION`, `VERIFICATION`, `RECOVERY`) with confidence scoring.
- **Cognitive Phase Spectrum**: Segmented overview bar and interactive legend displaying session time distribution across cognitive phases.
- **Per-Step Cognitive Badges**: Traces timeline renders distinct phase pills (`[EXPLORATION]`, `[EXECUTION]`, `[VERIFICATION]`, `[RECOVERY]`, `[SYNTHESIS]`) for every execution step.
- **Semantic Loop Radar**: Vector and statistical n-gram similarity engine that detects semantic repetition loops (varied arguments, repeated slice reads, test retries) beyond naive exact-string matching.
- **Connected MCP Embedding Bridge (`classifier.mjs`)**: Directly leverages local neural embeddings powered by [Zvec](https://github.com/alibaba/zvec) and [zvec-grep](https://github.com/zvec-ai/zvec-grep) (`local/potion-code-16m-v2`) via dynamic resolver when present, with a fast, zero-dependency statistical n-gram fallback.
- **Trace Search by Cognitive Phase**: Traces search input now supports queries matching cognitive phase labels directly (e.g. `recovery`, `verification`).

## [1.2.1] - 2026-10-12

### Added
- **Dedicated Cache Hits Overview Tile**: Replaced the theoretical Est. Cost overview card with a focused Cache Hits tile showcasing prompt cache hit percentage as the primary KPI, accompanied by cached token counts and savings tooltips.
- **Manual Telemetry Refresh Button**: Added a compact, animated refresh button in the header bar allowing immediate, uncached reload of active conversation transcripts and session listings.
- **Granular MCP Server & Ecosystem Breakdown**: The Ecosystem tile now breaks down specific MCP server counts (e.g., `Engram (4), zvec-grep (1)`) and active skills with structured hover diagnostics.
- **MCP Server Spectrum Segments & Active Skills Tags**: The Tool Spectrum splits MCP tool calls by individual server with dedicated colors and percentages, and renders an Active Skills tag list for detected skill and MCP activations.

### Changed
- **Sidecar Caching Bypass**: The `/api/telemetry` endpoint now supports a `force=true` query parameter to invalidate in-memory transcript and session caches on demand.

## [1.2.0] - 2026-10-11

### Added
- **Context Window Utilization Gauge**: Visual capacity meter tracking token volume against Gemini's 1.0M token context limit, accompanied by session compaction counters.
- **Prompt Cache Dollar Savings**: Real-time monetary savings calculator quantifying dollar savings achieved through Gemini prompt cache hits ($0.1125 / 1M cached tokens).
- **Latency & Tool Reliability**: Added step turnaround latency (average duration per model turn) and tool call success rate percentage.
- **Antigravity Ecosystem Metrics**: Dedicated overview cards tracking subagent delegations, MCP tool executions, artifact generations, and compaction events.
- **MCP Spectrum Classification**: Tool distribution spectrum now breaks down Model Context Protocol tool invocations alongside shell, file, and web operations.
- **Active Model Detection**: Header displays the active model identity (such as Gemini 2.5 Pro) derived from conversation transcripts.

### Changed
- **Decluttered Header Bar**: Restructured header layout by grouping title and model details vertically on the left and streamlining right-side controls, eliminating multi-row wrapping on narrow sidecar panels.
- **Compact Power Controls**: Refactored live monitoring switch and session dropdown into a minimal footprint while suppressing redundant status indicators.

## [1.1.0] - 2026-10-10

### Added
- **Deep Trace Inspector**: Individual trace timeline cards now expand into structured drawers containing:
  - **Reasoning & Strategy**: Displays model `thinking` (chain of thought) explaining why each action was taken.
  - **Arguments Grid**: Clean key-value breakdown of tool arguments with unquoted, readable values.
  - **Execution Output Preview**: Scrollable terminal box showing tool stdout, stderr, exit codes, and error logs with one-click copy.
  - **Step-Level Token Economics**: Per-step metrics tracking fresh prompt tokens, cache reads, completion tokens, duration, and dollar cost.
- **Trace Search & Filters**: Live search input to filter traces by tool, command, file, or keyword, alongside category filter chips (`All`, `Tools`, `Errors`).
- **Expand/Collapse All**: Toolbar button to expand or collapse all displayed trace cards simultaneously.
- **Visual Category Pills**: Timeline badges color-coding events by domain (`SHELL`, `FILE`, `SEARCH`, `MCP`, `AGENT`, `USER`, `ASSISTANT`).

## [1.0.1] - 2026-10-10

### Fixed
- **Node.js 20+ Compatibility**: Converted static `import { DatabaseSync } from 'node:sqlite'` to dynamic `import('node:sqlite')` with graceful fallback for Node.js runtimes prior to v22.5.0.
- **Resource Cleanup**: Wrapped SQLite database connections and file descriptors in `try ... finally` blocks to prevent unclosed handles during lock conditions or unexpected errors.
- **Title Extraction Buffer**: Expanded initial chunk buffer to 16KB and implemented newline boundary slicing to prevent truncated JSON parsing on large initial prompts.

### Added
- **Pure Telemetry Engine**: Extracted core mathematical formulas and JSONL parsing into `plugin/sidecars/panel/telemetry.mjs` with zero framework dependencies.
- **Comprehensive Test Suite**: Added automated unit tests in `scripts/test.mjs` verifying cache hit rates, cost calculations, loop detection, and transcript log parsing.
- **GitHub Actions CI**: Added `.github/workflows/ci.yml` supporting multi-platform testing across Node.js 20, 22, and 24 on Linux, macOS, and Windows.
- **Documentation**: Added `docs/API.md`, `CONTRIBUTING.md`, and updated `README.md`.

## [1.0.0] - 2026-10-10

- Initial release of Antigravity Observability Companion.
- Real-time token metrics, prompt cache hit rate gauge, and vertical waterfall trace timeline.
- Human-in-the-loop steering controls and multi-chat auto tracking.
