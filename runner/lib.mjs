// Shared runner plumbing: config from runner/.env, a small logger, and the
// HTTP client for the worker's /api/runner/* routes.

import { readFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
export const RUNNER_VERSION = '1.0.0';

export function loadConfig(envFile = join(RUNNER_DIR, '.env')) {
  const fromFile = {};
  try {
    for (const raw of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      let value = line.slice(eq + 1).trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      fromFile[line.slice(0, eq).trim()] = value;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const get = (k, d) => process.env[k] ?? fromFile[k] ?? d;
  const config = {
    workerUrl: String(get('WORKER_URL', '')).replace(/\/+$/, ''),
    runnerToken: get('RUNNER_TOKEN', ''),
    accessClientId: get('CF_ACCESS_CLIENT_ID', ''),
    accessClientSecret: get('CF_ACCESS_CLIENT_SECRET', ''),
    careerOpsRoot: get('CAREER_OPS_ROOT', ''),
    pollSeconds: Math.max(5, Number(get('POLL_SECONDS', 15)) || 15),
    claudeOauthToken: get('CLAUDE_CODE_OAUTH_TOKEN', ''),
  };
  const missing = ['workerUrl', 'runnerToken', 'careerOpsRoot'].filter((k) => !config[k]);
  if (missing.length) throw new Error(`runner/.env is missing: ${missing.join(', ')}`);
  return config;
}

// ----------------------------------------------------------------- logging ----

const LOG_FILE = join(RUNNER_DIR, 'runner.log');
const LOG_MAX_BYTES = 5_000_000;

export function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map(String).join(' ')}`;
  console.log(line);
  try {
    if (statSync(LOG_FILE, { throwIfNoEntry: false })?.size > LOG_MAX_BYTES) {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
    appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging must never take the runner down */ }
}

// ------------------------------------------------------------------- client ----

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function createClient(config) {
  const headers = {
    'X-Runner-Token': config.runnerToken,
    ...(config.accessClientId ? {
      'CF-Access-Client-Id': config.accessClientId,
      'CF-Access-Client-Secret': config.accessClientSecret,
    } : {}),
  };

  async function call(method, path, body) {
    const res = await fetch(`${config.workerUrl}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
    // Cloudflare Access answers an unauthenticated request with a redirect to
    // its login page rather than a 401.
    if (res.status >= 300 && res.status < 400) {
      throw new ApiError('Cloudflare Access rejected the runner — check CF_ACCESS_CLIENT_ID/SECRET', res.status);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok) throw new ApiError(data?.error || `HTTP ${res.status} from ${path}`, res.status);
    return data;
  }

  return {
    claim: (info) => call('POST', '/api/runner/claim', { info }),
    progress: (id, append) => call('POST', '/api/runner/progress', { id, append }),
    done: (payload) => call('POST', '/api/runner/done', payload),
    manifest: () => call('GET', '/api/runner/manifest'),
    sync: (payload) => call('PUT', '/api/runner/sync', payload),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
