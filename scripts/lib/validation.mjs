const ITEM_KEYS = new Set(['itemId', 'status', 'summary', 'body', 'comment']);
const PLAN_KEYS = new Set(['updates']);
const UPDATE_FIELDS = ['status', 'summary', 'body', 'comment'];

export const MANAGED_BODY_START = '<!-- mineprogress:managed:start -->';
export const MANAGED_BODY_END = '<!-- mineprogress:managed:end -->';

export function findSensitiveText(text) {
  const checks = [
    ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ['absolute Windows path', /\b[A-Z]:\\[^\s]+/i],
    ['home path', /\/(?:Users|home)\/[^\s]+/],
    ['GitHub token', /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/]
  ];
  return checks.filter(([, expression]) => expression.test(text)).map(([label]) => label);
}

export function findControlPlaneNarration(text) {
  const checks = [
    ['generation attempt', /\bgeneration attempt\s+\d+\b/i],
    ['review wait state', /\b(?:awaiting|pending)\s+(?:reviewer|review)(?:\s+approval)?\b/i],
    ['review execution state', /\b(?:reviewer|generator)\s+(?:is\s+)?(?:running|pending|approved|rejected)\b/i],
    ['static-check execution state', /\bstatic (?:checks?|validation)\s+(?:passed|failed|succeeded|is valid)\b/i],
    ['update-run narration', /\bthis (?:generation|review|update)\s+(?:run|round|attempt)\b/i]
  ];
  return checks.filter(([, expression]) => expression.test(text)).map(([label]) => label);
}

function validateHistoricalProgress(body, prefix) {
  const errors = [];
  const start = body.indexOf(MANAGED_BODY_START);
  const end = body.indexOf(MANAGED_BODY_END, start + MANAGED_BODY_START.length);
  if (start < 0 || end < 0) {
    errors.push(`${prefix} must contain both Mineprogress managed-section markers.`);
    return errors;
  }
  if (body.indexOf(MANAGED_BODY_START, start + 1) >= 0 || body.indexOf(MANAGED_BODY_END, end + 1) >= 0) {
    errors.push(`${prefix} must contain exactly one Mineprogress managed section.`);
  }
  const managed = body.slice(start + MANAGED_BODY_START.length, end);
  if (!/^## Historical Progress\s*$/mu.test(managed)) {
    errors.push(`${prefix} must contain a Historical Progress section.`);
  }
  if (/^## Current Progress\s*$/imu.test(managed)) {
    errors.push(`${prefix} must not contain a Current Progress section.`);
  }
  const segments = [...managed.matchAll(/^### (\d{4}-\d{2}-\d{2})\s+[—-]\s+.+$/gmu)];
  if (!segments.length) errors.push(`${prefix} must contain at least one dated history segment.`);
  let previous = '';
  for (const [index, segment] of segments.entries()) {
    const date = segment[1];
    if (previous && date < previous) errors.push(`${prefix} history segments must be chronological.`);
    previous = date;
    const start = segment.index + segment[0].length;
    const segmentEnd = segments[index + 1]?.index ?? managed.length;
    const content = managed.slice(start, segmentEnd);
    if (!/^#### Requirements\s*$/mu.test(content)) errors.push(`${prefix} segment ${date} is missing Requirements.`);
    if (!/^#### Results\s*$/mu.test(content)) errors.push(`${prefix} segment ${date} is missing Results.`);
  }
  return errors;
}

function preservesManualBody(existing, proposed) {
  if (!existing) return true;
  const oldStart = existing.indexOf(MANAGED_BODY_START);
  const oldEnd = existing.indexOf(MANAGED_BODY_END, oldStart + MANAGED_BODY_START.length);
  if (oldStart < 0 || oldEnd < 0) return proposed.startsWith(existing);
  const newStart = proposed.indexOf(MANAGED_BODY_START);
  const newEnd = proposed.indexOf(MANAGED_BODY_END, newStart + MANAGED_BODY_START.length);
  if (newStart < 0 || newEnd < 0) return false;
  return existing.slice(0, oldStart) === proposed.slice(0, newStart) &&
    existing.slice(oldEnd + MANAGED_BODY_END.length) === proposed.slice(newEnd + MANAGED_BODY_END.length);
}

function validateOptionalText(value, prefix, maxCharacters, { historical = false } = {}) {
  const errors = [];
  if (value === undefined || value === null) return errors;
  if (typeof value !== 'string' || !value.trim()) return [`${prefix} must be non-empty text or null.`];
  if ([...value].length > maxCharacters) errors.push(`${prefix} exceeds ${maxCharacters} characters.`);
  for (const sensitive of findSensitiveText(value)) errors.push(`${prefix} contains ${sensitive}.`);
  for (const narration of findControlPlaneNarration(value)) {
    errors.push(`${prefix} contains transient Mineprogress control-plane narration (${narration}).`);
  }
  if (historical) errors.push(...validateHistoricalProgress(value, prefix));
  return errors;
}

function requiredPendingLines(body) {
  const start = body.indexOf(MANAGED_BODY_START);
  const end = body.indexOf(MANAGED_BODY_END, start + MANAGED_BODY_START.length);
  if (start < 0 || end < 0) return [];
  return body.slice(start + MANAGED_BODY_START.length, end)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean);
}

function validatePendingPreservation(plan, existingPlan, allowedIds) {
  const errors = [];
  const proposed = new Map((plan.updates || []).map(update => [update.itemId, update]));
  for (const existing of existingPlan?.updates || []) {
    if (!allowedIds.has(existing.itemId)) continue;
    const next = proposed.get(existing.itemId);
    if (!next) {
      errors.push(`updates must preserve pending item ${existing.itemId} until submission is confirmed.`);
      continue;
    }
    for (const field of UPDATE_FIELDS) {
      if (existing[field] !== undefined && existing[field] !== null &&
          (next[field] === undefined || next[field] === null)) {
        errors.push(`updates for ${existing.itemId} drop pending ${field}.`);
      }
    }
    if (existing.comment && next.comment !== existing.comment) {
      errors.push(`updates for ${existing.itemId} must preserve the pending comment verbatim.`);
    }
    if (existing.body && next.body) {
      for (const line of requiredPendingLines(existing.body)) {
        if (!next.body.includes(line)) {
          errors.push(`updates for ${existing.itemId} drop approved managed-body content: ${line.slice(0, 80)}.`);
          break;
        }
      }
    }
  }
  return errors;
}

export function validatePlan(plan, {
  boundItemIds,
  boundItems,
  allowedStatuses,
  maxCharacters = 500,
  maxWords = 80,
  maxBodyCharacters = 60000,
  maxCommentCharacters = 10000,
  existingPlan = { updates: [] }
}) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: ['Plan must be a JSON object.'] };
  for (const key of Object.keys(plan)) if (!PLAN_KEYS.has(key)) errors.push(`Unexpected plan field: ${key}.`);
  if (!Array.isArray(plan.updates)) errors.push('updates must be an array.');
  const normalizedBoundItems = boundItems || (boundItemIds || []).map(itemId => ({ itemId }));
  const itemsById = new Map(normalizedBoundItems.map(item => [item.itemId, item]));
  const allowedIds = new Set(itemsById.keys());
  const allowedStatusNames = new Set(allowedStatuses);
  const seen = new Set();
  for (const [index, update] of (Array.isArray(plan.updates) ? plan.updates : []).entries()) {
    const prefix = `updates[${index}]`;
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    for (const key of Object.keys(update)) if (!ITEM_KEYS.has(key)) errors.push(`${prefix} has forbidden field: ${key}.`);
    if (!allowedIds.has(update.itemId)) errors.push(`${prefix}.itemId is not bound to this thread.`);
    if (seen.has(update.itemId)) errors.push(`${prefix}.itemId is duplicated.`);
    seen.add(update.itemId);
    const item = itemsById.get(update.itemId);
    if (!update.status && !update.summary && !update.body && !update.comment) {
      errors.push(`${prefix} must change status, summary, body, or comment.`);
    }
    if (update.status && !allowedStatusNames.has(update.status)) errors.push(`${prefix}.status is not allowed.`);
    if (update.summary !== undefined) {
      if (typeof update.summary !== 'string' || !update.summary.trim()) errors.push(`${prefix}.summary must be non-empty text.`);
      const summary = String(update.summary || '');
      if ([...summary].length > maxCharacters) errors.push(`${prefix}.summary exceeds ${maxCharacters} characters.`);
      if (summary.trim().split(/\s+/).filter(Boolean).length > maxWords) errors.push(`${prefix}.summary exceeds ${maxWords} words.`);
      for (const sensitive of findSensitiveText(summary)) errors.push(`${prefix}.summary contains ${sensitive}.`);
      for (const narration of findControlPlaneNarration(summary)) {
        errors.push(`${prefix}.summary contains transient Mineprogress control-plane narration (${narration}).`);
      }
    }
    errors.push(...validateOptionalText(update.body, `${prefix}.body`, maxBodyCharacters, { historical: true }));
    errors.push(...validateOptionalText(update.comment, `${prefix}.comment`, maxCommentCharacters));
    if (update.body && item?.contentType && !['issue', 'draft'].includes(item.contentType)) {
      errors.push(`${prefix}.body cannot update ${item.contentType} content.`);
    }
    if (update.body && item && !preservesManualBody(item.body || '', update.body)) {
      errors.push(`${prefix}.body changes content outside the managed section.`);
    }
    if (update.comment && item?.contentType && !['issue', 'pullRequest'].includes(item.contentType)) {
      errors.push(`${prefix}.comment cannot be added to ${item.contentType} content.`);
    }
  }
  if (Array.isArray(plan.updates)) {
    errors.push(...validatePendingPreservation(plan, existingPlan, allowedIds));
  }
  return { valid: errors.length === 0, errors };
}

export function validateReview(review) {
  const valid = review && typeof review === 'object' && ['approve', 'reject'].includes(review.decision) &&
    typeof review.reason === 'string' && Object.keys(review).every(key => ['decision', 'reason'].includes(key));
  return { valid: Boolean(valid), errors: valid ? [] : ['Review must contain only decision (approve|reject) and reason.'] };
}
