/**
 * Cognitive Phase Classifier & Semantic Loop Detection Engine for Antigravity Observability.
 * Leverages local vector embeddings (local/potion-code-16m-v2) powered by Zvec
 * (https://github.com/alibaba/zvec) and zvec-grep (https://github.com/zvec-ai/zvec-grep) when available,
 * with a high-performance zero-dependency statistical n-gram fallback.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Supported cognitive phases in agent execution lifecycles.
 */
export const COGNITIVE_PHASES = Object.freeze({
  EXPLORATION: 'EXPLORATION',
  SYNTHESIS: 'SYNTHESIS',
  EXECUTION: 'EXECUTION',
  VERIFICATION: 'VERIFICATION',
  RECOVERY: 'RECOVERY',
});

/**
 * Visual styling and metadata for cognitive phases.
 */
export const PHASE_METADATA = Object.freeze({
  EXPLORATION: {
    label: 'Exploration',
    color: '#10b981',
    badge: 'phase-exploration',
    description: 'Code discovery, file inspection, and searching',
  },
  SYNTHESIS: {
    label: 'Synthesis',
    color: '#8b5cf6',
    badge: 'phase-synthesis',
    description: 'Planning, reasoning, and context consolidation',
  },
  EXECUTION: {
    label: 'Execution',
    color: '#3b82f6',
    badge: 'phase-execution',
    description: 'File modification, code generation, and updates',
  },
  VERIFICATION: {
    label: 'Verification',
    color: '#f59e0b',
    badge: 'phase-verification',
    description: 'Running tests, linters, git diffs, and builds',
  },
  RECOVERY: {
    label: 'Recovery',
    color: '#f43f5e',
    badge: 'phase-recovery',
    description: 'Error debugging, failure analysis, and remediation',
  },
});

// Cache for computed text vectors (bounded LRU, max 256 entries)
const vectorCache = new Map();
const MAX_VECTOR_CACHE = 256;

// Neural embedding model singleton state
let neuralModel = null;
let neuralModelInitAttempted = false;
let neuralEngineStatus = {
  engine: 'statistical-fallback',
  model: 'none',
  dimensions: 0,
  active: false,
};

/**
 * Attempts to locate and load the local zvec-grep embedding factory.
 */
function findZvecFactoryUrl() {
  const candidates = [
    join(process.env.APPDATA || '', 'npm/node_modules/@zvec/zvec-grep/dist/engine/models/factory.js'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@zvec', 'zvec-grep', 'dist', 'engine', 'models', 'factory.js'),
    join(homedir(), '.nvm/versions/node', process.version, 'lib/node_modules/@zvec/zvec-grep/dist/engine/models/factory.js'),
    '/usr/local/lib/node_modules/@zvec/zvec-grep/dist/engine/models/factory.js',
    '/usr/lib/node_modules/@zvec/zvec-grep/dist/engine/models/factory.js',
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      try {
        return pathToFileURL(candidate).href;
      } catch {
        // Continue to next candidate
      }
    }
  }

  return null;
}

/**
 * Initializes the neural embedding model from zvec-grep if installed locally.
 */
export async function initNeuralEmbeddingEngine(reference = 'local/potion-code-16m-v2') {
  if (neuralModel) return neuralModel;
  if (neuralModelInitAttempted) return null;
  neuralModelInitAttempted = true;

  try {
    const factoryUrl = findZvecFactoryUrl();
    if (!factoryUrl) {
      return null;
    }

    const { createEmbeddingModel } = await import(factoryUrl);
    if (typeof createEmbeddingModel !== 'function') {
      return null;
    }

    const model = createEmbeddingModel(reference);
    if (model && model.info) {
      neuralModel = model;
      neuralEngineStatus = {
        engine: 'zvec-grep',
        model: model.info.name || reference,
        dimensions: model.info.dimension || 256,
        active: true,
      };
      return neuralModel;
    }
  } catch (err) {
    console.warn('[antigravity-observability] Neural embedding engine unavailable, using statistical fallback:', err.message);
  }

  return null;
}

/**
 * Returns current embedding engine operational status and cache metrics.
 */
export function getEmbeddingEngineStatus() {
  return {
    ...neuralEngineStatus,
    cachedVectors: vectorCache.size,
  };
}

/**
 * Computes cosine similarity between two numerical vectors.
 */
export function cosineSimilarity(a = [], b = []) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Computes character 3-gram term-frequency vector cosine similarity.
 * High-speed, zero-dependency statistical fallback matching neural distance behavior.
 */
export function computeNgramSimilarity(textA = '', textB = '', n = 3) {
  const normA = String(textA || '').toLowerCase().replace(/\s+/g, ' ');
  const normB = String(textB || '').toLowerCase().replace(/\s+/g, ' ');

  if (!normA.trim() || !normB.trim()) return 0;
  if (normA === normB) return 1.0;

  const vA = new Map();
  for (let i = 0; i <= normA.length - n; i++) {
    const gram = normA.slice(i, i + n);
    vA.set(gram, (vA.get(gram) || 0) + 1);
  }

  const vB = new Map();
  for (let i = 0; i <= normB.length - n; i++) {
    const gram = normB.slice(i, i + n);
    vB.set(gram, (vB.get(gram) || 0) + 1);
  }

  if (vA.size === 0 || vB.size === 0) return 0;

  let dot = 0;
  let normSqA = 0;
  let normSqB = 0;

  for (const [gram, countA] of vA.entries()) {
    normSqA += countA * countA;
    if (vB.has(gram)) {
      dot += countA * vB.get(gram);
    }
  }

  for (const countB of vB.values()) {
    normSqB += countB * countB;
  }

  const denom = Math.sqrt(normSqA) * Math.sqrt(normSqB);
  return denom === 0 ? 0 : +(dot / denom).toFixed(4);
}

/**
 * Asynchronously computes or retrieves cached embedding vector for a given text.
 */
export async function getVectorForText(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return null;

  if (vectorCache.has(clean)) {
    return vectorCache.get(clean);
  }

  if (neuralModel && typeof neuralModel.embed === 'function') {
    try {
      const res = await neuralModel.embed([{ kind: 'text', text: clean.slice(0, 1024) }]);
      if (res && res.vectors && res.vectors.length > 0) {
        const vec = res.vectors[0];
        if (vectorCache.size >= MAX_VECTOR_CACHE) {
          const firstKey = vectorCache.keys().next().value;
          vectorCache.delete(firstKey);
        }
        vectorCache.set(clean, vec);
        return vec;
      }
    } catch {
      // Ignore embed errors and return null
    }
  }

  return null;
}

/**
 * Computes semantic similarity between two texts.
 * Uses neural vector cosine similarity when available; falls back to n-gram similarity.
 */
export async function computeSemanticSimilarityAsync(textA = '', textB = '') {
  const vecA = await getVectorForText(textA);
  const vecB = await getVectorForText(textB);

  if (vecA && vecB) {
    return +(cosineSimilarity(vecA, vecB).toFixed(4));
  }

  return computeNgramSimilarity(textA, textB, 3);
}

/**
 * Extracts a concise semantic signature string from a step record for similarity comparison.
 */
export function getStepSemanticSignature(step = {}) {
  const parts = [];

  if (Array.isArray(step.tools) && step.tools.length > 0) {
    for (const t of step.tools) {
      const toolName = t.name || '';
      const arg = t.primaryArg || '';
      const act = t.action || t.summary || '';
      parts.push(`${toolName} ${arg} ${act}`);
    }
  } else if (step.userPrompt) {
    parts.push(`user: ${step.userPrompt}`);
  } else if (step.thinking) {
    parts.push(`thinking: ${step.thinking.slice(0, 200)}`);
  } else if (step.content) {
    parts.push(step.content.slice(0, 200));
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Regex patterns identifying verification commands in shell actions.
 */
const VERIFICATION_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(test|run\s+test|run\s+lint|run\s+check)\b/i,
  /\b(jest|vitest|mocha|pytest|cargo\s+test|go\s+test|ctest)\b/i,
  /\b(git\s+(status|diff|log|show))\b/i,
  /\b(eslint|ts-node|tsc|ruff|flake8|mypy|biome|prettier\s+--check)\b/i,
  /\b(node\s+(?:scripts\/)?test[\w-]*\.m?js)\b/i,
];

/**
 * Regex patterns identifying recovery / error states in output or content.
 */
const RECOVERY_INDICATORS = [
  'exit status 1',
  'exit status 2',
  'Encountered error in',
  'SyntaxError:',
  'TypeError:',
  'ReferenceError:',
  'Traceback (most recent call last)',
  'AssertionError:',
  'FAIL',
  'failed with error',
];

/**
 * Classifies an individual step into its primary cognitive phase.
 *
 * @param {object} step Parsed step record from parseTranscript
 * @returns {{ phase: string, confidence: number, label: string, color: string, badge: string, method: string }}
 */
export function classifyStepPhase(step = {}) {
  // 1. Recovery phase: errors, crashes, failed executions
  const isExplicitError = step.status === 'ERROR';
  const hasErrorContent = typeof step.content === 'string' && RECOVERY_INDICATORS.some(ind => step.content.includes(ind));
  const hasErrorOutput = typeof step.outputSnippet === 'string' && RECOVERY_INDICATORS.some(ind => step.outputSnippet.includes(ind));

  if (isExplicitError || hasErrorContent || hasErrorOutput) {
    return {
      phase: COGNITIVE_PHASES.RECOVERY,
      confidence: 0.95,
      ...PHASE_METADATA.RECOVERY,
      method: 'heuristic',
    };
  }

  // 2. Tool calls classification
  if (Array.isArray(step.tools) && step.tools.length > 0) {
    const primaryTool = step.tools[0];
    const name = primaryTool.name || '';
    const arg = primaryTool.primaryArg || '';

    // File editing and creation -> Execution
    if (['replace_file_content', 'write_to_file', 'edit_file', 'write_file'].includes(name)) {
      return {
        phase: COGNITIVE_PHASES.EXECUTION,
        confidence: 0.92,
        ...PHASE_METADATA.EXECUTION,
        method: 'heuristic',
      };
    }

    // Shell commands: differentiate verification vs execution vs exploration
    if (name === 'run_command') {
      const isVerification = VERIFICATION_PATTERNS.some(pat => pat.test(arg));
      if (isVerification) {
        return {
          phase: COGNITIVE_PHASES.VERIFICATION,
          confidence: 0.90,
          ...PHASE_METADATA.VERIFICATION,
          method: 'heuristic',
        };
      }

      if (/\b(git\s+commit|git\s+push|git\s+add|npm\s+install|pnpm\s+add|cargo\s+build)\b/i.test(arg)) {
        return {
          phase: COGNITIVE_PHASES.EXECUTION,
          confidence: 0.85,
          ...PHASE_METADATA.EXECUTION,
          method: 'heuristic',
        };
      }

      if (/\b(grep|cat|ls|dir|find|zg|zvec|graphify|archify)\b/i.test(arg)) {
        return {
          phase: COGNITIVE_PHASES.EXPLORATION,
          confidence: 0.85,
          ...PHASE_METADATA.EXPLORATION,
          method: 'heuristic',
        };
      }

      return {
        phase: COGNITIVE_PHASES.EXECUTION,
        confidence: 0.70,
        ...PHASE_METADATA.EXECUTION,
        method: 'heuristic',
      };
    }

    // Reading, web browsing, discovery -> Exploration
    if (['view_file', 'read_file', 'read_url_content', 'search_web', 'list_resources', 'read_resource'].includes(name)) {
      return {
        phase: COGNITIVE_PHASES.EXPLORATION,
        confidence: 0.94,
        ...PHASE_METADATA.EXPLORATION,
        method: 'heuristic',
      };
    }

    // Agent communication, question asking, memory review -> Synthesis
    if (['ask_question', 'send_message', 'manage_subagents', 'define_subagent', 'mem_judge', 'mem_review'].includes(name)) {
      return {
        phase: COGNITIVE_PHASES.SYNTHESIS,
        confidence: 0.88,
        ...PHASE_METADATA.SYNTHESIS,
        method: 'heuristic',
      };
    }

    // MCP Tools (engram mem_save/mem_session_summary) -> Synthesis
    if (name === 'call_mcp_tool' || name.startsWith('mcp_')) {
      const toolName = primaryTool.args?.ToolName || name;
      if (toolName.includes('save') || toolName.includes('summary') || toolName.includes('judge')) {
        return {
          phase: COGNITIVE_PHASES.SYNTHESIS,
          confidence: 0.85,
          ...PHASE_METADATA.SYNTHESIS,
          method: 'heuristic',
        };
      }
      return {
        phase: COGNITIVE_PHASES.EXPLORATION,
        confidence: 0.75,
        ...PHASE_METADATA.EXPLORATION,
        method: 'heuristic',
      };
    }
  }

  // 3. User prompts -> Synthesis
  if (step.type === 'USER_INPUT' || step.source === 'USER_EXPLICIT') {
    return {
      phase: COGNITIVE_PHASES.SYNTHESIS,
      confidence: 0.90,
      ...PHASE_METADATA.SYNTHESIS,
      method: 'heuristic',
    };
  }

  // 4. Model responses with thinking and no tool calls -> Synthesis
  if (step.source === 'MODEL' && step.thinking && (!step.tools || step.tools.length === 0)) {
    return {
      phase: COGNITIVE_PHASES.SYNTHESIS,
      confidence: 0.90,
      ...PHASE_METADATA.SYNTHESIS,
      method: 'heuristic',
    };
  }

  // Default fallback
  return {
    phase: COGNITIVE_PHASES.SYNTHESIS,
    confidence: 0.60,
    ...PHASE_METADATA.SYNTHESIS,
    method: 'heuristic',
  };
}

/**
 * Detects repetitive semantic loops across recent steps by measuring pairwise semantic similarity.
 *
 * Catches patterns where exact strings differ (e.g. slight file line offsets, minor command flags,
 * repeated test runs), but the agent is caught in a repetitive action loop.
 *
 * @param {Array<object>} steps Array of parsed step records
 * @param {number} threshold Cosine / n-gram similarity threshold to trigger detection (default: 0.85)
 * @param {number} minStreak Minimum consecutive similar steps required (default: 3)
 * @returns {{ detected: boolean, similarity: number, tool: string, phase: string, description: string, stepIndices: number[] } | null}
 */
export function detectSemanticLoop(steps = [], threshold = 0.85, minStreak = 3) {
  if (!Array.isArray(steps) || steps.length < minStreak) {
    return null;
  }

  // Filter to steps with actionable tools or distinct content
  const actionableSteps = steps
    .map((s, idx) => ({ step: s, originalIdx: s.stepIndex ?? idx, sig: getStepSemanticSignature(s) }))
    .filter(item => item.sig && item.sig.length >= 8);

  if (actionableSteps.length < minStreak) {
    return null;
  }

  // Check the trailing window (last 10 actionable steps)
  const windowSlice = actionableSteps.slice(-10);

  // 1. Check trailing consecutive streak
  let trailingStreak = 1;
  const lastItem = windowSlice[windowSlice.length - 1];
  const matchedIndices = [lastItem.originalIdx];
  let totalSim = 1.0;

  for (let i = windowSlice.length - 2; i >= 0; i--) {
    const prevItem = windowSlice[i];
    const sameTool = Boolean(
      lastItem.step.tools?.[0]?.name &&
      lastItem.step.tools[0].name === prevItem.step.tools?.[0]?.name
    );
    const effectiveThreshold = sameTool ? Math.min(threshold, 0.72) : threshold;
    const sim = computeNgramSimilarity(lastItem.sig, prevItem.sig, 3);
    if (sim >= effectiveThreshold) {
      trailingStreak++;
      totalSim += sim;
      matchedIndices.unshift(prevItem.originalIdx);
    } else {
      break;
    }
  }

  if (trailingStreak >= minStreak) {
    const avgSim = +(totalSim / trailingStreak).toFixed(2);
    const primaryTool = lastItem.step.tools?.[0]?.name || 'action';
    const phaseInfo = classifyStepPhase(lastItem.step);

    return {
      detected: true,
      similarity: avgSim,
      tool: primaryTool,
      phase: phaseInfo.phase,
      description: `Repetitive ${phaseInfo.label.toLowerCase()} loop detected (${Math.round(avgSim * 100)}% similarity across ${trailingStreak} steps)`,
      stepIndices: matchedIndices,
    };
  }

  // 2. Check recent window for any streak of >= minStreak
  let streak = 1;
  let streakIndices = [windowSlice[0].originalIdx];
  let streakSimSum = 1.0;

  for (let i = 1; i < windowSlice.length; i++) {
    const curr = windowSlice[i];
    const prev = windowSlice[i - 1];
    const sameTool = Boolean(
      curr.step.tools?.[0]?.name &&
      curr.step.tools[0].name === prev.step.tools?.[0]?.name
    );
    const effectiveThreshold = sameTool ? Math.min(threshold, 0.72) : threshold;
    const sim = computeNgramSimilarity(curr.sig, prev.sig, 3);

    if (sim >= effectiveThreshold) {
      streak++;
      streakSimSum += sim;
      streakIndices.push(curr.originalIdx);

      if (streak >= minStreak) {
        const avgSim = +(streakSimSum / streak).toFixed(2);
        const toolName = curr.step.tools?.[0]?.name || 'action';
        const phaseInfo = classifyStepPhase(curr.step);

        return {
          detected: true,
          similarity: avgSim,
          tool: toolName,
          phase: phaseInfo.phase,
          description: `Repetitive ${phaseInfo.label.toLowerCase()} loop detected (${Math.round(avgSim * 100)}% similarity across ${streak} steps)`,
          stepIndices: streakIndices,
        };
      }
    } else {
      streak = 1;
      streakSimSum = 1.0;
      streakIndices = [curr.originalIdx];
    }
  }

  return null;
}

/**
 * Performs full cognitive phase and semantic loop analysis on a list of steps.
 *
 * @param {Array<object>} parsedSteps All steps from transcript parsing
 * @returns {object} Aggregated cognition metrics
 */
export function analyzeSessionCognition(parsedSteps = []) {
  const counts = {
    [COGNITIVE_PHASES.EXPLORATION]: 0,
    [COGNITIVE_PHASES.SYNTHESIS]: 0,
    [COGNITIVE_PHASES.EXECUTION]: 0,
    [COGNITIVE_PHASES.VERIFICATION]: 0,
    [COGNITIVE_PHASES.RECOVERY]: 0,
  };

  const classifiedSteps = [];

  for (let i = 0; i < parsedSteps.length; i++) {
    const step = parsedSteps[i];
    const classification = classifyStepPhase(step);

    // Mutate or annotate step record
    step.phase = classification.phase;
    step.phaseConfidence = classification.confidence;
    step.phaseLabel = classification.label;
    step.phaseColor = classification.color;
    step.phaseBadge = classification.badge;

    counts[classification.phase] = (counts[classification.phase] || 0) + 1;
    classifiedSteps.push(step);
  }

  const total = parsedSteps.length || 1;
  const distribution = {
    exploration: +((counts[COGNITIVE_PHASES.EXPLORATION] / total) * 100).toFixed(1),
    synthesis: +((counts[COGNITIVE_PHASES.SYNTHESIS] / total) * 100).toFixed(1),
    execution: +((counts[COGNITIVE_PHASES.EXECUTION] / total) * 100).toFixed(1),
    verification: +((counts[COGNITIVE_PHASES.VERIFICATION] / total) * 100).toFixed(1),
    recovery: +((counts[COGNITIVE_PHASES.RECOVERY] / total) * 100).toFixed(1),
  };

  // Determine current active cognitive phase
  const lastStep = parsedSteps.length > 0 ? parsedSteps[parsedSteps.length - 1] : null;
  const currentPhase = lastStep ? (lastStep.phase || COGNITIVE_PHASES.SYNTHESIS) : COGNITIVE_PHASES.SYNTHESIS;
  const currentPhaseMeta = PHASE_METADATA[currentPhase] || PHASE_METADATA.SYNTHESIS;

  // Detect semantic loops
  const semanticLoop = detectSemanticLoop(parsedSteps, 0.85, 3);

  return {
    currentPhase,
    currentPhaseLabel: currentPhaseMeta.label,
    currentPhaseColor: currentPhaseMeta.color,
    phaseCounts: counts,
    phaseDistribution: distribution,
    semanticLoop,
    engineStatus: getEmbeddingEngineStatus(),
  };
}
