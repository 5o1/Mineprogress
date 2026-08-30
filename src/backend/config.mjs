import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';

export const DEFAULT_CONFIG = {
  ownerType: 'user',
  statusFieldName: 'Status',
  updateFieldName: 'Update',
  kanban: {
    defaultStatus: '',
    terminalStatuses: [],
    statusRoles: {
      queued: '',
      active: '',
      review: '',
      blocked: '',
      completed: ''
    }
  },
  creation: {
    repository: '',
    projectVisibility: 'auto',
    repositoryVisibility: 'auto',
    routes: {
      public_private: 'issue',
      public_public: 'issue',
      private_private: 'issue',
      private_public: 'draft'
    }
  },
  update: {
    maxReviewAttempts: 5,
    maxSummaryCharacters: 500,
    maxSummaryWords: 80,
    maxBodyCharacters: 60000,
    maxCommentCharacters: 10000
  },
  models: {
    create: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
    update: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
    review: { model: 'gpt-5.6-luna', reasoningEffort: 'medium' },
    preferFastMode: true
  }
};

const DEFAULT_STATUS_PATTERNS = [
  /^todo$/i,
  /^to do$/i,
  /^backlog$/i,
  /^new$/i,
  /^not started$/i,
  /^ready$/i,
  /^open$/i,
  /^planned?$/i,
  /^planning$/i,
  /^\u5f85\u529e$/u,
  /^\u672a\u5f00\u59cb$/u
];
const TERMINAL_STATUS_PATTERN = /^(?:done|complete|completed|closed|resolved|cancelled|canceled|not planned|won't do|won't fix|\u5df2\u5b8c\u6210|\u5df2\u53d6\u6d88)$/iu;
const STATUS_ROLE_PATTERNS = {
  active: /^(?:in progress|doing|active|implementing|development|\u8fdb\u884c\u4e2d|\u5904\u7406\u4e2d)$/iu,
  review: /^(?:review|in review|code review|verification|qa|\u5f85\u5ba1\u6838|\u5ba1\u6838\u4e2d|\u9a8c\u6536)$/iu,
  blocked: /^(?:blocked|on hold|waiting|stalled|\u963b\u585e|\u6682\u505c)$/iu
};
const STATUS_ROLE_NAMES = ['queued', 'active', 'review', 'blocked', 'completed'];

function statusNames(statuses) {
  return (statuses || []).map(status => typeof status === 'string' ? status : status?.name)
    .filter(status => typeof status === 'string' && status.trim())
    .map(status => status.trim());
}

export function detectTerminalStatuses(statuses) {
  return statusNames(statuses).filter(status => TERMINAL_STATUS_PATTERN.test(status));
}

export function selectDefaultStatus(statuses) {
  const names = statusNames(statuses);
  for (const pattern of DEFAULT_STATUS_PATTERNS) {
    const match = names.find(status => pattern.test(status));
    if (match) return match;
  }
  const terminal = new Set(detectTerminalStatuses(names));
  return names.find(status => !terminal.has(status)) || names[0] || '';
}

export function detectStatusRoles(statuses) {
  const names = statusNames(statuses);
  const terminal = detectTerminalStatuses(names);
  return {
    queued: selectDefaultStatus(names),
    active: names.find(status => STATUS_ROLE_PATTERNS.active.test(status)) || '',
    review: names.find(status => STATUS_ROLE_PATTERNS.review.test(status)) || '',
    blocked: names.find(status => STATUS_ROLE_PATTERNS.blocked.test(status)) || '',
    completed: terminal[0] || ''
  };
}

export function synchronizeKanbanConfig(config, statuses) {
  const names = statusNames(statuses);
  const available = new Set(names);
  const detected = detectStatusRoles(names);
  const currentRoles = config.kanban?.statusRoles || {};
  const statusRoles = Object.fromEntries(STATUS_ROLE_NAMES.map(role => {
    const configured = currentRoles[role];
    return [role, configured && available.has(configured) ? configured : detected[role]];
  }));
  const defaultStatus = available.has(config.kanban?.defaultStatus)
    ? config.kanban.defaultStatus
    : statusRoles.queued;
  if (!statusRoles.queued) statusRoles.queued = defaultStatus;
  const terminalStatuses = [...new Set([
    ...(config.kanban?.terminalStatuses || []).filter(status => available.has(status)),
    ...detectTerminalStatuses(names),
    ...(statusRoles.completed ? [statusRoles.completed] : [])
  ])];
  const next = mergeConfig({
    ...config,
    kanban: { ...config.kanban, defaultStatus, terminalStatuses, statusRoles }
  });
  const changes = [];
  for (const [path, before, after] of [
    ['kanban.defaultStatus', config.kanban?.defaultStatus || '', defaultStatus],
    ['kanban.terminalStatuses', config.kanban?.terminalStatuses || [], terminalStatuses],
    ...STATUS_ROLE_NAMES.map(role => [
      `kanban.statusRoles.${role}`,
      currentRoles[role] || '',
      statusRoles[role]
    ])
  ]) {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ path, before, after });
  }
  return { config: next, changes };
}

function mergeConfig(raw) {
  const { defaultRepository: legacyRepository, ...values } = raw;
  const repository = raw.creation?.repository ?? legacyRepository ?? DEFAULT_CONFIG.creation.repository;
  return {
    ...DEFAULT_CONFIG,
    ...values,
    kanban: {
      ...DEFAULT_CONFIG.kanban,
      ...raw.kanban,
      statusRoles: { ...DEFAULT_CONFIG.kanban.statusRoles, ...raw.kanban?.statusRoles }
    },
    creation: {
      ...DEFAULT_CONFIG.creation,
      ...raw.creation,
      repository,
      routes: { ...DEFAULT_CONFIG.creation.routes, ...raw.creation?.routes }
    },
    update: { ...DEFAULT_CONFIG.update, ...raw.update },
    models: {
      ...DEFAULT_CONFIG.models,
      ...raw.models,
      create: { ...DEFAULT_CONFIG.models.create, ...raw.models?.create },
      update: { ...DEFAULT_CONFIG.models.update, ...raw.models?.update },
      review: { ...DEFAULT_CONFIG.models.review, ...raw.models?.review }
    }
  };
}

export function configPath(env = {}, cwd = '.', dataDir) {
  if (env.MINEPROGRESS_CONFIG || env.GITHUB_PROJECTS_CONFIG) {
    return env.MINEPROGRESS_CONFIG || env.GITHUB_PROJECTS_CONFIG;
  }
  if (dataDir) return path.join(dataDir, 'config.json');
  return path.join(dataDir || cwd, 'config.json');
}

export async function loadConfig(file) {
  if (!file) throw Object.assign(new Error('A config file path is required.'), { code: 'CONFIG_PATH_REQUIRED' });
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  const config = mergeConfig(raw);
  if (!config.owner || !Number.isInteger(config.projectNumber)) {
    throw Object.assign(new Error('config.json requires owner and integer projectNumber'), { code: 'CONFIG_INVALID' });
  }
  if (!['user', 'organization'].includes(config.ownerType)) {
    throw Object.assign(new Error('ownerType must be user or organization'), { code: 'CONFIG_INVALID' });
  }
  if (!['auto', 'public', 'private'].includes(config.creation.projectVisibility) ||
      !['auto', 'public', 'private'].includes(config.creation.repositoryVisibility) ||
      Object.values(config.creation.routes).some(route => !['issue', 'draft'].includes(route))) {
    throw Object.assign(new Error('creation visibility must be auto/public/private and every route must be issue/draft'), { code: 'CONFIG_INVALID' });
  }
  if (typeof config.creation.repository !== 'string') {
    throw Object.assign(new Error('creation.repository must use owner/name form or be empty'), { code: 'CONFIG_INVALID' });
  }
  if (!Array.isArray(config.kanban.terminalStatuses) || config.kanban.terminalStatuses.some(status => typeof status !== 'string')) {
    throw Object.assign(new Error('kanban.terminalStatuses must be an array of status names'), { code: 'CONFIG_INVALID' });
  }
  if (typeof config.kanban.defaultStatus !== 'string') {
    throw Object.assign(new Error('kanban.defaultStatus must be a status name'), { code: 'CONFIG_INVALID' });
  }
  if (STATUS_ROLE_NAMES.some(role => typeof config.kanban.statusRoles?.[role] !== 'string')) {
    throw Object.assign(new Error('kanban.statusRoles must map every role to a status name or empty string'), { code: 'CONFIG_INVALID' });
  }
  return config;
}

export function createConfig(values) {
  return mergeConfig(values);
}

export function creationRepository(config) {
  return config?.creation?.repository ?? config?.defaultRepository ?? '';
}

export async function saveConfig(file, config) {
  await atomicWriteFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
