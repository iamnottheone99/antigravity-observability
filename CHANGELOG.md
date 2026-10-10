# Changelog

All notable changes to the Antigravity Observability Companion will be documented in this file.

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
