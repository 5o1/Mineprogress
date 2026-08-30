import crypto from 'node:crypto';

export function statusFixture() {
  const suffix = crypto.randomUUID();
  return {
    queued: `fixture-queued-${suffix}`,
    active: `fixture-active-${suffix}`,
    review: `fixture-review-${suffix}`,
    blocked: `fixture-blocked-${suffix}`,
    terminal: `fixture-terminal-${suffix}`
  };
}
