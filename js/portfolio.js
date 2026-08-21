const API_BASE = '/api';
const OWNER = 'samarthvmurthy';

let fileSha = null;
let defaultBranch = 'main';
let data = null;
let dirty = false;
let ownRepos = null; // repos fetched from GitHub, populated automatically on load

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

// ---- DOM helpers ----
function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
}

function fieldRow(label, inputEl) {
    const row = el('div', 'field-row');
    row.appendChild(el('div', 'field-label', label));
    const val = el('div', 'field-value-plain');
    val.appendChild(inputEl);
    row.appendChild(val);
    return row;
}

function textInput(value, onChange, multiline) {
    const input = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) input.type = 'text';
    input.value = value ?? '';
    input.addEventListener('input', () => { onChange(input.value); markDirty(); });
    return input;
}

function bindPathInput(path, multiline) {
    return textInput(getPath(data, path), (v) => setPath(data, path, v), multiline);
}

function selectInput(value, options, onChange) {
    const select = document.createElement('select');
    select.className = 'select-plain';
    options.forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        if (opt === value) o.selected = true;
        select.appendChild(o);
    });
    select.addEventListener('change', () => { onChange(select.value); markDirty(); });
    return select;
}

function removeBtn(onClick, label) {
    const btn = el('button', 'btn-remove-icon', label || '✕');
    btn.type = 'button';
    btn.title = 'Remove';
    btn.onclick = onClick;
    return btn;
}

function addBtn(label, onClick) {
    const btn = el('button', 'btn-add', `+ ${label}`);
    btn.type = 'button';
    btn.onclick = onClick;
    return btn;
}

// ---- Site & Hero ----
function renderSiteFields() {
    const el2 = document.getElementById('site-fields');
    el2.innerHTML = '';
    el2.appendChild(fieldRow('Page title', bindPathInput('site.title')));
    el2.appendChild(fieldRow('Nav name', bindPathInput('site.navName')));
    el2.appendChild(fieldRow('Typing text', bindPathInput('hero.typingText')));
    el2.appendChild(fieldRow('Hero name', bindPathInput('hero.name')));
    el2.appendChild(fieldRow('Tagline', bindPathInput('hero.tagline', true)));
    el2.appendChild(fieldRow('Hero image path', bindPathInput('hero.image')));
    el2.appendChild(fieldRow('Hero image alt', bindPathInput('hero.imageAlt')));
}

// ---- About ----
function renderAboutFields() {
    const container = document.getElementById('about-fields');
    container.innerHTML = '';
    container.appendChild(fieldRow('Bio', bindPathInput('about.bio', true)));

    const skillsWrap = el('div', 'subsection');
    skillsWrap.appendChild(el('div', 'subfield-label', 'Skill rows'));
    const rowsHost = el('div', 'repeater');
    skillsWrap.appendChild(rowsHost);
    skillsWrap.appendChild(addBtn('Add row', () => {
        data.about.skillRows.push({ reverse: false, skills: [] });
        markDirty();
        renderSkillRows(rowsHost);
    }));
    container.appendChild(skillsWrap);
    renderSkillRows(rowsHost);
}

function renderSkillRows(host) {
    host.innerHTML = '';
    data.about.skillRows.forEach((row, rIndex) => {
        const rowEl = el('div', 'repeater-item');
        const head = el('div', 'repeater-item-row');
        const reverseLabel = el('label', 'checkbox-inline');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!row.reverse;
        cb.addEventListener('change', () => { row.reverse = cb.checked; markDirty(); });
        reverseLabel.appendChild(cb);
        reverseLabel.appendChild(document.createTextNode(' Reverse direction'));
        head.appendChild(reverseLabel);
        head.appendChild(removeBtn(() => {
            data.about.skillRows.splice(rIndex, 1);
            markDirty();
            renderSkillRows(host);
        }));
        rowEl.appendChild(head);

        const chipList = el('div', 'chip-list');
        row.skills.forEach((skill, sIndex) => {
            const chip = el('div', 'chip skill-chip');
            const iconInput = textInput(skill.icon, (v) => { skill.icon = v; });
            iconInput.placeholder = 'devicon-python-plain colored';
            iconInput.className = 'chip-input chip-input-wide';
            const labelInput = textInput(skill.label, (v) => { skill.label = v; });
            labelInput.placeholder = 'Python';
            labelInput.className = 'chip-input';
            chip.appendChild(iconInput);
            chip.appendChild(labelInput);
            chip.appendChild(removeBtn(() => {
                row.skills.splice(sIndex, 1);
                markDirty();
                renderSkillRows(host);
            }));
            chipList.appendChild(chip);
        });
        rowEl.appendChild(chipList);
        rowEl.appendChild(addBtn('Add skill', () => {
            row.skills.push({ icon: '', label: '' });
            markDirty();
            renderSkillRows(host);
        }));
        host.appendChild(rowEl);
    });
}

// ---- Projects ----
function parseOwnerRepo(url) {
    if (!url) return null;
    const m = url.match(/github\.com\/([^\/]+)\/([^\/#?]+)/i);
    if (!m) return null;
    return { owner: m[1], name: m[2].replace(/\.git$/, '') };
}

function projectSourceUrl(project) {
    const link = (project.links || []).find((l) => /github\.com/.test(l.url || ''));
    return link ? link.url : null;
}

async function fetchLanguagesFor(ownerRepo) {
    if (!ownerRepo) return [];
    try {
        const res = await fetch(`${API_BASE}/languages?repo=${encodeURIComponent(`${ownerRepo.owner}/${ownerRepo.name}`)}`);
        if (!res.ok) return [];
        const langBytes = await res.json();
        const total = Object.values(langBytes).reduce((a, b) => a + b, 0) || 1;
        return Object.entries(langBytes).map(([name, bytes]) => ({
            name,
            percent: Math.round((bytes / total) * 1000) / 10,
            color: LANG_COLORS[name] || '#8a8f98',
        }));
    } catch (e) {
        return [];
    }
}

const LANG_COLORS = {
    Python: '#3572A5', JavaScript: '#f1e05a', TypeScript: '#3178c6', HTML: '#e34c26',
    CSS: '#563d7c', Java: '#b07219', Kotlin: '#A97BFF', Swift: '#F05138', Go: '#00ADD8',
    Rust: '#dea584', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600', Shell: '#89e051',
    Dockerfile: '#384d54', Ruby: '#701516', PHP: '#4F5D95', Vue: '#41b883', Dart: '#00B4AB',
};

async function autoFetchRepos() {
    const hint = document.getElementById('repo-load-hint');
    hint.textContent = 'Loading your GitHub repositories…';
    try {
        const res = await fetch(`${API_BASE}/repos`);
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        ownRepos = await res.json();
        hint.textContent = '';
    } catch (e) {
        ownRepos = [];
        hint.textContent = 'Could not load your GitHub repositories: ' + e.message;
    }
    renderProjects();
}

function renderProjects() {
    const host = document.getElementById('curated-projects');
    host.innerHTML = '';
    document.getElementById('curated-count-badge').textContent =
        `${data.projects.length} project${data.projects.length === 1 ? '' : 's'}`;
    document.getElementById('more-projects-url').innerHTML = '';
    document.getElementById('more-projects-url').appendChild(bindPathInput('moreProjectsUrl'));

    const curatedUrls = new Set();
    data.projects.forEach((project) => {
        const src = projectSourceUrl(project);
        if (src) curatedUrls.add(src.replace(/\/$/, ''));
    });

    data.projects.forEach((project, index) => {
        host.appendChild(renderProjectRow(project, index, true));
    });

    if (ownRepos) {
        const available = ownRepos.filter((r) => !curatedUrls.has((r.html_url || '').replace(/\/$/, '')));
        if (available.length) {
            const label = el('div', 'subfield-label', 'Other repositories — check to feature on the site');
            host.appendChild(label);
            available.forEach((repo) => {
                host.appendChild(renderAvailableRepoRow(repo));
            });
        }
    }
}

function renderProjectRow(project, index, checked) {
    const row = el('div', 'project-row');

    // Left: checkbox + GitHub module
    const left = el('div', 'project-left');
    const cbLabel = el('label', 'checkbox-inline project-checkbox');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => {
        if (!cb.checked) {
            data.projects.splice(index, 1);
            markDirty();
            renderProjects();
        }
    });
    cbLabel.appendChild(cb);
    cbLabel.appendChild(document.createTextNode(' Featured'));
    left.appendChild(cbLabel);

    const src = projectSourceUrl(project);
    const ownerRepo = parseOwnerRepo(src);
    const module = el('div', 'github-module');
    if (ownerRepo) {
        const nameLine = el('div', 'github-module-name', `${ownerRepo.owner}/${ownerRepo.name}`);
        const link = el('a', 'github-module-link', 'View on GitHub ↗');
        link.href = src;
        link.target = '_blank';
        link.rel = 'noopener';
        module.appendChild(nameLine);
        module.appendChild(link);
    } else {
        module.appendChild(el('div', 'github-module-name', 'No GitHub link yet'));
    }

    const langBar = el('div', 'lang-bar');
    (project.languages || []).forEach((lang) => {
        const seg = el('span', 'lang-seg');
        seg.style.width = `${lang.percent}%`;
        seg.style.background = lang.color || '#8a8f98';
        seg.title = `${lang.name} ${lang.percent}%`;
        langBar.appendChild(seg);
    });
    module.appendChild(langBar);
    const langLegend = el('div', 'lang-legend');
    (project.languages || []).forEach((lang) => {
        langLegend.appendChild(el('span', 'lang-legend-item', `${lang.name} ${lang.percent}%`));
    });
    module.appendChild(langLegend);

    const refreshBtn = el('button', 'btn-edit btn-small', 'Refresh languages');
    refreshBtn.type = 'button';
    refreshBtn.onclick = async () => {
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing…';
        project.languages = await fetchLanguagesFor(ownerRepo);
        markDirty();
        renderProjects();
    };
    module.appendChild(refreshBtn);

    left.appendChild(module);
    row.appendChild(left);

    // Right: editable fields
    const right = el('div', 'project-right');

    right.appendChild(fieldRow('Title', textInput(project.title, (v) => { project.title = v; })));

    // Links
    const linksWrap = el('div', 'subsection');
    linksWrap.appendChild(el('div', 'subfield-label', 'Links'));
    const linksHost = el('div', 'repeater-inline');
    (project.links || []).forEach((link, lIndex) => {
        const row2 = el('div', 'repeater-item-row');
        row2.appendChild(selectInput(link.type, ['source', 'demo'], (v) => { link.type = v; }));
        const urlInput = textInput(link.url, (v) => { link.url = v; });
        urlInput.className = 'chip-input-wide';
        row2.appendChild(urlInput);
        row2.appendChild(removeBtn(() => {
            project.links.splice(lIndex, 1);
            markDirty();
            renderProjects();
        }));
        linksHost.appendChild(row2);
    });
    linksWrap.appendChild(linksHost);
    linksWrap.appendChild(addBtn('Add link', () => {
        if (!project.links) project.links = [];
        project.links.push({ type: 'source', url: '' });
        markDirty();
        renderProjects();
    }));
    right.appendChild(linksWrap);

    // Description paragraphs
    const descWrap = el('div', 'subsection');
    descWrap.appendChild(el('div', 'subfield-label', 'Description paragraphs'));
    const descHost = el('div', 'repeater');
    (project.description || []).forEach((para, dIndex) => {
        const row2 = el('div', 'repeater-item-row');
        const ta = textInput(para, (v) => { project.description[dIndex] = v; }, true);
        row2.appendChild(ta);
        row2.appendChild(removeBtn(() => {
            project.description.splice(dIndex, 1);
            markDirty();
            renderProjects();
        }));
        descHost.appendChild(row2);
    });
    descWrap.appendChild(descHost);
    descWrap.appendChild(addBtn('Add paragraph', () => {
        if (!project.description) project.description = [];
        project.description.push('');
        markDirty();
        renderProjects();
    }));
    right.appendChild(descWrap);

    // Tech icons
    const iconsWrap = el('div', 'subsection');
    iconsWrap.appendChild(el('div', 'subfield-label', 'Tech icons'));
    const iconsHost = el('div', 'repeater');
    (project.techIcons || []).forEach((icon, iIndex) => {
        iconsHost.appendChild(renderTechIconRow(icon, () => {
            project.techIcons.splice(iIndex, 1);
            markDirty();
            renderProjects();
        }));
    });
    iconsWrap.appendChild(iconsHost);
    iconsWrap.appendChild(addBtn('Add tech icon', () => {
        if (!project.techIcons) project.techIcons = [];
        project.techIcons.push({ type: 'devicon', class: '', tooltip: '' });
        markDirty();
        renderProjects();
    }));
    right.appendChild(iconsWrap);

    row.appendChild(right);
    return row;
}

function renderTechIconRow(icon, onRemove) {
    const wrap = el('div', 'repeater-item');
    const head = el('div', 'repeater-item-row');
    head.appendChild(selectInput(icon.type, ['devicon', 'emoji', 'svg'], (v) => {
        icon.type = v;
        renderProjects();
    }));
    const tooltipInput = textInput(icon.tooltip, (v) => { icon.tooltip = v; });
    tooltipInput.placeholder = 'Tooltip';
    tooltipInput.className = 'chip-input-wide';
    head.appendChild(tooltipInput);
    head.appendChild(removeBtn(onRemove));
    wrap.appendChild(head);

    if (icon.type === 'devicon') {
        const input = textInput(icon.class, (v) => { icon.class = v; });
        input.placeholder = 'devicon-python-plain colored';
        wrap.appendChild(input);
    } else if (icon.type === 'emoji') {
        const input = textInput(icon.value, (v) => { icon.value = v; });
        input.placeholder = 'Emoji or HTML entity';
        wrap.appendChild(input);
    } else if (icon.type === 'svg') {
        const input = textInput(icon.content, (v) => { icon.content = v; }, true);
        input.placeholder = 'Inner SVG markup';
        wrap.appendChild(input);
    }
    return wrap;
}

function renderAvailableRepoRow(repo) {
    const row = el('div', 'project-row project-row-available');
    const left = el('div', 'project-left');
    const cbLabel = el('label', 'checkbox-inline project-checkbox');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = false;
    cb.addEventListener('change', async () => {
        if (!cb.checked) return;
        cb.disabled = true;
        const links = [{ type: 'source', url: repo.html_url }];
        if (repo.homepage) links.unshift({ type: 'demo', url: repo.homepage });
        const languages = await fetchLanguagesFor({ owner: OWNER, name: repo.name });
        data.projects.push({
            title: repo.name,
            links,
            description: [repo.description || ''],
            languages,
            techIcons: [],
        });
        markDirty();
        renderProjects();
    });
    cbLabel.appendChild(cb);
    cbLabel.appendChild(document.createTextNode(' Featured'));
    left.appendChild(cbLabel);

    const module = el('div', 'github-module');
    module.appendChild(el('div', 'github-module-name', repo.name));
    if (repo.description) module.appendChild(el('div', 'github-module-desc', repo.description));
    const meta = el('div', 'github-module-meta', repo.private ? 'private' : (repo.language || ''));
    module.appendChild(meta);
    const link = el('a', 'github-module-link', 'View on GitHub ↗');
    link.href = repo.html_url;
    link.target = '_blank';
    link.rel = 'noopener';
    module.appendChild(link);
    left.appendChild(module);
    row.appendChild(left);
    row.appendChild(el('div', 'project-right project-right-empty', 'Check the box to feature this repository and edit its details.'));
    return row;
}

// ---- Journey ----
function renderJourneyFields() {
    const host = document.getElementById('journey-fields');
    host.innerHTML = '';
    const list = el('div', 'repeater');
    host.appendChild(list);
    host.appendChild(addBtn('Add year', () => {
        data.journey.unshift({ year: '', items: [] });
        markDirty();
        renderYearGroups(list);
    }));
    renderYearGroups(list);
}

function renderYearGroups(list) {
    list.innerHTML = '';
    data.journey.forEach((yearGroup, yIndex) => {
        const block = el('div', 'repeater-item year-block');
        const head = el('div', 'repeater-item-row');
        const yearInput = textInput(yearGroup.year, (v) => { yearGroup.year = v; });
        yearInput.className = 'chip-input-narrow';
        head.appendChild(yearInput);
        head.appendChild(removeBtn(() => {
            data.journey.splice(yIndex, 1);
            markDirty();
            renderYearGroups(list);
        }));
        block.appendChild(head);

        const itemsHost = el('div', 'repeater');
        (yearGroup.items || []).forEach((item, iIndex) => {
            itemsHost.appendChild(renderJourneyItem(item, () => {
                yearGroup.items.splice(iIndex, 1);
                markDirty();
                renderYearGroups(list);
            }));
        });
        block.appendChild(itemsHost);
        block.appendChild(addBtn('Add item', () => {
            if (!yearGroup.items) yearGroup.items = [];
            yearGroup.items.push({ type: 'work', title: '', details: '', leaves: [] });
            markDirty();
            renderYearGroups(list);
        }));
        list.appendChild(block);
    });
}

function renderJourneyItem(item, onRemove) {
    const block = el('div', 'repeater-item item-block');
    const head = el('div', 'repeater-item-row');
    const typeInput = textInput(item.type, (v) => { item.type = v; });
    typeInput.placeholder = 'work / education';
    typeInput.className = 'chip-input-narrow';
    head.appendChild(typeInput);
    head.appendChild(removeBtn(onRemove));
    block.appendChild(head);

    block.appendChild(fieldRow('Title', textInput(item.title, (v) => { item.title = v; })));
    block.appendChild(fieldRow('Details', textInput(item.details, (v) => { item.details = v; })));

    const leavesWrap = el('div', 'subsection');
    leavesWrap.appendChild(el('div', 'subfield-label', 'Details blocks'));
    const leavesHost = el('div', 'repeater');
    (item.leaves || []).forEach((leaf, lIndex) => {
        leavesHost.appendChild(renderLeaf(leaf, () => {
            item.leaves.splice(lIndex, 1);
            markDirty();
            renderJourneyFields();
        }));
    });
    leavesWrap.appendChild(leavesHost);
    leavesWrap.appendChild(addBtn('Add details block', () => {
        if (!item.leaves) item.leaves = [];
        item.leaves.push({ kind: 'impact', items: [''] });
        markDirty();
        renderJourneyFields();
    }));
    block.appendChild(leavesWrap);
    return block;
}

function renderLeaf(leaf, onRemove) {
    const wrap = el('div', 'repeater-item leaf-block');
    const head = el('div', 'repeater-item-row');
    head.appendChild(selectInput(leaf.kind, ['gpa-courses', 'project', 'impact'], (v) => {
        leaf.kind = v;
        renderJourneyFields();
    }));
    head.appendChild(removeBtn(onRemove));
    wrap.appendChild(head);

    if (leaf.kind === 'gpa-courses') {
        wrap.appendChild(fieldRow('GPA', textInput(leaf.gpa, (v) => { leaf.gpa = v; })));
        wrap.appendChild(el('div', 'subfield-label', 'Courses'));
        const chipList = el('div', 'chip-list');
        (leaf.courses || []).forEach((course, cIndex) => {
            const chip = el('div', 'chip');
            const input = textInput(course, (v) => { leaf.courses[cIndex] = v; });
            input.className = 'chip-input';
            chip.appendChild(input);
            chip.appendChild(removeBtn(() => {
                leaf.courses.splice(cIndex, 1);
                markDirty();
                renderJourneyFields();
            }));
            chipList.appendChild(chip);
        });
        wrap.appendChild(chipList);
        wrap.appendChild(addBtn('Add course', () => {
            if (!leaf.courses) leaf.courses = [];
            leaf.courses.push('');
            markDirty();
            renderJourneyFields();
        }));
    } else if (leaf.kind === 'project') {
        wrap.appendChild(fieldRow('Title', textInput(leaf.title, (v) => { leaf.title = v; })));
        wrap.appendChild(fieldRow('Text', textInput(leaf.text, (v) => { leaf.text = v; }, true)));
    } else if (leaf.kind === 'impact') {
        wrap.appendChild(el('div', 'subfield-label', 'Bullet points'));
        const list = el('div', 'repeater');
        (leaf.items || []).forEach((line, lIndex) => {
            const row = el('div', 'repeater-item-row');
            const input = textInput(line, (v) => { leaf.items[lIndex] = v; }, true);
            row.appendChild(input);
            row.appendChild(removeBtn(() => {
                leaf.items.splice(lIndex, 1);
                markDirty();
                renderJourneyFields();
            }));
            list.appendChild(row);
        });
        wrap.appendChild(list);
        wrap.appendChild(addBtn('Add bullet', () => {
            if (!leaf.items) leaf.items = [];
            leaf.items.push('');
            markDirty();
            renderJourneyFields();
        }));
    }
    return wrap;
}

// ---- Contact ----
function renderContactFields() {
    const container = document.getElementById('contact-fields');
    container.innerHTML = '';
    container.appendChild(fieldRow('Heading', bindPathInput('contact.heading')));
    container.appendChild(fieldRow('Intro', bindPathInput('contact.intro', true)));
    container.appendChild(fieldRow('Email', bindPathInput('contact.email')));
    container.appendChild(fieldRow('Location', bindPathInput('contact.location')));
    container.appendChild(fieldRow('Timezone', bindPathInput('contact.timezone')));
    container.appendChild(fieldRow('Resume path', bindPathInput('contact.resume')));

    const socialWrap = el('div', 'subsection');
    socialWrap.appendChild(el('div', 'subfield-label', 'Social links'));
    const socialHost = el('div', 'repeater-inline');
    container.appendChild(socialWrap);
    socialWrap.appendChild(socialHost);
    socialWrap.appendChild(addBtn('Add social link', () => {
        data.contact.social.push({ platform: '', url: '' });
        markDirty();
        renderSocialLinks(socialHost);
    }));
    renderSocialLinks(socialHost);
}

function renderSocialLinks(host) {
    host.innerHTML = '';
    data.contact.social.forEach((social, index) => {
        const row = el('div', 'repeater-item-row');
        const platformInput = textInput(social.platform, (v) => { social.platform = v; });
        platformInput.placeholder = 'Platform';
        platformInput.className = 'chip-input-narrow';
        const urlInput = textInput(social.url, (v) => { social.url = v; });
        urlInput.placeholder = 'https://...';
        urlInput.className = 'chip-input-wide';
        row.appendChild(platformInput);
        row.appendChild(urlInput);
        row.appendChild(removeBtn(() => {
            data.contact.social.splice(index, 1);
            markDirty();
            renderSocialLinks(host);
        }));
        host.appendChild(row);
    });
}

// ---- Top-level render / load / push ----
function renderAll() {
    renderSiteFields();
    renderAboutFields();
    renderProjects();
    renderJourneyFields();
    renderContactFields();
    document.getElementById('app').style.display = 'block';
    document.getElementById('push-bar').style.display = 'flex';
    autoFetchRepos();
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

        document.getElementById('load-hint').textContent = '';
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

document.getElementById('push-btn').onclick = pushToGitHub;

loadData();
