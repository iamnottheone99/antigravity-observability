import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  calculateCacheHitRate,
  calculateCost,
  detectRepetitionLoop,
  escapeHtml,
  formatTokens,
  getToolCategory,
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

runTest('root package.json is valid and declares engines', () => {
  const data = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(data.name, 'antigravity-observability');
  assert.equal(data.type, 'module');
  assert.ok(data.engines?.node, 'Missing engines.node definition');
});

runTest('HTML layout contains all 4 tabs, CSP, and ARIA roles', () => {
  const html = readFileSync(join(PLUGIN, 'sidecars/panel/index.html'), 'utf8');
  assert.ok(html.includes('id="pane-overview"'), 'Missing pane-overview');
  assert.ok(html.includes('id="pane-traces"'), 'Missing pane-traces');
  assert.ok(html.includes('id="pane-files"'), 'Missing pane-files');
  assert.ok(html.includes('id="pane-steer"'), 'Missing pane-steer');
  assert.ok(html.includes('id="btn-toggle-monitor"'), 'Missing power toggle');
  assert.ok(html.includes('id="btn-copy-report"'), 'Missing copy report button');
  assert.ok(html.includes('Content-Security-Policy'), 'Missing Content-Security-Policy meta tag');
  assert.ok(html.includes('role="tablist"'), 'Missing role="tablist"');
  assert.ok(html.includes('role="tabpanel"'), 'Missing role="tabpanel"');
  assert.ok(html.includes('aria-label="Select conversation to observe"'), 'Missing select aria-label');
  assert.ok(html.includes('aria-label="Type instruction for agent"'), 'Missing steer input aria-label');
});

// -----------------------------------------------------------------------------
// 2. Syntax Verification
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
  assert.equal(calculateCost(1000000, 0, 0), '$0.1500');
  assert.equal(calculateCost(0, 1000000, 0), '$0.0375');
  assert.equal(calculateCost(0, 0, 1000000), '$0.6000');
  assert.equal(calculateCost(10000, 20000, 5000), '$0.0053');
});

runTest('detectRepetitionLoop detects strictly consecutive identical tool calls', () => {
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

runTest('detectRepetitionLoop does not trigger false positives on alternating patterns', () => {
  // Common edit-inspect cycle: view, edit, view, edit, view
  const alternating = [
    { name: 'view_file', signature: 'view_file:foo.txt' },
    { name: 'replace_file_content', signature: 'replace_file_content:foo.txt' },
    { name: 'view_file', signature: 'view_file:foo.txt' },
    { name: 'replace_file_content', signature: 'replace_file_content:foo.txt' },
    { name: 'view_file', signature: 'view_file:foo.txt' },
  ];
  assert.equal(detectRepetitionLoop(alternating, 3), null);
});

runTest('detectRepetitionLoop ignores trailing calls without arguments', () => {
  const emptySig = [
    { name: 'run_command', signature: 'run_command:' },
    { name: 'run_command', signature: 'run_command:' },
    { name: 'run_command', signature: 'run_command:' },
  ];
  assert.equal(detectRepetitionLoop(emptySig, 3), null);
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
  assert.equal(report.recentSteps[2].durationSeconds, 0);
  assert.equal(report.recentSteps[1].durationSeconds, 2.5);
  assert.equal(report.recentSteps[0].durationSeconds, 2.5);
});

runTest('parseTranscript captures rich arguments, tool outputs, thinking, and per-step economics', () => {
  const sampleLog = [
    JSON.stringify({
      step_index: 10,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-10-10T12:00:00.000Z',
      input_tokens: 500,
      cache_read_tokens: 1500,
      output_tokens: 100,
      thinking: 'Need to check git branch first.',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: 'git status', toolAction: 'Checking git status' },
        },
      ],
    }),
    JSON.stringify({
      step_index: 11,
      source: 'SYSTEM',
      type: 'GENERIC',
      status: 'DONE',
      content: 'On branch main\nnothing to commit',
      created_at: '2026-10-10T12:00:01.000Z',
    }),
  ].join('\n');

  const report = parseTranscript(sampleLog, { conversationId: 'conv-detail' });
  const step = report.recentSteps[1]; // step 10 in reversed array

  assert.equal(step.stepIndex, 10);
  assert.equal(step.thinking, 'Need to check git branch first.');
  assert.equal(step.outputSnippet, 'On branch main\nnothing to commit');
  assert.equal(step.totalStepTokens, 2100);
  assert.equal(step.tools[0].primaryArg, '$ git status');
  assert.equal(step.tools[0].args.CommandLine, 'git status');
  assert.equal(step.tools[0].category, 'shell');
});

// -----------------------------------------------------------------------------
// 4. Frontend Helper Unit Tests
// -----------------------------------------------------------------------------
console.log('\n🎨 Frontend Helper Unit Tests:');

runTest('getToolCategory classifies tools into proper categories', () => {
  assert.equal(getToolCategory('replace_file_content').id, 'file');
  assert.equal(getToolCategory('write_to_file').id, 'file');
  assert.equal(getToolCategory('run_command').id, 'shell');
  assert.equal(getToolCategory('view_file').id, 'read');
  assert.equal(getToolCategory('search_web').id, 'read');
  assert.equal(getToolCategory('invoke_subagent').id, 'agent');
  assert.equal(getToolCategory('send_message').id, 'agent');
  assert.equal(getToolCategory('unknown_custom_tool').id, 'other');
});

runTest('formatTokens formats values with k and M units correctly', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(null), '0');
  assert.equal(formatTokens(NaN), '0');
  assert.equal(formatTokens(850), '850');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(24000), '24.0k');
  assert.equal(formatTokens(1250000), '1.25M');
});

runTest('escapeHtml escapes dangerous HTML entities', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('foo & bar'), 'foo &amp; bar');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
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
