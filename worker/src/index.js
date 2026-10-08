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

// ------------------------------------------------------------- workspaces ----

const WS_PREFIX = 'ws:';
const CUSTOM_KEY = 'projects:custom';

function emptyWorkspace() {
  return {
    status: 'active',
    summary: '',
    liveUrl: '',
    tasks: [],
    milestones: [],
    links: [],
    thinking: '',
    design: '',
    updatedAt: null,
  };
}

function kv(env) {
  if (!env.WORKSPACE) throw new Error('WORKSPACE KV namespace is not bound to this worker');
  return env.WORKSPACE;
}

async function handleGetWorkspace(env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const stored = await kv(env).get(WS_PREFIX + id, 'json');
  return json(stored ? { ...emptyWorkspace(), ...stored } : emptyWorkspace());
}

async function handlePutWorkspace(env, request, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const body = await request.json();
  const doc = { ...emptyWorkspace(), ...body, updatedAt: new Date().toISOString() };
  await kv(env).put(WS_PREFIX + id, JSON.stringify(doc));
  return json(doc);
}

async function handleGetAllWorkspaces(env) {
  // Seed first: the dashboard asks for repos, projects and workspaces in
  // parallel, and the seeded program's workspace should be in this response.
  await readCustomProjects(env);
  const out = {};
  let cursor;
  do {
    const list = await kv(env).list({ prefix: WS_PREFIX, cursor });
    for (const k of list.keys) {
      const doc = await kv(env).get(k.name, 'json');
      if (doc) out[k.name.slice(WS_PREFIX.length)] = doc;
    }
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return json(out);
}

// The 13-week SWE prep program ships as a seeded project so the dashboard is
// useful on first load instead of empty.
function sweprepSeed() {
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
  return {
    id: 'custom:swe-prep-13-week',
    name: '13-Week SWE Prep',
    description: 'Structured 13-week run at interview readiness: DS&A by topic, then system design, stories and mocks.',
    kind: 'program',
    liveUrl: '',
    repo: '',
    createdAt: new Date().toISOString(),
    seededWorkspace: {
      ...emptyWorkspace(),
      status: 'active',
      summary: 'One topic per week, each closed out with a timed mock before moving on.',
      milestones: weeks.map((label, i) => ({
        id: `week-${i + 1}`,
        label: `Week ${i + 1} — ${label}`,
        done: false,
        due: '',
      })),
      tasks: [
        { id: 'seed-1', text: 'Pick the problem set / book for week 1', lane: 'next', created: new Date().toISOString() },
        { id: 'seed-2', text: 'Block daily study time on the calendar', lane: 'next', created: new Date().toISOString() },
      ],
      thinking: 'What "ready" looks like at the end of 13 weeks, and how I will know:\n\n',
      design: 'Weekly shape: 5 days of problems, 1 day review, 1 timed mock.\n\n',
    },
  };
}

async function readCustomProjects(env) {
  const store = kv(env);
  let list = await store.get(CUSTOM_KEY, 'json');
  if (!Array.isArray(list)) {
    // First run: seed the SWE prep program and its workspace.
    const seed = sweprepSeed();
    const { seededWorkspace, ...project } = seed;
    list = [project];
    await store.put(CUSTOM_KEY, JSON.stringify(list));
    const existing = await store.get(WS_PREFIX + project.id, 'json');
    if (!existing) {
      await store.put(WS_PREFIX + project.id, JSON.stringify({ ...seededWorkspace, updatedAt: new Date().toISOString() }));
    }
  }
  return list;
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
    kind: body.kind || 'project',
    repo: (body.repo || '').trim(),
    liveUrl: (body.liveUrl || '').trim(),
    createdAt: new Date().toISOString(),
  };
  list.unshift(project);
  await kv(env).put(CUSTOM_KEY, JSON.stringify(list));
  return json(project, 201);
}

async function handlePatchProject(env, request, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const body = await request.json();
  const list = await readCustomProjects(env);
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) return json({ error: 'project not found' }, 404);
  const allowed = ['name', 'description', 'kind', 'repo', 'liveUrl'];
  for (const k of allowed) if (k in body) list[idx][k] = body[k];
  await kv(env).put(CUSTOM_KEY, JSON.stringify(list));
  return json(list[idx]);
}

async function handleDeleteProject(env, url) {
  const id = url.searchParams.get('id');
  if (!id) return json({ error: 'id query param required' }, 400);
  const list = await readCustomProjects(env);
  const next = list.filter((p) => p.id !== id);
  await kv(env).put(CUSTOM_KEY, JSON.stringify(next));
  await kv(env).delete(WS_PREFIX + id);
  return json({ deleted: id });
}

// Full dump of everything in KV, so the only copy of your thinking is never
// stuck inside Cloudflare.
async function handleExport(env) {
  const store = kv(env);
  const out = { exportedAt: new Date().toISOString(), customProjects: [], workspaces: {} };
  out.customProjects = (await store.get(CUSTOM_KEY, 'json')) || [];
  let cursor;
  do {
    const list = await store.list({ prefix: WS_PREFIX, cursor });
    for (const k of list.keys) out.workspaces[k.name.slice(WS_PREFIX.length)] = await store.get(k.name, 'json');
    cursor = list.list_complete ? null : list.cursor;
  } while (cursor);
  return json(out);
}

async function handleImport(env, request) {
  const body = await request.json();
  const store = kv(env);
  let written = 0;
  if (Array.isArray(body.customProjects)) {
    await store.put(CUSTOM_KEY, JSON.stringify(body.customProjects));
    written++;
  }
  for (const [id, doc] of Object.entries(body.workspaces || {})) {
    if (!doc) continue;
    await store.put(WS_PREFIX + id, JSON.stringify(doc));
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

function shapeEvent(e) {
  return {
    id: e.id,
    calendarId: e.organizer?.email,
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
  };
}

async function handleGetCalendars(env) {
  const data = await gcal(env, '/users/me/calendarList?minAccessRole=writer&maxResults=50');
  return json((data.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: Boolean(c.primary),
    backgroundColor: c.backgroundColor,
    accessRole: c.accessRole,
    timeZone: c.timeZone,
  })));
}

async function handleGetEvents(env, url) {
  const calendarId = url.searchParams.get('calendarId') || 'primary';
  const timeMin = url.searchParams.get('timeMin') || new Date().toISOString();
  const timeMax = url.searchParams.get('timeMax');
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: url.searchParams.get('maxResults') || '250',
    timeMin,
  });
  if (timeMax) params.set('timeMax', timeMax);
  const data = await gcal(env, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  return json({
    timeZone: data.timeZone,
    events: (data.items || []).map((e) => ({ ...shapeEvent(e), calendarId })),
  });
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
  const created = await gcal(env, `/calendars/${encodeURIComponent(calendarId)}/events`, {
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
  const updated = await gcal(env, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify(eventPayload(body)),
  });
  return json({ ...shapeEvent(updated), calendarId });
}

async function handleDeleteEvent(env, url) {
  const calendarId = url.searchParams.get('calendarId') || 'primary';
  const eventId = url.searchParams.get('eventId');
  if (!eventId) return json({ error: 'eventId query param required' }, 400);
  await gcal(env, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, {
    method: 'DELETE',
  });
  return json({ deleted: eventId });
}

async function handleCalendarStatus(env) {
  const configured = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
  return json({ configured });
}

// ----------------------------------------------------------------- router ----

const ROUTES = [
  ['GET',    '/api/data',             (c) => handleGetData(c.env)],
  ['PUT',    '/api/data',             (c) => handlePutData(c.env, c.request)],
  ['GET',    '/api/repos',            (c) => handleGetRepos(c.env)],
  ['GET',    '/api/repo',             (c) => handleGetRepoDetail(c.env, c.url)],
  ['GET',    '/api/languages',        (c) => handleGetLanguages(c.env, c.url)],
  ['GET',    '/api/workspace',        (c) => handleGetWorkspace(c.env, c.url)],
  ['PUT',    '/api/workspace',        (c) => handlePutWorkspace(c.env, c.request, c.url)],
  ['GET',    '/api/workspaces',       (c) => handleGetAllWorkspaces(c.env)],
  ['GET',    '/api/projects',         (c) => handleGetProjects(c.env)],
  ['POST',   '/api/projects',         (c) => handlePostProject(c.env, c.request)],
  ['PATCH',  '/api/projects',         (c) => handlePatchProject(c.env, c.request, c.url)],
  ['DELETE', '/api/projects',         (c) => handleDeleteProject(c.env, c.url)],
  ['GET',    '/api/export',           (c) => handleExport(c.env)],
  ['POST',   '/api/import',           (c) => handleImport(c.env, c.request)],
  ['GET',    '/api/calendar/status',    (c) => handleCalendarStatus(c.env)],
  ['GET',    '/api/calendar/calendars', (c) => handleGetCalendars(c.env)],
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
