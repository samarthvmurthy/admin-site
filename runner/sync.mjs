// Mirrors the career-ops files the site shows (tracker, pipeline inbox,
// reports, PDFs) up to the worker. Only what changed since the server's
// manifest is uploaded. The Dell's files stay the source of truth; this is a
// one-way copy.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { RUNNER_VERSION } from './lib.mjs';

const MAX_PDF_BYTES = 1_900_000;
const MAX_DOC_BATCH_CHARS = 1_500_000;
const PROCESSED_KEEP = 300;

const sha = (data) => createHash('sha256').update(data).digest('hex');

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

function listFiles(dir, ext) {
  try {
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(ext) && !f.startsWith('.')).sort();
  } catch { return []; }
}

// --------------------------------------------------------------- tracker ----

function runNode(root, args, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root, env: { ...process.env, CAREER_OPS_ROOT: root }, windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// "[007](../reports/007-palantir-2026-10-20.md)" -> { num: '007', file: '007-palantir-2026-10-20.md' }
export function parseReportCell(cell) {
  const m = /\[([^\]]*)\]\(([^)]+\.md)\)/.exec(cell || '');
  if (!m) return { num: null, file: null };
  return { num: m[1].trim() || null, file: basename(m[2]) };
}

function parseScore(cell) {
  const m = /^(\d+(?:\.\d+)?)\/5$/.exec(String(cell || '').trim());
  return m ? Number(m[1]) : null;
}

function cellUrl(cell) {
  if (!cell) return null;
  const link = /\]\((https?:\/\/[^)\s]+)\)/.exec(cell);
  if (link) return link[1];
  const bare = /https?:\/\/\S+/.exec(cell);
  return bare ? bare[0] : null;
}

async function readTracker(root) {
  // tracker.mjs is career-ops' own schema-validating reader; it resyncs its
  // SQLite index from applications.md when that changed.
  const res = await runNode(root, ['tracker.mjs', 'query', '--json', '--limit', '100000']);
  if (res.code !== 0) throw new Error(`tracker.mjs failed: ${(res.err || res.out).trim().slice(-500)}`);
  const rows = JSON.parse(res.out);
  return rows.map((r) => {
    const report = parseReportCell(r.report);
    return {
      ...r,
      reportNum: report.num,
      reportFile: report.file,
      scoreValue: parseScore(r.score),
      url: cellUrl(r.url) || null,
    };
  }).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
}

// -------------------------------------------------------------- pipeline ----

// Pending: "- [ ] url | Company | Role | location… | salary | posted: YYYY-MM-DD"
// Processed: "- [x] #001 | url | Company | Role | 4.1/5 | PDF ✅"
export function parsePipeline(text) {
  const pending = [];
  const processed = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = /^\s*- \[( |x|X)\]\s+(.*)$/.exec(raw);
    if (!m) continue;
    const done = m[1] !== ' ';
    const parts = m[2].split(' | ').map((s) => s.trim());
    const entry = { line: raw.trim() };
    if (done && /^#\d+$/.test(parts[0])) entry.num = parts.shift().slice(1);
    entry.url = parts.shift() || '';
    entry.company = parts.shift() || '';
    entry.role = parts.shift() || '';
    const rest = [];
    for (const p of parts) {
      if (/^posted:/i.test(p)) entry.posted = p.replace(/^posted:\s*/i, '');
      else if (/^\d+(\.\d+)?\/5$/.test(p)) entry.score = p;
      else if (/^PDF\b/i.test(p)) entry.pdf = p.includes('✅');
      else if (/\d{4,}.*\b(USD|EUR|GBP|INR|CAD|AUD)\b|[$€£₹]\s?\d/.test(p)) entry.salary = p;
      else rest.push(p);
    }
    if (rest.length) entry.location = rest.join(' | ');
    (done ? processed : pending).push(entry);
  }
  return { pending, processed: processed.slice(-PROCESSED_KEEP).reverse() };
}

function readPdfIndex(root) {
  const text = readText(join(root, 'data', 'pdf-index.tsv')) || '';
  return text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => {
    const [report, pdf, html, format, date, kind] = l.split('\t');
    return { report, pdf: pdf ? basename(pdf) : null, html: html ? basename(html) : null, format, date, kind };
  });
}

function readVersion(root) {
  return (readText(join(root, 'VERSION')) || '').split(/\s/)[0] || null;
}

async function readJsonScript(root, args) {
  const res = await runNode(root, args);
  if (res.code !== 0) return { error: (res.err || res.out).trim().slice(-300) || `exit ${res.code}` };
  try { return JSON.parse(res.out); } catch { return { error: 'unreadable output' }; }
}

// --------------------------------------------------------------- collect ----

export async function collect(root) {
  const docs = {};
  const pdfs = {};
  let trackerError = null;

  try {
    docs.tracker = JSON.stringify(await readTracker(root));
  } catch (e) {
    trackerError = e.message;
  }
  docs.pipeline = JSON.stringify(parsePipeline(readText(join(root, 'data', 'pipeline.md'))));

  // NNN-RESERVED.md files are report-number reservations, not reports.
  const reportFiles = listFiles(join(root, 'reports'), '.md').filter((f) => !/-RESERVED\.md$/i.test(f));
  for (const f of reportFiles) {
    if (!/^[\w.-]{1,160}\.md$/.test(f)) continue;
    const body = readText(join(root, 'reports', f));
    if (body != null) docs[`report:${f}`] = body;
  }

  const pdfFiles = [];
  for (const f of listFiles(join(root, 'output'), '.pdf')) {
    if (!/^[\w.-]{1,160}\.pdf$/.test(f)) continue;
    const path = join(root, 'output', f);
    const { size, mtime } = statSync(path);
    const entry = { name: f, size, modified: mtime.toISOString(), synced: size <= MAX_PDF_BYTES };
    pdfFiles.push(entry);
    if (entry.synced) pdfs[f] = path;
  }

  // Funnel stats and follow-up cadence: both are quick, token-free scripts,
  // so every sync refreshes them and the page never needs a button for it.
  const [stats, followups] = await Promise.all([
    readJsonScript(root, ['stats.mjs']),
    readJsonScript(root, ['followup-cadence.mjs', '--json']),
  ]);

  docs.meta = JSON.stringify({
    careerOpsVersion: readVersion(root),
    runnerVersion: RUNNER_VERSION,
    trackerError,
    // Finished evaluations not yet folded into applications.md.
    pendingAdditions: listFiles(join(root, 'batch', 'tracker-additions'), '.tsv').length,
    reportFiles,
    pdfFiles,
    pdfIndex: readPdfIndex(root),
    stats,
    followups,
  });
  // On a tracker read error the server keeps the last good copy, and meta
  // carries the error so the page can say so.
  return { docs, pdfs };
}

// ---------------------------------------------------------------- upload ----

export async function syncUp(client, root) {
  const { docs, pdfs } = await collect(root);
  const manifest = await client.manifest();

  const changedDocs = [];
  for (const [key, body] of Object.entries(docs)) {
    const hash = sha(body);
    if (manifest.docs[key] !== hash) changedDocs.push({ key, hash, body });
  }
  const deleteDocs = Object.keys(manifest.docs).filter((k) => k.startsWith('report:') && !(k in docs));

  // Docs go up in a few batches to keep each request modest.
  let batch = [];
  let size = 0;
  const flush = async (extra = {}) => {
    if (!batch.length && !Object.keys(extra).length) return;
    await client.sync({ docs: batch, ...extra });
    batch = [];
    size = 0;
  };
  for (const doc of changedDocs) {
    if (size + doc.body.length > MAX_DOC_BATCH_CHARS && batch.length) await flush();
    batch.push(doc);
    size += doc.body.length;
  }
  await flush(deleteDocs.length ? { deleteDocs } : {});

  // PDFs one per request (base64 inflates them by a third).
  let pdfCount = 0;
  for (const [name, path] of Object.entries(pdfs)) {
    const bytes = readFileSync(path);
    const hash = sha(bytes);
    if (manifest.pdfs[name] === hash) continue;
    await client.sync({ pdfs: [{ name, hash, data: bytes.toString('base64') }] });
    pdfCount++;
  }
  const deletePdfs = Object.keys(manifest.pdfs).filter((n) => !(n in pdfs));
  if (deletePdfs.length) await client.sync({ deletePdfs });

  return { docs: changedDocs.length, deletedDocs: deleteDocs.length, pdfs: pdfCount, deletedPdfs: deletePdfs.length };
}
