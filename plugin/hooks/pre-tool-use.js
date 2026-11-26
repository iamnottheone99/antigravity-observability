#!/usr/bin/env node

/**
 * PreToolUse Hook for Agent Observability
 * Active guardrails: Intercepts repetitive tool loops before execution and validates paths/binaries.
 */

import { existsSync, openSync, readFileSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, normalize, resolve, extname } from 'node:path';

export const RECENT_CALLS_FILE = resolve(tmpdir(), 'antigravity-observability-tool-calls.json');
const LOOP_THRESHOLD = 5;

function getSessionCallsFile(sessionId = 'default') {
  const safeId = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return resolve(tmpdir(), `ag-obs-calls-${safeId || 'default'}.json`);
}

const KNOWN_TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.yaml', '.yml', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.cs', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp', '.sh', '.bash',
  '.ps1', '.sql', '.axaml', '.xml', '.svg', '.toml', '.ini', '.env', '.gitignore',
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar', '.wasm',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.db', '.sqlite', '.pb',
]);

export function cleanFilePath(val) {
  if (val === undefined || val === null) return '';
  let str = String(val).trim();
  while (
    (str.startsWith('"') && str.endsWith('"') && str.length >= 2) ||
    (str.startsWith("'") && str.endsWith("'") && str.length >= 2)
  ) {
    str = str.slice(1, -1).trim();
  }
  if (!str) return '';

  if (str.startsWith('file:///')) {
    const after = str.slice(8);
    str = /^[a-zA-Z]:/.test(after) ? after : '/' + after;
  } else if (str.startsWith('file://')) {
    str = str.slice(7);
  }

  try {
    str = decodeURIComponent(str);
  } catch {}

  str = str.replace(/#L\d+(-L\d+)?$/i, '');
  return normalize(str.trim());
}

export function isBinaryBuffer(buf, bytesRead = buf.length) {
  if (!buf || bytesRead <= 0) return false;

  // UTF-16 LE / BE BOM
  if (bytesRead >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return false;
  }
  // UTF-8 BOM
  if (bytesRead >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return false;
  }
  // PDF magic header (%PDF)
  if (bytesRead >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return true;
  }

  // Scan first chunk for null bytes
  for (let i = 0; i < bytesRead; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export function isBinaryFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = extname(filePath).toLowerCase();
  if (KNOWN_TEXT_EXTENSIONS.has(ext)) return false;
  if (KNOWN_BINARY_EXTENSIONS.has(ext)) return true;

  try {
    if (existsSync(filePath)) {
      const fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(512);
      const bytesRead = readSync(fd, buf, 0, 512, 0);
      closeSync(fd);
      return isBinaryBuffer(buf, bytesRead);
    }
  } catch {}

  return false;
}

function recordAndCheckLoop(toolName, signature, sessionId = 'default') {
  const now = Date.now();
  const filePath = getSessionCallsFile(sessionId);
  let list = [];
  try {
    if (existsSync(filePath)) {
      list = JSON.parse(readFileSync(filePath, 'utf8'));
    }
  } catch {}

  // Filter out expired calls older than 60 seconds to prevent cross-session leakage
  const activeList = (Array.isArray(list) ? list : []).filter((item) => now - (item.time || 0) < 60000);
  activeList.push({ toolName, signature, time: now });

  // Keep last 15 entries for this session
  if (activeList.length > 15) {
    activeList.splice(0, activeList.length - 15);
  }

  try {
    writeFileSync(filePath, JSON.stringify(activeList), 'utf8');
  } catch {}

  // Check trailing streak
  let streak = 0;
  for (let i = activeList.length - 1; i >= 0; i--) {
    if (activeList[i].toolName === toolName && activeList[i].signature === signature) {
      streak++;
    } else {
      break;
    }
  }

  return streak >= LOOP_THRESHOLD ? streak : 0;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

async function main() {
  const rawInput = await readStdin();
  if (!rawInput.trim()) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    return;
  }

  const toolCall = payload.toolCall || {};
  const toolName = toolCall.name || '';
  const args = toolCall.args || {};
  const sessionId = payload.sessionId || payload.conversationId || 'default';

  const signature = JSON.stringify(args);
  const streak = recordAndCheckLoop(toolName, signature, sessionId);

  if (streak >= LOOP_THRESHOLD) {
    process.stdout.write(
      JSON.stringify({
        decision: 'deny',
        reason: `[agent-observability loop-radar] Repetitive execution loop detected: '${toolName}' executed ${streak} consecutive times with identical arguments. Please adjust strategy or verify parameters.`,
      }) + '\n'
    );
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
}

main().catch(() => {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
});
