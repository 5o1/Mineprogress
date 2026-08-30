export const DEFAULT_CONTENT_LANGUAGE = 'en';

export function normalizeContentLanguage(value = DEFAULT_CONTENT_LANGUAGE) {
  const language = String(value || DEFAULT_CONTENT_LANGUAGE).trim().toLowerCase();
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u.test(language)) {
    throw Object.assign(new Error('Content language must be a valid language tag such as en or zh-CN.'), {
      code: 'CONTENT_LANGUAGE_INVALID'
    });
  }
  return language;
}

export function validateContentLanguage(text, language = DEFAULT_CONTENT_LANGUAGE) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const normalized = normalizeContentLanguage(language);
  const containsHan = /\p{Script=Han}/u.test(text);
  if (normalized === 'en' && containsHan) return ['must use the item content language en'];
  if (normalized.startsWith('zh') && !containsHan) return [`must use the item content language ${normalized}`];
  return [];
}
