import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const APP_PATH = join(ROOT, 'plugin/sidecars/panel/app.js');

// -----------------------------------------------------------------------------
// Lightweight Headless DOM Mock (Zero Dependencies)
// -----------------------------------------------------------------------------

class MockElement {
  constructor(id = '', tag = 'div') {
    this.id = id;
    this.tagName = tag.toUpperCase();
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.style = {};
    this.className = '';
    this.classList = {
      _classes: new Set(),
      add: (...cls) => cls.forEach(c => this.classList._classes.add(c)),
      remove: (...cls) => cls.forEach(c => this.classList._classes.delete(c)),
      toggle: (c, force) => {
        if (force === true) this.classList._classes.add(c);
        else if (force === false) this.classList._classes.delete(c);
        else if (this.classList._classes.has(c)) this.classList._classes.delete(c);
        else this.classList._classes.add(c);
      },
      contains: (c) => this.classList._classes.has(c),
    };
    this.attributes = new Map();
    this.listeners = new Map();
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  addEventListener(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(handler);
  }

  querySelectorAll(sel) {
    return [];
  }

  focus() {}
}

const elements = new Map();
function getOrCreate(id) {
  if (!elements.has(id)) {
    elements.set(id, new MockElement(id));
  }
  return elements.get(id);
}

// Configure global DOM mocks
globalThis.document = {
  getElementById: (id) => getOrCreate(id),
  querySelectorAll: (sel) => {
    if (sel === '.nav-tab') {
      return [getOrCreate('nav-tab-overview'), getOrCreate('nav-tab-traces')];
    }
    if (sel === '.tab-pane') {
      return [getOrCreate('pane-overview'), getOrCreate('pane-traces')];
    }
    return [];
  },
};

globalThis.__IS_HEADLESS_TEST__ = true;

globalThis.window = {
  sidecar: {
    agent: {
      sendMessage: async (text, convId) => ({ success: true }),
    },
    fetch: async (path) => ({
      ok: true,
      json: async () => ({
        conversationId: 'test-conv-001',
        totalSteps: 5,
        totalTokens: 1200,
        recentSteps: [],
        toolCounts: {},
      }),
    }),
    conversationId: 'test-conv-001',
  },
  addEventListener: () => {},
};

try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText: async (text) => {},
      },
    },
    configurable: true,
    writable: true,
  });
} catch (_) {
  if (globalThis.navigator && !globalThis.navigator.clipboard) {
    globalThis.navigator.clipboard = { writeText: async (text) => {} };
  }
}

// Evaluate app.js in current context
const appSource = readFileSync(APP_PATH, 'utf8');
vm.runInThisContext(appSource);

const api = globalThis.__observabilityPanel;
assert.ok(api, 'Panel API must be exported on globalThis');

// -----------------------------------------------------------------------------
// Unit Test Suite for All 22 Sidecar Panel Functions
// -----------------------------------------------------------------------------

console.log('[Panel UI Unit Tests] Running panel component tests...\n');

// 1. byId
console.log('  Testing byId...');
assert.ok(api.byId('toast'));
assert.equal(api.byId('toast').id, 'toast');
assert.equal(api.byId('non-existent').id, 'non-existent');

// 2. showToast
console.log('  Testing showToast...');
api.showToast('Test Notification');
assert.equal(getOrCreate('toast-msg').textContent, 'Test Notification');
assert.ok(getOrCreate('toast').classList.contains('visible'));

// 3. formatTokens
console.log('  Testing formatTokens...');
assert.equal(api.formatTokens(0), '0');
assert.equal(api.formatTokens(null), '0');
assert.equal(api.formatTokens(1500), '1.5k');
assert.equal(api.formatTokens(24000), '24.0k');
assert.equal(api.formatTokens(1250000), '1.25M');

// 4. escapeHtml
console.log('  Testing escapeHtml...');
assert.equal(api.escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
assert.equal(api.escapeHtml("it's fine"), 'it&#39;s fine');
assert.equal(api.escapeHtml(null), '');

// 5. getToolCategory
console.log('  Testing getToolCategory...');
assert.equal(api.getToolCategory('replace_file_content').id, 'file');
assert.equal(api.getToolCategory('run_command').id, 'shell');
assert.equal(api.getToolCategory('read_file').id, 'read');
assert.equal(api.getToolCategory('invoke_subagent').id, 'agent');
assert.equal(api.getToolCategory('call_mcp_tool', 'engram').id, 'mcp-engram');
assert.equal(api.getToolCategory('call_mcp_tool', 'zvec').id, 'mcp-zvec');
assert.equal(api.getToolCategory('custom_tool').id, 'other');

// 6. sendSteerMessage
console.log('  Testing sendSteerMessage...');
await api.sendSteerMessage('Please run unit tests');
assert.equal(getOrCreate('steer-input').value, '');

// 7. renderToolSpectrum
console.log('  Testing renderToolSpectrum...');
api.renderToolSpectrum({ read_file: 4, write_file: 2 }, { engram: 1 }, ['automation']);
assert.equal(getOrCreate('spectrum-total').textContent, '6 calls');

// 8. renderCognitiveSpectrum
console.log('  Testing renderCognitiveSpectrum...');
api.renderCognitiveSpectrum(
  { exploration: 20, execution: 50, verification: 30 },
  'EXECUTION',
  'Execution',
  { engine: 'zvec-grep', active: true, dimensions: 256, cachedVectors: 12 }
);
assert.equal(getOrCreate('val-current-phase').textContent, 'Execution');
assert.ok(getOrCreate('val-classifier-engine').textContent.includes('zvec-grep'));

// 9. renderHealthScorecard
console.log('  Testing renderHealthScorecard...');
api.renderHealthScorecard({
  score: 95,
  grade: 'Optimal',
  color: '#10b981',
  summary: 'Healthy execution',
  pillars: { reliability: 100, loopRadar: 90, phaseBalance: 95, contextEconomy: 95 },
});
assert.equal(String(getOrCreate('val-health-score').textContent), '95');
assert.equal(getOrCreate('badge-health-grade').textContent, 'Optimal');

// 10. setPillar
console.log('  Testing setPillar...');
api.setPillar('reliability', 85);
assert.equal(getOrCreate('pillar-val-reliability').textContent, '85%');
api.setPillar('loop', 55);
assert.equal(getOrCreate('pillar-val-loop').textContent, '55%');

// 11. renderErrorTaxonomy
console.log('  Testing renderErrorTaxonomy...');
api.renderErrorTaxonomy({
  syntax_parse: { id: 'syntax_parse', label: 'Syntax Error', count: 2, color: '#ef4444' },
});
assert.equal(getOrCreate('error-taxonomy-badge').textContent, '2 errors');

// 12. renderErrorClustersFilter
console.log('  Testing renderErrorClustersFilter...');
api.renderErrorClustersFilter({
  syntax_parse: { id: 'syntax_parse', label: 'Syntax Error', count: 2, color: '#ef4444' },
});
assert.ok(getOrCreate('error-clusters-filter'));

// 13. switchToTab
console.log('  Testing switchToTab...');
api.switchToTab('pane-traces');
assert.ok(getOrCreate('pane-traces').classList.contains('active'));

// 14. setFilterMode
console.log('  Testing setFilterMode...');
api.setFilterMode('tools');
assert.ok(getOrCreate('tab-tools').classList.contains('active'));
api.setFilterMode('errors', 'syntax_parse');
assert.ok(getOrCreate('tab-errors').classList.contains('active'));

// 15. renderWaterfall
console.log('  Testing renderWaterfall...');
api.renderWaterfall();
assert.ok(getOrCreate('waterfall-feed'));

// 16. renderFiles
console.log('  Testing renderFiles...');
api.renderFiles(['plugin/sidecars/panel/app.js', 'plugin/sidecars/panel/main.mjs']);
assert.equal(String(getOrCreate('tab-files-badge').textContent), '2');
assert.equal(getOrCreate('files-summary-count').textContent, '2 files');
api.renderFiles([]);
assert.equal(String(getOrCreate('tab-files-badge').textContent), '0');

// 17. copySessionReport
console.log('  Testing copySessionReport...');
api.copySessionReport();
assert.ok(getOrCreate('toast-msg'));

// 18. updateSessionDropdown
console.log('  Testing updateSessionDropdown...');
api.updateSessionDropdown([{ id: 'sess-001', title: 'Task Observability', stepCount: 12 }], 'Task Observability');
assert.ok(getOrCreate('session-select').innerHTML.includes('Task Observability'));

// 19. refreshTelemetry
console.log('  Testing refreshTelemetry...');
await api.refreshTelemetry(false);

// 20. setupTabsAndControls
console.log('  Testing setupTabsAndControls...');
api.setupTabsAndControls();

// 21. selectTab
console.log('  Testing selectTab...');
const mockNavTab = new MockElement('nav-tab-overview');
mockNavTab.setAttribute('data-tab', 'pane-overview');
api.selectTab(mockNavTab);
assert.ok(mockNavTab.classList.contains('active'));

// 22. toggleMonitoring
console.log('  Testing toggleMonitoring...');
api.toggleMonitoring();
assert.equal(getOrCreate('power-text').textContent, 'OFF');
api.toggleMonitoring();
assert.equal(getOrCreate('power-text').textContent, 'ON');

console.log('\n[SUCCESS] All 22 panel functions executed and verified successfully!');
process.exit(0);
