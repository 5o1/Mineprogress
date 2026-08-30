export const HOST_ADAPTER_API_VERSION = 1;
export const LIFECYCLE_EVENTS = ['session-start', 'user-prompt', 'turn-stop', 'session-end'];

export function assertHostEvent(event) {
  if (!event || !LIFECYCLE_EVENTS.includes(event.type)) {
    throw Object.assign(new Error('Host event type is not supported.'), { code: 'HOST_EVENT_INVALID' });
  }
  if (typeof event.sessionId !== 'string' || !event.sessionId) {
    throw Object.assign(new Error('Host event requires sessionId.'), { code: 'HOST_EVENT_INVALID' });
  }
  if (event.type === 'user-prompt' && typeof event.prompt !== 'string') {
    throw Object.assign(new Error('User-prompt event requires prompt text.'), { code: 'HOST_EVENT_INVALID' });
  }
  if (event.type === 'turn-stop' && typeof event.assistantMessage !== 'string') {
    throw Object.assign(new Error('Turn-stop event requires assistantMessage text.'), { code: 'HOST_EVENT_INVALID' });
  }
  return event;
}

export function validateHostManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== HOST_ADAPTER_API_VERSION) errors.push('schemaVersion must equal 1');
  if (!/^[a-z][a-z0-9-]*$/.test(manifest?.id || '')) errors.push('id must be kebab-case');
  if (!['implemented', 'planned'].includes(manifest?.status)) errors.push('status must be implemented or planned');
  const capabilities = manifest?.capabilities || {};
  const events = capabilities.lifecycleEvents || [];
  if (events.some(event => !LIFECYCLE_EVENTS.includes(event)) || new Set(events).size !== events.length) {
    errors.push('lifecycleEvents contains an invalid or duplicate event');
  }
  for (const name of ['explicitCommands', 'backgroundExecution', 'threadHistory', 'structuredModelOutput', 'writableDataDirectory']) {
    if (typeof capabilities[name] !== 'boolean') errors.push(`capabilities.${name} must be boolean`);
  }
  if (manifest?.status === 'implemented' && (!manifest.entrypoints?.lifecycle || !manifest.entrypoints?.commands)) {
    errors.push('implemented adapters require lifecycle and command entrypoints');
  }
  return errors;
}
