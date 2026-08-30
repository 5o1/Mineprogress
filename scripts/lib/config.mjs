import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

export const DEFAULT_CONFIG = {
  ownerType: 'user',
  statusFieldName: 'Status',
  updateFieldName: 'Update',
  kanban: {
    terminalStatuses: []
  },
  defaultRepository: '',
  creation: {
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

function mergeConfig(raw) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    kanban: { ...DEFAULT_CONFIG.kanban, ...raw.kanban },
    creation: {
      ...DEFAULT_CONFIG.creation,
      ...raw.creation,
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

export function configPath(env = process.env, cwd = process.cwd(), dataDir) {
  if (env.MINEPROGRESS_CONFIG || env.GITHUB_PROJECTS_CONFIG) {
    return env.MINEPROGRESS_CONFIG || env.GITHUB_PROJECTS_CONFIG;
  }
  if (dataDir) return path.join(dataDir, 'config.json');
  return path.join(env.PLUGIN_ROOT || cwd, 'config.json');
}

export async function loadConfig(file = configPath()) {
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
  if (!Array.isArray(config.kanban.terminalStatuses) || config.kanban.terminalStatuses.some(status => typeof status !== 'string')) {
    throw Object.assign(new Error('kanban.terminalStatuses must be an array of status names'), { code: 'CONFIG_INVALID' });
  }
  return config;
}

export function createConfig(values) {
  return mergeConfig(values);
}

export async function saveConfig(file, config) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, file);
  return file;
}
