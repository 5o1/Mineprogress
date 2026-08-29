const ITEM_KEYS = new Set(['itemId', 'status', 'summary']);
const PLAN_KEYS = new Set(['updates']);

export function findSensitiveText(text) {
  const checks = [
    ['email', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
    ['absolute Windows path', /\b[A-Z]:\\[^\s]+/i],
    ['home path', /\/(?:Users|home)\/[^\s]+/],
    ['GitHub token', /\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/]
  ];
  return checks.filter(([, expression]) => expression.test(text)).map(([label]) => label);
}

export function validatePlan(plan, { boundItemIds, allowedStatuses, maxCharacters = 500, maxWords = 80 }) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, errors: ['Plan must be a JSON object.'] };
  for (const key of Object.keys(plan)) if (!PLAN_KEYS.has(key)) errors.push(`Unexpected plan field: ${key}.`);
  if (!Array.isArray(plan.updates)) errors.push('updates must be an array.');
  const allowedIds = new Set(boundItemIds);
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
    if (!update.status && !update.summary) errors.push(`${prefix} must change status or summary.`);
    if (update.status && !allowedStatusNames.has(update.status)) errors.push(`${prefix}.status is not allowed.`);
    if (update.summary !== undefined) {
      if (typeof update.summary !== 'string' || !update.summary.trim()) errors.push(`${prefix}.summary must be non-empty text.`);
      const summary = String(update.summary || '');
      if ([...summary].length > maxCharacters) errors.push(`${prefix}.summary exceeds ${maxCharacters} characters.`);
      if (summary.trim().split(/\s+/).filter(Boolean).length > maxWords) errors.push(`${prefix}.summary exceeds ${maxWords} words.`);
      for (const sensitive of findSensitiveText(summary)) errors.push(`${prefix}.summary contains ${sensitive}.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateReview(review) {
  const valid = review && typeof review === 'object' && ['approve', 'reject'].includes(review.decision) &&
    typeof review.reason === 'string' && Object.keys(review).every(key => ['decision', 'reason'].includes(key));
  return { valid: Boolean(valid), errors: valid ? [] : ['Review must contain only decision (approve|reject) and reason.'] };
}
