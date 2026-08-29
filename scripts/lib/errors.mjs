import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function errorLogPath(dataDir) {
  return path.join(dataDir, 'logs', 'errors.jsonl');
}

export function sanitizeErrorText(value) {
  return String(value || 'Unknown error')
    .replace(/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(?:bearer|token|authorization)\s*[:=]?\s*\S+/gi, '$1 [REDACTED]')
    .replace(/[A-Z]:\\(?:[^\\\s]+\\)*[^\s]*/gi, '[REDACTED_PATH]')
    .replace(/\/(?:Users|home)\/[^\s]+/g, '[REDACTED_PATH]')
    .replace(/https?:\/\/[^\s]+/gi, '[REDACTED_URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .slice(0, 500);
}

async function appendEvent(dataDir, event) {
  const file = errorLogPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  return event;
}

export function classifyError(error) {
  const code = error?.code || 'UNEXPECTED_ERROR';
  const contentCodes = new Set(['PLAN_INVALID', 'REVIEW_REJECTED', 'PII_DETECTED', 'REVIEW_EXHAUSTED']);
  return { code, retryableContent: contentCodes.has(code), sandboxDenied: code === 'SANDBOX_DENIED' };
}

export async function logError(dataDir, details) {
  return appendEvent(dataDir, {
    type: 'error',
    errorId: details.errorId || crypto.randomUUID(),
    sessionId: details.sessionId || null,
    turnId: details.turnId || null,
    updateRunId: details.updateRunId || null,
    stage: details.stage || 'unknown',
    errorCode: details.errorCode || 'UNEXPECTED_ERROR',
    message: sanitizeErrorText(details.message),
    handled: false,
    timestamp: new Date().toISOString()
  });
}

export async function resolveError(dataDir, errorId, resolution = 'Acknowledged by user') {
  if (!errorId) throw Object.assign(new Error('errorId is required'), { code: 'ERROR_ID_REQUIRED' });
  return appendEvent(dataDir, {
    type: 'error_resolved',
    errorId,
    resolution: sanitizeErrorText(resolution),
    timestamp: new Date().toISOString()
  });
}

export async function unresolvedErrors(dataDir, { sessionId, all = false, limit = 20 } = {}) {
  let raw;
  try {
    raw = await fs.readFile(errorLogPath(dataDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const open = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'error') open.set(event.errorId, event);
    if (event.type === 'error_resolved') open.delete(event.errorId);
  }
  return [...open.values()]
    .filter(event => all || !sessionId || event.sessionId === sessionId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, limit)
    .map(({ errorId, sessionId: ownerSession, stage, errorCode, message, timestamp }) => ({
      errorId,
      sessionId: ownerSession,
      stage,
      errorCode,
      message,
      timestamp
    }));
}
