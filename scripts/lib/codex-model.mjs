import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const MODEL_PATTERN = /^[A-Za-z0-9._:+-]{1,100}$/;
const EFFORT_PATTERN = /^[a-z]{2,16}$/;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexInvocation(env = process.env) {
  if (env.MINEPROGRESS_CODEX_CLI) {
    const configured = path.resolve(env.MINEPROGRESS_CODEX_CLI);
    if (!await exists(configured)) {
      throw Object.assign(new Error('MINEPROGRESS_CODEX_CLI does not exist.'), { code: 'CODEX_CLI_NOT_FOUND' });
    }
    return configured.endsWith('.js')
      ? { command: process.execPath, prefix: [configured] }
      : { command: configured, prefix: [] };
  }
  const candidates = [];
  if (process.platform === 'win32' && env.APPDATA) {
    candidates.push(path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  }
  for (const entry of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return { command: process.execPath, prefix: [candidate] };
  }
  if (process.platform !== 'win32') return { command: 'codex', prefix: [] };
  throw Object.assign(new Error('Codex CLI was not found for background planning.'), { code: 'CODEX_CLI_NOT_FOUND' });
}

function collect(stream, limit = 16_000) {
  let value = '';
  stream?.on('data', chunk => {
    if (value.length < limit) value += String(chunk).slice(0, limit - value.length);
  });
  return () => value;
}

export async function invokeCodexJson({
  dataDir,
  model,
  reasoningEffort,
  prompt,
  schema,
  forkSessionId = null,
  timeoutMs = 300_000,
  spawnProcess = spawn,
  env = process.env
}) {
  if (!MODEL_PATTERN.test(model || '') || !EFFORT_PATTERN.test(reasoningEffort || '')) {
    throw Object.assign(new Error('Configured model or reasoning effort is invalid.'), { code: 'MODEL_CONFIG_INVALID' });
  }
  const invocation = await resolveCodexInvocation(env);
  const temporary = await fs.mkdtemp(path.join(path.resolve(dataDir), 'tmp-model-'));
  const schemaFile = path.join(temporary, 'schema.json');
  const outputFile = path.join(temporary, 'output.json');
  await fs.writeFile(schemaFile, JSON.stringify(schema), { encoding: 'utf8', mode: 0o600 });
  const args = [...invocation.prefix,
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--disable', 'hooks', '--disable', 'plugins', '--skip-git-repo-check',
    '-C', temporary, '-m', model, '-c', `model_reasoning_effort="${reasoningEffort}"`,
    '--sandbox', 'read-only', '--color', 'never', '--output-schema', schemaFile,
    '--output-last-message', outputFile
  ];
  if (forkSessionId) args.push('fork', forkSessionId, '-');
  else args.push('-');
  const childEnv = { ...env };
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'PLUGIN_DATA', 'MINEPROGRESS_DATA', 'MINEPROGRESS_CONFIG', 'PLUGIN_ROOT']) {
    delete childEnv[key];
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(invocation.command, args, {
        cwd: temporary,
        env: childEnv,
        stdio: ['pipe', 'ignore', 'pipe'],
        windowsHide: true
      });
      const stderr = collect(child.stderr);
      const timer = setTimeout(() => {
        child.kill();
        reject(Object.assign(new Error('Background model call timed out.'), { code: 'MODEL_TIMEOUT' }));
      }, timeoutMs);
      child.once('error', error => {
        clearTimeout(timer);
        reject(Object.assign(error, { code: error.code || 'MODEL_PROCESS_FAILED' }));
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(Object.assign(new Error(stderr() || `Codex exited with code ${code}.`), { code: 'MODEL_PROCESS_FAILED' }));
      });
      child.stdin.end(prompt);
    });
    const raw = await fs.readFile(outputFile, 'utf8');
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('Background model returned invalid JSON.'), { code: 'MODEL_OUTPUT_INVALID' });
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
