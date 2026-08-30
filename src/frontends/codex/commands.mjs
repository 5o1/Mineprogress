export function isControlPrompt(text = '') {
  const prompt = String(text);
  if (/^\s*\$mineprogress(?::|\b)/i.test(prompt)) {
    return /^\s*\$mineprogress:(?:init|create|bind|unbind|update|check|status)\b/i.test(prompt);
  }
  if (prompt.length > 500 || /<hook_prompt\b|\bstop hook\b|\bfeedback:|\brun node\b/i.test(prompt)) return false;
  return /\bmineprogress\b/i.test(prompt)
    && /(?:init(?:ialize)?|setup|create|bind|unbind|update|check|status|\u521d\u59cb\u5316|\u521b\u5efa|\u7ed1\u5b9a|\u89e3\u7ed1|\u66f4\u65b0|\u68c0\u67e5|\u72b6\u6001)/i.test(prompt);
}

export function controlCommandAction(text = '') {
  const normalized = String(text).toLowerCase();
  const explicit = normalized.match(/^\s*\$mineprogress:(init|create|bind|unbind|update|check|status)\b/);
  if (!explicit && /^\s*\$mineprogress(?::|\b)/.test(normalized)) return null;
  const natural = isControlPrompt(normalized);
  const command = explicit?.[1] || (natural && /\bmineprogress\b/.test(normalized)
    ? [['init', /init(?:ialize)?|setup|\u521d\u59cb\u5316/], ['create', /create|\u521b\u5efa/], ['unbind', /unbind|\u89e3\u7ed1/], ['bind', /bind|\u7ed1\u5b9a/], ['update', /update|\u66f4\u65b0/], ['check', /check|\u68c0\u67e5/], ['status', /status|\u72b6\u6001/]]
      .find(([, pattern]) => pattern.test(normalized))?.[0]
    : null);
  if (command === 'update' && /\bretry\b|\u91cd\u8bd5/.test(normalized)) return 'update_retry';
  if (command === 'status' && /\bresolve\b|\u5904\u7406|\u89e3\u51b3/.test(normalized)) return 'status_resolve';
  return command;
}
