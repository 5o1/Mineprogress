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

const PROPOSAL_SECTIONS = [
  'Abstract',
  'Background and Significance',
  'Problem Statement',
  'Objectives',
  'Scope and Research Questions',
  'Methodology and Technical Approach',
  'Expected Deliverables and Evaluation Criteria',
  'Work Plan and Milestones',
  'Risks, Constraints, and Security'
];

function managedSection(body, prefix) {
  const errors = [];
  const start = body.indexOf(MANAGED_BODY_START);
  const end = body.indexOf(MANAGED_BODY_END, start + MANAGED_BODY_START.length);
  if (start < 0 || end < 0) {
    errors.push(`${prefix} must contain both Mineprogress managed-section markers.`);
    return { errors, managed: '' };
  }
  if (body.indexOf(MANAGED_BODY_START, start + 1) >= 0 || body.indexOf(MANAGED_BODY_END, end + 1) >= 0) {
    errors.push(`${prefix} must contain exactly one Mineprogress managed section.`);
  }
  return { errors, managed: body.slice(start + MANAGED_BODY_START.length, end) };
}

function validateProposal(body, prefix) {
  const { errors, managed } = managedSection(body, prefix);
  if (!managed) return errors;
  if (/^## Historical Progress\s*$/imu.test(managed)) {
    errors.push(`${prefix} must not store Historical Progress in the proposal body.`);
  }
  let previous = -1;
  for (const section of PROPOSAL_SECTIONS) {
    const expression = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mu');
    const match = expression.exec(managed);
    if (!match) {
      errors.push(`${prefix} is missing proposal section: ${section}.`);
      continue;
    }
    if (match.index <= previous) errors.push(`${prefix} proposal sections must use the required order.`);
    previous = match.index;
    const contentStart = match.index + match[0].length;
    const nextHeading = managed.slice(contentStart).search(/^## /mu);
    const content = managed.slice(contentStart, nextHeading < 0 ? undefined : contentStart + nextHeading).trim();
    if (!content) errors.push(`${prefix} proposal section ${section} must not be empty.`);
  }
  return errors;
}

function validateProgressUpdate(text, prefix) {
  const errors = [];
  if (!/^## Progress Update\s+[—-]\s+\d{4}-\d{2}-\d{2}(?:\s+[—-]\s+.+)?\s*$/mu.test(text)) {
    errors.push(`${prefix} must start with a dated Progress Update heading.`);
  }
  const requirements = /^### Requirements\s*$/mu.exec(text);
  const results = /^### Results\s*$/mu.exec(text);
  if (!requirements) errors.push(`${prefix} is missing Requirements.`);
  if (!results) errors.push(`${prefix} is missing Results.`);
  if (requirements && results && requirements.index >= results.index) {
    errors.push(`${prefix} must place Requirements before Results.`);
  }
  for (const [name, match, next] of [
    ['Requirements', requirements, results],
    ['Results', results, null]
  ]) {
    if (!match) continue;
    const start = match.index + match[0].length;
    const content = text.slice(start, next?.index ?? text.length).trim();
    if (!content) errors.push(`${prefix} ${name} must not be empty.`);
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

function validateOptionalText(value, prefix, maxCharacters, { format = null } = {}) {
  const errors = [];
  if (value === undefined || value === null) return errors;
  if (typeof value !== 'string' || !value.trim()) return [`${prefix} must be non-empty text or null.`];
  if ([...value].length > maxCharacters) errors.push(`${prefix} exceeds ${maxCharacters} characters.`);
  for (const sensitive of findSensitiveText(value)) errors.push(`${prefix} contains ${sensitive}.`);
  for (const narration of findControlPlaneNarration(value)) {
    errors.push(`${prefix} contains transient Mineprogress control-plane narration (${narration}).`);
  }
  if (format === 'proposal') errors.push(...validateProposal(value, prefix));
  if (format === 'progress') errors.push(...validateProgressUpdate(value, prefix));
  return errors;
}

function validatePendingPreservation(plan, existingPlan, allowedIds, itemsById) {
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
    if (existing.comment && !next.comment?.startsWith(existing.comment)) {
      errors.push(`updates for ${existing.itemId} must preserve the pending comment as an exact prefix.`);
    }
    if (existing.body && next.body) {
      const item = itemsById.get(existing.itemId);
      const preserved = item?.contentType === 'draft'
        ? next.body.startsWith(existing.body)
        : next.body === existing.body;
      if (!preserved) {
        errors.push(`updates for ${existing.itemId} alter a pending immutable body.`);
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
  const existingById = new Map((existingPlan?.updates || []).map(update => [update.itemId, update]));
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
    const existing = existingById.get(update.itemId);
    if (update.body !== undefined && update.body !== null) {
      const carriedProposal = Boolean(existing?.body && update.body === existing.body && item?.pendingBodyKind === 'proposalBody');
      if (item?.contentType === 'issue') {
        if (!item.proposalWritable && !carriedProposal) {
          errors.push(`${prefix}.body is immutable after the initial created-item proposal.`);
        }
        errors.push(...validateOptionalText(update.body, `${prefix}.body`, maxBodyCharacters, { format: 'proposal' }));
      } else if (item?.contentType === 'draft') {
        if (item.proposalWritable || carriedProposal) {
          errors.push(...validateOptionalText(update.body, `${prefix}.body`, maxBodyCharacters, { format: 'proposal' }));
        } else {
          const requiredPrefix = existing?.body || item.body || '';
          if ([...update.body].length > maxBodyCharacters) {
            errors.push(`${prefix}.body exceeds ${maxBodyCharacters} characters.`);
          }
          if (!update.body.startsWith(requiredPrefix) || update.body === requiredPrefix) {
            errors.push(`${prefix}.body may only append to the exact Draft body.`);
          } else {
            errors.push(...validateOptionalText(update.body.slice(requiredPrefix.length).trim(), `${prefix}.body append`, maxBodyCharacters, { format: 'progress' }));
          }
        }
      } else {
        errors.push(...validateOptionalText(update.body, `${prefix}.body`, maxBodyCharacters));
      }
    }
    errors.push(...validateOptionalText(update.comment, `${prefix}.comment`, maxCommentCharacters, { format: 'progress' }));
    if (update.body && item?.contentType && !['issue', 'draft'].includes(item.contentType)) {
      errors.push(`${prefix}.body cannot update ${item.contentType} content.`);
    }
    if (update.body && item && (item.contentType !== 'draft' || item.proposalWritable) &&
        !preservesManualBody(item.body || '', update.body)) {
      errors.push(`${prefix}.body changes content outside the managed section.`);
    }
    if (update.comment && item?.contentType && !['issue', 'pullRequest'].includes(item.contentType)) {
      errors.push(`${prefix}.comment cannot be added to ${item.contentType} content.`);
    }
  }
  if (Array.isArray(plan.updates)) {
    errors.push(...validatePendingPreservation(plan, existingPlan, allowedIds, itemsById));
  }
  return { valid: errors.length === 0, errors };
}

export function validateReview(review) {
  const valid = review && typeof review === 'object' && ['approve', 'reject'].includes(review.decision) &&
    typeof review.reason === 'string' && Object.keys(review).every(key => ['decision', 'reason'].includes(key));
  return { valid: Boolean(valid), errors: valid ? [] : ['Review must contain only decision (approve|reject) and reason.'] };
}
