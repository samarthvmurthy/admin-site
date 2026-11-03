/**
 * Projects: every GitHub repo plus hand-added projects, each as a tile with
 * what's been achieved and what's next. Steps can be added and ticked off
 * right on the tile; the project page has the full view.
 */
(function () {
    const A = window.Admin;

    const STATUS = {
        active: { label: 'Active', pill: 'pill-active' },
        idea: { label: 'Idea', pill: 'pill-idea' },
        paused: { label: 'Paused', pill: 'pill-paused' },
        shipped: { label: 'Shipped', pill: 'pill-shipped' },
    };
    const VIEWS = [
        { key: 'all', label: 'All projects', icon: 'projects' },
        { key: 'steps', label: 'Has next steps', icon: 'upnext' },
        { key: 'active', label: 'Active', icon: 'target' },
        { key: 'shipped', label: 'Shipped', icon: 'check' },
        { key: 'paused', label: 'Paused', icon: 'clock' },
        { key: 'idea', label: 'Ideas', icon: 'inbox' },
        { key: 'untracked', label: 'Untracked', icon: 'layers' },
    ];

    const prefs = (() => {
        try { return JSON.parse(localStorage.getItem('cp:projects') || '{}'); } catch { return {}; }
    })();
    const state = {
        repos: [],
        custom: [],
        workspaces: {},
        roadmaps: [],
        projects: [],
        view: prefs.view || 'all',
        sort: prefs.sort || 'touched',
        forks: Boolean(prefs.forks),
        archived: Boolean(prefs.archived),
        search: '',
        reposLoaded: false,
    };

    function savePrefs() {
        try {
            localStorage.setItem('cp:projects', JSON.stringify({ view: state.view, sort: state.sort, forks: state.forks, archived: state.archived }));
        } catch { /* ignore */ }
    }

    document.querySelectorAll('[data-icon]').forEach((n) => { n.innerHTML = window.Nav.svg(n.dataset.icon, 17); });

    // ------------------------------------------------------------ modelling --

    function buildProjects() {
        const fromRepos = state.repos.map((r) => ({
            id: `gh:${r.full_name}`, name: r.name, description: r.description || '', kind: 'repo',
            repo: r.full_name, liveUrl: r.homepage || '', pushedAt: r.pushed_at, language: r.language,
            private: r.private, fork: r.fork, archived: r.archived, openIssues: r.open_issues_count, topics: r.topics || [],
        }));
        const fromCustom = state.custom.map((p) => ({
            id: p.id, name: p.name, description: p.description || '', kind: 'custom', repo: p.repo || '',
            liveUrl: p.liveUrl || '', pushedAt: p.createdAt, language: null, private: false, fork: false,
            archived: false, openIssues: 0, topics: [],
        }));
        state.projects = [...fromCustom, ...fromRepos];
    }

    function ws(p) { return state.workspaces[p.id] || null; }

    function matchesView(p, view) {
        const w = ws(p);
        switch (view) {
            case 'steps': return Boolean(w?.next?.length);
            case 'untracked': return !w;
            case 'all': return true;
            default: return w?.status === view;
        }
    }

    function baseList() {
        return state.projects.filter((p) => (state.forks || !p.fork) && (state.archived || !p.archived));
    }

    function visible() {
        const q = state.search.toLowerCase();
        const list = baseList().filter((p) => matchesView(p, state.view) && (!q ||
            [p.name, p.description, p.repo, p.topics.join(' '), ws(p)?.summary || ''].join(' ').toLowerCase().includes(q)));
        const byName = (a, b) => a.name.localeCompare(b.name);
        const sorters = {
            name: byName,
            pushed: (a, b) => new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0),
            touched: (a, b) => new Date(ws(b)?.updatedAt || 0) - new Date(ws(a)?.updatedAt || 0)
                || new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0),
            steps: (a, b) => (ws(b)?.next?.length || 0) - (ws(a)?.next?.length || 0) || byName(a, b),
        };
        return list.sort(sorters[state.sort] || sorters.touched);
    }

    // -------------------------------------------------------------- actions --

    async function workspaceFor(p) {
        const doc = A.store.workspace(p.id);
        await doc.load();
        state.workspaces[p.id] = doc.doc;
        doc.doc.projectName = p.name;
        return doc;
    }

    async function addStep(p, text) {
        const doc = await workspaceFor(p);
        doc.doc.next.push({ id: A.uid(), text, due: '', time: '', priority: 'medium', createdAt: new Date().toISOString() });
        doc.save(true);
        rerenderTile(p);
        renderSidebar();
    }

    async function completeStep(p, stepId) {
        const doc = await workspaceFor(p);
        A.items.completeStep(doc.doc, stepId);
        doc.save(true);
        rerenderTile(p);
        renderSidebar();
    }

    // ------------------------------------------------------------ rendering --

    function tile(p) {
        const w = ws(p);
        const card = A.el('article', 'ptile');
        card.dataset.id = p.id;

        const head = A.el('div', 'ptile-head');
        const top = A.el('div', 'ptile-top');
        const name = A.el('a', 'ptile-name', p.name);
        name.href = A.projectHref(p.id);
        top.appendChild(name);
        if (p.kind === 'custom') top.appendChild(A.el('span', 'tag', 'Manual'));
        if (p.private && p.kind === 'repo') top.appendChild(A.el('span', 'tag', 'Private'));
        if (p.fork) top.appendChild(A.el('span', 'tag', 'Fork'));
        if (p.archived) top.appendChild(A.el('span', 'tag', 'Archived'));
        const st = w ? STATUS[w.status] : null;
        top.appendChild(A.el('span', `pill ${st ? st.pill : 'pill-none'}`, st ? st.label : 'Untracked'));
        head.appendChild(top);

        const desc = w?.summary || p.description;
        if (desc) head.appendChild(A.el('p', 'ptile-desc', desc));

        const meta = A.el('div', 'ptile-meta');
        if (p.language) {
            const lang = A.el('span', 'meta-item');
            const dot = A.el('span', 'lang-dot');
            dot.style.background = A.langColor(p.language);
            lang.appendChild(dot);
            lang.appendChild(A.el('span', null, p.language));
            meta.appendChild(lang);
        }
        if (p.kind === 'repo' && p.pushedAt) meta.appendChild(A.el('span', 'meta-item', `pushed ${A.relativeTime(p.pushedAt)}`));
        if (p.openIssues) meta.appendChild(A.el('span', 'meta-item', `${p.openIssues} issue${p.openIssues === 1 ? '' : 's'}`));
        const live = w?.liveUrl || p.liveUrl;
        if (live) meta.appendChild(A.externalLink('live ↗', live, 'meta-live'));
        A.projectTools(p.id).forEach((t) => {
            const a = A.link(t.label, t.href, 'meta-item inline-link');
            a.title = t.hint || t.label;
            meta.appendChild(a);
        });
        if (meta.children.length) head.appendChild(meta);
        card.appendChild(head);

        // Linked roadmap progress
        const linked = state.roadmaps.filter((r) => r.projectId === p.id);
        if (linked.length) {
            const rm = A.el('div', 'ptile-roadmap');
            linked.forEach((r) => {
                const items = r.phases.flatMap((ph) => ph.items);
                const line = A.el('a', 'ptile-line');
                line.href = A.pageHref(`pages/plan.html#roadmap=${encodeURIComponent(r.id)}`);
                line.style.textDecoration = 'none';
                line.style.color = 'inherit';
                line.appendChild(A.icon('map', 13));
                line.appendChild(A.el('span', 'grow', r.title));
                rm.appendChild(line);
                rm.appendChild(A.progressBar(items.filter((i) => i.done).length, items.length));
            });
            card.appendChild(rm);
        }

        const cols = A.el('div', 'ptile-cols');

        // Achieved
        const achieved = A.el('div', 'ptile-col achieved');
        const ah = A.el('div', 'ptile-col-head');
        ah.appendChild(A.icon('check', 12));
        ah.appendChild(A.el('span', null, 'Achieved'));
        ah.appendChild(A.el('span', 'count', String(w?.achieved?.length || 0)));
        achieved.appendChild(ah);
        const done = (w?.achieved || []).slice(0, 3);
        if (!done.length) achieved.appendChild(A.el('div', 'ptile-empty', 'Nothing logged yet.'));
        done.forEach((a) => {
            const line = A.el('div', 'ptile-line');
            line.appendChild(A.icon('check', 12, 'ok-mark'));
            line.appendChild(A.el('span', 'grow', a.text));
            if (a.date) line.appendChild(A.el('span', 'when', A.dueLabel(a.date).replace(' overdue', ' ago')));
            achieved.appendChild(line);
        });
        if ((w?.achieved?.length || 0) > 3) {
            const more = A.el('a', 'ptile-more', `+${w.achieved.length - 3} more`);
            more.href = A.projectHref(p.id);
            achieved.appendChild(more);
        }
        cols.appendChild(achieved);

        // Next steps
        const next = A.el('div', 'ptile-col next');
        const nh = A.el('div', 'ptile-col-head');
        nh.appendChild(A.icon('upnext', 12));
        nh.appendChild(A.el('span', null, 'Next steps'));
        nh.appendChild(A.el('span', 'count', String(w?.next?.length || 0)));
        next.appendChild(nh);
        const steps = [...(w?.next || [])].sort((a, b) => {
            if (a.due && b.due) return a.due.localeCompare(b.due);
            if (a.due) return -1;
            if (b.due) return 1;
            return A.priorityRank(a.priority) - A.priorityRank(b.priority);
        });
        steps.slice(0, 4).forEach((s) => {
            const line = A.el('div', 'ptile-line');
            line.appendChild(A.checkbox(false, () => {
                line.querySelector('.check').classList.add('on');
                setTimeout(() => completeStep(p, s.id), 220);
            }, `Mark "${s.text}" done`));
            line.appendChild(A.el('span', 'grow', s.text));
            if (s.due) {
                const chip = A.dueChip(s.due);
                chip.classList.add('when');
                line.appendChild(chip);
            }
            next.appendChild(line);
        });
        if (steps.length > 4) {
            const more = A.el('a', 'ptile-more', `+${steps.length - 4} more`);
            more.href = A.projectHref(p.id);
            next.appendChild(more);
        }
        const addWrap = A.el('div', 'ptile-add');
        const add = A.el('input');
        add.type = 'text';
        add.placeholder = '+ Next step';
        add.setAttribute('aria-label', `Add a next step to ${p.name}`);
        add.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !add.value.trim()) return;
            const text = add.value.trim();
            add.value = '';
            addStep(p, text).then(() => {
                document.querySelector(`.ptile[data-id="${CSS.escape(p.id)}"] .ptile-add input`)?.focus();
            });
        });
        addWrap.appendChild(add);
        next.appendChild(addWrap);
        cols.appendChild(next);

        card.appendChild(cols);
        return card;
    }

    function rerenderTile(p) {
        const old = document.querySelector(`.ptile[data-id="${CSS.escape(p.id)}"]`);
        if (old) old.replaceWith(tile(p));
    }

    function renderGrid() {
        const grid = A.clear(document.getElementById('project-grid'));
        const list = visible();
        const hint = document.getElementById('projects-hint');

        if (!state.reposLoaded && !state.custom.length) return;
        if (!list.length) {
            hint.style.display = '';
            hint.textContent = state.search ? `Nothing matches "${state.search}".` : 'No projects in this view.';
        } else {
            hint.style.display = 'none';
        }
        list.forEach((p) => grid.appendChild(tile(p)));

        const tracked = Object.keys(state.workspaces).length;
        const steps = Object.values(state.workspaces).reduce((n, w) => n + (w.next?.length || 0), 0);
        document.getElementById('projects-summary').textContent =
            `${baseList().length} projects · ${tracked} tracked · ${steps} open next step${steps === 1 ? '' : 's'}`;
    }

    function renderSidebar() {
        const base = baseList();
        window.Nav.setSections([
            {
                label: 'View',
                items: VIEWS.map((v) => ({
                    label: v.label,
                    icon: v.icon,
                    active: state.view === v.key,
                    count: base.filter((p) => matchesView(p, v.key)).length || '',
                    onClick: () => { state.view = v.key; savePrefs(); renderSidebar(); renderGrid(); },
                })),
            },
            {
                label: 'Include',
                items: [
                    { label: 'Forks', dot: 'var(--text-dim)', dotOff: !state.forks, onClick: () => { state.forks = !state.forks; savePrefs(); renderSidebar(); renderGrid(); } },
                    { label: 'Archived', dot: 'var(--text-dim)', dotOff: !state.archived, onClick: () => { state.archived = !state.archived; savePrefs(); renderSidebar(); renderGrid(); } },
                ],
            },
        ]);
    }

    function newProjectDialog() {
        A.modal.open({
            title: 'New project',
            description: 'For work that has no repo yet, or lives outside GitHub. Your repos appear here automatically.',
            fields: [
                { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Side app idea' },
                { name: 'description', label: 'Description', type: 'textarea', rows: 2, placeholder: 'One or two lines on what this is.' },
                { name: 'repo', label: 'Linked repo (optional)', placeholder: 'owner/name', hint: 'Link later to pull live GitHub data into the project page.', half: true },
                { name: 'liveUrl', label: 'Live URL (optional)', placeholder: 'https://…', half: true },
            ],
            submitLabel: 'Create project',
            onSubmit: async (v) => {
                const created = await A.api('/projects', { method: 'POST', body: v });
                window.location.href = A.projectHref(created.id);
            },
        });
    }

    // ---------------------------------------------------------------- init --

    function initControls() {
        document.getElementById('new-project-btn').addEventListener('click', newProjectDialog);
        const search = document.getElementById('project-search');
        search.addEventListener('input', A.debounce(() => { state.search = search.value.trim(); renderGrid(); }, 150));
        const sort = document.getElementById('project-sort');
        sort.value = state.sort;
        sort.addEventListener('change', () => { state.sort = sort.value; savePrefs(); renderGrid(); });
    }

    async function load() {
        initControls();
        renderSidebar();
        const [custom, workspaces, plan] = await Promise.all([
            A.api('/projects').catch((e) => { A.toast(`Projects: ${e.message}`, 'error'); return []; }),
            A.api('/workspaces').catch(() => ({})),
            A.store.plan.load().catch(() => ({ roadmaps: [] })),
        ]);
        state.custom = custom;
        Object.entries(workspaces).forEach(([id, w]) => { state.workspaces[id] = A.store.workspace(id).seed(w); });
        state.roadmaps = plan.roadmaps || [];
        buildProjects();
        renderGrid();
        renderSidebar();

        try {
            state.repos = await A.api('/repos');
        } catch (e) {
            A.toast(`GitHub: ${e.message}`, 'error');
            state.repos = [];
        }
        state.reposLoaded = true;
        buildProjects();
        renderGrid();
        renderSidebar();
    }

    load();
})();
