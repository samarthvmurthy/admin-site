// Jobs module: a queue the admin site fills and the Dell runner drains, plus
// a read-only mirror of the career-ops files the runner syncs up.
//
// Storage is D1 (binding JOBS_DB), not KV: the runner checks in every ~15s and
// free-plan KV allows only 1,000 writes a day and is eventually consistent,
// which a queue can't live with.
//
// Two kinds of routes:
//   /api/jobs/*    the browser (behind Cloudflare Access like everything else)
//   /api/runner/*  the Dell runner; additionally requires X-Runner-Token to
//                  match the RUNNER_TOKEN secret

import { validateRun, describeActions } from '../../runner/actions-spec.mjs';

const LOG_LIMIT = 200_000;            // characters of log kept per run
const ONLINE_WINDOW_MS = 60_000;      // runner counts as online if seen this recently
const MAX_PDF_BYTES = 1_900_000;      // D1 row limit is 2 MB
const REPORT_FILE_RE = /^[\w.-]{1,160}\.md$/;
const PDF_NAME_RE = /^[\w.-]{1,160}\.pdf$/;
const DOC_KEY_RE = /^(tracker|pipeline|meta|report:[\w.-]{1,160}\.md)$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const nowIso = () => new Date().toISOString();

function db(env) {
  if (!env.JOBS_DB) throw httpError('The jobs database is not set up on this worker yet', 503);
  return env.JOBS_DB;
}

function parseJson(text, fallback = null) {
  if (text == null) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function shapeRun(row, { withLog = false } = {}) {
  if (!row) return null;
  const run = {
    id: row.id,
    action: row.action,
    params: parseJson(row.params, {}),
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    cancelRequested: !!row.cancel_requested,
    error: row.error,
    exitCode: row.exit_code,
  };
  if (withLog) {
    run.log = row.log;
    run.result = parseJson(row.result, row.result);
  }
  return run;
}

async function readRunner(env) {
  const row = await db(env).prepare('SELECT last_seen, info FROM runner WHERE id = 1').first();
  const lastSeen = row?.last_seen || null;
  return {
    lastSeen,
    online: !!lastSeen && Date.now() - Date.parse(lastSeen) < ONLINE_WINDOW_MS,
    info: parseJson(row?.info, null),
  };
}

// ------------------------------------------------------------- browser ----

async function handleGetJobs(env) {
  const d = db(env);
  const [docs, runs, runner] = await Promise.all([
    d.prepare("SELECT key, body, updated_at FROM docs WHERE key IN ('tracker', 'pipeline', 'meta')").all(),
    d.prepare(`SELECT id, action, params, status, source, created_at, started_at, finished_at,
                      cancel_requested, error, exit_code
                 FROM runs ORDER BY created_at DESC LIMIT 40`).all(),
    readRunner(env),
  ]);
  const byKey = Object.fromEntries(docs.results.map((r) => [r.key, r]));
  return json({
    runner,
    tracker: parseJson(byKey.tracker?.body, []),
    pipeline: parseJson(byKey.pipeline?.body, { pending: [], processed: [] }),
    meta: parseJson(byKey.meta?.body, null),
    syncedAt: byKey.meta?.updated_at || null,
    runs: runs.results.map((r) => shapeRun(r)),
    actions: describeActions(),
  });
}

async function handleGetReport(env, url) {
  const file = url.searchParams.get('file') || '';
  if (!REPORT_FILE_RE.test(file)) return json({ error: 'Invalid report name' }, 400);
  const row = await db(env).prepare('SELECT body, updated_at FROM docs WHERE key = ?').bind(`report:${file}`).first();
  if (!row) return json({ error: 'This report has not been synced from the Dell' }, 404);
  return json({ file, body: row.body, updatedAt: row.updated_at });
}

async function handleGetPdf(env, url) {
  const name = url.searchParams.get('name') || '';
  if (!PDF_NAME_RE.test(name)) return json({ error: 'Invalid PDF name' }, 400);
  const row = await db(env).prepare('SELECT data FROM pdfs WHERE name = ?').bind(name).first();
  if (!row) return json({ error: 'This PDF has not been synced from the Dell' }, 404);
  const bytes = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data);
  const download = url.searchParams.get('download') === '1';
  return new Response(bytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${name}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}

export async function enqueueRun(env, action, params, source = 'ui') {
  const clean = validateRun(action, params);
  const d = db(env);
  const paramsText = JSON.stringify(clean);
  // Pressing a button twice shouldn't queue the same work twice.
  const existing = await d.prepare(
    "SELECT * FROM runs WHERE action = ? AND params = ? AND status IN ('queued', 'running') LIMIT 1",
  ).bind(action, paramsText).first();
  if (existing) return { run: shapeRun(existing), duplicate: true };

  const id = crypto.randomUUID();
  await d.prepare('INSERT INTO runs (id, action, params, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, action, paramsText, source, nowIso()).run();
  const row = await d.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  return { run: shapeRun(row), duplicate: false };
}

async function handlePostRun(env, request) {
  const body = await request.json().catch(() => ({}));
  const { run, duplicate } = await enqueueRun(env, String(body.action || ''), body.params || {});
  return json({ run, duplicate }, duplicate ? 200 : 201);
}

async function handleGetRun(env, url) {
  const id = url.searchParams.get('id') || '';
  const row = await db(env).prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Run not found' }, 404);
  return json({ run: shapeRun(row, { withLog: true }) });
}

async function handleCancelRun(env, url) {
  const id = url.searchParams.get('id') || '';
  const d = db(env);
  const now = nowIso();
  await d.batch([
    d.prepare("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'queued'").bind(now, id),
    d.prepare("UPDATE runs SET cancel_requested = 1 WHERE id = ? AND status = 'running'").bind(id),
  ]);
  const row = await d.prepare('SELECT * FROM runs WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'Run not found' }, 404);
  return json({ run: shapeRun(row) });
}

// -------------------------------------------------------------- runner ----

async function requireRunner(env, request) {
  const expected = env.RUNNER_TOKEN;
  if (!expected) throw httpError('RUNNER_TOKEN is not configured on this worker', 503);
  const given = request.headers.get('X-Runner-Token') || '';
  const enc = new TextEncoder();
  const a = enc.encode(given);
  const b = enc.encode(expected);
  const ok = a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
  if (!ok) throw httpError('Runner token rejected', 401);
}

// The runner only claims when it's idle, so anything still 'running' at that
// point was interrupted (runner crash, Dell reboot) and is marked failed.
async function handleClaim(env, request) {
  await requireRunner(env, request);
  const body = await request.json().catch(() => ({}));
  const d = db(env);
  const now = nowIso();
  await d.batch([
    d.prepare(`INSERT INTO runner (id, last_seen, info) VALUES (1, ?, ?)
               ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, info = excluded.info`)
      .bind(now, JSON.stringify(body.info || {})),
    d.prepare(`UPDATE runs SET status = 'failed', finished_at = ?, error = 'Interrupted: the runner stopped before this finished'
               WHERE status = 'running'`).bind(now),
  ]);
  if (body.idleOnly) return json({ run: null });

  const next = await d.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY created_at LIMIT 1").first();
  if (!next) return json({ run: null });
  const claimed = await d.prepare(
    "UPDATE runs SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ? AND status = 'queued'",
  ).bind(now, now, next.id).run();
  if (!claimed.meta.changes) return json({ run: null });
  return json({ run: { id: next.id, action: next.action, params: parseJson(next.params, {}) } });
}

async function handleProgress(env, request) {
  await requireRunner(env, request);
  const body = await request.json().catch(() => ({}));
  const d = db(env);
  const now = nowIso();
  const append = typeof body.append === 'string' ? body.append.slice(-LOG_LIMIT) : '';
  await d.batch([
    d.prepare(`UPDATE runs SET log = substr(log || ?, -${LOG_LIMIT}), heartbeat_at = ?
               WHERE id = ? AND status = 'running'`).bind(append, now, String(body.id || '')),
    d.prepare('UPDATE runner SET last_seen = ? WHERE id = 1').bind(now),
  ]);
  const row = await d.prepare('SELECT cancel_requested FROM runs WHERE id = ?').bind(String(body.id || '')).first();
  return json({ cancel: !!row?.cancel_requested });
}

async function handleDone(env, request) {
  await requireRunner(env, request);
  const body = await request.json().catch(() => ({}));
  const status = ['done', 'failed', 'cancelled'].includes(body.status) ? body.status : 'failed';
  const append = typeof body.append === 'string' ? body.append.slice(-LOG_LIMIT) : '';
  const result = body.result === undefined ? null : JSON.stringify(body.result);
  const d = db(env);
  await d.prepare(`UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, error = ?, result = ?,
                          log = substr(log || ?, -${LOG_LIMIT})
                   WHERE id = ? AND status = 'running'`)
    .bind(status, nowIso(), Number.isInteger(body.exitCode) ? body.exitCode : null,
      body.error ? String(body.error).slice(0, 4000) : null, result, append, String(body.id || ''))
    .run();
  return json({ ok: true });
}

async function handleManifest(env, request) {
  await requireRunner(env, request);
  const d = db(env);
  const [docs, pdfs] = await Promise.all([
    d.prepare('SELECT key, hash FROM docs').all(),
    d.prepare('SELECT name, hash FROM pdfs').all(),
  ]);
  return json({
    docs: Object.fromEntries(docs.results.map((r) => [r.key, r.hash])),
    pdfs: Object.fromEntries(pdfs.results.map((r) => [r.name, r.hash])),
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function handleSync(env, request) {
  await requireRunner(env, request);
  const body = await request.json().catch(() => ({}));
  const d = db(env);
  const now = nowIso();
  const stmts = [];

  for (const doc of body.docs || []) {
    if (!DOC_KEY_RE.test(doc.key || '') || typeof doc.body !== 'string') throw httpError(`Bad doc ${doc.key}`, 400);
    stmts.push(d.prepare(`INSERT INTO docs (key, hash, body, updated_at) VALUES (?, ?, ?, ?)
                          ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, body = excluded.body,
                                                         updated_at = excluded.updated_at`)
      .bind(doc.key, String(doc.hash || ''), doc.body, now));
  }
  for (const key of body.deleteDocs || []) {
    if (!DOC_KEY_RE.test(key)) throw httpError(`Bad doc ${key}`, 400);
    stmts.push(d.prepare('DELETE FROM docs WHERE key = ?').bind(key));
  }
  for (const pdf of body.pdfs || []) {
    if (!PDF_NAME_RE.test(pdf.name || '') || typeof pdf.data !== 'string') throw httpError(`Bad PDF ${pdf.name}`, 400);
    const bytes = base64ToBytes(pdf.data);
    if (bytes.byteLength > MAX_PDF_BYTES) throw httpError(`${pdf.name} is larger than 1.9 MB`, 413);
    stmts.push(d.prepare(`INSERT INTO pdfs (name, hash, size, data, updated_at) VALUES (?, ?, ?, ?, ?)
                          ON CONFLICT(name) DO UPDATE SET hash = excluded.hash, size = excluded.size,
                                                          data = excluded.data, updated_at = excluded.updated_at`)
      .bind(pdf.name, String(pdf.hash || ''), bytes.byteLength, bytes, now));
  }
  for (const name of body.deletePdfs || []) {
    if (!PDF_NAME_RE.test(name)) throw httpError(`Bad PDF ${name}`, 400);
    stmts.push(d.prepare('DELETE FROM pdfs WHERE name = ?').bind(name));
  }
  if (stmts.length) await d.batch(stmts);
  return json({ written: stmts.length });
}

// Keep the run history from growing without bound.
export async function pruneRuns(env) {
  if (!env.JOBS_DB) return;
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await env.JOBS_DB.prepare("DELETE FROM runs WHERE created_at < ? AND status NOT IN ('queued', 'running')")
    .bind(cutoff).run();
}

export const JOB_ROUTES = [
  ['GET',  '/api/jobs',            (c) => handleGetJobs(c.env)],
  ['GET',  '/api/jobs/report',     (c) => handleGetReport(c.env, c.url)],
  ['GET',  '/api/jobs/pdf',        (c) => handleGetPdf(c.env, c.url)],
  ['POST', '/api/jobs/run',        (c) => handlePostRun(c.env, c.request)],
  ['GET',  '/api/jobs/run',        (c) => handleGetRun(c.env, c.url)],
  ['POST', '/api/jobs/cancel',     (c) => handleCancelRun(c.env, c.url)],
  ['POST', '/api/runner/claim',    (c) => handleClaim(c.env, c.request)],
  ['POST', '/api/runner/progress', (c) => handleProgress(c.env, c.request)],
  ['POST', '/api/runner/done',     (c) => handleDone(c.env, c.request)],
  ['GET',  '/api/runner/manifest', (c) => handleManifest(c.env, c.request)],
  ['PUT',  '/api/runner/sync',     (c) => handleSync(c.env, c.request)],
];
