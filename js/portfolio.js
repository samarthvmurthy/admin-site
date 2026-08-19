const API_BASE = '/api';

let fileSha = null;
let defaultBranch = 'main';
let data = null;
let dirty = false;

const LANG_COLORS = {
    Python: '#3572A5', JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26',
    CSS: '#563d7c', Java: '#b07219', Kotlin: '#A97BFF', Swift: '#F05138', Go: '#00ADD8',
    Rust: '#dea584', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Shell: '#89e051',
    Dockerfile: '#384d54', Ruby: '#701516', PHP: '#4F5D95', Vue: '#41b883', Dart: '#00B4AB',
};

function toast(msg, kind) {
    const t = document.createElement('div');
    t.className = `toast${kind ? ' ' + kind : ''}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

function markDirty() {
    dirty = true;
    document.getElementById('dirty-indicator').textContent = 'Unsaved changes — push when ready';
    document.getElementById('dirty-indicator').classList.add('dirty');
    document.getElementById('push-btn').disabled = false;
}

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
}

// ---- Generic frozen-field renderer ----
function renderScalarField(container, label, path, multiline) {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.innerHTML = `
        <div class="field-label">${label}</div>
        <div class="field-value" data-role="value"></div>
        <div class="field-actions"></div>
    `;
    const valueEl = row.querySelector('[data-role="value"]');
    const actionsEl = row.querySelector('.field-actions');

    function showFrozen() {
        valueEl.textContent = getPath(data, path) ?? '';
        actionsEl.innerHTML = '';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-edit';
        editBtn.textContent = 'Edit';
        editBtn.onclick = showEditing;
        actionsEl.appendChild(editBtn);
    }

    function showEditing() {
        const current = getPath(data, path) ?? '';
        valueEl.innerHTML = '';
        const input = document.createElement(multiline ? 'textarea' : 'input');
        if (!multiline) input.type = 'text';
        input.value = current;
        valueEl.appendChild(input);
        input.focus();

        actionsEl.innerHTML = '';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save';
        saveBtn.textContent = 'Save';
        saveBtn.onclick = () => {
            setPath(data, path, input.value);
            markDirty();
            showFrozen();
        };
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = showFrozen;
        actionsEl.appendChild(saveBtn);
        actionsEl.appendChild(cancelBtn);
    }

    showFrozen();
    container.appendChild(row);
}

// ---- JSON-block renderer for nested structures ----
function renderJsonField(container, label, path, onDelete) {
    const row = document.createElement('div');
    row.className = 'field-row';
    row.innerHTML = `
        <div class="field-label">${label}</div>
        <div class="field-value json" data-role="value"></div>
        <div class="field-actions"></div>
    `;
    const valueEl = row.querySelector('[data-role="value"]');
    const actionsEl = row.querySelector('.field-actions');

    function showFrozen() {
        valueEl.textContent = JSON.stringify(getPath(data, path), null, 2);
        actionsEl.innerHTML = '';
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-edit';
        editBtn.textContent = 'Edit';
        editBtn.onclick = showEditing;
        actionsEl.appendChild(editBtn);
        if (onDelete) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn-danger';
            delBtn.textContent = 'Remove';
            delBtn.onclick = () => { onDelete(); };
            actionsEl.appendChild(delBtn);
        }
    }

    function showEditing() {
        const current = JSON.stringify(getPath(data, path), null, 2);
        valueEl.innerHTML = '';
        const textarea = document.createElement('textarea');
        textarea.value = current;
        textarea.style.minHeight = '160px';
        valueEl.appendChild(textarea);
        textarea.focus();

        actionsEl.innerHTML = '';
        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn-save';
        saveBtn.textContent = 'Save';
        saveBtn.onclick = () => {
            try {
                const parsed = JSON.parse(textarea.value);
                setPath(data, path, parsed);
                markDirty();
                showFrozen();
            } catch (e) {
                toast('Invalid JSON: ' + e.message, 'error');
            }
        };
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = showFrozen;
        actionsEl.appendChild(saveBtn);
        actionsEl.appendChild(cancelBtn);
    }

    showFrozen();
    container.appendChild(row);
}

function renderSiteFields() {
    const el = document.getElementById('site-fields');
    el.innerHTML = '';
    renderScalarField(el, 'Page title', 'site.title');
    renderScalarField(el, 'Nav name', 'site.navName');
    renderScalarField(el, 'Typing text', 'hero.typingText');
    renderScalarField(el, 'Hero name', 'hero.name');
    renderScalarField(el, 'Tagline', 'hero.tagline', true);
    renderScalarField(el, 'Hero image path', 'hero.image');
    renderScalarField(el, 'Hero image alt', 'hero.imageAlt');
}

function renderAboutFields() {
    const el = document.getElementById('about-fields');
    el.innerHTML = '';
    renderScalarField(el, 'Bio', 'about.bio', true);
    renderJsonField(el, 'Skill rows', 'about.skillRows');
}

function renderCuratedProjects() {
    const el = document.getElementById('curated-projects');
    el.innerHTML = '';
    document.getElementById('curated-count-badge').textContent = `${data.projects.length} project${data.projects.length === 1 ? '' : 's'}`;
    if (data.projects.length === 0) {
        el.innerHTML = '<div class="empty-state">No projects yet — check some repos below to add them.</div>';
        return;
    }
    data.projects.forEach((project, index) => {
        renderJsonField(el, project.title || `Project ${index + 1}`, `projects.${index}`, () => {
            data.projects.splice(index, 1);
            markDirty();
            renderCuratedProjects();
            syncRepoCheckboxes();
        });
    });
    renderScalarField(el, '"See more" GitHub URL', 'moreProjectsUrl');
}

function projectIndexForRepoUrl(url) {
    return data.projects.findIndex((p) => (p.links || []).some((l) => l.url === url));
}

function syncRepoCheckboxes() {
    document.querySelectorAll('#repo-list input[type="checkbox"]').forEach((cb) => {
        cb.checked = projectIndexForRepoUrl(cb.dataset.repoUrl) !== -1;
    });
}

async function toggleRepoProject(repo, checked) {
    if (checked) {
        if (projectIndexForRepoUrl(repo.html_url) !== -1) return;
        let languages = [];
        try {
            const res = await fetch(`${API_BASE}/languages?repo=${encodeURIComponent(`samarthvmurthy/${repo.name}`)}`);
            const langBytes = await res.json();
            const total = Object.values(langBytes).reduce((a, b) => a + b, 0) || 1;
            languages = Object.entries(langBytes).map(([name, bytes]) => ({
                name,
                percent: Math.round((bytes / total) * 1000) / 10,
                color: LANG_COLORS[name] || '#8a8f98',
            }));
        } catch (e) {
            // languages are a nice-to-have; keep going without them
        }
        const links = [{ type: 'source', url: repo.html_url }];
        if (repo.homepage) links.unshift({ type: 'demo', url: repo.homepage });

        data.projects.push({
            title: repo.name,
            links,
            description: [repo.description || ''],
            languages,
            techIcons: [],
        });
    } else {
        const idx = projectIndexForRepoUrl(repo.html_url);
        if (idx !== -1) data.projects.splice(idx, 1);
    }
    markDirty();
    renderCuratedProjects();
}

async function fetchRepos() {
    const btn = document.getElementById('fetch-repos');
    btn.disabled = true;
    btn.textContent = 'Fetching...';
    const listEl = document.getElementById('repo-list');
    listEl.innerHTML = '';
    try {
        const res = await fetch(`${API_BASE}/repos`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const repos = await res.json();
        if (repos.length === 0) {
            listEl.innerHTML = '<div class="empty-state">No repositories found.</div>';
            return;
        }
        repos.forEach((repo) => {
            const row = document.createElement('label');
            row.className = 'repo-item';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.dataset.repoUrl = repo.html_url;
            cb.checked = projectIndexForRepoUrl(repo.html_url) !== -1;
            cb.onchange = () => toggleRepoProject(repo, cb.checked);
            row.appendChild(cb);
            const info = document.createElement('div');
            info.innerHTML = `<div class="repo-name">${repo.name}</div><div class="repo-desc">${repo.description || ''}</div>`;
            row.appendChild(info);
            const meta = document.createElement('div');
            meta.className = 'repo-meta';
            meta.textContent = repo.private ? 'private' : (repo.language || '');
            row.appendChild(meta);
            listEl.appendChild(row);
        });
    } catch (e) {
        toast('Failed to fetch repos: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Fetch my repositories';
    }
}

function renderJourneyFields() {
    const el = document.getElementById('journey-fields');
    el.innerHTML = '';
    data.journey.forEach((yearGroup, yIndex) => {
        renderJsonField(el, `Year ${yearGroup.year}`, `journey.${yIndex}`, () => {
            data.journey.splice(yIndex, 1);
            markDirty();
            renderJourneyFields();
        });
    });
}

function renderContactFields() {
    const el = document.getElementById('contact-fields');
    el.innerHTML = '';
    renderScalarField(el, 'Heading', 'contact.heading');
    renderScalarField(el, 'Intro', 'contact.intro', true);
    renderScalarField(el, 'Email', 'contact.email');
    renderScalarField(el, 'Location', 'contact.location');
    renderScalarField(el, 'Timezone', 'contact.timezone');
    renderScalarField(el, 'Resume path', 'contact.resume');
    renderJsonField(el, 'Social links', 'contact.social');
}

function renderAll() {
    renderSiteFields();
    renderAboutFields();
    renderCuratedProjects();
    renderJourneyFields();
    renderContactFields();
    document.getElementById('app').style.display = 'block';
    document.getElementById('push-bar').style.display = 'flex';
}

async function loadData() {
    document.getElementById('load-hint').textContent = 'Loading data.json...';
    try {
        const res = await fetch(`${API_BASE}/data`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const file = await res.json();
        fileSha = file.sha;
        defaultBranch = file.defaultBranch || 'main';
        data = file.content;

        document.getElementById('load-hint').textContent = `Loaded data.json (${file.size} bytes).`;
        renderAll();
    } catch (e) {
        document.getElementById('load-hint').textContent = 'Failed to load data.json: ' + e.message;
        toast('Failed to load: ' + e.message, 'error');
    }
}

async function pushToGitHub() {
    const btn = document.getElementById('push-btn');
    btn.disabled = true;
    btn.textContent = 'Pushing...';
    try {
        const message = document.getElementById('commit-message').value || 'Update data.json via admin tool';
        const res = await fetch(`${API_BASE}/data`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: data, message, sha: fileSha, branch: defaultBranch }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `API returned ${res.status}`);
        }
        const result = await res.json();
        fileSha = result.sha;
        dirty = false;
        document.getElementById('dirty-indicator').textContent = 'Pushed — up to date';
        document.getElementById('dirty-indicator').classList.remove('dirty');
        toast('Pushed to GitHub successfully.', 'ok');
    } catch (e) {
        toast('Push failed: ' + e.message, 'error');
    } finally {
        btn.disabled = !dirty;
        btn.textContent = 'Push to GitHub';
    }
}

document.getElementById('fetch-repos').onclick = fetchRepos;
document.getElementById('push-btn').onclick = pushToGitHub;

loadData();
