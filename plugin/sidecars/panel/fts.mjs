/**
 * SQLite FTS5 Full-Text Search Engine
 * Provides BM25 ranking, trigram tokenization, and cross-session search across conversation traces.
 */

/**
 * Sanitize an input query string for safe SQLite FTS5 matching.
 *
 * @param {string} query
 * @returns {string} Sanitized query string with tokens escaped
 */
export function sanitizeFtsQuery(query) {
  if (!query || typeof query !== 'string') return '';
  const cleaned = query.trim().replace(/[\x00-\x1f]/g, ' ');
  const tokens = cleaned.match(/[a-zA-Z0-9_\u0080-\uffff]+/g);
  if (!tokens || tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Initializes the FTS5 virtual table and supporting indexes.
 *
 * @param {object} db DatabaseSync instance
 */
export function initFtsIndex(db) {
  if (!db) return;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
      conversation_id UNINDEXED,
      step_index UNINDEXED,
      role UNINDEXED,
      tool_name UNINDEXED,
      content,
      tokenize = 'trigram'
    );
  `);
}

/**
 * Indexes an array of transcript steps for a given session.
 *
 * @param {object} db DatabaseSync instance
 * @param {string} conversationId
 * @param {Array<object>} steps
 */
export function indexSessionSteps(db, conversationId, steps = []) {
  if (!db || !conversationId || !Array.isArray(steps) || steps.length === 0) return 0;

  initFtsIndex(db);

  // Remove existing indexed steps for this session to avoid duplication
  try {
    db.prepare('DELETE FROM transcript_fts WHERE conversation_id = ?').run(conversationId);
  } catch {}

  const insertStmt = db.prepare(`
    INSERT INTO transcript_fts (conversation_id, step_index, role, tool_name, content)
    VALUES (?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const step of steps) {
    if (!step) continue;
    const stepIdx = String(step.stepIndex ?? step.step_index ?? count);
    const role = step.source || step.role || step.type || 'SYSTEM';
    const toolName = step.toolsInStep?.[0]?.name || step.tool_calls?.[0]?.name || '';
    const content = typeof step.content === 'string'
      ? step.content
      : (typeof step.output === 'string' ? step.output : JSON.stringify(step.args || {}));

    if (content && content.trim()) {
      insertStmt.run(conversationId, stepIdx, role, toolName, content.slice(0, 16384));
      count++;
    }
  }

  return count;
}

/**
 * Searches indexed transcript steps using BM25 ranking and snippet generation.
 *
 * @param {object} db DatabaseSync instance
 * @param {string} query Search terms
 * @param {number} limit Maximum results to return
 * @returns {Array<object>} List of search hits with rank and snippet
 */
export function searchTranscripts(db, query, limit = 20) {
  if (!db || !query || typeof query !== 'string') return [];
  initFtsIndex(db);

  const safeQuery = sanitizeFtsQuery(query);
  if (!safeQuery) return [];

  try {
    const rows = db.prepare(`
      SELECT
        conversation_id,
        step_index,
        role,
        tool_name,
        snippet(transcript_fts, 4, '<mark>', '</mark>', '...', 32) AS snippet,
        rank
      FROM transcript_fts
      WHERE transcript_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(safeQuery, Math.max(1, Math.min(100, limit)));

    return rows.map((r) => ({
      conversationId: r.conversation_id,
      stepIndex: parseInt(r.step_index, 10) || 0,
      role: r.role,
      toolName: r.tool_name,
      snippet: r.snippet,
      score: typeof r.rank === 'number' ? Number((-r.rank).toFixed(4)) : 1.0,
    }));
  } catch {
    return [];
  }
}
