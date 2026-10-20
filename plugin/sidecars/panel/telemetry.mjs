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
 * Standardized taxonomy categories for classifying agent tool and execution errors.
 */
export const ERROR_CATEGORIES = {
  PATH_NOT_FOUND: {
    id: 'path_not_found',
    label: 'File / Path Not Found',
    color: '#f43f5e',
    description: 'Target file or directory does not exist on disk',
  },
  EDIT_CONFLICT: {
    id: 'edit_conflict',
    label: 'Edit Target Mismatch',
    color: '#f59e0b',
    description: 'Target text chunk could not be matched for replacement',
  },
  COMMAND_FAILED: {
    id: 'command_failed',
    label: 'Command Execution Failure',
    color: '#ef4444',
    description: 'Subprocess or terminal script exited with a non-zero exit code',
  },
  MCP_ERROR: {
    id: 'mcp_error',
    label: 'MCP Protocol Error',
    color: '#a855f7',
    description: 'External MCP server returned an exception or unknown project context',
  },
  VALIDATION: {
    id: 'validation',
    label: 'Tool Schema Error',
    color: '#3b82f6',
    description: 'Tool invocation failed due to missing or invalid argument schema',
  },
  PERMISSION: {
    id: 'permission',
    label: 'Permission Denied',
    color: '#e11d48',
    description: 'Operation rejected by workspace boundaries or OS access controls',
  },
  TIMEOUT: {
    id: 'timeout',
    label: 'Timeout / Aborted',
    color: '#64748b',
    description: 'Process exceeded execution deadline or was cancelled by user',
  },
  RUNTIME: {
    id: 'runtime',
    label: 'General Runtime',
    color: '#8b5cf6',
    description: 'Uncategorized runtime exception or internal tool execution failure',
  },
};

/**
 * Classifies an error message into a standardized root-cause taxonomy category.
 *
 * @param {string} rawMessage
 * @param {string} [toolName]
 * @returns {{ id: string, label: string, color: string, summary: string, raw: string }}
 */
export function classifyError(rawMessage = '', toolName = '') {
  const str = String(rawMessage || '').trim();
  const tool = String(toolName || '').toLowerCase();

  // 1. Path not found
  if (
    /GetFileAttributesEx|cannot find the path|ENOENT|no such file|not found|does not exist|path specified/i.test(str) &&
    !/target content not found/i.test(str) &&
    !/unknown_project/i.test(str)
  ) {
    let summary = 'File or directory path not found';
    const pathMatch = str.match(/GetFileAttributesEx\s+(.+?)(?::\s*The system|:\s*[A-Z]|$)/i) ||
                      str.match(/(?:open|read|stat)\s*['"`]([^'"`]+)['"`]/i) ||
                      str.match(/`?file:\/\/\/([^`\n\r]+)`?/i) ||
                      str.match(/(?:failed to read file|path specified)[^:]*:\s*([^\n\r]+)/i);
    if (pathMatch && pathMatch[1]) {
      const cleanPath = pathMatch[1].trim().replace(/^["']|["']$/g, '');
      const base = cleanPath.split(/[/\\]/).pop();
      summary = base ? `File not found: ${base}` : `File not found: ${cleanPath}`;
    }
    return {
      id: ERROR_CATEGORIES.PATH_NOT_FOUND.id,
      label: ERROR_CATEGORIES.PATH_NOT_FOUND.label,
      color: ERROR_CATEGORIES.PATH_NOT_FOUND.color,
      summary,
      raw: str.slice(0, 300),
    };
  }

  // 2. Edit conflict / replacement mismatch
  if (/target content not found|Could not successfully apply any edits|TargetContent|chunk \d+/i.test(str)) {
    return {
      id: ERROR_CATEGORIES.EDIT_CONFLICT.id,
      label: ERROR_CATEGORIES.EDIT_CONFLICT.label,
      color: ERROR_CATEGORIES.EDIT_CONFLICT.color,
      summary: 'Edit chunk mismatch: target content not found in file',
      raw: str.slice(0, 300),
    };
  }

  // 3. MCP Protocol error
  if (/unknown_project|error_code|Encountered error in tool execution|cortex tool.*call_mcp|MCP error/i.test(str) || tool.includes('mcp')) {
    let summary = 'MCP server returned protocol error';
    const msgMatch = str.match(/"message"\s*:\s*"([^"]+)"/);
    if (msgMatch && msgMatch[1]) {
      summary = msgMatch[1];
    } else if (str.includes('unknown_project')) {
      summary = 'Engram project context unrecognized';
    }
    return {
      id: ERROR_CATEGORIES.MCP_ERROR.id,
      label: ERROR_CATEGORIES.MCP_ERROR.label,
      color: ERROR_CATEGORIES.MCP_ERROR.color,
      summary,
      raw: str.slice(0, 300),
    };
  }

  // 4. Permission / Sandbox denial
  if (/declaring permissions|permission denied|EACCES|access is denied|forbidden/i.test(str)) {
    return {
      id: ERROR_CATEGORIES.PERMISSION.id,
      label: ERROR_CATEGORIES.PERMISSION.label,
      color: ERROR_CATEGORIES.PERMISSION.color,
      summary: 'Operation denied by workspace permission policy',
      raw: str.slice(0, 300),
    };
  }

  // 5. Validation / invalid tool call args
  if (/invalid tool call|invalid_args|missing required|validation error|parameter error/i.test(str)) {
    return {
      id: ERROR_CATEGORIES.VALIDATION.id,
      label: ERROR_CATEGORIES.VALIDATION.label,
      color: ERROR_CATEGORIES.VALIDATION.color,
      summary: 'Invalid tool arguments or malformed schema parameters',
      raw: str.slice(0, 300),
    };
  }

  // 6. Timeout / Interrupted
  if (/timed out|timeout|cancelled|aborted|ETIMEDOUT/i.test(str)) {
    return {
      id: ERROR_CATEGORIES.TIMEOUT.id,
      label: ERROR_CATEGORIES.TIMEOUT.label,
      color: ERROR_CATEGORIES.TIMEOUT.color,
      summary: 'Subprocess timed out or execution was aborted',
      raw: str.slice(0, 300),
    };
  }

  // 7. Command failed (exit status / code)
  if (/exit status \d+|exit code \d+|Process terminated with exit status|command failed/i.test(str) || tool === 'run_command') {
    let exitCode = '1';
    const codeMatch = str.match(/exit status (\d+)/i) || str.match(/exit code (\d+)/i);
    if (codeMatch && codeMatch[1]) exitCode = codeMatch[1];
    return {
      id: ERROR_CATEGORIES.COMMAND_FAILED.id,
      label: ERROR_CATEGORIES.COMMAND_FAILED.label,
      color: ERROR_CATEGORIES.COMMAND_FAILED.color,
      summary: `Process terminated with exit status ${exitCode}`,
      raw: str.slice(0, 300),
    };
  }

  // Fallback: General Runtime
  const firstLine = str.split(/\r?\n/)[0] || 'Uncategorized runtime error';
  return {
    id: ERROR_CATEGORIES.RUNTIME.id,
    label: ERROR_CATEGORIES.RUNTIME.label,
    color: ERROR_CATEGORIES.RUNTIME.color,
    summary: firstLine.length > 70 ? firstLine.slice(0, 67) + '...' : firstLine,
    raw: str.slice(0, 300),
  };
}

/**
 * Computes an automated agent efficiency and health scorecard (0 - 100).
 * Evaluates 4 core pillars:
 * 1. Tool Reliability (30%): tool success rate with error recovery credit
 * 2. Loop Radar (25%): absence of consecutive or semantic repetition loops
 * 3. Phase Balance (25%): harmonious progression across discovery, execution, and verification
 * 4. Context Economy (20%): headroom maintenance and avoidance of compaction overflows
 *
 * @param {object} params
 * @returns {{ score: number, grade: string, color: string, summary: string, deductions: string[], pillars: object }}
 */
export function calculateAgentHealth({
  totalSteps = 0,
  toolCounts = {},
  failedSteps = [],
  loopDetected = null,
  semanticLoop = null,
  cognition = {},
  compactionsCount = 0,
  latestContextTokens = 0,
  contextLimit = 1000000,
} = {}) {
  // 1. Tool Reliability Pillar (30%)
  const totalCalls = Object.values(toolCounts || {}).reduce((sum, c) => sum + c, 0);
  const totalErrors = Array.isArray(failedSteps) ? failedSteps.length : 0;
  let reliability = 100;
  if (totalCalls > 0) {
    const rawRate = Math.max(0, ((totalCalls - totalErrors) / totalCalls) * 100);
    const recoveredCount = Math.max(0, Math.min(totalErrors, totalCalls - totalErrors));
    const recoveryBonus = totalErrors > 0 ? (recoveredCount / totalErrors) * 10 : 0;
    reliability = Math.min(100, Math.max(0, rawRate + recoveryBonus));
  }

  // 2. Loop Radar Pillar (25%)
  let loopScore = 100;
  if (loopDetected) {
    const reps = Number(loopDetected.repetitions) || 3;
    loopScore = Math.max(0, 100 - (reps * 12));
  } else if (semanticLoop) {
    const sim = Number(semanticLoop.similarity) || 0.8;
    loopScore = Math.max(20, Math.round(100 - (sim * 60)));
  }

  // 3. Phase Balance Pillar (25%)
  let phaseBalance = 100;
  const dist = cognition?.phaseDistribution || {};
  const execPct = Number(dist.execution) || 0;
  const verifPct = Number(dist.verification) || 0;
  const explorPct = Number(dist.exploration) || 0;
  const deductions = [];

  if (execPct >= 15 && verifPct === 0) {
    phaseBalance -= 30;
    deductions.push('Unverified modifications: 0% verification phase');
  }
  if (explorPct >= 80 && totalSteps > 20 && execPct === 0) {
    phaseBalance -= 25;
    deductions.push('High exploration churn without execution');
  }
  phaseBalance = Math.max(20, phaseBalance);

  // 4. Context Economy Pillar (20%)
  let contextEconomy = 100;
  if (compactionsCount > 0) {
    const compPenalty = Math.min(45, compactionsCount * 15);
    contextEconomy -= compPenalty;
    deductions.push(`${compactionsCount} context compaction${compactionsCount > 1 ? 's' : ''}`);
  }
  const loadPct = contextLimit > 0 ? (latestContextTokens / contextLimit) * 100 : 0;
  if (loadPct >= 85) {
    contextEconomy -= 25;
    deductions.push('Context window near saturation (>85%)');
  } else if (loadPct >= 70) {
    contextEconomy -= 10;
  }
  contextEconomy = Math.max(10, contextEconomy);

  // Overall Weighted Score
  const overall = Math.round(
    (reliability * 0.30) +
    (loopScore * 0.25) +
    (phaseBalance * 0.25) +
    (contextEconomy * 0.20)
  );

  const score = Math.min(100, Math.max(0, overall));

  let grade = 'Optimal';
  let color = '#10b981'; // Emerald
  if (score < 60) {
    grade = 'Degraded';
    color = '#f43f5e'; // Rose
  } else if (score < 75) {
    grade = 'Attention';
    color = '#f59e0b'; // Amber
  } else if (score < 90) {
    grade = 'Healthy';
    color = '#3b82f6'; // Blue
  }

  let summary = 'Agent execution is clean and responsive';
  if (score < 60) {
    summary = 'Degraded: multiple errors, loops, or context exhaustion';
  } else if (deductions.length > 0) {
    summary = deductions[0];
  } else if (score < 90) {
    summary = 'Healthy execution with minor friction';
  }

  return {
    score,
    grade,
    color,
    summary,
    deductions,
    pillars: {
      reliability: Math.round(reliability),
      toolReliability: Math.round(reliability),
      loopRadar: Math.round(loopScore),
      phaseBalance: Math.round(phaseBalance),
      contextEconomy: Math.round(contextEconomy),
    },
  };
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
    case 'view_file':
    case 'read_file': {
      const path = clean.Path || clean.AbsolutePath || clean.TargetFile || '';
      const range = clean.StartLine ? `:${clean.StartLine}${clean.EndLine ? `-${clean.EndLine}` : ''}` : '';
      return path ? `${path}${range}` : '';
    }
    case 'write_to_file':
    case 'write_file': {
      const target = clean.Path || clean.TargetFile || '';
      return target ? `Create ${target}` : '';
    }
    case 'replace_file_content':
    case 'edit_file': {
      const path = clean.Path || clean.TargetFile || '';
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
      return clean.Path || clean.TargetFile || clean.AbsolutePath || clean.query || clean.CommandLine || clean.Url || '';
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
      if ((step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') && step.content.includes('<CONTEXT_SUMMARY>')) {
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

        if (name === 'view_file' || name === 'read_file') {
          const path = tc.args?.Path || tc.args?.AbsolutePath || tc.args?.TargetFile || '';
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

        if (name === 'write_to_file' || name === 'write_file') {
          const tf = tc.args?.Path || tc.args?.TargetFile;
          if (tf && (typeof tf === 'string') && (tf.includes('.md') || tf.includes('brain') || tc.args?.ArtifactMetadata)) {
            artifactsCount++;
          }
        }

        const target = tc.args?.Path || tc.args?.TargetFile || tc.args?.AbsolutePath;
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

        const signature = `${name}:${tc.args?.CommandLine || tc.args?.Path || tc.args?.AbsolutePath || tc.args?.TargetFile || ''}`;

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

    let errorTaxonomy = null;
    if (isError || pairedError) {
      const errStr = outputSnippet || (typeof step.content === 'string' ? step.content : '') || (typeof step.error === 'string' ? step.error : '');
      const toolName = toolsInStep[0] ? toolsInStep[0].name : (rawSteps[i - 1]?.tool_calls?.[0]?.name || '');
      errorTaxonomy = classifyError(errStr, toolName);
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
      errorTaxonomy,
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

  // Aggregate errors into root-cause taxonomy clusters
  const errorTaxonomy = {};
  for (const failed of failedSteps) {
    const cat = failed.errorTaxonomy || classifyError(failed.outputSnippet || failed.content || failed.error, failed.tools?.[0]?.name);
    failed.errorTaxonomy = cat;

    if (!errorTaxonomy[cat.id]) {
      errorTaxonomy[cat.id] = {
        id: cat.id,
        label: cat.label,
        color: cat.color,
        description: cat.description,
        count: 0,
        stepIndices: [],
        sample: cat.summary,
      };
    }
    errorTaxonomy[cat.id].count++;
    errorTaxonomy[cat.id].stepIndices.push(failed.stepIndex);
  }

  // Calculate automated efficiency & health scorecard
  const healthScorecard = calculateAgentHealth({
    totalSteps: parsedSteps.length,
    toolCounts,
    failedSteps,
    loopDetected: loopDetected || cognition.semanticLoop,
    semanticLoop: cognition.semanticLoop,
    cognition,
    compactionsCount,
    latestContextTokens,
    contextLimit,
  });

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
    healthScorecard,
    errorTaxonomy,
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
  if (['replace_file_content', 'write_to_file', 'edit_file', 'write_file'].includes(toolName)) {
    return { id: 'file', label: 'File Edits', color: '#3b82f6', cls: 'segment-file' };
  }
  if (['run_command'].includes(toolName)) {
    return { id: 'shell', label: 'Shell / Terminal', color: '#8b5cf6', cls: 'segment-shell' };
  }
  if (['view_file', 'read_file', 'read_url_content', 'search_web'].includes(toolName)) {
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

