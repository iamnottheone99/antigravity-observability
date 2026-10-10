import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  calculateCacheHitRate,
  calculateCost,
  detectRepetitionLoop,
  parseTranscript,
} from '../plugin/sidecars/panel/telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN = join(ROOT, 'plugin');

console.log('🧪 Running Antigravity Observability Test Suite...\n');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    failed = true;
  }
}

// -----------------------------------------------------------------------------
// 1. Manifest & File Validation
// -----------------------------------------------------------------------------
console.log('📦 Manifest & Structure Checks:');

runTest('plugin.json is valid and contains expected metadata', () => {
  const data = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8'));
  assert.equal(data.name, 'agent-observability');
  assert.ok(data.description && data.description.length > 0);
  assert.equal(data.logo, 'assets/logo.svg');
});

runTest('sidecar.json defines auxiliary pane entrypoint', () => {
  const data = JSON.parse(readFileSync(join(PLUGIN, 'sidecars/panel/sidecar.json'), 'utf8'));
  assert.equal(data.has_web_ui, true);
  assert.equal(data.command, 'node');
  assert.deepEqual(data.args, ['main.mjs']);
  const auxView = data.ui_config?.views?.find(v => v.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE');
  assert.ok(auxView, 'Missing SIDECAR_UI_ENTRYPOINT_AUX_PANE in sidecar.json');
});

runTest('sidecars package.json defines ES module', () => {
  const data = JSON.parse(readFileSync(join(PLUGIN, 'sidecars/panel/package.json'), 'utf8'));
  assert.equal(data.type, 'module');
});

runTest('root package.json is valid', () => {
  const data = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(data.name, 'antigravity-observability');
  assert.equal(data.type, 'module');
});

runTest('HTML layout contains all 4 tabs and key controls', () => {
  const html = readFileSync(join(PLUGIN, 'sidecars/panel/index.html'), 'utf8');
  assert.ok(html.includes('id="pane-overview"'), 'Missing pane-overview');
  assert.ok(html.includes('id="pane-traces"'), 'Missing pane-traces');
  assert.ok(html.includes('id="pane-files"'), 'Missing pane-files');
  assert.ok(html.includes('id="pane-steer"'), 'Missing pane-steer');
  assert.ok(html.includes('id="btn-toggle-monitor"'), 'Missing power toggle');
  assert.ok(html.includes('id="btn-copy-report"'), 'Missing copy report button');
});

// -----------------------------------------------------------------------------
// 2. Syntax Validation
// -----------------------------------------------------------------------------
console.log('\n🔍 Syntax Verification:');

function checkJsSyntax(relPath) {
  runTest(`Syntax OK: ${relPath}`, () => {
    execFileSync('node', ['-c', join(ROOT, relPath)]);
  });
}

checkJsSyntax('plugin/sidecars/panel/main.mjs');
checkJsSyntax('plugin/sidecars/panel/telemetry.mjs');
checkJsSyntax('plugin/sidecars/panel/app.js');
checkJsSyntax('scripts/install.mjs');
checkJsSyntax('scripts/test.mjs');

// -----------------------------------------------------------------------------
// 3. Telemetry Engine Unit Tests
// -----------------------------------------------------------------------------
console.log('\n⚡ Telemetry Engine Unit Tests:');

runTest('calculateCacheHitRate handles zero and invalid values', () => {
  assert.equal(calculateCacheHitRate(0, 0), '0%');
  assert.equal(calculateCacheHitRate(0, 100), '0%');
  assert.equal(calculateCacheHitRate(-10, 100), '0%');
  assert.equal(calculateCacheHitRate(null, undefined), '0%');
});

runTest('calculateCacheHitRate computes bounded percentage accurately', () => {
  assert.equal(calculateCacheHitRate(50, 100), '50.0%');
  assert.equal(calculateCacheHitRate(1, 3), '33.3%');
  assert.equal(calculateCacheHitRate(8000, 10000), '80.0%');
  assert.equal(calculateCacheHitRate(150, 100), '100.0%'); // clamped
});

runTest('calculateCost handles zero tokens', () => {
  assert.equal(calculateCost(0, 0, 0), '$0.0000');
  assert.equal(calculateCost(), '$0.0000');
});

runTest('calculateCost applies Gemini benchmark pricing formula', () => {
  // 1M fresh input ($0.15), 0 cache, 0 out
  assert.equal(calculateCost(1000000, 0, 0), '$0.1500');
  // 0 fresh, 1M cache ($0.0375), 0 out
  assert.equal(calculateCost(0, 1000000, 0), '$0.0375');
  // 0 fresh, 0 cache, 1M out ($0.60)
  assert.equal(calculateCost(0, 0, 1000000), '$0.6000');
  // Mixed calculation
  // 10k in ($0.0015) + 20k cache ($0.00075) + 5k out ($0.0030) = $0.00525 -> $0.0053
  assert.equal(calculateCost(10000, 20000, 5000), '$0.0053');
});

runTest('detectRepetitionLoop returns null when repetitions are below threshold', () => {
  const calls = [
    { name: 'run_command', signature: 'run_command:git status' },
    { name: 'view_file', signature: 'view_file:package.json' },
    { name: 'run_command', signature: 'run_command:git status' },
  ];
  assert.equal(detectRepetitionLoop(calls, 3), null);
  assert.equal(detectRepetitionLoop([], 3), null);
});

runTest('detectRepetitionLoop detects >= 3 consecutive identical tool calls', () => {
  const calls = [
    { name: 'view_file', signature: 'view_file:foo.txt' },
    { name: 'view_file', signature: 'view_file:foo.txt' },
    { name: 'view_file', signature: 'view_file:foo.txt' },
  ];
  const loop = detectRepetitionLoop(calls, 3);
  assert.ok(loop);
  assert.equal(loop.tool, 'view_file');
  assert.equal(loop.repetitions, 3);
  assert.equal(loop.signature, 'view_file:foo.txt');
});

runTest('parseTranscript handles empty or malformed input safely', () => {
  const res = parseTranscript('', { conversationId: 'conv-123', activeTitle: 'Test Chat' });
  assert.equal(res.status, 'active');
  assert.equal(res.conversationId, 'conv-123');
  assert.equal(res.activeTitle, 'Test Chat');
  assert.equal(res.totalSteps, 0);
  assert.equal(res.totalTokens, 0);
  assert.equal(res.estimatedCost, '$0.0000');
  assert.equal(res.cacheHitRate, '0%');
  assert.equal(res.errorCount, 0);
  assert.deepEqual(res.filesTouched, []);
});

runTest('parseTranscript aggregates token metrics, steps, latencies, and touched files', () => {
  const sampleLog = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-10-10T12:00:00.000Z',
      input_tokens: 100,
      cache_read_tokens: 0,
      output_tokens: 0,
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-10-10T12:00:02.500Z',
      input_tokens: 200,
      cache_read_tokens: 300,
      output_tokens: 50,
      tool_calls: [
        {
          name: 'write_to_file',
          args: { TargetFile: 'c:/project/src/index.js', toolSummary: 'Write file' },
        },
        {
          name: 'run_command',
          args: { CommandLine: 'npm test', toolSummary: 'Run tests' },
        },
      ],
    }),
    JSON.stringify({
      step_index: 2,
      source: 'SYSTEM',
      type: 'TOOL_RESPONSE',
      status: 'ERROR',
      content: 'Process terminated with exit status 1',
      created_at: '2026-10-10T12:00:05.000Z',
      input_tokens: 0,
      output_tokens: 0,
    }),
    'invalid-json-line-to-ignore',
  ].join('\n');

  const report = parseTranscript(sampleLog, { conversationId: 'test-conv' });

  assert.equal(report.totalSteps, 3);
  assert.equal(report.inputTokens, 300);
  assert.equal(report.cacheReadTokens, 300);
  assert.equal(report.totalPromptTokens, 600);
  assert.equal(report.outputTokens, 50);
  assert.equal(report.totalTokens, 650);
  assert.equal(report.cacheHitRate, '50.0%');
  assert.equal(report.errorCount, 1);
  assert.equal(report.failedSteps.length, 1);
  assert.deepEqual(report.filesTouched, ['c:/project/src/index.js']);
  assert.equal(report.toolCounts['write_to_file'], 1);
  assert.equal(report.toolCounts['run_command'], 1);

  // Duration checks
  // Step 0: duration = 0
  assert.equal(report.recentSteps[2].durationSeconds, 0);
  // Step 1: 12:00:02.500 - 12:00:00.000 = 2.5s
  assert.equal(report.recentSteps[1].durationSeconds, 2.5);
  // Step 2: 12:00:05.000 - 12:00:02.500 = 2.5s
  assert.equal(report.recentSteps[0].durationSeconds, 2.5);
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
if (failed) {
  console.error('\n❌ Test suite finished with failures.');
  process.exit(1);
} else {
  console.log('\n🎉 All checks and unit tests passed successfully!');
}
