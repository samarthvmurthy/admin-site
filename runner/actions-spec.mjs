// The fixed list of things the admin site may ask the Dell runner to do.
//
// Shared by the worker (validates before queueing) and the runner (validates
// again before executing, then builds the argument list). The site never sends
// a command: it sends an action name plus parameters, and each parameter is
// checked against a strict validator here. Arguments are passed to
// child_process.spawn without a shell, so nothing is ever interpreted by
// cmd.exe or bash.
//
// Plain ES module with no imports so the worker can bundle it as-is.

export const STATES = [
  'Evaluated', 'Applied', 'Responded', 'Assessment', 'Interview',
  'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP',
];

class ParamError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

// ------------------------------------------------------------ validators ----

const v = {
  int: (min, max) => (x) => {
    const n = typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x;
    if (!Number.isInteger(n) || n < min || n > max) throw new ParamError(`must be an integer ${min}–${max}`);
    return n;
  },
  enumOf: (list) => (x) => {
    const hit = list.find((s) => s.toLowerCase() === String(x).toLowerCase());
    if (!hit) throw new ParamError(`must be one of ${list.join(', ')}`);
    return hit;
  },
  // Free text that ends up as one argv element. Never allowed to start with
  // "-" so it can't be read as a flag; control characters stripped.
  text: (max) => (x) => {
    if (typeof x !== 'string') throw new ParamError('must be text');
    const s = x.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (!s) throw new ParamError('must not be empty');
    if (s.length > max) throw new ParamError(`must be at most ${max} characters`);
    if (s.startsWith('-')) throw new ParamError('must not start with "-"');
    return s;
  },
  // Company / name filters: a conservative character set.
  name: (x) => {
    const s = v.text(80)(x);
    if (!/^[\p{L}\p{N} .,&'()+/-]+$/u.test(s)) throw new ParamError('contains unsupported characters');
    return s;
  },
  url: (x) => {
    const s = v.text(2000)(x);
    let u;
    try { u = new URL(s); } catch { throw new ParamError('must be a valid URL'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ParamError('must be an http(s) URL');
    return u.toString();
  },
  bool: (x) => {
    if (typeof x !== 'boolean') throw new ParamError('must be true or false');
    return x;
  },
};

// --------------------------------------------------------------- actions ----
//
// kind:     'internal' — handled by the runner itself (no process)
//           'script'   — `node <script> ...args` inside the career-ops folder
// params:   name -> { check, required }
// args(p):  the argv after the script name
// json:     stdout is a JSON document to keep as the run's result
// timeout:  ms before the runner kills the process

export const ACTIONS = {
  sync: {
    label: 'Refresh from the Dell',
    kind: 'internal',
    params: {},
    timeout: 5 * 60_000,
  },

  scan: {
    label: 'Scan job portals',
    kind: 'script',
    script: 'scan.mjs',
    params: {
      company: { check: v.name },
      since: { check: v.int(1, 365) },
    },
    args: (p) => [
      '--json', '--quiet',
      ...(p.company ? ['--company', p.company] : []),
      ...(p.since ? ['--since', String(p.since)] : []),
    ],
    json: true,
    timeout: 30 * 60_000,
  },

  'set-status': {
    label: 'Change status',
    kind: 'script',
    script: 'set-status.mjs',
    params: {
      row: { check: v.int(1, 1_000_000), required: true },
      state: { check: v.enumOf(STATES), required: true },
      note: { check: v.text(300) },
    },
    // --note=VALUE is the script's documented form for literal text.
    args: (p) => [
      '--row', String(p.row), p.state, '--source', 'web', '--json',
      ...(p.note ? [`--note=${p.note}`] : []),
    ],
    json: true,
    timeout: 60_000,
  },

  'check-liveness': {
    label: 'Check if postings are still open',
    kind: 'script',
    script: 'check-liveness.mjs',
    params: {
      url: { check: v.url },
      tracker: { check: v.bool },
    },
    validate: (p) => {
      if (!p.url && !p.tracker) throw new ParamError('give a url, or tracker: true');
      if (p.url && p.tracker) throw new ParamError('give either a url or tracker: true, not both');
    },
    args: (p) => (p.tracker
      ? ['--tracker', '--status=Evaluated,Applied']
      : [p.url]),
    timeout: 20 * 60_000,
  },

  // Folds finished evaluations (batch/tracker-additions/*.tsv) into
  // applications.md — career-ops' only sanctioned way to add tracker rows.
  'merge-tracker': {
    label: 'Merge pending evaluations into the tracker',
    kind: 'script',
    script: 'merge-tracker.mjs',
    params: {
      dryRun: { check: v.bool },
    },
    args: (p) => (p.dryRun ? ['--dry-run'] : []),
    timeout: 2 * 60_000,
  },

  stats: {
    label: 'Funnel statistics',
    kind: 'script',
    script: 'stats.mjs',
    params: {},
    args: () => [],
    json: true,
    timeout: 2 * 60_000,
  },

  followups: {
    label: 'Follow-ups due',
    kind: 'script',
    script: 'followup-cadence.mjs',
    params: {},
    args: () => ['--json'],
    json: true,
    timeout: 2 * 60_000,
  },

  verify: {
    label: 'Health check',
    kind: 'script',
    script: 'verify-pipeline.mjs',
    params: {},
    args: () => [],
    timeout: 5 * 60_000,
  },
};

// Returns a clean params object containing only declared, validated keys.
// Throws ParamError (status 400) on anything unknown or invalid.
export function validateRun(action, params = {}) {
  const spec = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!spec) throw new ParamError(`unknown action "${action}"`);
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new ParamError('params must be an object');
  }
  const clean = {};
  for (const key of Object.keys(params)) {
    if (!Object.prototype.hasOwnProperty.call(spec.params, key)) throw new ParamError(`unknown parameter "${key}"`);
  }
  for (const [key, def] of Object.entries(spec.params)) {
    const raw = params[key];
    if (raw === undefined || raw === null || raw === '') {
      if (def.required) throw new ParamError(`"${key}" is required`);
      continue;
    }
    try {
      clean[key] = def.check(raw);
    } catch (e) {
      throw new ParamError(`"${key}" ${e.message}`);
    }
  }
  if (spec.validate) spec.validate(clean);
  return clean;
}

// Public description for the UI (labels, parameter names).
export function describeActions() {
  return Object.fromEntries(Object.entries(ACTIONS).map(([name, a]) => [
    name, { label: a.label, kind: a.kind, params: Object.keys(a.params) },
  ]));
}
