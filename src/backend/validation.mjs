import { validateContentLanguage } from './language.mjs';

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

function validateLanguage(text, language, prefix) {
  return validateContentLanguage(text, language).map(error => `${prefix} ${error}.`);
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
  existingPlan = { updates: [] },
  statusRules = null,
  terminalStatuses = []
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
    const contentLanguage = item?.contentLanguage || 'en';
    if (terminalStatuses.includes(item?.status)) {
      errors.push(`${prefix} targets an item whose remote Project status is terminal.`);
    }
    if (!update.status && !update.summary && !update.body && !update.comment) {
      errors.push(`${prefix} must change status, summary, body, or comment.`);
    }
    if (update.status && !allowedStatusNames.has(update.status)) errors.push(`${prefix}.status is not allowed.`);
    if (update.status && item?.status && update.status !== item.status &&
        existingById.get(update.itemId)?.status !== update.status) {
      const transition = statusRules?.transitions?.find(rule =>
        rule.from === item.status && rule.to === update.status);
      if (!transition) {
        errors.push(`${prefix}.status has no generated transition rule from ${item.status} to ${update.status}; run check.`);
      }
    }
    if (update.summary !== undefined) {
      if (typeof update.summary !== 'string' || !update.summary.trim()) errors.push(`${prefix}.summary must be non-empty text.`);
      const summary = String(update.summary || '');
      if ([...summary].length > maxCharacters) errors.push(`${prefix}.summary exceeds ${maxCharacters} characters.`);
      if (summary.trim().split(/\s+/).filter(Boolean).length > maxWords) errors.push(`${prefix}.summary exceeds ${maxWords} words.`);
      for (const sensitive of findSensitiveText(summary)) errors.push(`${prefix}.summary contains ${sensitive}.`);
      for (const narration of findControlPlaneNarration(summary)) {
        errors.push(`${prefix}.summary contains transient Mineprogress control-plane narration (${narration}).`);
      }
      if (existingById.get(update.itemId)?.summary !== update.summary) {
        errors.push(...validateLanguage(summary, contentLanguage, `${prefix}.summary`));
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
        if (!carriedProposal) errors.push(...validateLanguage(update.body, contentLanguage, `${prefix}.body`));
      } else if (item?.contentType === 'draft') {
        if (item.proposalWritable || carriedProposal) {
          errors.push(...validateOptionalText(update.body, `${prefix}.body`, maxBodyCharacters, { format: 'proposal' }));
          if (!carriedProposal) errors.push(...validateLanguage(update.body, contentLanguage, `${prefix}.body`));
        } else {
          const requiredPrefix = existing?.body || item.body || '';
          if ([...update.body].length > maxBodyCharacters) {
            errors.push(`${prefix}.body exceeds ${maxBodyCharacters} characters.`);
          }
          if (!update.body.startsWith(requiredPrefix) || update.body === requiredPrefix) {
            errors.push(`${prefix}.body may only append to the exact Draft body.`);
          } else {
            const appended = update.body.slice(requiredPrefix.length).trim();
            errors.push(...validateOptionalText(appended, `${prefix}.body append`, maxBodyCharacters, { format: 'progress' }));
            errors.push(...validateLanguage(appended, contentLanguage, `${prefix}.body append`));
          }
        }
      } else {
        errors.push(...validateOptionalText(update.body, `${prefix}.body`, maxBodyCharacters));
        errors.push(...validateLanguage(update.body, contentLanguage, `${prefix}.body`));
      }
    }
    errors.push(...validateOptionalText(update.comment, `${prefix}.comment`, maxCommentCharacters, { format: 'progress' }));
    if (update.comment) {
      const pendingComment = existing?.comment;
      const newCommentText = pendingComment && update.comment.startsWith(pendingComment)
        ? update.comment.slice(pendingComment.length)
        : update.comment;
      errors.push(...validateLanguage(newCommentText, contentLanguage, `${prefix}.comment`));
    }
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
    const updatesById = new Map(plan.updates.map(update => [update.itemId, update]));
    for (const item of normalizedBoundItems) {
      const targetStatus = item.statusIntent?.targetStatus;
      if (!targetStatus) continue;
      const terminalIssueOpen = terminalStatuses.includes(targetStatus) &&
        item.contentType === 'issue' && item.contentState !== 'CLOSED';
      if ((item.status !== targetStatus || terminalIssueOpen) && updatesById.get(item.itemId)?.status !== targetStatus) {
        errors.push(`updates for ${item.itemId} must satisfy the durable status intent ${targetStatus}.`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function normalizedPlanUpdates(plan) {
  return new Map((plan?.updates || []).map(update => [update.itemId, Object.fromEntries(
    [...ITEM_KEYS].filter(key => key in update && (key === 'itemId' || update[key] !== null))
      .map(key => [key, update[key]])
  )]));
}

function changedPlanItemIds(proposedPlan, existingPlan) {
  const proposed = normalizedPlanUpdates(proposedPlan);
  const existing = normalizedPlanUpdates(existingPlan);
  return new Set([...new Set([...proposed.keys(), ...existing.keys()])].filter(itemId =>
    JSON.stringify(proposed.get(itemId) || null) !== JSON.stringify(existing.get(itemId) || null)));
}

export function validateReview(review, {
  journalEvents = [],
  proposedPlan = { updates: [] },
  existingPlan = { updates: [] },
  boundItemIds = [],
  requireCoverage = false,
  useThreadHistory = false
} = {}) {
  const errors = [];
  if (!review || typeof review !== 'object' || Array.isArray(review)) {
    return { valid: false, errors: ['Review must be an object.'] };
  }
  for (const key of Object.keys(review)) {
    if (!['decision', 'reason', 'journalCoverage'].includes(key)) errors.push(`Review has forbidden field: ${key}.`);
  }
  if (!['approve', 'reject'].includes(review.decision)) errors.push('Review decision must be approve or reject.');
  if (typeof review.reason !== 'string' || !review.reason.trim()) errors.push('Review reason must be non-empty text.');
  if (!requireCoverage && review.journalCoverage === undefined) return { valid: errors.length === 0, errors };
  if (!Array.isArray(review.journalCoverage)) {
    errors.push('Review journalCoverage must be an array.');
    return { valid: false, errors };
  }

  const expected = new Set(journalEvents.map(event => event.sequence));
  const bound = new Set(boundItemIds);
  const changed = changedPlanItemIds(proposedPlan, existingPlan);
  const representedChanges = new Set();
  const seen = new Set();
  for (const [index, entry] of review.journalCoverage.entries()) {
    const prefix = `journalCoverage[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!['sequence', 'disposition', 'itemIds', 'reason'].includes(key)) errors.push(`${prefix} has forbidden field: ${key}.`);
    }
    if (!Number.isInteger(entry.sequence) || !expected.has(entry.sequence)) {
      errors.push(`${prefix}.sequence is not in the active journal batch.`);
    }
    if (seen.has(entry.sequence)) errors.push(`${prefix}.sequence is duplicated.`);
    seen.add(entry.sequence);
    if (!['included', 'irrelevant', 'missing'].includes(entry.disposition)) {
      errors.push(`${prefix}.disposition must be included, irrelevant, or missing.`);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 12 || entry.reason.trim().length > 500) {
      errors.push(`${prefix}.reason must contain a specific 12-500 character explanation.`);
    }
    if (!Array.isArray(entry.itemIds) || new Set(entry.itemIds).size !== entry.itemIds?.length ||
        entry.itemIds?.some(itemId => typeof itemId !== 'string' || !bound.has(itemId))) {
      errors.push(`${prefix}.itemIds must contain unique bound item ids.`);
      continue;
    }
    if (entry.disposition === 'included') {
      if (!entry.itemIds.length) errors.push(`${prefix}.itemIds must identify the changed item for included evidence.`);
      for (const itemId of entry.itemIds) {
        representedChanges.add(itemId);
        if (!changed.has(itemId)) errors.push(`${prefix} claims inclusion in unchanged item ${itemId}.`);
      }
    } else if (entry.itemIds.length) {
      errors.push(`${prefix}.itemIds must be empty unless disposition is included.`);
    }
    if (review.decision === 'approve' && entry.disposition === 'missing') {
      errors.push(`${prefix} marks durable evidence as missing from an approved plan.`);
    }
  }
  if (seen.size !== expected.size || [...expected].some(sequence => !seen.has(sequence))) {
    errors.push('Review must classify every journal entry in the active batch exactly once.');
  }
  if (review.decision === 'approve' && journalEvents.length && !useThreadHistory) {
    for (const itemId of changed) {
      if (!representedChanges.has(itemId)) errors.push(`Changed item ${itemId} is not linked to included journal evidence.`);
    }
  }
  return { valid: errors.length === 0, errors };
}
