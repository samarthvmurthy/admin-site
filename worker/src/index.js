const GITHUB_API = 'https://api.github.com';

function ghHeaders(env, extra) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'admin-site-worker',
    ...extra,
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function ghFetch(env, path, init = {}) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: ghHeaders(env, init.headers),
  });
  return res;
}

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

async function handleGetRepos(env) {
  const res = await ghFetch(env, `/user/repos?per_page=100&sort=updated&affiliation=owner`);
  if (!res.ok) return json({ error: `GitHub API returned ${res.status}` }, res.status);
  const repos = await res.json();
  return json(repos.map((r) => ({
    name: r.name,
    description: r.description,
    html_url: r.html_url,
    homepage: r.homepage,
    private: r.private,
    language: r.language,
    languages_url: r.languages_url,
  })));
}

async function handleGetLanguages(env, url) {
  const repo = url.searchParams.get('repo');
  if (!repo) return json({ error: 'repo query param required (owner/name)' }, 400);
  const res = await ghFetch(env, `/repos/${repo}/languages`);
  if (!res.ok) return json({ error: `GitHub API returned ${res.status}` }, res.status);
  return json(await res.json());
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/data' && request.method === 'GET') return await handleGetData(env);
      if (pathname === '/api/data' && request.method === 'PUT') return await handlePutData(env, request);
      if (pathname === '/api/repos' && request.method === 'GET') return await handleGetRepos(env);
      if (pathname === '/api/languages' && request.method === 'GET') return await handleGetLanguages(env, url);
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || 'Internal error' }, 500);
    }
  },
};
