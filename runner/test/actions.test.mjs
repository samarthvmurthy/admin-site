import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, validateRun } from '../actions-spec.mjs';
import { parsePipeline, parseReportCell } from '../sync.mjs';

const argsFor = (action, params) => ACTIONS[action].args(validateRun(action, params));

test('unknown actions and prototype keys are rejected', () => {
  assert.throws(() => validateRun('rm', {}), /unknown action/);
  assert.throws(() => validateRun('__proto__', {}), /unknown action/);
  assert.throws(() => validateRun('toString', {}), /unknown action/);
});

test('unknown or malformed params are rejected', () => {
  assert.throws(() => validateRun('scan', { cmd: 'whoami' }), /unknown parameter/);
  assert.throws(() => validateRun('scan', []), /must be an object/);
  assert.throws(() => validateRun('scan', { since: '7; rm -rf /' }), /integer/);
  assert.throws(() => validateRun('scan', { since: 0 }), /integer/);
});

test('free text can never become a flag', () => {
  assert.throws(() => validateRun('scan', { company: '--dry-run' }), /must not start with "-"/);
  assert.throws(() => validateRun('scan', { company: 'Acme; whoami' }), /unsupported characters/);
  assert.throws(() => validateRun('set-status', { row: 1, state: 'Applied', note: '-x' }), /must not start/);
});

test('scan builds a fixed argument list', () => {
  assert.deepEqual(argsFor('scan', {}), ['--json', '--quiet']);
  assert.deepEqual(argsFor('scan', { company: 'Cohere', since: '7' }),
    ['--json', '--quiet', '--company', 'Cohere', '--since', '7']);
});

test('set-status requires a row and a canonical state', () => {
  assert.throws(() => validateRun('set-status', { state: 'Applied' }), /"row" is required/);
  assert.throws(() => validateRun('set-status', { row: 3, state: 'Ghosted' }), /must be one of/);
  assert.deepEqual(argsFor('set-status', { row: 3, state: 'applied', note: 'sent via referral' }),
    ['--row', '3', 'Applied', '--source', 'web', '--json', '--note=sent via referral']);
});

test('check-liveness takes a URL or the tracker, not both', () => {
  assert.throws(() => validateRun('check-liveness', {}), /give a url/);
  assert.throws(() => validateRun('check-liveness', { url: 'https://x.io/j/1', tracker: true }), /not both/);
  assert.throws(() => validateRun('check-liveness', { url: 'file:///etc/passwd' }), /http\(s\)/);
  assert.deepEqual(argsFor('check-liveness', { url: 'https://jobs.lever.co/a/b' }), ['https://jobs.lever.co/a/b']);
  assert.deepEqual(argsFor('check-liveness', { tracker: true }), ['--tracker', '--status=Evaluated,Applied']);
});

test('pipeline parser reads pending and processed lines', () => {
  const md = [
    '## Pending',
    '- [ ] https://jobs.ashbyhq.com/sierra/e9 | Sierra | Software Engineer, Agent | San Francisco, CA · New York | 180000-390000 USD | posted: 2025-04-18',
    '- [ ] https://job-boards.greenhouse.io/vercel/jobs/1 | Vercel | SWE | posted: 2026-09-02',
    '## Processed',
    '- [x] #001 | https://jobs.ashbyhq.com/sierra/14 | Sierra | SWE, Agent (New Grad 2027) | 4.1/5 | PDF ✅',
  ].join('\n');
  const { pending, processed } = parsePipeline(md);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].company, 'Sierra');
  assert.equal(pending[0].salary, '180000-390000 USD');
  assert.equal(pending[0].location, 'San Francisco, CA · New York');
  assert.equal(pending[0].posted, '2025-04-18');
  assert.equal(pending[1].location, undefined);
  assert.deepEqual(
    { num: processed[0].num, score: processed[0].score, pdf: processed[0].pdf, company: processed[0].company },
    { num: '001', score: '4.1/5', pdf: true, company: 'Sierra' },
  );
});

test('report cell parsing', () => {
  assert.deepEqual(parseReportCell('[007](../reports/007-palantir-2026-10-20.md)'),
    { num: '007', file: '007-palantir-2026-10-20.md' });
  assert.deepEqual(parseReportCell('—'), { num: null, file: null });
});
