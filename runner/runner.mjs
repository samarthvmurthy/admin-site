#!/usr/bin/env node
// The Dell runner: checks the admin site for queued jobs every few seconds,
// runs each one against the local career-ops folder, streams its output back,
// and mirrors the changed career-ops files up afterwards.
//
// Only outbound HTTPS — nothing listens on the Dell. Started at boot by the
// scheduled task install.ps1 creates. Usage:
//   node runner.mjs            run forever
//   node runner.mjs --once     claim and run at most one job, sync, exit
//   node runner.mjs --sync     sync only, exit

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { ACTIONS, validateRun } from './actions-spec.mjs';
import { syncUp } from './sync.mjs';
import { loadConfig, createClient, log, sleep, RUNNER_VERSION } from './lib.mjs';

const FLUSH_MS = 3_000;
const IDLE_SYNC_MS = 15 * 60_000;
const MAX_STDOUT = 5_000_000;

const config = loadConfig();
const client = createClient(config);
const root = config.careerOpsRoot;

if (!existsSync(join(root, 'AGENTS.md')) || !existsSync(join(root, 'modes'))) {
  log(`CAREER_OPS_ROOT does not look like a career-ops checkout: ${root}`);
  process.exit(1);
}

const info = {
  host: hostname(),
  platform: process.platform,
  node: process.version,
  runner: RUNNER_VERSION,
  careerOpsRoot: root,
};

// ----------------------------------------------------------------- execute ----

function runProcess(run, spec, params, onOutput, shouldCancel) {
  const args = [join(root, spec.script), ...spec.args(params)];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, CAREER_OPS_ROOT: root, FORCE_COLOR: '0', NO_COLOR: '1' },
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let killedFor = null;
    const kill = (why) => { if (!killedFor) { killedFor = why; child.kill(); } };
    const timer = setTimeout(() => kill('timeout'), spec.timeout);
    const cancelPoll = setInterval(() => { if (shouldCancel()) kill('cancelled'); }, 1_000);

    child.stdout.on('data', (d) => {
      const s = d.toString();
      if (spec.json) {
        if (stdout.length < MAX_STDOUT) stdout += s;
      } else {
        onOutput(s);
      }
    });
    child.stderr.on('data', (d) => onOutput(d.toString()));
    child.on('error', (e) => { onOutput(`\n[runner] could not start: ${e.message}\n`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(cancelPoll);
      resolve({ code, stdout, killedFor });
    });
  });
}

async function execute(run) {
  const spec = ACTIONS[run.action];
  // Validate again here: the runner never trusts the queue blindly.
  const params = validateRun(run.action, run.params);
  log(`run ${run.id} ${run.action} ${JSON.stringify(params)}`);

  let pending = '';
  let cancelled = false;
  const onOutput = (s) => { pending += s; };
  const flush = async () => {
    if (!pending) return;
    const chunk = pending;
    pending = '';
    try {
      const res = await client.progress(run.id, chunk);
      if (res?.cancel) cancelled = true;
    } catch (e) {
      pending = chunk + pending;   // keep it for the next flush
      log(`progress failed: ${e.message}`);
    }
  };
  const flusher = setInterval(flush, FLUSH_MS);

  let outcome;
  try {
    if (spec.kind === 'internal') {
      outcome = { status: 'done', exitCode: 0 };
    } else {
      onOutput(`$ node ${spec.script} ${spec.args(params).join(' ')}\n`);
      const { code, stdout, killedFor } = await runProcess(run, spec, params, onOutput, () => cancelled);
      let result;
      if (spec.json && stdout.trim()) {
        try { result = JSON.parse(stdout); } catch { onOutput(stdout); }
      }
      if (killedFor === 'cancelled') outcome = { status: 'cancelled', exitCode: code, result };
      else if (killedFor === 'timeout') outcome = { status: 'failed', exitCode: code, result, error: 'Timed out' };
      else if (code === 0) outcome = { status: 'done', exitCode: 0, result };
      else outcome = { status: 'failed', exitCode: code, result, error: `Exited with code ${code}` };
    }
  } catch (e) {
    outcome = { status: 'failed', error: e.message };
  }

  // Mirror whatever the run changed before reporting it finished, so the page
  // shows the new state the moment the run turns green.
  try {
    const s = await syncUp(client, root);
    onOutput(`\n[runner] synced: ${s.docs} document(s), ${s.pdfs} PDF(s) updated` +
      `${s.deletedDocs || s.deletedPdfs ? `, ${s.deletedDocs + s.deletedPdfs} removed` : ''}\n`);
  } catch (e) {
    onOutput(`\n[runner] sync failed: ${e.message}\n`);
  }

  clearInterval(flusher);
  await flush();
  await client.done({ id: run.id, ...outcome, append: pending });
  log(`run ${run.id} ${outcome.status}${outcome.error ? ` (${outcome.error})` : ''}`);
}

// -------------------------------------------------------------------- loop ----

async function syncNow(reason) {
  try {
    const s = await syncUp(client, root);
    log(`sync (${reason}): ${JSON.stringify(s)}`);
  } catch (e) {
    log(`sync (${reason}) failed: ${e.message}`);
  }
}

async function tick() {
  const { run } = await client.claim(info);
  if (!run) return false;
  try {
    await execute(run);
  } catch (e) {
    log(`run ${run.id} crashed: ${e.stack || e.message}`);
    await client.done({ id: run.id, status: 'failed', error: e.message }).catch(() => {});
  }
  return true;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--sync')) { await syncNow('manual'); return; }
  if (args.has('--once')) { await tick(); await syncNow('once'); return; }

  log(`runner ${RUNNER_VERSION} started on ${info.host}, career-ops at ${root}`);
  await syncNow('startup');
  let lastSync = Date.now();
  let backoff = 0;
  for (;;) {
    try {
      const didWork = await tick();
      backoff = 0;
      if (didWork) { lastSync = Date.now(); continue; }   // check straight away for more work
      if (Date.now() - lastSync > IDLE_SYNC_MS) {
        // Picks up anything changed on the Dell outside the runner.
        await syncNow('idle');
        lastSync = Date.now();
      }
      await sleep(config.pollSeconds * 1000);
    } catch (e) {
      backoff = Math.min(backoff ? backoff * 2 : 5_000, 5 * 60_000);
      log(`poll failed (${e.message}); retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
}

main().catch((e) => {
  log(`fatal: ${e.stack || e.message}`);
  process.exit(1);
});
