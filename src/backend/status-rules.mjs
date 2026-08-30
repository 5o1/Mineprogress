import crypto from 'node:crypto';

const RULE_KEYS = new Set(['statuses', 'transitions']);
const STATUS_KEYS = new Set(['name', 'enterWhen', 'doNotEnterWhen']);
const TRANSITION_KEYS = new Set(['from', 'to', 'when', 'doNotApplyWhen']);

function extraKeys(value, allowed) {
  return Object.keys(value || {}).filter(key => !allowed.has(key));
}

function boundedText(value) {
  return typeof value === 'string' && value.trim().length >= 12 && value.trim().length <= 500;
}

export function statusFingerprint(statuses) {
  const normalized = [...new Set(statuses || [])].sort();
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

export function validateStatusRules(value, {
  statuses = [],
  defaultStatus = ''
} = {}) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['Status rules must be an object.'] };
  }
  if (extraKeys(value, RULE_KEYS).length) errors.push('Status rules contain unsupported top-level fields.');
  if (!Array.isArray(value.statuses)) errors.push('statuses must be an array.');
  if (!Array.isArray(value.transitions)) errors.push('transitions must be an array.');
  if (errors.length) return { valid: false, errors };

  const available = new Set(statuses);
  const ruleNames = [];
  for (const [index, rule] of value.statuses.entries()) {
    const prefix = `statuses[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (extraKeys(rule, STATUS_KEYS).length) errors.push(`${prefix} contains unsupported fields.`);
    if (!available.has(rule.name)) errors.push(`${prefix}.name must be an exact available status.`);
    if (!boundedText(rule.enterWhen)) errors.push(`${prefix}.enterWhen must contain a specific 12-500 character boundary.`);
    if (!boundedText(rule.doNotEnterWhen)) errors.push(`${prefix}.doNotEnterWhen must contain a specific 12-500 character boundary.`);
    ruleNames.push(rule.name);
  }
  if (ruleNames.length !== statuses.length || new Set(ruleNames).size !== statuses.length ||
      statuses.some(status => !ruleNames.includes(status))) {
    errors.push('statuses must describe every available status exactly once.');
  }

  const edges = new Map(statuses.map(status => [status, []]));
  const transitionKeys = new Set();
  for (const [index, transition] of value.transitions.entries()) {
    const prefix = `transitions[${index}]`;
    if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (extraKeys(transition, TRANSITION_KEYS).length) errors.push(`${prefix} contains unsupported fields.`);
    if (!available.has(transition.from) || !available.has(transition.to)) {
      errors.push(`${prefix} must connect exact available statuses.`);
    }
    if (transition.from === transition.to) errors.push(`${prefix} cannot be a self-transition.`);
    if (!boundedText(transition.when)) errors.push(`${prefix}.when must contain a specific 12-500 character boundary.`);
    if (!boundedText(transition.doNotApplyWhen)) errors.push(`${prefix}.doNotApplyWhen must contain a specific 12-500 character boundary.`);
    const key = `${transition.from}\u0000${transition.to}`;
    if (transitionKeys.has(key)) errors.push(`${prefix} duplicates another transition.`);
    transitionKeys.add(key);
    if (edges.has(transition.from) && available.has(transition.to)) edges.get(transition.from).push(transition.to);
  }

  if (!available.has(defaultStatus)) {
    errors.push('The synchronized default status is unavailable.');
  } else {
    const reachable = new Set([defaultStatus]);
    const queue = [defaultStatus];
    while (queue.length) {
      for (const target of edges.get(queue.shift()) || []) {
        if (!reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
    const unreachable = statuses.filter(status => !reachable.has(status));
    if (unreachable.length) errors.push(`Every status must be reachable from ${defaultStatus}; unreachable: ${unreachable.join(', ')}.`);
  }
  return { valid: errors.length === 0, errors };
}

export function storedStatusRules(value, statuses) {
  return {
    fingerprint: statusFingerprint(statuses),
    generatedAt: new Date().toISOString(),
    statuses: value.statuses,
    transitions: value.transitions
  };
}

export function statusRuleLines(rules) {
  if (!rules) return ['Status rules: unavailable; run check to synchronize and generate them.'];
  return [
    ...rules.statuses.map(rule =>
      `Status ${rule.name}: enter when ${rule.enterWhen} Do not enter when ${rule.doNotEnterWhen}`),
    ...rules.transitions.map(rule =>
      `Transition ${rule.from} -> ${rule.to}: ${rule.when} Do not apply when ${rule.doNotApplyWhen}`)
  ];
}
