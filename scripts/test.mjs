import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  calculateCacheHitRate,
  calculateCacheSavings,
  calculateCost,
  detectRepetitionLoop,
  escapeHtml,
  formatTokens,
  getToolCategory,
  parseTranscript,
  redactSecrets,
  COGNITIVE_PHASES,
  PHASE_METADATA,
  analyzeSessionCognition,
  classifyStepPhase,
  detectSemanticLoop,
  ERROR_CATEGORIES,
  classifyError,
  calculateAgentHealth,
} from '../plugin/sidecars/panel/telemetry.mjs';

import {
  cosineSimilarity,
  computeNgramSimilarity,
  getStepSemanticSignature,
  getEmbeddingEngineStatus,
} from '../plugin/sidecars/panel/classifier.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGIN = join(ROOT, 'plugin');

console.log('[Test Suite] Running Antigravity Observability Test Suite...\n');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (err) {
    console.error(`  FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    failed = true;
  }
}

// -----------------------------------------------------------------------------
// 1. Manifest & File Validation
// -----------------------------------------------------------------------------
console.log('[Manifest & Structure Checks]');

runTest('plugin.json is valid and contains expected metadata', () => {
  const data = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8'));
  assert.equal(data.name, 'agent-observability');
  assert.equal(data.version, '1.4.0');
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

runTest('sidecars package.json defines ES module and matches version', () => {
  const data = JSON.parse(readFileSync(join(PLUGIN, 'sidecars/panel/package.json'), 'utf8'));
  assert.equal(data.type, 'module');
  assert.equal(data.version, '1.4.0');
});

runTest('sidecar main.mjs status route matches version 1.4.0', () => {
  const code = readFileSync(join(PLUGIN, 'sidecars/panel/main.mjs'), 'utf8');
  assert.ok(code.includes("version: '1.4.0'"), 'main.mjs status version is not 1.4.0');
});

runTest('sidecar main.mjs defines transcript cache TTL and expiry pruning', () => {
  const code = readFileSync(join(PLUGIN, 'sidecars/panel/main.mjs'), 'utf8');
  assert.ok(code.includes('TRANSCRIPT_TTL_MS = 60000'), 'Missing TRANSCRIPT_TTL_MS constant');
  assert.ok(code.includes('now < cached.expiresAt'), 'Missing cache expiry verification check');
  assert.ok(code.includes('transcriptCache.delete(id)'), 'Missing cache pruning logic');
});

runTest('CI workflow restricts GITHUB_TOKEN permissions to read-only', () => {
  const ciYaml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  assert.ok(ciYaml.includes('permissions:\n  contents: read'), 'Missing read-only permissions in ci.yml');
});

runTest('root package.json is valid and declares engines', () => {
  const data = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(data.name, 'antigravity-observability');
  assert.equal(data.version, '1.4.0');
  assert.equal(data.type, 'module');
  assert.ok(data.engines?.node, 'Missing engines.node definition');
});

runTest('HTML layout contains all 4 tabs, CSP, ARIA roles, and cognitive phase components', () => {
  const html = readFileSync(join(PLUGIN, 'sidecars/panel/index.html'), 'utf8');
  assert.ok(html.includes('id="pane-overview"'), 'Missing pane-overview');
  assert.ok(html.includes('id="pane-traces"'), 'Missing pane-traces');
  assert.ok(html.includes('id="pane-files"'), 'Missing pane-files');
  assert.ok(html.includes('id="pane-steer"'), 'Missing pane-steer');
  assert.ok(html.includes('id="btn-toggle-monitor"'), 'Missing power toggle');
  assert.ok(html.includes('id="btn-refresh"'), 'Missing refresh button');
  assert.ok(html.includes('id="val-context"'), 'Missing Context Window tile value');
  assert.ok(html.includes('id="spectrum-skills"'), 'Missing spectrum-skills container');
  assert.ok(html.includes('id="val-current-phase"'), 'Missing val-current-phase element');
  assert.ok(html.includes('id="cognitive-phase-bar"'), 'Missing cognitive-phase-bar element');
  assert.ok(html.includes('id="cognitive-phase-legend"'), 'Missing cognitive-phase-legend element');
  assert.ok(html.includes('id="val-classifier-engine"'), 'Missing val-classifier-engine element');
  assert.ok(html.includes('id="btn-copy-report"'), 'Missing copy report button');
  assert.ok(html.includes('Content-Security-Policy'), 'Missing Content-Security-Policy meta tag');
  assert.ok(html.includes('id="val-health-score"'), 'Missing val-health-score element');
  assert.ok(html.includes('id="badge-health-grade"'), 'Missing badge-health-grade element');
  assert.ok(html.includes('id="bar-health-fill"'), 'Missing bar-health-fill element');
  assert.ok(html.includes('class="health-scorecard-section"'), 'Missing health-scorecard-section');
  assert.ok(html.includes('class="error-taxonomy-section"'), 'Missing error-taxonomy-section');
  assert.ok(html.includes('id="error-clusters-filter"'), 'Missing error-clusters-filter');
  assert.ok(html.includes('role="tablist"'), 'Missing role="tablist"');
  assert.ok(html.includes('role="tabpanel"'), 'Missing role="tabpanel"');
  assert.ok(html.includes('aria-label="Select conversation to observe"'), 'Missing select aria-label');
  assert.ok(html.includes('aria-label="Type instruction for agent"'), 'Missing steer input aria-label');
});

// -----------------------------------------------------------------------------
// 2. Syntax Verification
// -----------------------------------------------------------------------------
console.log('\n[Syntax Verification]');

function checkJsSyntax(relPath) {
  runTest(`Syntax OK: ${relPath}`, () => {
    execFileSync('node', ['-c', join(ROOT, relPath)]);
  });
}

checkJsSyntax('plugin/sidecars/panel/main.mjs');
checkJsSyntax('plugin/sidecars/panel/telemetry.mjs');
checkJsSyntax('plugin/sidecars/panel/classifier.mjs');
checkJsSyntax('plugin/sidecars/panel/app.js');
checkJsSyntax('scripts/install.mjs');
checkJsSyntax('scripts/test.mjs');

// -----------------------------------------------------------------------------
// 3. Telemetry Engine Unit Tests
// -----------------------------------------------------------------------------
console.log('\n[Telemetry Engine Unit Tests]');

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

runTest('calculateCacheSavings computes 75% prompt cache discount savings', () => {
  assert.equal(calculateCacheSavings(0), '$0.0000');
  assert.equal(calculateCacheSavings(1000000), '$0.1125');
  assert.equal(calculateCacheSavings(500000), '$0.0562');
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
  assert.equal(res.currentPhase, 'SYNTHESIS');
  assert.deepEqual(res.filesTouched, []);
  assert.ok(res.healthScorecard, 'Missing healthScorecard in empty session fallback');
  assert.equal(res.healthScorecard.score, 100);
  assert.ok(res.errorTaxonomy, 'Missing errorTaxonomy in empty session fallback');
  assert.deepEqual(res.errorTaxonomy, {});
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
  assert.equal(report.cacheSavings, '$0.0000');
  assert.equal(report.latestContextTokens, 500);
  assert.equal(report.contextLoadPercent, '0.1%');
  assert.equal(report.activeModel, 'Gemini');
  assert.equal(report.toolSuccessRate, '50.0%');
  assert.equal(report.avgStepDuration, '2.5s');
  assert.equal(report.errorCount, 1);
  assert.equal(report.failedSteps.length, 1);
  assert.deepEqual(report.filesTouched, ['c:/project/src/index.js']);
  assert.equal(report.toolCounts['write_to_file'], 1);
  assert.equal(report.toolCounts['run_command'], 1);

  // Cognitive fields in report
  assert.ok(report.currentPhase);
  assert.ok(report.phaseDistribution);
  assert.ok(report.cognitiveEngine);

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
  assert.equal(step.phase, 'VERIFICATION');
});

runTest('parseTranscript detects model settings changes, compactions, and subagents', () => {
  const log = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High).\n<CONTEXT_SUMMARY>Compacted session</CONTEXT_SUMMARY>',
    }),
    JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      input_tokens: 1500,
      cache_read_tokens: 3500,
      output_tokens: 200,
      tool_calls: [
        { name: 'invoke_subagent', args: { TypeName: 'research' } },
        { name: 'call_mcp_tool', args: { ServerName: 'engram' } },
        { name: 'view_file', args: { AbsolutePath: 'c:/Users/test/.gemini/config/skills/graphify/SKILL.md' } },
        { name: 'write_to_file', args: { TargetFile: 'c:/brain/plan.md' } },
      ],
    }),
  ].join('\n');

  const report = parseTranscript(log, { conversationId: 'c1' });
  assert.equal(report.activeModel, 'Gemini 3.8 Flash (High)');
  assert.equal(report.compactionsCount, 1);
  assert.equal(report.subagentCalls, 1);
  assert.equal(report.mcpCalls, 1);
  assert.deepEqual(report.mcpServers, { engram: 1 });
  assert.ok(report.activeSkills.includes('engram'));
  assert.ok(report.activeSkills.includes('graphify'));
  assert.equal(report.artifactsCount, 1);
  assert.equal(report.latestContextTokens, 5000);
  assert.equal(report.contextLoadPercent, '0.5%');
  assert.equal(report.cacheSavings, '$0.0004');
});

runTest('parseTranscript ignores CONTEXT_SUMMARY mentions in assistant turns', () => {
  const log = [
    JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Here is a discussion mentioning <CONTEXT_SUMMARY> in normal text.',
    }),
  ].join('\n');
  const report = parseTranscript(log, { conversationId: 'c-compaction' });
  assert.equal(report.compactionsCount, 0);
});

runTest('parseTranscript recognizes modern Antigravity 2.0 tool calls with Path argument', () => {
  const log = [
    JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'read_file',
          args: { Path: 'c:/project/index.js', StartLine: 10, EndLine: 50 },
        },
        {
          name: 'edit_file',
          args: { Path: 'c:/project/index.js', Target: 'foo', Replacement: 'bar' },
        },
        {
          name: 'write_file',
          args: { Path: 'c:/brain/spec.md', Content: '# Spec' },
        },
      ],
    }),
  ].join('\n');

  const report = parseTranscript(log, { conversationId: 'c-modern-tools' });
  assert.equal(report.filesTouched.length, 2);
  assert.ok(report.filesTouched.includes('c:/project/index.js'));
  assert.ok(report.filesTouched.includes('c:/brain/spec.md'));
  assert.equal(report.artifactsCount, 1);
  assert.equal(report.toolCounts['read_file'], 1);
  assert.equal(report.toolCounts['edit_file'], 1);
  assert.equal(report.toolCounts['write_file'], 1);

  const step = report.recentSteps[0];
  assert.equal(step.tools[0].primaryArg, 'c:/project/index.js:10-50');
  assert.equal(step.tools[0].category, 'read');
  assert.equal(step.tools[1].primaryArg, 'Edit c:/project/index.js');
  assert.equal(step.tools[1].category, 'file');
  assert.equal(step.tools[2].primaryArg, 'Create c:/brain/spec.md');
  assert.equal(step.tools[2].category, 'file');
});

runTest('redactSecrets sanitizes Bearer tokens, GitHub PATs, and URL credentials', () => {
  assert.equal(
    redactSecrets('Authorization: Bearer ya29.a0AWY7C1234567890abcdef'),
    'Authorization: Bearer [REDACTED]'
  );
  assert.equal(
    redactSecrets('token: ghp_1234567890abcdefghijklmnopqrstuvwxyz'),
    'token: [REDACTED_GH_TOKEN]'
  );
  assert.equal(
    redactSecrets('git clone https://x-access-token:ghs_secret123456789@github.com/repo.git'),
    'git clone https://x-access-token:[REDACTED]@github.com/repo.git'
  );
  assert.equal(
    redactSecrets('apiKey="AIzaSyA1234567890abcdef"'),
    'apiKey="[REDACTED]"'
  );
});

runTest('parseTranscript redacts sensitive credentials from tool args and outputs', () => {
  const log = [
    JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      thinking: 'Connecting with Bearer ya29.a0AWY7C1234567890abcdef',
      tool_calls: [
        {
          name: 'run_command',
          args: { CommandLine: 'curl -H "Authorization: Bearer secret-token-123456789" https://api.example.com' },
        },
      ],
    }),
    JSON.stringify({
      step_index: 1,
      source: 'SYSTEM',
      type: 'TOOL_RESPONSE',
      content: 'Output contains apiKey="AIzaSyA1234567890abcdef" successfully',
    }),
  ].join('\n');

  const report = parseTranscript(log, { conversationId: 'c-secret' });
  assert.ok(!report.recentSteps[0].outputSnippet.includes('AIzaSyA1234567890abcdef'));
  assert.ok(report.recentSteps[0].outputSnippet.includes('[REDACTED]'));
  assert.ok(!report.recentSteps[1].thinking.includes('ya29.a0AWY7C1234567890abcdef'));
  assert.ok(report.recentSteps[1].thinking.includes('[REDACTED]'));
  assert.ok(!report.recentSteps[1].tools[0].primaryArg.includes('secret-token-123456789'));
  assert.ok(report.recentSteps[1].tools[0].primaryArg.includes('[REDACTED]'));
});

runTest('classifyError categorizes all 8 error taxonomy categories accurately', () => {
  // 1. Path not found
  const pathErr1 = classifyError('GetFileAttributesEx c:\\Users\\test\\missing.txt: The system cannot find the path specified.');
  assert.equal(pathErr1.id, ERROR_CATEGORIES.PATH_NOT_FOUND.id);
  assert.equal(pathErr1.summary, 'File not found: missing.txt');

  const pathErr2 = classifyError('ENOENT: no such file or directory, open "c:/project/foo.js"');
  assert.equal(pathErr2.id, ERROR_CATEGORIES.PATH_NOT_FOUND.id);

  // 2. Edit conflict
  const editErr1 = classifyError('target content not found in file chunk 1');
  assert.equal(editErr1.id, ERROR_CATEGORIES.EDIT_CONFLICT.id);

  const editErr2 = classifyError('TargetContent chunk mismatch: Could not successfully apply any edits');
  assert.equal(editErr2.id, ERROR_CATEGORIES.EDIT_CONFLICT.id);

  // 3. MCP Protocol error
  const mcpErr1 = classifyError('{"error": {"code": -32603, "message": "unknown_project"}}', 'call_mcp_tool');
  assert.equal(mcpErr1.id, ERROR_CATEGORIES.MCP_ERROR.id);

  const mcpErr2 = classifyError('Encountered error in tool execution from MCP server');
  assert.equal(mcpErr2.id, ERROR_CATEGORIES.MCP_ERROR.id);

  // 4. Permission error
  const permErr = classifyError('EACCES: permission denied, open /etc/shadow');
  assert.equal(permErr.id, ERROR_CATEGORIES.PERMISSION.id);

  // 5. Validation error
  const valErr = classifyError('invalid tool call: missing required parameter TargetFile');
  assert.equal(valErr.id, ERROR_CATEGORIES.VALIDATION.id);

  // 6. Timeout error
  const timeErr = classifyError('ETIMEDOUT: operation timed out after 30000ms');
  assert.equal(timeErr.id, ERROR_CATEGORIES.TIMEOUT.id);

  // 7. Command failed
  const cmdErr = classifyError('Process terminated with exit status 1', 'run_command');
  assert.equal(cmdErr.id, ERROR_CATEGORIES.COMMAND_FAILED.id);
  assert.equal(cmdErr.summary, 'Process terminated with exit status 1');

  // 8. General runtime fallback
  const runtimeErr = classifyError('TypeError: Cannot read properties of undefined');
  assert.equal(runtimeErr.id, ERROR_CATEGORIES.RUNTIME.id);
});

runTest('calculateAgentHealth computes weighted scorecards, grades, and diagnostics', () => {
  // Baseline clean execution (Optimal A+)
  const cleanHealth = calculateAgentHealth({
    totalSteps: 10,
    toolCounts: { run_command: 5, view_file: 5 },
    failedSteps: [],
  });
  assert.equal(cleanHealth.score, 100);
  assert.equal(cleanHealth.grade, 'Optimal');
  assert.equal(cleanHealth.pillars.toolReliability, 100);
  assert.equal(cleanHealth.pillars.loopRadar, 100);
  assert.equal(cleanHealth.pillars.phaseBalance, 100);
  assert.equal(cleanHealth.pillars.contextEconomy, 100);

  // Tool reliability penalty with recovery credit
  const errHealth = calculateAgentHealth({
    totalSteps: 10,
    toolCounts: { run_command: 8, view_file: 2 },
    failedSteps: [{ content: 'exit status 1' }, { content: 'exit status 1' }],
  });
  // 10 calls, 2 errors, 2 recovered: rawRate = 80, recoveryBonus = 10 -> reliability = 90
  assert.equal(errHealth.pillars.toolReliability, 90);

  // Loop radar penalty on consecutive repetitions
  const loopHealth = calculateAgentHealth({
    loopDetected: { repetitions: 4, tool: 'run_command' },
  });
  // 100 - (4 * 12) = 52
  assert.equal(loopHealth.pillars.loopRadar, 52);

  // Phase imbalance penalty (unverified execution)
  const unverifiedHealth = calculateAgentHealth({
    cognition: {
      phaseDistribution: { execution: 30, verification: 0, exploration: 70 },
    },
  });
  assert.equal(unverifiedHealth.pillars.phaseBalance, 70); // 100 - 30
  assert.ok(unverifiedHealth.deductions.some(d => d.includes('Unverified modifications')));

  // Context economy penalty (compactions and near-capacity load)
  const contextHeavyHealth = calculateAgentHealth({
    compactionsCount: 2,
    latestContextTokens: 900000,
    contextLimit: 1000000, // 90% load
  });
  // compactions: 100 - 30 = 70; load >= 85%: 70 - 25 = 45
  assert.equal(contextHeavyHealth.pillars.contextEconomy, 45);
  assert.ok(contextHeavyHealth.deductions.some(d => d.includes('2 context compactions')));
  assert.ok(contextHeavyHealth.deductions.some(d => d.includes('saturation')));

  // Clamped and degraded grade
  const degradedHealth = calculateAgentHealth({
    toolCounts: { run_command: 5 },
    failedSteps: [1, 2, 3, 4, 5],
    loopDetected: { repetitions: 8 },
    compactionsCount: 4,
  });
  assert.ok(degradedHealth.score < 60);
  assert.equal(degradedHealth.grade, 'Degraded');
});

runTest('parseTranscript embeds health scorecard and error taxonomy clusters', () => {
  const log = [
    JSON.stringify({
      step_index: 0,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'missing.txt' } }],
    }),
    JSON.stringify({
      step_index: 1,
      source: 'SYSTEM',
      type: 'TOOL_RESPONSE',
      status: 'ERROR',
      content: 'GetFileAttributesEx c:\\test\\missing.txt: The system cannot find the path specified.',
    }),
    JSON.stringify({
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
    }),
    JSON.stringify({
      step_index: 3,
      source: 'SYSTEM',
      type: 'TOOL_RESPONSE',
      status: 'ERROR',
      content: 'Process terminated with exit status 1',
    }),
  ].join('\n');

  const report = parseTranscript(log, { conversationId: 'conv-health-taxonomy' });

  // Health Scorecard assertions
  assert.ok(report.healthScorecard);
  assert.ok(typeof report.healthScorecard.score === 'number');
  assert.ok(report.healthScorecard.grade);
  assert.ok(report.healthScorecard.pillars);
  assert.ok(report.healthScorecard.pillars.toolReliability >= 0);
  assert.ok(report.healthScorecard.pillars.loopRadar >= 0);
  assert.ok(report.healthScorecard.pillars.phaseBalance >= 0);
  assert.ok(report.healthScorecard.pillars.contextEconomy >= 0);

  // Error Taxonomy assertions
  assert.ok(report.errorTaxonomy);
  assert.equal(report.errorCount, 2);
  assert.equal(report.errorTaxonomy.path_not_found.count, 1);
  assert.equal(report.errorTaxonomy.command_failed.count, 1);
  assert.equal(report.failedSteps[0].errorTaxonomy.id, 'command_failed');
  assert.equal(report.failedSteps[1].errorTaxonomy.id, 'path_not_found');
});

// -----------------------------------------------------------------------------
// 4. Cognitive Classifier & Semantic Loop Unit Tests
// -----------------------------------------------------------------------------
console.log('\n[Cognitive Classifier & Semantic Loop Tests]');

runTest('cosineSimilarity computes normalized vector dot-products accurately', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1.0);
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity(null, undefined), 0);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0); // length mismatch

  const vA = [0.5, 0.5, 0.5, 0.5];
  const vB = [0.5, 0.5, 0.5, 0.5];
  assert.equal(cosineSimilarity(vA, vB).toFixed(4), '1.0000');
});

runTest('computeNgramSimilarity matches strings and slices proportionally', () => {
  assert.equal(computeNgramSimilarity('identical text', 'identical text'), 1.0);
  assert.equal(computeNgramSimilarity('', 'test'), 0);
  assert.equal(computeNgramSimilarity('apple banana', 'xyz 1234'), 0);

  const slice1 = 'view_file c:/project/telemetry.mjs:1-50 Reading telemetry';
  const slice2 = 'view_file c:/project/telemetry.mjs:51-100 Reading telemetry';
  const sim = computeNgramSimilarity(slice1, slice2, 3);
  assert.ok(sim > 0.80, `Expected similarity > 0.80 for slices, got ${sim}`);
});

runTest('classifyStepPhase categorizes each cognitive phase accurately', () => {
  // Exploration
  const exploreStep = {
    tools: [{ name: 'view_file', primaryArg: 'src/main.js' }],
  };
  assert.equal(classifyStepPhase(exploreStep).phase, COGNITIVE_PHASES.EXPLORATION);

  const readFileStep = {
    tools: [{ name: 'read_file', primaryArg: 'src/main.js' }],
  };
  assert.equal(classifyStepPhase(readFileStep).phase, COGNITIVE_PHASES.EXPLORATION);

  // Execution
  const editStep = {
    tools: [{ name: 'replace_file_content', primaryArg: 'src/main.js' }],
  };
  assert.equal(classifyStepPhase(editStep).phase, COGNITIVE_PHASES.EXECUTION);

  const editFileStep = {
    tools: [{ name: 'edit_file', primaryArg: 'Edit src/main.js' }],
  };
  assert.equal(classifyStepPhase(editFileStep).phase, COGNITIVE_PHASES.EXECUTION);

  const writeFileStep = {
    tools: [{ name: 'write_file', primaryArg: 'Create src/main.js' }],
  };
  assert.equal(classifyStepPhase(writeFileStep).phase, COGNITIVE_PHASES.EXECUTION);

  // Verification
  const verifyStep = {
    tools: [{ name: 'run_command', primaryArg: '$ npm test' }],
  };
  assert.equal(classifyStepPhase(verifyStep).phase, COGNITIVE_PHASES.VERIFICATION);

  // Recovery
  const errStep = {
    status: 'ERROR',
    content: 'Process terminated with exit status 1',
  };
  assert.equal(classifyStepPhase(errStep).phase, COGNITIVE_PHASES.RECOVERY);

  // Synthesis
  const synthStep = {
    source: 'MODEL',
    thinking: 'Planning out the architectural refactoring steps.',
    tools: [],
  };
  assert.equal(classifyStepPhase(synthStep).phase, COGNITIVE_PHASES.SYNTHESIS);
});

runTest('detectSemanticLoop catches repetitive slice loops and command variations', () => {
  // Repeated slice reads
  const sliceSteps = [
    { tools: [{ name: 'view_file', primaryArg: 'foo.js:1-50' }] },
    { tools: [{ name: 'view_file', primaryArg: 'foo.js:51-100' }] },
    { tools: [{ name: 'view_file', primaryArg: 'foo.js:101-150' }] },
  ];
  const sliceLoop = detectSemanticLoop(sliceSteps, 0.75, 3);
  assert.ok(sliceLoop);
  assert.equal(sliceLoop.detected, true);
  assert.equal(sliceLoop.tool, 'view_file');
  assert.equal(sliceLoop.phase, 'EXPLORATION');
  assert.ok(sliceLoop.similarity >= 0.75);

  // Varied command loops
  const cmdSteps = [
    { tools: [{ name: 'run_command', primaryArg: '$ npm test' }] },
    { tools: [{ name: 'run_command', primaryArg: '$ npm test -- --verbose' }] },
    { tools: [{ name: 'run_command', primaryArg: '$ npm test -- --bail' }] },
  ];
  const cmdLoop = detectSemanticLoop(cmdSteps, 0.75, 3);
  assert.ok(cmdLoop);
  assert.equal(cmdLoop.tool, 'run_command');
  assert.equal(cmdLoop.phase, 'VERIFICATION');

  // Alternating cycle should NOT trigger
  const healthyCycle = [
    { tools: [{ name: 'view_file', primaryArg: 'foo.js' }] },
    { tools: [{ name: 'replace_file_content', primaryArg: 'foo.js' }] },
    { tools: [{ name: 'view_file', primaryArg: 'foo.js' }] },
    { tools: [{ name: 'replace_file_content', primaryArg: 'foo.js' }] },
    { tools: [{ name: 'view_file', primaryArg: 'foo.js' }] },
  ];
  assert.equal(detectSemanticLoop(healthyCycle, 0.75, 3), null);
});

runTest('analyzeSessionCognition annotates steps and computes distribution percentages', () => {
  const steps = [
    { tools: [{ name: 'view_file', primaryArg: 'foo.js' }] },
    { tools: [{ name: 'replace_file_content', primaryArg: 'foo.js' }] },
    { tools: [{ name: 'run_command', primaryArg: '$ npm test' }] },
    { status: 'ERROR', content: 'exit status 1' },
    { type: 'USER_INPUT', content: 'Please fix the failing tests.' },
  ];

  const analysis = analyzeSessionCognition(steps);
  assert.equal(analysis.currentPhase, 'SYNTHESIS');
  assert.equal(analysis.phaseCounts.EXPLORATION, 1);
  assert.equal(analysis.phaseCounts.EXECUTION, 1);
  assert.equal(analysis.phaseCounts.VERIFICATION, 1);
  assert.equal(analysis.phaseCounts.RECOVERY, 1);
  assert.equal(analysis.phaseCounts.SYNTHESIS, 1);

  assert.equal(analysis.phaseDistribution.exploration, 20.0);
  assert.equal(analysis.phaseDistribution.execution, 20.0);
  assert.equal(analysis.phaseDistribution.verification, 20.0);
  assert.equal(analysis.phaseDistribution.recovery, 20.0);
  assert.equal(analysis.phaseDistribution.synthesis, 20.0);

  // Each step was annotated with badge and color
  assert.equal(steps[0].phase, 'EXPLORATION');
  assert.ok(steps[0].phaseColor);
  assert.ok(steps[0].phaseBadge);
});

// -----------------------------------------------------------------------------
// 5. Frontend Helper Unit Tests
// -----------------------------------------------------------------------------
console.log('\n[Frontend Helper Unit Tests]');

runTest('getToolCategory classifies tools into proper categories', () => {
  assert.equal(getToolCategory('replace_file_content').id, 'file');
  assert.equal(getToolCategory('write_to_file').id, 'file');
  assert.equal(getToolCategory('edit_file').id, 'file');
  assert.equal(getToolCategory('write_file').id, 'file');
  assert.equal(getToolCategory('run_command').id, 'shell');
  assert.equal(getToolCategory('view_file').id, 'read');
  assert.equal(getToolCategory('read_file').id, 'read');
  assert.equal(getToolCategory('search_web').id, 'read');
  assert.equal(getToolCategory('invoke_subagent').id, 'agent');
  assert.equal(getToolCategory('send_message').id, 'agent');
  assert.equal(getToolCategory('call_mcp_tool').id, 'mcp');
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

runTest('escapeHtml escapes dangerous HTML entities including single quotes', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('foo & bar'), 'foo &amp; bar');
  assert.equal(escapeHtml("it's a test"), 'it&#39;s a test');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
if (failed) {
  console.error('\nFAILURE: Test suite finished with failures.');
  process.exit(1);
} else {
  console.log('\nSUCCESS: All checks and unit tests passed successfully!');
}
