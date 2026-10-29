import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { initNeuralEmbeddingEngine } from './classifier.mjs';
import { parseTranscript } from './telemetry.mjs';

// Non-blocking background bootstrap of local neural embedding engine
initNeuralEmbeddingEngine().catch(() => {});

// Dynamic import of node:sqlite for backwards compatibility with Node.js < 22.5.0
let DatabaseSync = null;
try {
  const sqlite = await import('node:sqlite');
  DatabaseSync = sqlite.DatabaseSync || null;
} catch {
  // node:sqlite is unavailable in Node < 22.5.0; fallback strategy will be used
}

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();
const ANTIGRAVITY_BASE = join(homedir(), '.gemini', 'antigravity');
const BRAIN_DIR = join(ANTIGRAVITY_BASE, 'brain');
const CONVERSATIONS_DIR = join(ANTIGRAVITY_BASE, 'conversations');
const RECORDINGS_DIR = join(ANTIGRAVITY_BASE, 'browser_recordings');
const CACHE_DIR = join(ANTIGRAVITY_BASE, 'cache');
const DB_PATH = join(ANTIGRAVITY_BASE, 'conversation_summaries.db');
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// In-memory caches to eliminate synchronous disk churn during 2.5s polling
let cachedSessions = null;
let sessionsCacheExpiry = 0;
const SESSIONS_TTL_MS = 5000; // 5-second session listing TTL
const TRANSCRIPT_TTL_MS = 60000; // 60-second transcript cache TTL
const transcriptCache = new Map(); // conversationId -> { mtimeMs, size, report, expiresAt }

let cachedQuota = null;
let quotaCacheExpiry = 0;
const QUOTA_TTL_MS = 15000; // 15-second quota cache TTL

let cachedCacheInfo = null;
let cacheInfoExpiry = 0;
const CACHE_INFO_TTL_MS = 5000; // 5-second cache info TTL

const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

// Security headers for static assets.
// Note: X-Frame-Options is intentionally omitted because the sidecar UI is rendered
// inside an iframe in the Antigravity IDE auxiliary webview pane. Setting X-Frame-Options
// blocks the parent IDE window from embedding the panel, resulting in a blank screen.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
};

// Static file routes with security headers
app.page('/', () => new Response(readLocal('index.html'), { contentType: 'text/html', headers: SECURITY_HEADERS }));
app.page('/app.js', () => new Response(readLocal('app.js'), { contentType: 'application/javascript', headers: SECURITY_HEADERS }));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css', headers: SECURITY_HEADERS }), 'GET');

// System status
app.api('/api/status', () => ({
  status: 'ok',
  version: '1.5.0',
  node: process.version,
  platform: `${platform()} ${release()}`,
  uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
  sqliteAvailable: Boolean(DatabaseSync),
  cachedTranscripts: transcriptCache.size,
}), 'GET');

// Retrieve recent conversations with real user-facing titles (cached)
function getRecentSessions(force = false) {
  const now = Date.now();
  if (!force && cachedSessions && now < sessionsCacheExpiry) {
    return cachedSessions;
  }

  let sessions = [];

  // Strategy 1: Read conversation_summaries.db (SQLite)
  if (DatabaseSync && existsSync(DB_PATH)) {
    let db = null;
    try {
      db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
      const rows = db.prepare(`
        SELECT conversation_id, title, preview, step_count, last_modified_time, parent_conversation_id
        FROM conversation_summaries
        WHERE parent_conversation_id = '' OR parent_conversation_id IS NULL
        ORDER BY last_modified_time DESC
        LIMIT 30
      `).all();

      if (rows && rows.length > 0) {
        sessions = rows.map(r => {
          let cleanTitle = (r.title || '').trim();
          if (!cleanTitle && r.preview) {
            cleanTitle = r.preview.trim().slice(0, 36);
          }
          if (!cleanTitle) {
            cleanTitle = `Chat ${r.conversation_id.slice(0, 8)}`;
          }

          return {
            id: r.conversation_id,
            title: cleanTitle,
            stepCount: r.step_count || 0,
            lastModified: r.last_modified_time || '',
          };
        });
      }
    } catch (err) {
      console.warn('Fallback to brain scan (DB error):', err.message);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore close error
        }
      }
    }
  }

  // Strategy 2: Fallback scan of brain/ directory if SQLite returned nothing
  if (sessions.length === 0 && existsSync(BRAIN_DIR)) {
    try {
      const entries = readdirSync(BRAIN_DIR, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'tempmediaStorage') continue;
        const transPath = join(BRAIN_DIR, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (existsSync(transPath)) {
          let mtime = 0;
          try {
            mtime = statSync(transPath).mtimeMs;
          } catch {
            mtime = 0;
          }

          let title = `Chat ${entry.name.slice(0, 8)}`;
          let fd = null;
          try {
            fd = openSync(transPath, 'r');
            const buf = Buffer.alloc(16384);
            const bytesRead = readSync(fd, buf, 0, 16384, 0);
            const rawChunk = buf.toString('utf8', 0, bytesRead);
            const newlineIdx = rawChunk.indexOf('\n');
            const firstLine = newlineIdx !== -1 ? rawChunk.slice(0, newlineIdx) : rawChunk;
            if (firstLine.trim()) {
              const parsed = JSON.parse(firstLine);
              if (parsed.content) {
                const m = parsed.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                if (m) title = m[1].trim().split('\n')[0].slice(0, 32);
              }
            }
          } catch {
            // ignore malformed initial chunk
          } finally {
            if (fd !== null) {
              try {
                closeSync(fd);
              } catch {
                // ignore close error
              }
            }
          }

          sessions.push({
            id: entry.name,
            title,
            lastModified: mtime,
          });
        }
      }

      sessions.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    } catch (err) {
      console.error('Failed to list sessions:', err.message);
    }
  }

  cachedSessions = sessions;
  sessionsCacheExpiry = now + SESSIONS_TTL_MS;
  return sessions;
}

// Endpoint to list all discoverable conversation sessions
app.api('/api/sessions', () => {
  return { sessions: getRecentSessions() };
}, 'GET');

// Telemetry parsing endpoint with file mtime/size caching
app.api('/api/telemetry', (params) => {
  let conversationId = params?.conversationId;
  const isForced = params?.force === 'true' || params?.force === true;
  const recentSessions = getRecentSessions(isForced);

  // Auto-resolve: if conversationId is 'auto' or omitted, dynamically target the latest active chat
  let isAuto = false;
  if (!conversationId || conversationId === 'auto' || conversationId === 'latest') {
    isAuto = true;
    if (recentSessions.length > 0) {
      conversationId = recentSessions[0].id;
    }
  }

  if (!conversationId) {
    return {
      error: 'No active session found',
      status: 'no_session',
      sessions: recentSessions,
    };
  }

  // Find active chat title
  const activeSession = recentSessions.find(s => s.id === conversationId) || recentSessions[0];
  const activeTitle = activeSession ? activeSession.title : `Chat ${conversationId.slice(0, 8)}`;

  if (!/^[a-zA-Z0-9_-]+$/.test(conversationId)) {
    return { error: 'Invalid conversationId format', status: 'invalid_id' };
  }

  const transcriptPath = join(
    BRAIN_DIR,
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  );

  if (!existsSync(transcriptPath)) {
    return {
      ...parseTranscript('', { conversationId, activeTitle, isAuto, sessions: recentSessions }),
      status: 'waiting_for_transcript',
    };
  }

  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch (err) {
    return { error: `Failed to stat transcript: ${err.message}`, status: 'read_error' };
  }

  const now = Date.now();

  // Check stat cache: avoid re-reading and re-parsing unchanged transcripts unless forced or expired
  if (isForced) {
    transcriptCache.delete(conversationId);
  } else {
    const cached = transcriptCache.get(conversationId);
    if (cached && now < cached.expiresAt && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return {
        ...cached.report,
        activeTitle,
        isAuto,
        sessions: recentSessions,
      };
    }
  }

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    return { error: `Failed to read transcript: ${err.message}`, status: 'read_error' };
  }

  const parsed = parseTranscript(raw, {
    conversationId,
    activeTitle,
    isAuto,
    sessions: recentSessions,
  });

  // Prune expired entries to release memory for inactive sessions
  for (const [id, entry] of transcriptCache.entries()) {
    if (now >= entry.expiresAt) {
      transcriptCache.delete(id);
    }
  }

  if (transcriptCache.size >= 50) {
    const oldestKey = transcriptCache.keys().next().value;
    transcriptCache.delete(oldestKey);
  }

  transcriptCache.set(conversationId, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    report: parsed,
    expiresAt: now + TRANSCRIPT_TTL_MS,
  });

  return parsed;
}, 'GET');

/**
 * Recursively calculate total size in bytes of a directory tree.
 * @param {string} dirPath - Absolute directory path.
 * @param {number} [maxDepth=6] - Maximum recursion depth to prevent cyclic links.
 * @returns {number} Cumulative size in bytes.
 */
function getDirectorySize(dirPath, maxDepth = 6) {
  if (maxDepth <= 0 || !existsSync(dirPath)) return 0;
  let total = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += getDirectorySize(fullPath, maxDepth - 1);
      } else if (entry.isFile()) {
        try {
          total += statSync(fullPath).size;
        } catch {
          // ignore vanishing files
        }
      }
    }
  } catch {
    // ignore unreadable directory
  }
  return total;
}

/**
 * Convert byte values into human-readable units (B, KB, MB, GB).
 * @param {number} bytes - Raw byte count.
 * @returns {string} Formatted size string.
 */
function formatBytes(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Retrieve comprehensive storage breakdown and brain task list.
 * @param {boolean} [force=false] - Whether to bypass memory cache.
 * @returns {object} Cache storage metrics and task listings.
 */
function getBrainCacheInfo(force = false) {
  const now = Date.now();
  if (!force && cachedCacheInfo && now < cacheInfoExpiry) {
    return cachedCacheInfo;
  }

  // Load known titles from conversation_summaries.db
  const titleMap = new Map();
  if (DatabaseSync && existsSync(DB_PATH)) {
    let db = null;
    try {
      db = new DatabaseSync(DB_PATH, { open: true, readOnly: true });
      const rows = db.prepare('SELECT conversation_id, title, preview FROM conversation_summaries').all();
      for (const r of rows) {
        const t = (r.title || '').trim() || (r.preview || '').trim().slice(0, 48);
        if (t) titleMap.set(r.conversation_id, t);
      }
    } catch {
      // fallback if db locked or read fails
    } finally {
      if (db) {
        try { db.close(); } catch {}
      }
    }
  }

  const tasks = [];
  let brainBytes = 0;

  if (existsSync(BRAIN_DIR)) {
    try {
      const entries = readdirSync(BRAIN_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID_REGEX.test(entry.name)) continue;
        const taskPath = join(BRAIN_DIR, entry.name);
        const taskSize = getDirectorySize(taskPath);
        brainBytes += taskSize;

        let title = titleMap.get(entry.name) || '';
        if (!title) {
          const taskMd = join(taskPath, 'task.md');
          if (existsSync(taskMd)) {
            try {
              const firstLine = readFileSync(taskMd, 'utf8').split('\n')[0].trim();
              if (firstLine.startsWith('#')) {
                title = firstLine.replace(/^#+\s*/, '').trim();
              } else if (firstLine) {
                title = firstLine.slice(0, 48);
              }
            } catch {}
          }
        }
        if (!title) {
          title = `Session ${entry.name.slice(0, 8)}`;
        }

        let mtime = 0;
        try {
          mtime = statSync(taskPath).mtimeMs;
        } catch {}

        tasks.push({
          id: entry.name,
          title,
          sizeBytes: taskSize,
          sizeFormatted: formatBytes(taskSize),
          mtime,
        });
      }
      tasks.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    } catch (err) {
      console.warn('Failed to scan brain directory:', err.message);
    }
  }

  const conversationsBytes = existsSync(CONVERSATIONS_DIR) ? getDirectorySize(CONVERSATIONS_DIR) : 0;
  const recordingsBytes = existsSync(RECORDINGS_DIR) ? getDirectorySize(RECORDINGS_DIR) : 0;
  const tempBytes = existsSync(CACHE_DIR) ? getDirectorySize(CACHE_DIR) : 0;
  const totalBytes = brainBytes + conversationsBytes + recordingsBytes + tempBytes;

  const summary = {
    totalBytes,
    totalFormatted: formatBytes(totalBytes),
    brainBytes,
    brainFormatted: formatBytes(brainBytes),
    brainTasksCount: tasks.length,
    conversationsBytes,
    conversationsFormatted: formatBytes(conversationsBytes),
    recordingsBytes,
    recordingsFormatted: formatBytes(recordingsBytes),
    tempBytes,
    tempFormatted: formatBytes(tempBytes),
  };

  const result = {
    status: 'ok',
    summary,
    tasks,
    updatedAt: now,
  };

  cachedCacheInfo = result;
  cacheInfoExpiry = now + CACHE_INFO_TTL_MS;
  return result;
}

/**
 * Safely prune stale sessions or delete individual cache tasks.
 * @param {object} params - Action parameters.
 * @returns {object} Action execution status.
 */
function handleCacheAction(params = {}) {
  const action = params.action;
  const activeId = params.activeConversationId || process.env.ANTIGRAVITY_CONVERSATION_ID || '';

  if (action === 'prune_stale') {
    const keepCount = Math.max(1, parseInt(params.keepCount, 10) || 10);
    const info = getBrainCacheInfo(true);
    const toDelete = info.tasks.slice(keepCount).filter(t => t.id !== activeId);

    let freedBytes = 0;
    let deletedCount = 0;

    for (const t of toDelete) {
      if (!UUID_REGEX.test(t.id)) continue;
      const taskDir = join(BRAIN_DIR, t.id);
      try {
        if (existsSync(taskDir)) {
          rmSync(taskDir, { recursive: true, force: true });
          freedBytes += t.sizeBytes;
          deletedCount += 1;
        }
      } catch (err) {
        console.warn(`Failed to remove stale task ${t.id}:`, err.message);
      }

      // Also clean matching files in conversations/
      if (existsSync(CONVERSATIONS_DIR)) {
        for (const ext of ['.pb', '.db', '.db-wal', '.db-shm']) {
          const convFile = join(CONVERSATIONS_DIR, `${t.id}${ext}`);
          try {
            if (existsSync(convFile)) {
              const sz = statSync(convFile).size;
              rmSync(convFile, { force: true });
              freedBytes += sz;
            }
          } catch {}
        }
      }
    }

    cachedCacheInfo = null; // invalidate cache
    return {
      status: 'ok',
      action: 'prune_stale',
      freedBytes,
      freedFormatted: formatBytes(freedBytes),
      deletedCount,
      keptCount: info.tasks.length - deletedCount,
    };
  }

  if (action === 'delete_task') {
    const taskId = params.taskId;
    if (!taskId || !UUID_REGEX.test(taskId)) {
      return { status: 'error', error: 'Invalid or missing task UUID format' };
    }
    if (taskId === activeId) {
      return { status: 'error', error: 'Cannot delete currently active conversation' };
    }

    const taskDir = join(BRAIN_DIR, taskId);
    let freedBytes = 0;

    try {
      if (existsSync(taskDir)) {
        freedBytes += getDirectorySize(taskDir);
        rmSync(taskDir, { recursive: true, force: true });
      }
    } catch (err) {
      return { status: 'error', error: `Failed to delete task directory: ${err.message}` };
    }

    if (existsSync(CONVERSATIONS_DIR)) {
      for (const ext of ['.pb', '.db', '.db-wal', '.db-shm']) {
        const convFile = join(CONVERSATIONS_DIR, `${taskId}${ext}`);
        try {
          if (existsSync(convFile)) {
            freedBytes += statSync(convFile).size;
            rmSync(convFile, { force: true });
          }
        } catch {}
      }
    }

    cachedCacheInfo = null; // invalidate cache
    return {
      status: 'ok',
      action: 'delete_task',
      taskId,
      freedBytes,
      freedFormatted: formatBytes(freedBytes),
    };
  }

  if (action === 'clear_recordings') {
    let freedBytes = 0;
    if (existsSync(RECORDINGS_DIR)) {
      try {
        const entries = readdirSync(RECORDINGS_DIR, { withFileTypes: true });
        for (const e of entries) {
          const p = join(RECORDINGS_DIR, e.name);
          try {
            if (e.isDirectory()) {
              freedBytes += getDirectorySize(p);
              rmSync(p, { recursive: true, force: true });
            } else if (e.isFile()) {
              freedBytes += statSync(p).size;
              rmSync(p, { force: true });
            }
          } catch {}
        }
      } catch (err) {
        return { status: 'error', error: `Failed to clear recordings: ${err.message}` };
      }
    }

    cachedCacheInfo = null;
    return {
      status: 'ok',
      action: 'clear_recordings',
      freedBytes,
      freedFormatted: formatBytes(freedBytes),
    };
  }

  return { status: 'error', error: `Unknown cache action: ${action}` };
}

/**
 * Send Connect-RPC request to the Antigravity Language Server.
 * @param {string} endpoint - LanguageServerService method identifier.
 * @param {object} [payload={}] - Additional RPC payload fields.
 * @returns {Promise<object>} Parsed JSON response.
 */
function fetchLanguageServerRpc(endpoint, payload = {}) {
  return new Promise((resolve, reject) => {
    const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN;

    if (!lsAddr || !csrfToken) {
      return reject(new Error('Language server address or CSRF token not configured'));
    }

    const [host, portStr] = lsAddr.split(':');
    const port = parseInt(portStr || '64235', 10);
    const body = JSON.stringify({
      metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' },
      ...payload,
    });

    const req = http.request({
      hostname: host || '127.0.0.1',
      port,
      path: `/exa.language_server_pb.LanguageServerService/${endpoint}`,
      method: 'POST',
      timeout: 3500,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Codeium-Csrf-Token': csrfToken,
        'Connect-Protocol-Version': '1',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          return reject(new Error(`Language server responded with HTTP ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Failed to parse language server response: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Language server request timed out'));
    });

    req.on('error', (err) => {
      reject(new Error(`Language server connection failed: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

/**
 * Retrieve model rate limit quotas and user credit metrics.
 * @param {boolean} [force=false] - Whether to bypass in-memory quota cache.
 * @returns {Promise<object>} Quota summary payload.
 */
async function fetchUserQuotaSummary(force = false) {
  const now = Date.now();
  if (!force && cachedQuota && now < quotaCacheExpiry) {
    return cachedQuota;
  }

  try {
    const [quotaRes, statusRes] = await Promise.allSettled([
      fetchLanguageServerRpc('RetrieveUserQuotaSummary'),
      fetchLanguageServerRpc('GetUserStatus'),
    ]);

    if (quotaRes.status !== 'fulfilled' && statusRes.status !== 'fulfilled') {
      return {
        status: 'unavailable',
        message: 'Language Server is not reachable',
        groups: [],
        models: [],
        user: null,
      };
    }

    const rawQuota = quotaRes.status === 'fulfilled' ? quotaRes.value : null;
    const rawStatus = statusRes.status === 'fulfilled' ? statusRes.value : null;

    // Extract user profile and plan
    const userStatus = rawStatus?.userStatus || {};
    const planInfo = userStatus?.planStatus?.planInfo || {};
    const user = {
      name: userStatus.name || '',
      email: userStatus.email || '',
      plan: planInfo.planName || userStatus.userTier?.name || 'Pro',
      availablePromptCredits: userStatus.planStatus?.availablePromptCredits ?? planInfo.monthlyPromptCredits ?? null,
      monthlyPromptCredits: planInfo.monthlyPromptCredits ?? null,
      availableFlowCredits: userStatus.planStatus?.availableFlowCredits ?? planInfo.monthlyFlowCredits ?? null,
      monthlyFlowCredits: planInfo.monthlyFlowCredits ?? null,
    };

    // Extract rate limit quota groups
    const rawGroups = rawQuota?.response?.groups || [];
    const groups = rawGroups.map(g => ({
      name: g.displayName || 'Model Group',
      description: g.description || '',
      buckets: (g.buckets || []).map(b => {
        const remainingFraction = typeof b.remainingFraction === 'number'
          ? Math.max(0, Math.min(1, b.remainingFraction))
          : 0;
        return {
          id: b.bucketId || '',
          name: b.displayName || b.bucketId || 'Limit',
          description: b.description || '',
          window: b.window || '',
          remainingFraction,
          remainingPercent: Math.round(remainingFraction * 100),
          resetTime: b.resetTime || null,
        };
      }),
    }));

    // Extract configured models
    const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    const models = rawModels
      .filter(m => m.quotaInfo)
      .map(m => {
        const remainingFraction = typeof m.quotaInfo?.remainingFraction === 'number'
          ? Math.max(0, Math.min(1, m.quotaInfo.remainingFraction))
          : 0;
        return {
          label: m.label || 'Model',
          modelId: m.modelId || m.modelOrAlias?.model || 'unknown',
          remainingFraction,
          remainingPercent: Math.round(remainingFraction * 100),
          resetTime: m.quotaInfo?.resetTime || null,
        };
      });

    const result = {
      status: 'ok',
      user,
      groups,
      models,
      updatedAt: now,
    };

    cachedQuota = result;
    quotaCacheExpiry = now + QUOTA_TTL_MS;
    return result;
  } catch (err) {
    return {
      status: 'unavailable',
      message: err.message,
      groups: [],
      models: [],
      user: null,
    };
  }
}

// Rate limit quota and credit metrics endpoint
app.api('/api/quota', async (params) => {
  const isForced = params?.force === 'true' || params?.force === true;
  return await fetchUserQuotaSummary(isForced);
}, 'GET');

// Storage and cache inspection endpoint
app.api('/api/cache', (params) => {
  const isForced = params?.force === 'true' || params?.force === true;
  return getBrainCacheInfo(isForced);
}, 'GET');

// Cache management action endpoint
app.api('/api/cache', (data) => {
  return handleCacheAction(data || {});
}, 'POST');

app.run();
