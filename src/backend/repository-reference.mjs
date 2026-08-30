import { normalizeReferenceLink } from './references.mjs';

const MANAGED_START = '<!-- mineprogress:managed:start -->';
const MANAGED_END = '<!-- mineprogress:managed:end -->';
const REPOSITORY_HEADING = '## Repository';
const BACKGROUND_HEADING = '## Background and Significance';

function oneLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function repositoryLabel(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join('/') : new URL(url).hostname;
  } catch {
    return url;
  }
}

export function normalizePrimaryRepository(value, title = '') {
  const candidate = typeof value === 'string' ? { url: value } : value;
  if (!candidate?.url) return null;
  const url = normalizeReferenceLink(candidate.url);
  if (!url) return null;
  const subject = oneLine(title) || 'this work';
  return {
    url,
    description: oneLine(candidate.description) || `Primary source repository for ${subject}.`
  };
}

export function primaryRepositoryFromLinks(links, title = '') {
  const url = (links || []).map(normalizeReferenceLink).find(Boolean);
  return url ? normalizePrimaryRepository({ url }, title) : null;
}

export function canManageRepositoryReference(body) {
  const text = String(body || '');
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END, start + MANAGED_START.length);
  return start >= 0 && end > start;
}

export function upsertRepositoryReference(body, value) {
  const repository = normalizePrimaryRepository(value);
  if (!repository) return String(body || '');
  const text = String(body || '');
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END, start + MANAGED_START.length);
  if (start < 0 || end <= start) {
    throw Object.assign(new Error('Repository references require a managed proposal body.'), {
      code: 'REPOSITORY_REFERENCE_BODY_UNMANAGED'
    });
  }
  const managedStart = start + MANAGED_START.length;
  const managed = text.slice(managedStart, end);
  const section = `${REPOSITORY_HEADING}\n\n[${repositoryLabel(repository.url)}](${repository.url}) — ${repository.description}`;
  const existing = /(?:^|\n)## Repository\s*\n[\s\S]*?(?=\n## |$)/;
  let updated;
  if (existing.test(managed)) {
    updated = managed.replace(existing, match => `${match.startsWith('\n') ? '\n' : ''}${section}\n`);
  } else {
    const insertion = managed.indexOf(`\n${BACKGROUND_HEADING}`);
    if (insertion < 0) {
      throw Object.assign(new Error('Managed proposal is missing its Background and Significance section.'), {
        code: 'REPOSITORY_REFERENCE_LOCATION_MISSING'
      });
    }
    updated = `${managed.slice(0, insertion).trimEnd()}\n\n${section}\n${managed.slice(insertion)}`;
  }
  return `${text.slice(0, managedStart)}${updated}${text.slice(end)}`;
}
