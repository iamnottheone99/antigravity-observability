/**
 * Pure telemetry calculation engine for Antigravity Observability Companion.
 * Free of external framework dependencies so it can be tested and reused across runtimes.
 */

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
  const toolCounts = {};
  const filesTouched = new Set();
  const parsedSteps = [];
  const failedSteps = [];
  const recentToolCalls = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const step = JSON.parse(lines[i]);

      if (typeof step.input_tokens === 'number') totalInputTokens += step.input_tokens;
      if (typeof step.cache_read_tokens === 'number') totalCacheTokens += step.cache_read_tokens;
      if (typeof step.output_tokens === 'number') totalOutputTokens += step.output_tokens;

      const isError = step.status === 'ERROR' ||
        (typeof step.content === 'string' && (
          step.content.includes('"exit status 1"') ||
          step.content.includes('Encountered error in tool execution')
        ));

      const toolsInStep = [];
      if (Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          const name = tc.name || 'unknown_tool';
          toolCounts[name] = (toolCounts[name] || 0) + 1;

          const target = tc.args?.TargetFile || tc.args?.AbsolutePath;
          if (target && typeof target === 'string') {
            filesTouched.add(target.replace(/^"|"$/g, ''));
          }

          const toolSummary = tc.args?.toolSummary ? String(tc.args.toolSummary).replace(/^"|"$/g, '') : '';
          const toolAction = tc.args?.toolAction ? String(tc.args.toolAction).replace(/^"|"$/g, '') : '';
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
          });
        }
      }

      const stepRecord = {
        stepIndex: step.step_index ?? i,
        source: step.source || 'UNKNOWN',
        type: step.type || 'UNKNOWN',
        status: isError ? 'ERROR' : (step.status || 'DONE'),
        createdAt: step.created_at || null,
        inputTokens: step.input_tokens || 0,
        outputTokens: step.output_tokens || 0,
        tools: toolsInStep,
      };

      parsedSteps.push(stepRecord);

      if (isError) {
        failedSteps.push(stepRecord);
      }
    } catch {
      // Ignore trailing malformed or partial JSON lines
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
  const estimatedCost = calculateCost(totalInputTokens, totalCacheTokens, totalOutputTokens);
  const loopDetected = detectRepetitionLoop(recentToolCalls, 3);

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
    errorCount: failedSteps.length,
    loopDetected,
    toolCounts,
    filesTouched: Array.from(filesTouched),
    failedSteps: failedSteps.slice(-10).reverse(),
    recentSteps: parsedSteps.slice(-25).reverse(),
  };
}

/**
 * Classifies tool calls into semantic UI categories.
 *
 * @param {string} toolName
 * @returns {{ id: string, label: string, color: string, cls: string }}
 */
export function getToolCategory(toolName) {
  if (['replace_file_content', 'write_to_file'].includes(toolName)) {
    return { id: 'file', label: 'File Edits', color: '#3b82f6', cls: 'segment-file' };
  }
  if (['run_command'].includes(toolName)) {
    return { id: 'shell', label: 'Shell / Terminal', color: '#8b5cf6', cls: 'segment-shell' };
  }
  if (['view_file', 'read_url_content', 'read_resource', 'search_web'].includes(toolName)) {
    return { id: 'read', label: 'Read / Search', color: '#10b981', cls: 'segment-read' };
  }
  if (['invoke_subagent', 'send_message', 'manage_subagents'].includes(toolName)) {
    return { id: 'agent', label: 'Subagents', color: '#f59e0b', cls: 'segment-agent' };
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

