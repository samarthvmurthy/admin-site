const GITHUB_API = 'https://api.github.com';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GCAL_API = 'https://www.googleapis.com/calendar/v3';

// ---------------------------------------------------------------- helpers ----

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function ghHeaders(env, extra) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'admin-site-worker',
    ...extra,
  };
}

async function ghFetch(env, path, init = {}) {
  return fetch(`${GITHUB_API}${path}`, { ...init, headers: ghHeaders(env, init.headers) });
}

// Fetch + parse JSON, returning `fallback` instead of throwing so one bad
// sub-request never takes down a whole aggregate response.
async function ghJson(env, path, fallback, init) {
  try {
    const res = await ghFetch(env, path, init);
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// ------------------------------------------------------------- portfolio ----

async function handleGetData(env) {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_FILE_PATH } = env;
  const fileRes = await ghFetch(env, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`);
  if (!fileRes.ok) return json({ error: `GitHub API returned ${fileRes.status}` }, fileRes.status);
  const file = await fileRes.json();
  const content = JSON.parse(decodeURIComponent(escape(atob(file.content))));

  let defaultBranch = 'main';
  const repoRes = await ghFetch(env, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}`);
  if (repoRes.ok) {
    const repoInfo = await repoRes.json();
    defaultBranch = repoInfo.default_branch || 'main';
  }

  return json({ content, sha: file.sha, size: file.size, defaultBranch });
}

async function handlePutData(env, request) {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_FILE_PATH } = env;
  const body = await request.json();
  const { content, message, sha, branch } = body;
  if (!content || !sha) return json({ error: 'content and sha are required' }, 400);

  const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(content, null, 4) + '\n')));
  const res = await ghFetch(env, `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: message || 'Update data.json via admin tool',
      content: encoded,
      sha,
      branch: branch || 'main',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return json({ error: err.message || `GitHub API returned ${res.status}` }, res.status);
  }
  const result = await res.json();
  return json({ sha: result.content.sha });
}

// ---------------------------------------------------------------- github ----

function shapeRepo(r) {
  return {
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    description: r.description,
    html_url: r.html_url,
    homepage: r.homepage,
    private: r.private,
    fork: r.fork,
    archived: r.archived,
    language: r.language,
    languages_url: r.languages_url,
    topics: r.topics || [],
    default_branch: r.default_branch,
    open_issues_count: r.open_issues_count,
    stargazers_count: r.stargazers_count,
    forks_count: r.forks_count,
    size: r.size,
    pushed_at: r.pushed_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

async function handleGetRepos(env) {
  const all = [];
  // Page through so repo #101 doesn't silently vanish from the dashboard.
  for (let page = 1; page <= 5; page++) {
    const res = await ghFetch(env, `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner`);
    if (!res.ok) return json({ error: `GitHub API returned ${res.status}` }, res.status);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return json(all.map(shapeRepo));
}

async function handleGetLanguages(env, url) {
  const repo = url.searchParams.get('repo');
  if (!repo) return json({ error: 'repo query param required (owner/name)' }, 400);
  const res = await ghFetch(env, `/repos/${repo}/languages`);
  if (!res.ok) return json({ error: `GitHub API returned ${res.status}` }, res.status);
  return json(await res.json());
}

// Strip anything executable out of GitHub's rendered README HTML before it
// reaches the page.
function sanitizeHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/javascript:/gi, '');
}

async function handleGetRepoDetail(env, url) {
  const repo = url.searchParams.get('repo');
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return json({ error: 'repo query param required (owner/name)' }, 400);
  }

  const infoRes = await ghFetch(env, `/repos/${repo}`);
  if (!infoRes.ok) return json({ error: `GitHub API returned ${infoRes.status}` }, infoRes.status);
  const info = await infoRes.json();

  const [languages, commits, branches, issues, pulls, readmeHtml, deployments] = await Promise.all([
    ghJson(env, `/repos/${repo}/languages`, {}),
    ghJson(env, `/repos/${repo}/commits?per_page=10`, []),
    ghJson(env, `/repos/${repo}/branches?per_page=20`, []),
    ghJson(env, `/repos/${repo}/issues?state=open&per_page=20`, []),
    ghJson(env, `/repos/${repo}/pulls?state=open&per_page=20`, []),
    (async () => {
      try {
        const res = await ghFetch(env, `/repos/${repo}/readme`, {
          headers: { 'Accept': 'application/vnd.github.html+json' },
        });
        if (!res.ok) return null;
        return sanitizeHtml(await res.text());
      } catch {
        return null;
      }
    })(),
    ghJson(env, `/repos/${repo}/deployments?per_page=1`, []),
  ]);

  // GitHub lumps PRs into the issues endpoint; keep them apart.
  const realIssues = (Array.isArray(issues) ? issues : []).filter((i) => !i.pull_request);

  return json({
    repo: shapeRepo(info),
    languages,
    commits: (Array.isArray(commits) ? commits : []).map((c) => ({
      sha: c.sha,
      short: (c.sha || '').slice(0, 7),
      message: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name,
      date: c.commit?.author?.date,
      html_url: c.html_url,
    })),
    branches: (Array.isArray(branches) ? branches : []).map((b) => ({ name: b.name, protected: b.protected })),
    issues: realIssues.map((i) => ({
      number: i.number, title: i.title, html_url: i.html_url,
      labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      created_at: i.created_at,
    })),
    pulls: (Array.isArray(pulls) ? pulls : []).map((p) => ({
      number: p.number, title: p.title, html_url: p.html_url, draft: p.draft, created_at: p.created_at,
    })),
    hasDeployments: Array.isArray(deployments) && deployments.length > 0,
    readmeHtml,
  });
}

// ------------------------------------------------------------ kv storage ----
//
// Key layout (one JSON document per key):
//   plan              tasks + roadmaps
//   habits            habit list with a per-day log
//   projects:custom   hand-added projects
//   ws:<projectId>    a project's workspace (next steps, achieved, notes)
//   cal:cp-id         id of the "Control Panel" Google calendar

const WS_PREFIX = 'ws:';
const CUSTOM_KEY = 'projects:custom';
const PLAN_KEY = 'plan';
const HABITS_KEY = 'habits';
const CP_CAL_KEY = 'cal:cp-id';
const CP_CAL_NAME = 'Control Panel';
const SITE_URL = 'https://admin.samarthvmurthy.dev';

function kv(env) {
  if (!env.WORKSPACE) throw new Error('WORKSPACE KV namespace is not bound to this worker');
  return env.WORKSPACE;
}

async function readJson(env, key) {
  return kv(env).get(key, 'json');
}

async function writeJson(env, key, doc) {
  await kv(env).put(key, JSON.stringify(doc));
}

const arr = (v) => (Array.isArray(v) ? v : []);
const withId = (v) => v && typeof v === 'object' && typeof v.id === 'string' && v.id;
const nowIso = () => new Date().toISOString();

function requestTimeZone(request) {
  const tz = request.headers.get('X-Time-Zone') || '';
  return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz) ? tz : '';
}

// ------------------------------------------------------------------ plan ----

function emptyPlan() {
  return { tasks: [], roadmaps: [], timeZone: '', calOrphans: [], updatedAt: null };
}

function normalizePlan(body) {
  return {
    tasks: arr(body.tasks).filter(withId),
    roadmaps: arr(body.roadmaps).filter(withId).map((r) => ({
      ...r,
      phases: arr(r.phases).filter(withId).map((p) => ({ ...p, items: arr(p.items).filter(withId) })),
    })),
  };
}

// The 13-week SWE prep program ships as a seeded roadmap so the Plan page is
// useful on first load. Phases are left unscheduled until you pick a start.
function seedPlan() {
  const weeks = [
    'Arrays, strings & two pointers',
    'Hashing, sets & frequency counting',
    'Stacks, queues & monotonic patterns',
    'Linked lists & pointer manipulation',
    'Binary search & sorting patterns',
    'Trees & BFS/DFS traversal',
    'Heaps, tries & intervals',
    'Graphs: traversal, topo sort, union-find',
    'Dynamic programming I — 1D & knapsack',
    'Dynamic programming II — 2D & strings',
    'System design fundamentals',
    'Behavioural, resume & project stories',
    'Mock interviews & weak-spot drilling',
  ];
  const created = nowIso();
  return {
    ...emptyPlan(),
    tasks: [
      { id: 'seed-task-1', title: 'Pick the problem set / book for SWE prep week 1', notes: '', due: '', time: '', priority: 'high', done: false, createdAt: created },
      { id: 'seed-task-2', title: 'Block daily study time on the calendar', notes: '', due: '', time: '', priority: 'medium', done: false, createdAt: created },
    ],
    roadmaps: [{
      id: 'rm-swe-prep',
      title: '13-Week SWE Prep',
      description: 'DS&A by topic, then system design, stories and mocks. One topic per week, each closed out with a timed mock.',
      projectId: '',
      createdAt: created,
      phases: weeks.map((topic, i) => ({
        id: `rm-swe-w${i + 1}`,
        title: `Week ${i + 1} — ${topic}`,
        start: '',
        end: '',
        notes: '',
        items: [{ id: `rm-swe-w${i + 1}-mock`, title: 'Timed mock', due: '', done: false }],
      })),
    }],
  };
}

async function handleGetPlan(env) {
  let doc = await readJson(env, PLAN_KEY);
  if (!doc) {
    doc = seedPlan();
    await writeJson(env, PLAN_KEY, doc);
  }
  return json({ ...emptyPlan(), ...doc });
}

async function handlePutPlan(env, request) {
  const body = await request.json();
  const prev = { ...emptyPlan(), ...((await readJson(env, PLAN_KEY)) || {}) };
  const doc = {
    ...normalizePlan(body),
    timeZone: requestTimeZone(request) || prev.timeZone || '',
    calOrphans: arr(prev.calOrphans),
  };
  const sync = await runSync(env, doc, planEntries(prev), planEntries(doc));
  doc.updatedAt = nowIso();
  await writeJson(env, PLAN_KEY, doc);
  return json({ ...doc, sync });
}

// ---------------------------------------------------------------- habits ----

async function handleGetHabits(env) {
  const doc = await readJson(env, HABITS_KEY);
  return json({ habits: [], updatedAt: null, ...(doc || {}) });
}

async function handlePutHabits(env, request) {
  const body = await request.json();
  const doc = {
    habits: arr(body.habits).filter(withId).map((h) => ({
      ...h,
      log: h.log && typeof h.log === 'object' && !Array.isArray(h.log) ? h.log : {},
    })),
    updatedAt: nowIso(),
  };
  await writeJson(env, HABITS_KEY, doc);
  return json(doc);
}

// ------------------------------------------------------------- workspaces ----

function emptyWorkspace() {
  return {
    status: 'active',
    summary: '',
    liveUrl: '',
    projectName: '',
    next: [],       // [{ id, text, due, time, priority, createdAt }]
    achieved: [],   // [{ id, text, date, due? }]
    notes: '',
    links: [],
    timeZone: '',
    calOrphans: [],
    updatedAt: null,
  };
}

function normalizeWorkspace(body) {
  return {
    status: typeof body.status === 'string' ? body.status : 'active',
    summary: String(body.summary || ''),
    liveUrl: String(body.liveUrl || ''),
    projectName: String(body.projectName || ''),
    next: arr(body.next).filter(withId),
    achieved: arr(body.achieved).filter(withId),
    notes: String(body.notes || ''),
    links: arr(body.links).filter((l) => l && typeof l === 'object'),
  };
}

async function handleGetWorkspace(env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const stored = await readJson(env, WS_PREFIX + id);
  return json({ ...emptyWorkspace(), ...(stored || {}) });
}

async function handlePutWorkspace(env, request, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const body = await request.json();
  const prev = { ...emptyWorkspace(), ...((await readJson(env, WS_PREFIX + id)) || {}) };
  const doc = {
    ...normalizeWorkspace(body),
    timeZone: requestTimeZone(request) || prev.timeZone || '',
    calOrphans: arr(prev.calOrphans),
  };
  const sync = await runSync(env, doc, workspaceEntries(prev, id), workspaceEntries(doc, id));
  doc.updatedAt = nowIso();
  await writeJson(env, WS_PREFIX + id, doc);
  return json({ ...doc, sync });
}

async function listWorkspaces(env) {
  const out = {};
  let cursor;
  do {
    const list = await kv(env).list({ prefix: WS_PREFIX, cursor });
    const docs = await Promise.all(list.keys.map((k) => kv(env).get(k.name, 'json')));
    list.keys.forEach((k, i) => { if (docs[i]) out[k.name.slice(WS_PREFIX.length)] = docs[i]; });
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return out;
}

async function handleGetAllWorkspaces(env) {
  return json(await listWorkspaces(env));
}

// --------------------------------------------------------- custom projects ----

async function readCustomProjects(env) {
  return arr(await readJson(env, CUSTOM_KEY));
}

async function handleGetProjects(env) {
  return json(await readCustomProjects(env));
}

async function handlePostProject(env, request) {
  const body = await request.json();
  const name = (body.name || '').trim();
  if (!name) return json({ error: 'name is required' }, 400);

  const list = await readCustomProjects(env);
  const base = slugify(name) || 'project';
  let slug = base;
  let n = 2;
  while (list.some((p) => p.id === `custom:${slug}`)) slug = `${base}-${n++}`;

  const project = {
    id: `custom:${slug}`,
    name,
    description: (body.description || '').trim(),
    repo: (body.repo || '').trim(),
    liveUrl: (body.liveUrl || '').trim(),
    createdAt: nowIso(),
  };
  list.unshift(project);
  await writeJson(env, CUSTOM_KEY, list);
  return json(project, 201);
}

async function handlePatchProject(env, request, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const body = await request.json();
  const list = await readCustomProjects(env);
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return json({ error: 'project not found' }, 404);
  for (const k of ['name', 'description', 'repo', 'liveUrl']) if (k in body) list[idx][k] = String(body[k] || '').trim();
  await writeJson(env, CUSTOM_KEY, list);
  return json(list[idx]);
}

async function handleDeleteProject(env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const list = await readCustomProjects(env);
  await writeJson(env, CUSTOM_KEY, list.filter((p) => p.id !== id));

  // Take the project's mirrored calendar events with it.
  const ws = await readJson(env, WS_PREFIX + id);
  if (ws) {
    const empty = { ...emptyWorkspace(), calOrphans: arr(ws.calOrphans) };
    await runSync(env, empty, workspaceEntries(ws, id), []);
  }
  await kv(env).delete(WS_PREFIX + id);
  return json({ deleted: id });
}

// ------------------------------------------------------------ backup ----

// Full dump of everything in KV, so the only copy of your notes is never
// stuck inside Cloudflare.
async function handleExport(env) {
  return json({
    version: 2,
    exportedAt: nowIso(),
    plan: (await readJson(env, PLAN_KEY)) || null,
    habits: (await readJson(env, HABITS_KEY)) || null,
    customProjects: await readCustomProjects(env),
    workspaces: await listWorkspaces(env),
  });
}

async function handleImport(env, request) {
  const body = await request.json();
  let written = 0;
  if (body.plan && typeof body.plan === 'object') { await writeJson(env, PLAN_KEY, body.plan); written++; }
  if (body.habits && typeof body.habits === 'object') { await writeJson(env, HABITS_KEY, body.habits); written++; }
  if (Array.isArray(body.customProjects)) { await writeJson(env, CUSTOM_KEY, body.customProjects); written++; }
  for (const [id, doc] of Object.entries(body.workspaces || {})) {
    if (!doc) continue;
    await writeJson(env, WS_PREFIX + id, doc);
    written++;
  }
  return json({ written });
}

// -------------------------------------------------------------- calendar ----

// Access tokens live ~1h; cache in module scope so warm isolates skip the
// refresh round-trip.
let googleToken = { value: null, expiresAt: 0 };

async function googleAccessToken(env) {
  const now = Date.now();
  if (googleToken.value && googleToken.expiresAt > now + 60_000) return googleToken.value;

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    const err = new Error('Google Calendar is not configured on this worker yet');
    err.status = 503;
    throw err;
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Google token refresh failed (${res.status}): ${detail.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  const tok = await res.json();
  googleToken = { value: tok.access_token, expiresAt: now + (tok.expires_in || 3600) * 1000 };
  return googleToken.value;
}

async function gcal(env, path, init = {}) {
  const token = await googleAccessToken(env);
  const res = await fetch(`${GCAL_API}${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    let message = `Google Calendar API returned ${res.status}`;
    try { message = JSON.parse(detail).error?.message || message; } catch {}
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

function calendarConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

const enc = encodeURIComponent;

function shapeEvent(e) {
  const priv = e.extendedProperties?.private || {};
  return {
    id: e.id,
    summary: e.summary || '(no title)',
    description: e.description || '',
    location: e.location || '',
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    status: e.status,
    htmlLink: e.htmlLink,
    recurringEventId: e.recurringEventId || null,
    attendees: (e.attendees || []).map((a) => a.email),
    hangoutLink: e.hangoutLink || null,
    cpKind: priv.cpKind || null,
    cpId: priv.cpId || null,
    cpOwner: priv.cpOwner || null,
  };
}

// ------------------------------------------------ Control Panel calendar ----
//
// Everything with a date on this site (tasks, roadmap phases and milestones,
// project next steps) is mirrored into a dedicated Google calendar, so it
// shows up on your phone and can be hidden or recoloured in Google as one
// unit. Items remember their event id and a hash of what was last written,
// so a save only touches Google for items that actually changed.

let cpCalCache = null;

async function cpCalendarId(env) {
  if (cpCalCache) return cpCalCache;
  let id = await kv(env).get(CP_CAL_KEY);
  if (!id) {
    const list = await gcal(env, '/users/me/calendarList?minAccessRole=owner&maxResults=250');
    const found = (list.items || []).find((c) => c.summary === CP_CAL_NAME);
    if (found) {
      id = found.id;
    } else {
      const primary = await gcal(env, '/calendars/primary');
      const created = await gcal(env, '/calendars', {
        method: 'POST',
        body: JSON.stringify({
          summary: CP_CAL_NAME,
          description: `Mirrored from ${SITE_URL}. Edit these on the site; changes made here are overwritten.`,
          timeZone: primary.timeZone,
        }),
      });
      id = created.id;
    }
    await kv(env).put(CP_CAL_KEY, id);
  }
  cpCalCache = id;
  return id;
}

async function forgetCpCalendar(env) {
  cpCalCache = null;
  await kv(env).delete(CP_CAL_KEY);
}

const isDateKey = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s);
const pad2 = (n) => String(n).padStart(2, '0');

function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// All-day unless a time (and a zone to read it in) is known.
function eventWhen(date, time, minutes, timeZone) {
  if (isTime(time) && timeZone) {
    const [h, mi] = time.split(':').map(Number);
    let total = h * 60 + mi + minutes;
    let endDate = date;
    if (total >= 1440) { endDate = addDaysKey(date, 1); total -= 1440; }
    return {
      start: { dateTime: `${date}T${time}:00`, timeZone },
      end: { dateTime: `${endDate}T${pad2(Math.floor(total / 60))}:${pad2(total % 60)}:00`, timeZone },
    };
  }
  return { start: { date }, end: { date: addDaysKey(date, 1) } };
}

function cpProps(kind, id, owner) {
  return { private: { cp: '1', cpKind: kind, cpId: id, cpOwner: owner || '' } };
}

function taskSpec(t, timeZone) {
  if (!isDateKey(t.due)) return null;
  return {
    summary: `${t.done ? '✓' : '○'} ${t.title || 'Untitled task'}`,
    description: [
      t.priority ? `Priority: ${t.priority}` : '',
      t.notes || '',
      `Open in Plan: ${SITE_URL}/pages/plan.html`,
    ].filter(Boolean).join('\n\n'),
    ...eventWhen(t.due, t.time, 30, timeZone),
    transparency: 'transparent',
    extendedProperties: cpProps('task', t.id, 'plan'),
  };
}

function phaseSpec(r, ph) {
  const start = isDateKey(ph.start) ? ph.start : null;
  const end = isDateKey(ph.end) ? ph.end : start;
  if (!start || !end || end < start) return null;
  return {
    summary: `▸ ${r.title}: ${ph.title}`,
    description: [ph.notes || '', `Roadmap: ${SITE_URL}/pages/plan.html#roadmap=${enc(r.id)}`].filter(Boolean).join('\n\n'),
    start: { date: start },
    end: { date: addDaysKey(end, 1) },
    transparency: 'transparent',
    extendedProperties: cpProps('phase', ph.id, r.id),
  };
}

function milestoneSpec(r, ph, it) {
  if (!isDateKey(it.due)) return null;
  return {
    summary: `${it.done ? '✓' : '◆'} ${it.title} — ${r.title}`,
    description: `${ph.title}\n\nRoadmap: ${SITE_URL}/pages/plan.html#roadmap=${enc(r.id)}`,
    start: { date: it.due },
    end: { date: addDaysKey(it.due, 1) },
    transparency: 'transparent',
    extendedProperties: cpProps('milestone', it.id, r.id),
  };
}

function stepSpec(ws, projectId, s, done) {
  if (!isDateKey(s.due)) return null;
  const project = ws.projectName || projectId.replace(/^gh:[^/]+\/|^custom:/, '');
  return {
    summary: `${done ? '✓' : '○'} ${s.text || 'Next step'} · ${project}`,
    description: [
      s.priority ? `Priority: ${s.priority}` : '',
      `Project: ${SITE_URL}/pages/project.html?id=${enc(projectId)}`,
    ].filter(Boolean).join('\n\n'),
    ...eventWhen(s.due, s.time, 30, ws.timeZone),
    transparency: 'transparent',
    extendedProperties: cpProps('step', s.id, projectId),
  };
}

// [item, spec|null] pairs. `item` is the live object, so sync results
// (calEventId / calHash) are written straight back into the document.
function planEntries(doc) {
  const out = [];
  for (const t of arr(doc.tasks)) out.push([t, taskSpec(t, doc.timeZone)]);
  for (const r of arr(doc.roadmaps)) {
    for (const ph of arr(r.phases)) {
      out.push([ph, phaseSpec(r, ph)]);
      for (const it of arr(ph.items)) out.push([it, milestoneSpec(r, ph, it)]);
    }
  }
  return out;
}

function workspaceEntries(doc, projectId) {
  return [
    ...arr(doc.next).map((s) => [s, stepSpec(doc, projectId, s, false)]),
    // Finished steps keep their (ticked) event if they had a date.
    ...arr(doc.achieved).map((s) => [s, stepSpec(doc, projectId, s, true)]),
  ];
}

function hashOf(value) {
  const s = JSON.stringify(value);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

async function deleteCpEvent(env, calId, eventId) {
  try {
    await gcal(env, `/calendars/${enc(calId)}/events/${enc(eventId)}`, { method: 'DELETE' });
  } catch (e) {
    if (e.status !== 404 && e.status !== 410) throw e;
  }
}

async function writeCpEvent(env, calId, item, spec) {
  if (item.calEventId) {
    try {
      await gcal(env, `/calendars/${enc(calId)}/events/${enc(item.calEventId)}`, { method: 'PUT', body: JSON.stringify(spec) });
      return;
    } catch (e) {
      // Deleted by hand in Google — fall through and recreate it.
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
  try {
    const created = await gcal(env, `/calendars/${enc(calId)}/events`, { method: 'POST', body: JSON.stringify(spec) });
    item.calEventId = created.id;
  } catch (e) {
    // The whole Control Panel calendar was deleted; make a new one next time.
    if (e.status === 404) await forgetCpCalendar(env);
    throw e;
  }
}

// Workers cap subrequests per invocation, so each request does at most this
// many Google writes. Anything left over is reported as pending and the page
// finishes it through /api/calendar/sync.
const SYNC_BUDGET = 35;

async function syncEntries(env, doc, prevEntries, nextEntries, budget) {
  const calId = await cpCalendarId(env);
  let pending = false;
  const spend = () => (budget.left-- > 0);

  // Events whose items were deleted in an earlier, budget-limited save.
  const orphans = arr(doc.calOrphans);
  doc.calOrphans = [];
  for (const eventId of orphans) {
    if (!spend()) { doc.calOrphans.push(eventId); pending = true; continue; }
    await deleteCpEvent(env, calId, eventId);
  }

  const prevById = new Map(prevEntries.map(([item]) => [item.id, item]));
  const seen = new Set();

  for (const [item, spec] of nextEntries) {
    seen.add(item.id);
    // The page may not know an id the server assigned a moment ago.
    const prev = prevById.get(item.id);
    if (prev && prev.calEventId && !item.calEventId) {
      item.calEventId = prev.calEventId;
      item.calHash = prev.calHash;
    }

    if (!spec) {
      if (!item.calEventId) continue;
      if (!spend()) { pending = true; continue; }
      await deleteCpEvent(env, calId, item.calEventId);
      delete item.calEventId;
      delete item.calHash;
      continue;
    }

    const hash = hashOf(spec);
    if (item.calEventId && item.calHash === hash) continue;
    if (!spend()) { pending = true; continue; }
    await writeCpEvent(env, calId, item, spec);
    item.calHash = hash;
  }

  for (const [item] of prevEntries) {
    if (seen.has(item.id) || !item.calEventId) continue;
    if (!spend()) { doc.calOrphans.push(item.calEventId); pending = true; continue; }
    await deleteCpEvent(env, calId, item.calEventId);
  }

  return pending;
}

// Calendar trouble must never block saving your work: the doc is saved
// either way and anything unsynced is retried on the next save or sync.
async function runSync(env, doc, prevEntries, nextEntries, budget = { left: SYNC_BUDGET }) {
  if (!calendarConfigured(env)) return { enabled: false };
  try {
    const pending = await syncEntries(env, doc, prevEntries, nextEntries, budget);
    return { enabled: true, pending };
  } catch (e) {
    return { enabled: true, pending: true, error: e.message };
  }
}

// Re-run the mirror over every document. Used to finish pending work, and to
// back-fill everything the first time Google is connected.
async function handleSync(env) {
  if (!calendarConfigured(env)) return json({ enabled: false });
  const budget = { left: SYNC_BUDGET };
  let pending = false;
  const errors = [];

  // Make sure the calendar exists even before anything has a date.
  try {
    await cpCalendarId(env);
  } catch (e) {
    return json({ enabled: true, pending: false, error: e.message });
  }

  const plan = await readJson(env, PLAN_KEY);
  if (plan) {
    const before = JSON.stringify(plan);
    const res = await runSync(env, plan, planEntries(plan), planEntries(plan), budget);
    pending ||= Boolean(res.pending);
    if (res.error) errors.push(res.error);
    if (JSON.stringify(plan) !== before) await writeJson(env, PLAN_KEY, plan);
  }

  const workspaces = await listWorkspaces(env);
  for (const [id, ws] of Object.entries(workspaces)) {
    if (budget.left <= 0) { pending = true; break; }
    const before = JSON.stringify(ws);
    const res = await runSync(env, ws, workspaceEntries(ws, id), workspaceEntries(ws, id), budget);
    pending ||= Boolean(res.pending);
    if (res.error) errors.push(res.error);
    if (JSON.stringify(ws) !== before) await writeJson(env, WS_PREFIX + id, ws);
  }

  return json({ enabled: true, pending, error: errors[0] || null });
}

// ------------------------------------------------------- calendar routes ----

async function handleCalendarStatus(env) {
  const configured = calendarConfigured(env);
  return json({ configured, cpCalendarId: configured ? await kv(env).get(CP_CAL_KEY) : null });
}

async function handleGetCalendars(env) {
  const data = await gcal(env, '/users/me/calendarList?maxResults=250');
  const cpId = await kv(env).get(CP_CAL_KEY);
  return json((data.items || []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride || c.summary,
    primary: Boolean(c.primary),
    selected: Boolean(c.selected),
    backgroundColor: c.backgroundColor,
    accessRole: c.accessRole,
    writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    timeZone: c.timeZone,
    controlPanel: c.id === cpId,
  })));
}

async function fetchEvents(env, calendarId, timeMin, timeMax, maxResults = '250') {
  const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults, timeMin });
  if (timeMax) params.set('timeMax', timeMax);
  const data = await gcal(env, `/calendars/${enc(calendarId)}/events?${params}`);
  return data.items || [];
}

// Events from several calendars at once, tagged with each calendar's colour.
// With no `calendars` param it uses the ones you have switched on in Google,
// plus the Control Panel calendar.
async function handleAgenda(env, url) {
  const timeMin = url.searchParams.get('timeMin') || nowIso();
  const timeMax = url.searchParams.get('timeMax');
  const requested = (url.searchParams.get('calendars') || '').split(',').filter(Boolean);

  const list = await gcal(env, '/users/me/calendarList?maxResults=250');
  const cpId = await kv(env).get(CP_CAL_KEY);
  const calendars = (list.items || []).filter((c) =>
    requested.length ? requested.includes(c.id) : (c.selected || c.primary || c.id === cpId));

  const failed = [];
  const groups = await Promise.all(calendars.map(async (c) => {
    try {
      const items = await fetchEvents(env, c.id, timeMin, timeMax);
      return items
        .filter((e) => e.status !== 'cancelled')
        .map((e) => ({
          ...shapeEvent(e),
          calendarId: c.id,
          calendarName: c.summaryOverride || c.summary,
          color: c.backgroundColor,
          writable: c.accessRole === 'owner' || c.accessRole === 'writer',
          controlPanel: c.id === cpId,
        }));
    } catch {
      failed.push(c.summary);
      return [];
    }
  }));

  return json({ events: groups.flat(), failed });
}

async function handleGetEvents(env, url) {
  const calendarId = url.searchParams.get('calendarId') || 'primary';
  const items = await fetchEvents(env, calendarId,
    url.searchParams.get('timeMin') || nowIso(),
    url.searchParams.get('timeMax'),
    url.searchParams.get('maxResults') || '250');
  return json({ events: items.map((e) => ({ ...shapeEvent(e), calendarId })) });
}

// Google wants {date} for all-day and {dateTime,timeZone} for timed events.
function toGoogleTime(value, allDay, timeZone) {
  if (allDay) return { date: value.slice(0, 10) };
  return { dateTime: value, timeZone: timeZone || undefined };
}

function eventPayload(body) {
  const payload = {};
  if ('summary' in body) payload.summary = body.summary;
  if ('description' in body) payload.description = body.description;
  if ('location' in body) payload.location = body.location;
  if (body.start) payload.start = toGoogleTime(body.start, body.allDay, body.timeZone);
  if (body.end) payload.end = toGoogleTime(body.end, body.allDay, body.timeZone);
  if (Array.isArray(body.attendees)) {
    payload.attendees = body.attendees.filter(Boolean).map((email) => ({ email }));
  }
  return payload;
}

async function handleCreateEvent(env, request, url) {
  const calendarId = url.searchParams.get('calendarId') || 'primary';
  const body = await request.json();
  if (!body.summary || !body.start || !body.end) {
    return json({ error: 'summary, start and end are required' }, 400);
  }
  const created = await gcal(env, `/calendars/${enc(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(eventPayload(body)),
  });
  return json({ ...shapeEvent(created), calendarId }, 201);
}

async function handleUpdateEvent(env, request, url) {
  const calendarId = url.searchParams.get('calendarId') || 'primary';
  const eventId = url.searchParams.get('eventId');
  if (!eventId) return json({ error: 'eventId query param required' }, 400);
  const body = await request.json();
  const updated = await gcal(env, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(eventPayload(body)),
  });
  return json({ ...shapeEvent(updated), calendarId });
}

async function handleDeleteEvent(env, url) {
  const calendarId = url.searchParams.get('calendarId') || 'primary';
  const eventId = url.searchParams.get('eventId');
  if (!eventId) return json({ error: 'eventId query param required' }, 400);
  await gcal(env, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'DELETE' });
  return json({ deleted: eventId });
}

// ----------------------------------------------------------------- router ----

const ROUTES = [
  ['GET',    '/api/data',               (c) => handleGetData(c.env)],
  ['PUT',    '/api/data',               (c) => handlePutData(c.env, c.request)],
  ['GET',    '/api/repos',              (c) => handleGetRepos(c.env)],
  ['GET',    '/api/repo',               (c) => handleGetRepoDetail(c.env, c.url)],
  ['GET',    '/api/languages',          (c) => handleGetLanguages(c.env, c.url)],
  ['GET',    '/api/plan',               (c) => handleGetPlan(c.env)],
  ['PUT',    '/api/plan',               (c) => handlePutPlan(c.env, c.request)],
  ['GET',    '/api/habits',             (c) => handleGetHabits(c.env)],
  ['PUT',    '/api/habits',             (c) => handlePutHabits(c.env, c.request)],
  ['GET',    '/api/workspace',          (c) => handleGetWorkspace(c.env, c.url)],
  ['PUT',    '/api/workspace',          (c) => handlePutWorkspace(c.env, c.request, c.url)],
  ['GET',    '/api/workspaces',         (c) => handleGetAllWorkspaces(c.env)],
  ['GET',    '/api/projects',           (c) => handleGetProjects(c.env)],
  ['POST',   '/api/projects',           (c) => handlePostProject(c.env, c.request)],
  ['PATCH',  '/api/projects',           (c) => handlePatchProject(c.env, c.request, c.url)],
  ['DELETE', '/api/projects',           (c) => handleDeleteProject(c.env, c.url)],
  ['GET',    '/api/export',             (c) => handleExport(c.env)],
  ['POST',   '/api/import',             (c) => handleImport(c.env, c.request)],
  ['GET',    '/api/calendar/status',    (c) => handleCalendarStatus(c.env)],
  ['GET',    '/api/calendar/calendars', (c) => handleGetCalendars(c.env)],
  ['GET',    '/api/calendar/agenda',    (c) => handleAgenda(c.env, c.url)],
  ['POST',   '/api/calendar/sync',      (c) => handleSync(c.env)],
  ['GET',    '/api/calendar/events',    (c) => handleGetEvents(c.env, c.url)],
  ['POST',   '/api/calendar/events',    (c) => handleCreateEvent(c.env, c.request, c.url)],
  ['PATCH',  '/api/calendar/events',    (c) => handleUpdateEvent(c.env, c.request, c.url)],
  ['DELETE', '/api/calendar/events',    (c) => handleDeleteEvent(c.env, c.url)],
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const route = ROUTES.find(([method, path]) => path === url.pathname && method === request.method);
    if (!route) {
      const pathExists = ROUTES.some(([, path]) => path === url.pathname);
      return json({ error: pathExists ? 'Method not allowed' : 'Not found' }, pathExists ? 405 : 404);
    }
    try {
      return await route[2]({ env, request, url });
    } catch (e) {
      return json({ error: e.message || 'Internal error' }, e.status || 500);
    }
  },
};
