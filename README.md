# Antigravity Observability Companion

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Antigravity-2.0%20%7C%20IDE-4285F4.svg)](#)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero%20(Pure%20Node)-10b981.svg)](#)

A real-time, in-IDE observability dashboard, prompt cache analyzer, and human-in-the-loop steering extension for **Google Antigravity**.

Rendered directly inside Antigravity's **Auxiliary Side Pane**, this extension tracks financial costs, cache efficiency, tool distribution, and execution traces across all your agent sessions without adding latency to model generation loops.

---

## ✨ Features

* **💰 Live Cost & Cache Hit Analytics**:
  - Calculates real-time dollar cost with discounted prompt caching.
  - Mathematically bounded Prompt Cache Hit Rate gauge ($\frac{\text{cached}}{\text{uncached} + \text{cached}} \times 100\%$).
  - Breakdown of fresh prompt tokens, cached prompt hits, and completion tokens.
* **⚡ Vertical Waterfall Trace Timeline**:
  - Full-height continuous execution rail with duration tags (`+1.2s`) and status indicators.
  - Click-to-expand details showing exact tool arguments, commands executed, and timestamps.
  - Instant toggle to isolate errors and failed tool runs (`Exit Status 1`).
* **🎯 Human-in-the-Loop Steering**:
  - Quick action chips: `Pause & Explain`, `Run Tests`, and `Review Diffs`.
  - Inline prompt injector to steer the agent directly from the side panel.
  - One-click **Copy Markdown Report** for sharing session traces in PRs or issues.
* **🛡️ Loop & Stall Radar**:
  - Sliding-window signature detector that flags repetitive tool calls ($\ge 3$ consecutive executions with identical arguments).
* **📊 Categorical Tool Spectrum**:
  - Segmented distribution bar grouping calls into File Edits, Shell/Terminal, Search/Read, and Subagents.
* **🔄 Seamless Multi-Chat Auto Tracking**:
  - Reads Antigravity's internal `conversation_summaries.db` SQLite database to display user-facing chat titles.
  - **Auto** mode dynamically follows whichever conversation was modified most recently.
* **⏻ In-UI Monitoring Toggle**:
  - One-click `[ ⏻ ON / OFF ]` button to pause and resume live polling without closing or unmounting the extension.

---

## 🏗️ Architecture

```mermaid
flowchart LR
    subgraph Antigravity Engine
        Agent[Agent Execution Loop] -->|Streams| Transcript["transcript.jsonl (tokens, tool calls)"]
        Agent -->|Updates| DB["conversation_summaries.db (titles, mtime)"]
    end

    subgraph Sidecar Extension Backend
        Backend["main.mjs (SidecarApp)"] -.->|Reads| Transcript
        Backend -.->|Queries| DB
    end

    subgraph IDE Auxiliary Side Pane
        Bridge["/preload.js (window.sidecar)"] <-->|IPC / HTTP| Backend
        Frontend["index.html + app.js (4-Tab UI)"] <--> Bridge
    end
```

---

## 🚀 Quick Start

### Prerequisites
* **Node.js 20+** installed
* **Google Antigravity** (IDE or Antigravity 2.0 desktop app)

### 1. Clone & Install
```bash
# Clone the repository
git clone https://github.com/your-username/antigravity-observability.git
cd antigravity-observability

# Install the plugin into your global Antigravity plugins directory
npm run install-plugin
```

> The install script copies the plugin bundle to:
> - **Windows**: `%USERPROFILE%\.gemini\config\plugins\agent-observability\`
> - **macOS / Linux**: `~/.gemini/config/plugins/agent-observability/`

### 2. Enable in Antigravity
1. Open Google Antigravity.
2. In the left sidebar, click the **Customizations** icon.
3. Under the **Installed** tab, find **`agent-observability`** and toggle it **ON**.
4. Open any chat, click **⋮** (top right) $\rightarrow$ **Extensions** $\rightarrow$ **Observability**.

---

## 📁 Repository Layout

```text
antigravity-observability/
├── package.json             # Root scripts (test, install-plugin)
├── scripts/
│   ├── install.mjs          # Cross-platform installer
│   └── test.mjs             # Manifest & syntax validation test suite
└── plugin/                  # The Antigravity plugin bundle
    ├── plugin.json          # Plugin manifest
    ├── assets/
    │   └── logo.svg         # Telemetry radar icon
    └── sidecars/
        └── panel/
            ├── sidecar.json # Aux pane extension declaration
            ├── package.json # ES module package configuration
            ├── main.mjs     # Node.js backend (reads transcripts & SQLite summaries)
            ├── index.html   # 4-Tab client-side interface
            ├── styles.css   # Dark-mode theme-aware styling
            └── app.js       # Live polling & UI rendering logic
```

---

## 🧪 Testing & Verification

Run the automated test suite to verify manifest integrity and JavaScript syntax:

```bash
npm test
```

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for more details.
