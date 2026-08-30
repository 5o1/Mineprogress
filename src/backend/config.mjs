import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-file.mjs';

export const DEFAULT_CONFIG = {
  ownerType: 'user',
  statusFieldName: 'Status',
  updateFieldName: 'Update',
  kanban: {
    defaultStatus: '',
    terminalStatuses: []
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

function mergeConfig(raw) {
  const { defaultRepository: legacyRepository, ...values } = raw;
  const repository = raw.creation?.repository ?? legacyRepository ?? DEFAULT_CONFIG.creation.repository;
  return {
    ...DEFAULT_CONFIG,
    ...values,
    kanban: { ...DEFAULT_CONFIG.kanban, ...raw.kanban },
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
