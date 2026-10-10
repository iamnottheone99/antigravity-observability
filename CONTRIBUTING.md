# Contributing to Antigravity Observability Companion

Thank you for your interest in contributing to the Antigravity Observability Companion!

## Development Setup

1. **Prerequisites**:
   - Node.js 20.0.0 or higher.
   - Google Antigravity IDE or Antigravity 2.0 desktop application.

2. **Clone & Test**:
   ```bash
   git clone https://github.com/iamnottheone99/antigravity-observability.git
   cd antigravity-observability
   npm test
   ```

3. **Install Locally**:
   To test your changes inside Antigravity:
   ```bash
   npm run install-plugin
   ```
   Then reload the plugin in Antigravity via **Customizations** -> **Installed** -> toggle `agent-observability` OFF and ON.

## Code Guidelines

- **Zero External Dependencies**: Keep the sidecar pure Node.js ESM. Do not add runtime dependencies from npm.
- **Node Compatibility**: Ensure code remains backwards compatible with Node.js 20+. Use dynamic imports for features introduced in newer versions (like `node:sqlite`).
- **Resource Safety**: Always wrap file descriptors, streams, and database handles in `try ... finally` blocks.
- **Testing**: Add unit tests in `scripts/test.mjs` for any changes made to calculations or parsing logic in `telemetry.mjs`.

## Pull Request Process

1. Fork the repository and create a feature branch (`git checkout -b feature/my-feature`).
2. Make your edits and ensure `npm test` passes without errors.
3. Commit with descriptive messages.
4. Push to your branch and submit a Pull Request.
