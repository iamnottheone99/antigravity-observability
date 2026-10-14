/**
 * Pure telemetry calculation engine for Antigravity Observability Companion.
 * Free of external framework dependencies so it can be tested and reused across runtimes.
 */

import {
  COGNITIVE_PHASES,
  PHASE_METADATA,
  analyzeSessionCognition,
  classifyStepPhase,
  detectSemanticLoop,
} from './classifier.mjs';

export {
  COGNITIVE_PHASES,
  PHASE_METADATA,
  analyzeSessionCognition,
  classifyStepPhase,
  detectSemanticLoop,
};

/**
 * Calculates prompt cache hit percentage string bounded between 0% and 100%.
 *
 * @param {number} cacheTokens
 * @param {number} totalPromptTokens
 * @returns {string} e.g. "45.2%"
 */
export function calculateCacheHitRate(cacheTokens, totalPromptTokens) {
  if (!totalPromptTokens || totalPromptTokens <= 0 || !cacheTokens || cacheTokens <= 0) {
    return '0%';
  }
  const pct = (cacheTokens / totalPromptTokens) * 100;
  return `${Math.min(100, Math.max(0, pct)).toFixed(1)}%`;
}

/**
 * Calculates estimated cost formatted as dollar string based on Gemini model pricing.
 * - Fresh prompt: $0.15 / 1M tokens
 * - Cached prompt: $0.0375 / 1M tokens
 * - Output completion: $0.60 / 1M tokens
 *
 * @param {number} inputTokens Fresh prompt tokens
 * @param {number} cacheTokens Cached prompt tokens
 * @param {number} outputTokens Completion tokens
 * @returns {string} e.g. "$0.0042"
 */
export function calculateCost(inputTokens = 0, cacheTokens = 0, outputTokens = 0) {
  const inCost = (Number(inputTokens) || 0) * 0.00000015;
  const cacheCost = (Number(cacheTokens) || 0) * 0.0000000375;
  const outCost = (Number(outputTokens) || 0) * 0.0000006;
  const total = inCost + cacheCost + outCost;
  return `$${total.toFixed(4)}`;
}

/**
 * Calculates estimated dollar savings achieved through Gemini prompt caching.
 * Uncached baseline ($0.15/1M) vs Cached ($0.0375/1M) saves $0.1125/1M tokens.
 *
 * @param {number} cacheTokens
 * @returns {string} e.g. "$0.0125"
 */
export function calculateCacheSavings(cacheTokens = 0) {
  const tokens = Number(cacheTokens) || 0;
  if (tokens <= 0) return '$0.0000';
  const savings = tokens * 0.0000001125;
  return `$${savings.toFixed(4)}`;
}

/**
 * Detects repetitive tool loops by tracking strictly consecutive identical tool executions.
 *
 * @param {Array<{name: string, signature: string}>} recentToolCalls
 * @param {number} threshold Consecutive repetition count to trigger warning (default: 3)
 * @returns {{ tool: string, repetitions: number, signature: string } | null}
 */
export function detectRepetitionLoop(recentToolCalls = [], threshold = 3) {
  if (!Array.isArray(recentToolCalls) || recentToolCalls.length < threshold) {
    return null;
  }

  const validCalls = recentToolCalls.filter(c => c && c.signature && !c.signature.endsWith(':'));
  if (validCalls.length < threshold) {
    return null;
  }

  // 1. Check current trailing streak (active loop at the head of execution)
  const lastCall = validCalls[validCalls.length - 1];
  let trailingStreak = 0;
  for (let i = validCalls.length - 1; i >= 0; i--) {
    if (validCalls[i].signature === lastCall.signature) {
      trailingStreak++;
    } else {
      break;
    }
  }

  if (trailingStreak >= threshold) {
    return {
      tool: lastCall.name,
      repetitions: trailingStreak,
      signature: lastCall.signature,
    };
  }

  // 2. Check if a consecutive streak of >= threshold occurred recently (last 16 calls)
  const windowSlice = validCalls.slice(-16);
  let streak = 1;
  for (let i = windowSlice.length - 1; i > 0; i--) {
    if (windowSlice[i].signature === windowSlice[i - 1].signature) {
      streak++;
      if (streak >= threshold) {
        return {
          tool: windowSlice[i].name,
          repetitions: streak,
          signature: windowSlice[i].signature,
        };
      }
    } else {
      streak = 1;
    }
  }

  return null;
}

/**
 * Cleans string argument values by stripping outer quotes and parsing JSON if applicable.
 */
function cleanArgValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Extracts a concise human-readable primary argument string from a tool call.
 */
function extractPrimaryArg(name, args = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(args)) {
    clean[k] = cleanArgValue(v);
  }

  switch (name) {
    case 'run_command':
      return clean.CommandLine ? `$ ${clean.CommandLine}` : '';
    case 'view_file': {
      const path = clean.AbsolutePath || clean.TargetFile || '';
      const range = clean.StartLine ? `:${clean.StartLine}${clean.EndLine ? `-${clean.EndLine}` : ''}` : '';
      return path ? `${path}${range}` : '';
    }
    case 'write_to_file':
      return clean.TargetFile ? `Create ${clean.TargetFile}` : '';
    case 'replace_file_content': {
      const path = clean.TargetFile || '';
      const range = clean.StartLine ? ` (L${clean.StartLine}-L${clean.EndLine})` : '';
      return path ? `Edit ${path}${range}` : '';
    }
    case 'call_mcp_tool':
      return clean.ServerName && clean.ToolName ? `${clean.ServerName}:${clean.ToolName}` : (clean.ToolName || '');
    case 'search_web':
      return clean.query ? `"${clean.query}"` : '';
    case 'read_url_content':
      return clean.Url || '';
    case 'manage_task':
      return clean.Action ? `${clean.Action} (${clean.TaskId || ''})` : '';
    case 'send_message':
      return clean.Recipient ? `To: ${clean.Recipient}` : '';
    default:
      return clean.TargetFile || clean.AbsolutePath || clean.query || clean.CommandLine || clean.Url || '';
  }
}

/**
 * Parses raw JSONL transcript data into structured telemetry metrics.
 *
 * @param {string} rawTranscript Raw contents of transcript.jsonl
 * @param {object} [meta] Session metadata (conversationId, activeTitle, isAuto, sessions)
 * @returns {object} Complete telemetry report
 */
export function parseTranscript(rawTranscript = '', meta = {}) {
  const {
    conversationId = '',
    activeTitle = '',
    isAuto = false,
    sessions = [],
  } = meta;

  const lines = (rawTranscript || '').trim().split(/\r?\n/).filter(Boolean);

  let totalInputTokens = 0;
  let totalCacheTokens = 0;
  let totalOutputTokens = 0;
  let latestContextTokens = 0;
  let peakContextTokens = 0;
  let compactionsCount = 0;
  let activeModel = 'Gemini';
  let subagentCalls = 0;
  let mcpCalls = 0;
  let artifactsCount = 0;
  const mcpServers = {};
  const activeSkills = new Set();
  const toolCounts = {};
  const filesTouched = new Set();
  const parsedSteps = [];
  const failedSteps = [];
  const recentToolCalls = [];

  const rawSteps = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      rawSteps.push(JSON.parse(lines[i]));
    } catch {
      // Ignore trailing malformed or partial JSON lines
    }
  }

  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];

    if (typeof step.content === 'string') {
      const modelMatch = step.content.match(/Model Selection\` from ((?:(?! to ).)+) to (.+?)\.\s*(?:No need|$|\n|<)/);
      if (modelMatch && modelMatch[2]) {
        activeModel = modelMatch[2].trim();
      }
      if (step.content.includes('<CONTEXT_SUMMARY>')) {
        compactionsCount++;
      }
    }

    if (typeof step.input_tokens === 'number') totalInputTokens += step.input_tokens;
    if (typeof step.cache_read_tokens === 'number') totalCacheTokens += step.cache_read_tokens;
    if (typeof step.output_tokens === 'number') totalOutputTokens += step.output_tokens;

    if (typeof step.input_tokens === 'number' || typeof step.cache_read_tokens === 'number') {
      const stepContext = (step.input_tokens || 0) + (step.cache_read_tokens || 0);
      if (stepContext > 0) {
        latestContextTokens = stepContext;
        if (stepContext > peakContextTokens) {
          peakContextTokens = stepContext;
        }
      }
    }

    // Check next step for paired tool output if this step called tools
    const nextStep = rawSteps[i + 1];
    let outputSnippet = '';
    let pairedError = false;

    if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0 && nextStep) {
      if (typeof nextStep.content === 'string' && nextStep.content.trim()) {
        outputSnippet = nextStep.content.trim().slice(0, 2500);
        if (
          nextStep.status === 'ERROR' ||
          nextStep.content.includes('"exit status 1"') ||
          nextStep.content.includes('Encountered error in') ||
          nextStep.content.includes('Error:')
        ) {
          pairedError = true;
        }
      } else if (nextStep.status === 'ERROR') {
        pairedError = true;
      }
    } else if (typeof step.content === 'string' && step.content.trim()) {
      outputSnippet = step.content.trim().slice(0, 2500);
    }

    const isError = step.status === 'ERROR' ||
      (typeof step.content === 'string' && (
        step.content.includes('"exit status 1"') ||
        step.content.includes('Encountered error in tool execution')
      ));

    // Thinking / reasoning preview
    const thinkingSnippet = typeof step.thinking === 'string' && step.thinking.trim()
      ? step.thinking.trim().slice(0, 1500)
      : '';

    // Extract user request snippet if this is a user input step
    let userPrompt = '';
    if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
      const text = step.content || '';
      const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      userPrompt = reqMatch ? reqMatch[1].trim() : text.trim().slice(0, 500);
    }

    const toolsInStep = [];
    if (Array.isArray(step.tool_calls)) {
      for (const tc of step.tool_calls) {
        const name = tc.name || 'unknown_tool';
        toolCounts[name] = (toolCounts[name] || 0) + 1;

        let mcpServer = null;
        if (name === 'call_mcp_tool') {
          mcpServer = tc.args?.ServerName ? cleanArgValue(tc.args.ServerName) : 'mcp';
          mcpCalls++;
          mcpServers[mcpServer] = (mcpServers[mcpServer] || 0) + 1;
          activeSkills.add(mcpServer.toLowerCase());
        } else if (name.startsWith('mcp_')) {
          const parts = name.split('_');
          mcpServer = parts[1] || 'mcp';
          mcpCalls++;
          mcpServers[mcpServer] = (mcpServers[mcpServer] || 0) + 1;
          activeSkills.add(mcpServer.toLowerCase());
        } else if (name === 'list_resources' || name === 'read_resource') {
          mcpServer = tc.args?.ServerName ? cleanArgValue(tc.args.ServerName) : 'mcp';
          mcpCalls++;
          mcpServers[mcpServer] = (mcpServers[mcpServer] || 0) + 1;
          activeSkills.add(mcpServer.toLowerCase());
        }

        if (['invoke_subagent', 'send_message', 'manage_subagents', 'define_subagent'].includes(name)) {
          subagentCalls++;
        }

        if (name === 'view_file') {
          const path = tc.args?.AbsolutePath || tc.args?.TargetFile || '';
          const m = String(path).match(/[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md/i);
          if (m && m[1]) {
            activeSkills.add(m[1].toLowerCase());
          }
        } else if (name === 'run_command') {
          const cmd = String(tc.args?.CommandLine || '').trim();
          const firstWord = cmd.split(/\s+/)[0]?.replace(/^.*[/\\]/, '').toLowerCase();
          const knownSkillCommands = {
            'graphify': 'graphify',
            'archify': 'archify',
            'zg': 'zvec-grep',
            'zvec-grep': 'zvec-grep',
            'gh-axi': 'gh-axi',
            'docker-axi': 'docker-axi',
            'npm-axi': 'npm-axi',
            'chrome-devtools-axi': 'chrome-devtools-axi',
            'lavish': 'lavish',
            'lavish-axi': 'lavish-axi',
          };
          if (knownSkillCommands[firstWord]) {
            activeSkills.add(knownSkillCommands[firstWord]);
          }
        }

        if (name === 'write_to_file') {
          const tf = tc.args?.TargetFile;
          if (tf && (typeof tf === 'string') && (tf.includes('.md') || tf.includes('brain') || tc.args?.ArtifactMetadata)) {
            artifactsCount++;
          }
        }

        const target = tc.args?.TargetFile || tc.args?.AbsolutePath;
        if (target && typeof target === 'string') {
          filesTouched.add(target.replace(/^"|"$/g, ''));
        }

        const toolSummary = tc.args?.toolSummary ? cleanArgValue(tc.args.toolSummary) : '';
        const toolAction = tc.args?.toolAction ? cleanArgValue(tc.args.toolAction) : '';
        const primaryArg = extractPrimaryArg(name, tc.args || {});

        // Clean args for display (trim huge CodeContent to 400 chars)
        const sanitizedArgs = {};
        if (tc.args && typeof tc.args === 'object') {
          for (const [k, v] of Object.entries(tc.args)) {
            const cleaned = cleanArgValue(v);
            if (typeof cleaned === 'string' && cleaned.length > 500) {
              sanitizedArgs[k] = cleaned.slice(0, 500) + '... (truncated)';
            } else {
              sanitizedArgs[k] = cleaned;
            }
          }
        }

        const signature = `${name}:${tc.args?.CommandLine || tc.args?.AbsolutePath || tc.args?.TargetFile || ''}`;

        recentToolCalls.push({
          name,
          signature,
          stepIndex: step.step_index ?? i,
        });

        toolsInStep.push({
          name,
          summary: toolSummary,
          action: toolAction,
          primaryArg,
          category: getToolCategory(name, mcpServer).id,
          mcpServer,
          args: sanitizedArgs,
          output: outputSnippet,
        });
      }
    }

    const stepInput = step.input_tokens || 0;
    const stepCache = step.cache_read_tokens || 0;
    const stepOutput = step.output_tokens || 0;
    const totalStepTokens = stepInput + stepCache + stepOutput;
    const stepCost = calculateCost(stepInput, stepCache, stepOutput);

    // Primary category
    let category = 'system';
    if (toolsInStep.length > 0) {
      category = toolsInStep[0].category;
    } else if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
      category = 'user';
    } else if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
      category = 'assistant';
    }

    const stepRecord = {
      stepIndex: step.step_index ?? i,
      source: step.source || 'UNKNOWN',
      type: step.type || 'UNKNOWN',
      status: isError ? 'ERROR' : (step.status || 'DONE'),
      createdAt: step.created_at || null,
      inputTokens: stepInput,
      cacheReadTokens: stepCache,
      outputTokens: stepOutput,
      totalStepTokens,
      stepCost,
      tools: toolsInStep,
      thinking: thinkingSnippet,
      content: typeof step.content === 'string' ? step.content.trim().slice(0, 1500) : '',
      userPrompt,
      outputSnippet,
      category,
    };

    parsedSteps.push(stepRecord);

    if (isError) {
      failedSteps.push(stepRecord);
    }
  }

  // Calculate duration between consecutive steps
  for (let i = 0; i < parsedSteps.length; i++) {
    if (i > 0 && parsedSteps[i].createdAt && parsedSteps[i - 1].createdAt) {
      const prev = new Date(parsedSteps[i - 1].createdAt).getTime();
      const curr = new Date(parsedSteps[i].createdAt).getTime();
      const diffMs = curr - prev;
      parsedSteps[i].durationSeconds = diffMs >= 0 ? +(diffMs / 1000).toFixed(1) : 0;
    } else {
      parsedSteps[i].durationSeconds = 0;
    }
  }

  const totalPromptTokens = totalInputTokens + totalCacheTokens;
  const cacheHitRate = calculateCacheHitRate(totalCacheTokens, totalPromptTokens);
  const cacheSavings = calculateCacheSavings(totalCacheTokens);
  const estimatedCost = calculateCost(totalInputTokens, totalCacheTokens, totalOutputTokens);
  const loopDetected = detectRepetitionLoop(recentToolCalls, 3);
  const cognition = analyzeSessionCognition(parsedSteps);

  const timedSteps = parsedSteps.filter(s => s.durationSeconds > 0);
  const avgStepDuration = timedSteps.length > 0
    ? `${(timedSteps.reduce((sum, s) => sum + s.durationSeconds, 0) / timedSteps.length).toFixed(1)}s`
    : '0.0s';

  const totalToolCalls = Object.values(toolCounts).reduce((sum, count) => sum + count, 0);
  const totalToolErrors = failedSteps.length;
  const toolSuccessRate = totalToolCalls > 0
    ? `${Math.max(0, Math.min(100, ((totalToolCalls - totalToolErrors) / totalToolCalls) * 100)).toFixed(1)}%`
    : '100%';

  const contextLimit = 1000000;
  const contextLoadPercent = `${Math.min(100, Math.max(0, (latestContextTokens / contextLimit) * 100)).toFixed(1)}%`;

  return {
    status: 'active',
    conversationId,
    activeTitle,
    isAuto,
    sessions,
    totalSteps: parsedSteps.length,
    inputTokens: totalInputTokens,
    cacheReadTokens: totalCacheTokens,
    totalPromptTokens,
    outputTokens: totalOutputTokens,
    totalTokens: totalPromptTokens + totalOutputTokens,
    estimatedCost,
    cacheHitRate,
    cacheSavings,
    latestContextTokens,
    peakContextTokens,
    contextLimit,
    contextLoadPercent,
    compactionsCount,
    activeModel,
    avgStepDuration,
    toolSuccessRate,
    subagentCalls,
    mcpCalls,
    mcpServers,
    activeSkills: Array.from(activeSkills),
    artifactsCount,
    errorCount: failedSteps.length,
    loopDetected: loopDetected || cognition.semanticLoop,
    semanticLoop: cognition.semanticLoop,
    currentPhase: cognition.currentPhase,
    currentPhaseLabel: cognition.currentPhaseLabel,
    currentPhaseColor: cognition.currentPhaseColor,
    phaseCounts: cognition.phaseCounts,
    phaseDistribution: cognition.phaseDistribution,
    cognitiveEngine: cognition.engineStatus,
    toolCounts,
    filesTouched: Array.from(filesTouched),
    failedSteps: failedSteps.slice(-50).reverse(),
    recentSteps: parsedSteps.slice(-100).reverse(),
  };
}

/**
 * Classifies tool calls into semantic UI categories.
 *
 * @param {string} toolName
 * @param {string} [serverName]
 * @returns {{ id: string, label: string, color: string, cls: string, server?: string }}
 */
export function getToolCategory(toolName, serverName = null) {
  if (['replace_file_content', 'write_to_file'].includes(toolName)) {
    return { id: 'file', label: 'File Edits', color: '#3b82f6', cls: 'segment-file' };
  }
  if (['run_command'].includes(toolName)) {
    return { id: 'shell', label: 'Shell / Terminal', color: '#8b5cf6', cls: 'segment-shell' };
  }
  if (['view_file', 'read_url_content', 'search_web'].includes(toolName)) {
    return { id: 'read', label: 'Read / Search', color: '#10b981', cls: 'segment-read' };
  }
  if (['invoke_subagent', 'send_message', 'manage_subagents', 'define_subagent'].includes(toolName)) {
    return { id: 'agent', label: 'Subagents', color: '#f59e0b', cls: 'segment-agent' };
  }
  if (['call_mcp_tool', 'list_resources', 'read_resource'].includes(toolName) || (typeof toolName === 'string' && toolName.startsWith('mcp_'))) {
    if (serverName) {
      const s = String(serverName).toLowerCase();
      let color = '#ec4899';
      if (s === 'engram') color = '#ec4899';
      else if (s.includes('zvec')) color = '#06b6d4';
      else if (s.includes('chrome') || s.includes('devtools')) color = '#f97316';
      else if (s.includes('git') || s.includes('gh')) color = '#a855f7';
      else if (s.includes('docker')) color = '#38bdf8';
      else {
        const palette = ['#f43f5e', '#8b5cf6', '#14b8a6', '#0ea5e9', '#eab308'];
        let hash = 0;
        for (let i = 0; i < s.length; i++) hash = (hash << 5) - hash + s.charCodeAt(i);
        color = palette[Math.abs(hash) % palette.length];
      }
      const cleanLabel = serverName.charAt(0).toUpperCase() + serverName.slice(1);
      return { id: `mcp-${s}`, label: `${cleanLabel} (MCP)`, color, cls: 'segment-mcp', server: s };
    }
    return { id: 'mcp', label: 'MCP Tools', color: '#ec4899', cls: 'segment-mcp' };
  }
  return { id: 'other', label: 'Other Tools', color: '#64748b', cls: 'segment-other' };
}

/**
 * Formats token count with k/M suffixes.
 *
 * @param {number} num
 * @returns {string} e.g. "1.2M", "45.0k", "850"
 */
export function formatTokens(num) {
  if (!num || isNaN(num)) return '0';
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
  return String(num);
}

/**
 * Escapes unsafe HTML characters.
 *
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

