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
 * Detects repetitive tool loops using a sliding window across the most recent tool calls.
 *
 * @param {Array<{name: string, signature: string}>} recentToolCalls
 * @param {number} threshold Consecutive repetition count to trigger warning (default: 3)
 * @returns {{ tool: string, repetitions: number, signature: string } | null}
 */
export function detectRepetitionLoop(recentToolCalls = [], threshold = 3) {
  if (!Array.isArray(recentToolCalls) || recentToolCalls.length < threshold) {
    return null;
  }
  const tail = recentToolCalls.slice(-8);
  const sigCounts = {};
  for (const item of tail) {
    if (!item.signature || item.signature.endsWith(':')) continue;
    sigCounts[item.signature] = (sigCounts[item.signature] || 0) + 1;
    if (sigCounts[item.signature] >= threshold) {
      return {
        tool: item.name,
        repetitions: sigCounts[item.signature],
        signature: item.signature,
      };
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
