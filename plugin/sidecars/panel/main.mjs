import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { parseTranscript } from './telemetry.mjs';

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
const BRAIN_DIR = join(homedir(), '.gemini', 'antigravity', 'brain');
const DB_PATH = join(homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');

// In-memory caches to eliminate synchronous disk churn during 2.5s polling
let cachedSessions = null;
let sessionsCacheExpiry = 0;
const SESSIONS_TTL_MS = 5000; // 5-second session listing TTL
const transcriptCache = new Map(); // conversationId -> { mtimeMs, size, report }

const app = new SidecarApp();

const readLocal = (name) => readFileSync(join(HERE, name), 'utf8');

// Static file routes
app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => readLocal('app.js'));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');

// System status
app.api('/api/status', () => ({
  status: 'ok',
  version: '1.2.1',
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
      status: 'waiting_for_transcript',
      conversationId,
      activeTitle,
      isAuto,
      sessions: recentSessions,
      totalSteps: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      totalPromptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCost: '$0.0000',
      cacheHitRate: '0%',
      cacheSavings: '$0.0000',
      latestContextTokens: 0,
      peakContextTokens: 0,
      contextLimit: 1000000,
      contextLoadPercent: '0.0%',
      compactionsCount: 0,
      activeModel: 'Gemini',
      avgStepDuration: '0.0s',
      toolSuccessRate: '100%',
      subagentCalls: 0,
      mcpCalls: 0,
      artifactsCount: 0,
      errorCount: 0,
      loopDetected: null,
      toolCounts: {},
      filesTouched: [],
      failedSteps: [],
      recentSteps: [],
    };
  }

  let stat;
  try {
    stat = statSync(transcriptPath);
  } catch (err) {
    return { error: `Failed to stat transcript: ${err.message}`, status: 'read_error' };
  }

  // Check stat cache: avoid re-reading and re-parsing unchanged transcripts unless forced
  if (isForced) {
    transcriptCache.delete(conversationId);
  } else {
    const cached = transcriptCache.get(conversationId);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
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

  transcriptCache.set(conversationId, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    report: parsed,
  });

  return parsed;
}, 'GET');

app.run();
