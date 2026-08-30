const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_PUNCTUATION = /[),.;:!?\]}]+$/u;

export function normalizeReferenceLink(value) {
  const candidate = String(value || '').trim().replace(TRAILING_PUNCTUATION, '');
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    const link = url.toString();
    return link.endsWith('/') && url.pathname !== '/' ? link.slice(0, -1) : link;
  } catch {
    return null;
  }
}

export function extractReferenceLinks(events = []) {
  const links = [];
  const seen = new Set();
  for (const event of events) {
    for (const match of String(event?.text || '').matchAll(URL_PATTERN)) {
      const link = normalizeReferenceLink(match[0]);
      if (link && !seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    }
  }
  return links;
}

export function mergeReferenceLinks(...groups) {
  const links = [];
  const seen = new Set();
  for (const group of groups) {
    for (const value of group || []) {
      const link = normalizeReferenceLink(value);
      if (link && !seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    }
  }
  return links;
}
