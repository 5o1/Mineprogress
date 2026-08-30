import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';
import { calendarDate } from './calendar.mjs';
import { normalizeContentLanguage } from './language.mjs';
import { normalizePrimaryRepository } from './repository-reference.mjs';

const STATE_VERSION = 1;
const PLAN_FORMAT_VERSION = 5;
const UPDATE_PHASES = new Set(['claimed', 'prepared', 'staged', 'reviewed']);
const MAX_EVIDENCE_FACTS = 50;
const MAX_EVIDENCE_TEXT_CHARACTERS = 2000;
const MAX_PROCESSED_JOURNAL = 200;

export function statePath(dataDir, sessionId) {
  if (!sessionId) throw Object.assign(new Error('sessionId is required'), { code: 'SESSION_ID_REQUIRED' });
  const key = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(dataDir, 'threads', `${key}.json`);
}

export function newState(sessionId, now = new Date().toISOString()) {
  return {
    version: STATE_VERSION,
    planFormatVersion: PLAN_FORMAT_VERSION,
    sessionId,
    createdAt: now,
    updatedAt: now,
    lastEndedAt: null,
    dailySubmissionDate: calendarDate(now),
    boundItems: [],
    journal: [],
    controlTurnIds: [],
    pendingAuthorizations: [],
    nextSequence: 1,
    lastPlannedUpdate: null,
    lastSuccessfulUpdate: null,
    pendingPlan: null,
    activeUpdate: null,
    unverifiedEvidenceFacts: [],
    processedJournal: [],
    backgroundRequestedThrough: null,
    fullContextRequestedRevision: 0,
    fullContextPlannedRevision: 0
  };
}

function normalizeState(state) {
  const previousPlanFormat = state.planFormatVersion || 1;
  for (const item of state.boundItems || []) {
    item.bindingSource ||= 'bind';
    item.backfillRevision ??= 1;
    item.contentId ??= null;
    item.contentType ??= null;
    item.url ??= null;
    item.repository ??= null;
    item.proposalInitialized ??= item.bindingSource !== 'create';
    item.contentLanguage = normalizeContentLanguage(item.contentLanguage);
    item.primaryRepository = normalizePrimaryRepository(item.primaryRepository, item.title);
    item.evidenceLedger ||= { revision: 0, facts: [], recoveredAt: null };
    item.evidenceLedger.revision ??= 0;
    item.evidenceLedger.facts = normalizeEvidenceFacts(item.evidenceLedger.facts || []).slice(-MAX_EVIDENCE_FACTS);
    item.evidenceLedger.recoveredAt ??= null;
    item.statusIntentRevision ??= item.statusIntent?.revision || 0;
    item.statusIntent ??= null;
  }
  state.lastPlannedUpdate ??= state.lastSuccessfulUpdate || null;
  state.dailySubmissionDate ??= calendarDate(state.updatedAt || state.createdAt);
  state.pendingPlan ??= null;
  state.unverifiedEvidenceFacts = normalizeEvidenceFacts(state.unverifiedEvidenceFacts || []);
  state.processedJournal ??= [];
  state.backgroundRequestedThrough ??= null;
  if (state.fullContextRequestedRevision === undefined) {
    state.fullContextRequestedRevision = state.boundItems.length ? 1 : 0;
  }
  state.fullContextPlannedRevision ??= 0;
  if (previousPlanFormat < PLAN_FORMAT_VERSION) {
    if (!state.pendingPlan?.attempts?.length) state.pendingPlan = null;
    state.activeUpdate = null;
    if (state.boundItems.length) {
      const revision = (state.fullContextRequestedRevision || 0) + 1;
      for (const item of state.boundItems) item.backfillRevision = revision;
      state.fullContextRequestedRevision = revision;
    }
    state.planFormatVersion = PLAN_FORMAT_VERSION;
  }
  if (state.activeUpdate && state.fullContextRequestedRevision > state.fullContextPlannedRevision &&
      state.activeUpdate.fullContextRevision === undefined) {
    state.activeUpdate.useThreadHistory = true;
    state.activeUpdate.fullContextRevision = state.fullContextRequestedRevision;
  }
  if (state.activeUpdate) {
    state.activeUpdate.journalSequences ??= (state.journal || [])
      .filter(event => event.sequence > state.activeUpdate.fromSequence &&
        event.sequence <= state.activeUpdate.toSequence)
      .map(event => event.sequence);
    if (!UPDATE_PHASES.has(state.activeUpdate.phase)) {
      state.activeUpdate.phase = state.activeUpdate.approvedReview && state.activeUpdate.stagedPlan
        ? 'reviewed'
          : state.activeUpdate.stagedPlan ? 'staged'
          : state.activeUpdate.projectSnapshot ? 'prepared' : 'claimed';
    }
    if (state.activeUpdate.phase === 'reviewed') {
      const expected = state.activeUpdate.journalSequences;
      const covered = state.activeUpdate.approvedReview?.journalCoverage?.map(entry => entry.sequence);
      if (!Array.isArray(covered) || covered.length !== expected.length ||
          new Set(covered).size !== expected.length || expected.some(sequence => !covered.includes(sequence))) {
        state.activeUpdate.approvedReview = null;
        state.activeUpdate.phase = state.activeUpdate.stagedPlan ? 'staged' :
          state.activeUpdate.projectSnapshot ? 'prepared' : 'claimed';
      }
    }
  }
  return state;
}

export async function readState(dataDir, sessionId) {
  const file = statePath(dataDir, sessionId);
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state.version !== STATE_VERSION || state.sessionId !== sessionId) {
      throw Object.assign(new Error('Thread state is incompatible or belongs to another session'), { code: 'STATE_INVALID' });
    }
    return normalizeState(state);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeState(dataDir, state) {
  const file = statePath(dataDir, state.sessionId);
  state.updatedAt = new Date().toISOString();
  await atomicWriteFile(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

export async function openSession(dataDir, sessionId) {
  const existing = await readState(dataDir, sessionId);
  if (existing) return { state: existing, restored: true };
  const state = newState(sessionId);
  await writeState(dataDir, state);
  return { state, restored: false };
}

export function authorizeCommand(state, action, turnId) {
  if (!['create', 'bind', 'unbind', 'update_retry', 'status_resolve'].includes(action)) return false;
  state.pendingAuthorizations ||= [];
  if (state.pendingAuthorizations.some(entry => entry.action === action && entry.turnId === (turnId || null))) return true;
  state.pendingAuthorizations.push({ action, turnId: turnId || null, createdAt: new Date().toISOString() });
  state.pendingAuthorizations = state.pendingAuthorizations.slice(-20);
  return true;
}

export function requireCommandAuthorization(state, action, now = Date.now()) {
  state.pendingAuthorizations ||= [];
  const index = state.pendingAuthorizations.findIndex(entry =>
    entry.action === action && now - Date.parse(entry.createdAt) <= 10 * 60 * 1000);
  if (index < 0) {
    throw Object.assign(new Error(`${action} requires an explicit current Mineprogress user command.`), { code: 'USER_AUTHORIZATION_REQUIRED' });
  }
  return () => state.pendingAuthorizations.splice(index, 1);
}

export function appendJournal(state, { kind, turnId, text, control = false }) {
  const normalized = String(text || '').trim();
  if (!normalized || control) return null;
  const event = {
    sequence: state.nextSequence++,
    kind,
    turnId: turnId || null,
    text: normalized,
    timestamp: new Date().toISOString()
  };
  state.journal.push(event);
  return event;
}

export function markControlTurn(state, turnId) {
  state.controlTurnIds ||= [];
  if (turnId && !state.controlTurnIds.includes(turnId)) state.controlTurnIds.push(turnId);
  state.controlTurnIds = state.controlTurnIds.slice(-50);
}

export function isControlTurn(state, turnId) {
  return Boolean(turnId && state.controlTurnIds?.includes(turnId));
}

export function bindItem(state, item, {
  source = 'bind',
  contentLanguage = 'en',
  primaryRepository = null
} = {}) {
  const normalizedLanguage = normalizeContentLanguage(contentLanguage);
  const normalizedRepository = normalizePrimaryRepository(primaryRepository, item.title);
  const existing = state.boundItems.find(bound => bound.itemId === item.itemId);
  if (existing) {
    let changed = false;
    if (existing.contentLanguage !== normalizedLanguage) {
      existing.contentLanguage = normalizedLanguage;
      changed = true;
    }
    if (normalizedRepository && JSON.stringify(existing.primaryRepository) !== JSON.stringify(normalizedRepository)) {
      existing.primaryRepository = normalizedRepository;
      changed = true;
    }
    return changed;
  }
  const backfillRevision = (state.fullContextRequestedRevision || 0) + 1;
  state.boundItems.push({
    itemId: item.itemId,
    title: item.title || null,
    contentId: item.contentId || null,
    contentType: item.contentType || item.kind || null,
    url: item.url || item.issueUrl || null,
    repository: item.repository || null,
    proposalInitialized: source !== 'create',
    contentLanguage: normalizedLanguage,
    primaryRepository: normalizedRepository,
    bindingSource: source,
    evidenceLedger: { revision: 0, facts: [], recoveredAt: null },
    statusIntentRevision: 0,
    statusIntent: null,
    backfillRevision,
    boundAt: new Date().toISOString()
  });
  state.fullContextRequestedRevision = backfillRevision;
  state.fullContextPlannedRevision ??= 0;
  return true;
}

export function unbindItem(state, itemId) {
  const before = state.boundItems.length;
  state.boundItems = state.boundItems.filter(item => item.itemId !== itemId);
  if (state.pendingPlan?.plan?.updates) {
    state.pendingPlan.plan.updates = state.pendingPlan.plan.updates.filter(update => update.itemId !== itemId);
    state.pendingPlan.operations = (state.pendingPlan.operations || []).filter(operation => operation.itemId !== itemId);
    if (!state.pendingPlan.plan.updates.length) state.pendingPlan = null;
  }
  return state.boundItems.length !== before;
}

export function pendingJournal(state) {
  const after = state.lastPlannedUpdate?.sequence || state.lastSuccessfulUpdate?.sequence || 0;
  return state.journal.filter(event => event.sequence > after);
}

export function needsFullContext(state) {
  return (state.fullContextRequestedRevision || 0) > (state.fullContextPlannedRevision || 0);
}

export function hasPendingPlanning(state) {
  return needsFullContext(state) || pendingJournal(state).length > 0;
}

export function beginUpdate(state, runId = crypto.randomUUID()) {
  if (state.activeUpdate) return state.activeUpdate;
  const events = pendingJournal(state);
  const useThreadHistory = needsFullContext(state);
  if (!events.length && !useThreadHistory) return null;
  const checkpoint = state.lastPlannedUpdate?.sequence || state.lastSuccessfulUpdate?.sequence || 0;
  const toSequence = events.at(-1)?.sequence || checkpoint;
  state.activeUpdate = {
    runId,
    phase: 'claimed',
    fromSequence: checkpoint,
    toSequence,
    journalSequences: events.map(event => event.sequence),
    useThreadHistory,
    fullContextRevision: useThreadHistory ? state.fullContextRequestedRevision : null,
    attempt: 0,
    stagedPlan: null,
    appliedOperations: [],
    startedAt: new Date().toISOString()
  };
  return state.activeUpdate;
}

function activeRun(state, runId) {
  if (!state.activeUpdate || state.activeUpdate.runId !== runId) {
    throw Object.assign(new Error('The update run is not active'), { code: 'UPDATE_RUN_MISMATCH' });
  }
  return state.activeUpdate;
}

export function recordPreparedUpdate(state, runId, { projectSnapshot, referenceLinks = [] }) {
  const run = activeRun(state, runId);
  if (!['claimed', 'prepared'].includes(run.phase)) {
    throw Object.assign(new Error(`Cannot prepare an update in phase ${run.phase}.`), { code: 'UPDATE_PHASE_INVALID' });
  }
  run.projectSnapshot = projectSnapshot;
  run.referenceLinks = referenceLinks;
  run.phase = 'prepared';
  return run;
}

export function recordStagedUpdate(state, runId, {
  plan,
  staticReport,
  proposalBodyItemIds = []
}) {
  const run = activeRun(state, runId);
  if (run.phase !== 'prepared') {
    throw Object.assign(new Error(`Cannot stage an update in phase ${run.phase}.`), { code: 'UPDATE_PHASE_INVALID' });
  }
  run.stagedPlan = plan;
  run.staticReport = staticReport;
  run.proposalBodyItemIds = proposalBodyItemIds;
  run.approvedReview = null;
  run.phase = 'staged';
  return run;
}

export function resetStagedUpdate(state, runId) {
  const run = activeRun(state, runId);
  run.stagedPlan = null;
  run.staticReport = null;
  run.proposalBodyItemIds = [];
  run.approvedReview = null;
  run.phase = run.projectSnapshot ? 'prepared' : 'claimed';
  return run;
}

export function recordReviewedUpdate(state, runId, review) {
  const run = activeRun(state, runId);
  if (run.phase !== 'staged' || !run.stagedPlan) {
    throw Object.assign(new Error(`Cannot review an update in phase ${run.phase}.`), { code: 'UPDATE_PHASE_INVALID' });
  }
  run.approvedReview = review;
  run.evidenceFacts = reviewedEvidenceFacts(state, run, review);
  run.phase = 'reviewed';
  return run;
}

function normalizeEvidenceFacts(facts) {
  const seen = new Set();
  const normalized = [];
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (!fact || typeof fact !== 'object' || typeof fact.itemId !== 'string' || typeof fact.factId !== 'string' ||
        typeof fact.text !== 'string' || !fact.text.trim() || seen.has(`${fact.itemId}:${fact.factId}`)) continue;
    seen.add(`${fact.itemId}:${fact.factId}`);
    normalized.push({
      itemId: fact.itemId,
      factId: fact.factId,
      source: String(fact.source || 'unknown'),
      text: [...fact.text.trim()].slice(0, MAX_EVIDENCE_TEXT_CHARACTERS).join(''),
      url: typeof fact.url === 'string' ? fact.url : null,
      timestamp: typeof fact.timestamp === 'string' ? fact.timestamp : null,
      sequence: Number.isInteger(fact.sequence) ? fact.sequence : null
    });
  }
  return normalized;
}

function reviewedEvidenceFacts(state, run, review) {
  const events = new Map((state.journal || []).map(event => [event.sequence, event]));
  const coveredItems = new Map();
  for (const entry of review.journalCoverage || []) {
    if (entry.disposition !== 'included') continue;
    for (const itemId of entry.itemIds || []) {
      const sequences = coveredItems.get(itemId) || [];
      sequences.push(entry.sequence);
      coveredItems.set(itemId, sequences);
    }
  }
  const facts = [];
  for (const update of run.stagedPlan?.updates || []) {
    const sequences = coveredItems.get(update.itemId);
    if (!sequences?.length) continue;
    const text = [
      update.status && `Status: ${update.status}`,
      update.summary && `Summary:\n${update.summary}`,
      update.body && `Body:\n${update.body}`,
      update.comment && `Progress:\n${update.comment}`
    ].filter(Boolean).join('\n');
    if (!text) continue;
    const digest = crypto.createHash('sha256')
      .update(`${update.itemId}\n${text}`)
      .digest('hex').slice(0, 20);
    const lastSequence = Math.max(...sequences);
    facts.push({
      itemId: update.itemId,
      factId: `reviewed-plan:${digest}`,
      source: 'reviewed-plan',
      text,
      url: null,
      timestamp: events.get(lastSequence)?.timestamp || null,
      sequence: lastSequence
    });
  }
  return normalizeEvidenceFacts(facts);
}

export function mergeEvidenceFacts(state, itemId, facts, { recoveredAt = null } = {}) {
  const binding = state.boundItems.find(item => item.itemId === itemId);
  if (!binding) return 0;
  binding.evidenceLedger ||= { revision: 0, facts: [], recoveredAt: null };
  const existing = normalizeEvidenceFacts(binding.evidenceLedger.facts || []);
  const additions = normalizeEvidenceFacts((facts || []).map(fact => ({ ...fact, itemId })));
  const existingIds = new Set(existing.map(fact => fact.factId));
  const unique = additions.filter(fact => !existingIds.has(fact.factId));
  if (unique.length) {
    binding.evidenceLedger.facts = [...existing, ...unique].slice(-MAX_EVIDENCE_FACTS);
    binding.evidenceLedger.revision = (binding.evidenceLedger.revision || 0) + 1;
  }
  if (recoveredAt) binding.evidenceLedger.recoveredAt = recoveredAt;
  return unique.length;
}

export function recordStatusIntent(state, itemId, targetStatus, sourceSequence, { role = null } = {}) {
  const binding = state.boundItems.find(item => item.itemId === itemId);
  if (!binding || !targetStatus) return false;
  if (binding.statusIntent?.targetStatus === targetStatus) {
    binding.statusIntent.sourceSequence ||= sourceSequence || null;
    binding.statusIntent.role ||= role;
    return false;
  }
  binding.statusIntentRevision = (binding.statusIntentRevision || 0) + 1;
  binding.statusIntent = {
    targetStatus,
    role,
    revision: binding.statusIntentRevision,
    sourceSequence: sourceSequence || null,
    createdAt: new Date().toISOString()
  };
  return true;
}

function planRevisionMap(state, field) {
  return Object.fromEntries(state.boundItems.map(binding => [binding.itemId,
    field === 'evidence' ? binding.evidenceLedger?.revision || 0 : binding.statusIntentRevision || 0]));
}

export function pendingPlanIsCurrent(state) {
  const pending = state.pendingPlan;
  if (!pending) return true;
  if (!pending.evidenceRevisions || !pending.intentRevisions) return Boolean(pending.attempts?.length);
  const evidence = planRevisionMap(state, 'evidence');
  const intents = planRevisionMap(state, 'intent');
  return Object.entries(evidence).every(([itemId, revision]) => pending.evidenceRevisions[itemId] === revision) &&
    Object.entries(intents).every(([itemId, revision]) => pending.intentRevisions[itemId] === revision);
}

export function retryExhaustedUpdate(state) {
  if (!state.activeUpdate?.exhausted) {
    throw Object.assign(new Error('The active update is not exhausted.'), { code: 'UPDATE_NOT_EXHAUSTED' });
  }
  state.activeUpdate = null;
  return beginUpdate(state);
}

export async function pruneStaleStates(dataDir, { retentionDays = 30, keepSessionId, now = Date.now() } = {}) {
  const directory = path.join(path.resolve(dataDir), 'threads');
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.resolve(directory, entry.name);
    if (path.dirname(file) !== path.resolve(directory)) continue;
    let state;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')); } catch { continue; }
    if (state.sessionId === keepSessionId || !state.lastEndedAt) continue;
    if (Date.parse(state.lastEndedAt) < cutoff) {
      await fs.unlink(file);
      removed++;
    }
  }
  return removed;
}

export function completeUpdate(state, runId) {
  const run = activeRun(state, runId);
  if (run.phase !== 'reviewed' || run.approvedReview?.decision !== 'approve') {
    throw Object.assign(new Error('Only a fully reviewed journal batch can advance its checkpoint.'), { code: 'UPDATE_PHASE_INVALID' });
  }
  const expected = run.journalSequences || [];
  const covered = (run.approvedReview.journalCoverage || []).map(entry => entry.sequence);
  if (covered.length !== expected.length || new Set(covered).size !== expected.length ||
      expected.some(sequence => !covered.includes(sequence))) {
    throw Object.assign(new Error('Every journal entry in the active batch must be reviewed before advancing.'), { code: 'JOURNAL_COVERAGE_INCOMPLETE' });
  }
  if (run.approvedReview.journalCoverage.some(entry => entry.disposition === 'missing')) {
    throw Object.assign(new Error('A journal batch with missing durable evidence cannot advance.'), { code: 'JOURNAL_COVERAGE_INCOMPLETE' });
  }
  const sequence = run.toSequence;
  if (run.fullContextRevision) {
    state.fullContextPlannedRevision = Math.max(
      state.fullContextPlannedRevision || 0,
      run.fullContextRevision
    );
  }
  state.processedJournal ||= [];
  state.processedJournal.push(...(run.approvedReview.journalCoverage || []).map(entry => {
    const event = state.journal.find(candidate => candidate.sequence === entry.sequence);
    return {
      sequence: entry.sequence,
      runId,
      disposition: entry.disposition,
      itemIds: [...(entry.itemIds || [])],
      reasonHash: crypto.createHash('sha256').update(String(entry.reason || '')).digest('hex').slice(0, 20),
      eventHash: event ? crypto.createHash('sha256').update(String(event.text || '')).digest('hex').slice(0, 20) : null,
      processedAt: new Date().toISOString()
    };
  }));
  state.processedJournal = state.processedJournal.slice(-MAX_PROCESSED_JOURNAL);
  if (!run.evidenceSecured && run.evidenceFacts?.length) {
    state.unverifiedEvidenceFacts = normalizeEvidenceFacts([
      ...state.unverifiedEvidenceFacts,
      ...run.evidenceFacts
    ]);
  }
  state.lastPlannedUpdate = { sequence, runId, completedAt: new Date().toISOString() };
  state.journal = state.journal.filter(event => event.sequence > sequence);
  state.activeUpdate = null;
}

export function storePendingPlan(state, runId, plan, submission, review, {
  satisfiedStatusIntents = []
} = {}) {
  const run = activeRun(state, runId);
  if (run.phase !== 'reviewed' || run.approvedReview?.decision !== 'approve') {
    throw Object.assign(new Error('Only a fully reviewed journal batch can be stored.'), { code: 'UPDATE_PHASE_INVALID' });
  }
  const expected = run.journalSequences || [];
  const covered = (run.approvedReview.journalCoverage || []).map(entry => entry.sequence);
  if (covered.length !== expected.length || new Set(covered).size !== expected.length ||
      expected.some(sequence => !covered.includes(sequence))) {
    throw Object.assign(new Error('Every journal entry must be reviewed before storing a plan.'), { code: 'JOURNAL_COVERAGE_INCOMPLETE' });
  }
  if (run.approvedReview.journalCoverage.some(entry => entry.disposition === 'missing')) {
    throw Object.assign(new Error('A journal batch with missing durable evidence cannot be stored.'), { code: 'JOURNAL_COVERAGE_INCOMPLETE' });
  }
  const sequence = run.toSequence;
  state.unverifiedEvidenceFacts ||= [];
  const evidenceFacts = normalizeEvidenceFacts([
    ...state.unverifiedEvidenceFacts,
    ...(state.pendingPlan?.evidenceFacts || []),
    ...(run.evidenceFacts || [])
  ]);
  state.unverifiedEvidenceFacts = [];
  run.evidenceSecured = true;
  const satisfied = satisfiedStatusIntents.map(intent => ({
    itemId: intent.itemId,
    targetStatus: intent.targetStatus,
    revision: intent.revision
  }));
  state.pendingPlan = submission.operations.length ? {
    plan,
    projectId: submission.projectId,
    operations: submission.operations,
    throughSequence: sequence,
    approvedAt: new Date().toISOString(),
    submissionStatus: 'ready',
    attempts: [],
    review: run.approvedReview,
    evidenceFacts,
    evidenceRevisions: planRevisionMap(state, 'evidence'),
    intentRevisions: planRevisionMap(state, 'intent'),
    satisfiedStatusIntents: satisfied
  } : null;
  if (!submission.operations.length) {
    for (const fact of evidenceFacts) mergeEvidenceFacts(state, fact.itemId, [fact]);
    for (const intent of satisfied) {
      const binding = state.boundItems.find(item => item.itemId === intent.itemId);
      if (binding?.statusIntent?.revision === intent.revision && binding.statusIntent.targetStatus === intent.targetStatus) {
        binding.statusIntent = null;
      }
    }
  }
  completeUpdate(state, runId);
  return state.pendingPlan;
}

export function beginSubmissionAttempt(state, operationKeys) {
  if (!state.pendingPlan) throw Object.assign(new Error('No reviewed plan is pending.'), { code: 'PLAN_NOT_PENDING' });
  const attempt = {
    attemptId: crypto.randomUUID(),
    operationKeys: [...operationKeys],
    startedAt: new Date().toISOString(),
    responseReceivedAt: null
  };
  state.pendingPlan.submissionStatus = 'unverified';
  state.pendingPlan.attempts ||= [];
  state.pendingPlan.attempts.push(attempt);
  return attempt;
}

export function confirmSubmissionResponse(state, attemptId) {
  const attempt = state.pendingPlan?.attempts?.find(candidate => candidate.attemptId === attemptId);
  if (!attempt) throw Object.assign(new Error('Submission attempt was not found.'), { code: 'SUBMISSION_ATTEMPT_NOT_FOUND' });
  attempt.responseReceivedAt = new Date().toISOString();
  return attempt;
}

export function completeSubmission(state) {
  if (!state.pendingPlan) return false;
  const proposalItemIds = new Set((state.pendingPlan.operations || [])
    .filter(operation => operation.kind === 'proposalBody')
    .map(operation => operation.itemId));
  for (const binding of state.boundItems) {
    if (proposalItemIds.has(binding.itemId)) binding.proposalInitialized = true;
  }
  for (const fact of state.pendingPlan.evidenceFacts || []) mergeEvidenceFacts(state, fact.itemId, [fact]);
  for (const intent of state.pendingPlan.satisfiedStatusIntents || []) {
    const binding = state.boundItems.find(item => item.itemId === intent.itemId);
    if (binding?.statusIntent?.revision === intent.revision && binding.statusIntent.targetStatus === intent.targetStatus) {
      binding.statusIntent = null;
    }
  }
  state.lastSuccessfulUpdate = {
    sequence: state.pendingPlan.throughSequence,
    completedAt: new Date().toISOString()
  };
  state.pendingPlan = null;
  return true;
}
