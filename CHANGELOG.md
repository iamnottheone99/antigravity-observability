# Changelog

All notable changes to the Antigravity Observability Companion will be documented in this file.

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
