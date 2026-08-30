export const HOST_ADAPTER_API_VERSION = 1;
export const LIFECYCLE_EVENTS = ['session-start', 'user-prompt', 'turn-stop', 'session-end'];
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'id', 'displayName', 'status', 'entrypoints', 'resources', 'capabilities']);
const ENTRYPOINT_KEYS = new Set(['commands', 'lifecycle', 'background']);
const RESOURCE_KEYS = new Set(['hooks', 'skills']);
const CAPABILITY_KEYS = new Set([
  'lifecycleEvents',
  'explicitCommands',
  'backgroundExecution',
  'threadHistory',
  'structuredModelOutput',
  'writableDataDirectory'
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectAdditionalProperties(value, allowed, location, errors) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${location} contains unsupported property ${key}`);
  }
}

function validateOptionalStringMap(value, allowed, location, errors) {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${location} must be an object`);
    return;
  }
  rejectAdditionalProperties(value, allowed, location, errors);
  for (const [key, entry] of Object.entries(value)) {
    if (allowed.has(key) && typeof entry !== 'string') errors.push(`${location}.${key} must be a string`);
  }
}

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
  if (!isRecord(manifest)) return ['manifest must be an object'];
  rejectAdditionalProperties(manifest, TOP_LEVEL_KEYS, 'manifest', errors);
  if (manifest.schemaVersion !== HOST_ADAPTER_API_VERSION) errors.push('schemaVersion must equal 1');
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.id || '')) errors.push('id must be kebab-case');
  if (typeof manifest.displayName !== 'string' || !manifest.displayName.length) errors.push('displayName must be a non-empty string');
  if (!['implemented', 'planned'].includes(manifest.status)) errors.push('status must be implemented or planned');
  validateOptionalStringMap(manifest.entrypoints, ENTRYPOINT_KEYS, 'entrypoints', errors);
  validateOptionalStringMap(manifest.resources, RESOURCE_KEYS, 'resources', errors);
  if (!isRecord(manifest.capabilities)) {
    errors.push('capabilities must be an object');
  } else {
    rejectAdditionalProperties(manifest.capabilities, CAPABILITY_KEYS, 'capabilities', errors);
    const events = manifest.capabilities.lifecycleEvents;
    if (!Array.isArray(events)) {
      errors.push('capabilities.lifecycleEvents must be an array');
    } else if (events.some(event => !LIFECYCLE_EVENTS.includes(event)) || new Set(events).size !== events.length) {
      errors.push('capabilities.lifecycleEvents contains an invalid or duplicate event');
    }
    for (const name of [...CAPABILITY_KEYS].filter(name => name !== 'lifecycleEvents')) {
      if (typeof manifest.capabilities[name] !== 'boolean') errors.push(`capabilities.${name} must be boolean`);
    }
  }
  if (manifest.status === 'implemented' && (!manifest.entrypoints?.lifecycle || !manifest.entrypoints?.commands)) {
    errors.push('implemented adapters require lifecycle and command entrypoints');
  }
  return errors;
}
