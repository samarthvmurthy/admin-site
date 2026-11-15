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
        mode: ['board', 'week'].includes(prefs.mode) ? prefs.mode : 'grid',
    };

    function savePrefs() {
        try {
            localStorage.setItem('cp:projects', JSON.stringify({ view: state.view, sort: state.sort, forks: state.forks, archived: state.archived, mode: state.mode }));
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
        const parsed = A.steps.parseQuick(text);
        if (!parsed.text) return;
        doc.doc.next.push(A.steps.create(parsed));
        if (parsed.focus) A.steps.warnIfOver(Object.values(state.workspaces));
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
            const line = A.el('div', `ptile-line st-${A.steps.statusOf(s)}`);
            if (A.steps.statusOf(s) !== 'todo') line.title = A.steps.statusLabel(A.steps.statusOf(s));
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
        add.title = 'Shorthand: !high · @fri · #label · #12 · ~m · *';
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
            A.clear(hint);
            const label = VIEWS.find((v) => v.key === state.view)?.label || 'this view';
            hint.appendChild(document.createTextNode(state.search ? `Nothing matches "${state.search}". ` : `No projects in "${label}" yet. `));
            if (state.view !== 'all' || state.search) {
                const reset = A.el('a', 'inline-link', 'Show all projects');
                reset.href = '#';
                reset.addEventListener('click', (e) => {
                    e.preventDefault();
                    state.view = 'all';
                    state.search = '';
                    document.getElementById('project-search').value = '';
                    savePrefs();
                    renderSidebar();
                    renderGrid();
                });
                hint.appendChild(reset);
            }
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
        const steps = allSteps();
        const focus = steps.filter((e) => A.steps.isFocus(e.s)).length;
        const stale = steps.filter((e) => A.steps.isStale(e.s)).length;
        window.Nav.setSections([
            {
                label: 'Work',
                items: [
                    { label: 'Board', icon: 'layers', active: state.mode === 'board', count: steps.length || '', onClick: () => setMode('board') },
                    { label: 'This week', icon: 'flag', active: state.mode === 'week', count: focus || '', countTone: focus ? 'accent' : '', onClick: () => setMode('week') },
                    ...(stale ? [{ label: 'Weekly review', icon: 'refresh', count: stale, countTone: 'danger', onClick: () => setMode('week') }] : []),
                ],
            },
            {
                label: 'Projects',
                items: VIEWS.map((v) => ({
                    label: v.label,
                    icon: v.icon,
                    active: state.mode === 'grid' && state.view === v.key,
                    count: base.filter((p) => matchesView(p, v.key)).length || '',
                    onClick: () => { state.view = v.key; state.mode = 'grid'; savePrefs(); applyMode(); },
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

    // ------------------------------------------------------- work views --
    //
    // Board: every open next step across projects, by status.
    // This week: what's pinned to this week against your capacity, a weekly
    // review of what's left over from earlier weeks, and suggestions.

    const MODES = [
        { key: 'grid', label: 'Projects' },
        { key: 'board', label: 'Board' },
        { key: 'week', label: 'This week' },
    ];
    const work = {
        expanded: new Set(),
        refInfo: {},          // repo → Map(number → info)
        label: '',
        high: false,
        focusOnly: false,
    };

    function projectFor(id) {
        return state.projects.find((p) => p.id === id) || null;
    }

    function projectNameFor(id) {
        return projectFor(id)?.name || state.workspaces[id]?.projectName || A.projectLabel(id);
    }

    function repoFor(id) {
        if (id.startsWith('gh:')) return id.slice(3);
        return state.custom.find((p) => p.id === id)?.repo || null;
    }

    // Open steps across tracked projects, honouring the fork/archive filters.
    function allSteps() {
        const hidden = new Set(state.projects.filter((p) => (!state.forks && p.fork) || (!state.archived && p.archived)).map((p) => p.id));
        const out = [];
        Object.entries(state.workspaces).forEach(([id, w]) => {
            if (hidden.has(id)) return;
            (w.next || []).forEach((s) => out.push({ id, s: A.steps.normalize(s) }));
        });
        return out;
    }

    function stepCtx(id, s) {
        const doc = A.store.workspace(id);
        const repo = repoFor(id);
        if (repo && !work.refInfo[repo]) work.refInfo[repo] = new Map();
        return {
            doc: () => doc.doc,
            save: (now) => { doc.save(now); },
            key: `${id}::${s.id}`,
            expanded: work.expanded,
            rerender: (focus) => {
                renderWork(true);
                renderSidebar();
                if (focus) document.querySelector(focus)?.focus();
            },
            changed: renderSidebar,
            project: { name: projectNameFor(id), href: `${A.projectHref(id)}#step=${encodeURIComponent(s.id)}` },
            projectId: id,
            roadmaps: state.roadmaps,
            repo,
            refInfo: repo ? work.refInfo[repo] : null,
            loadRefs: (nums) => loadRefs(repo, nums),
            knownLabels: () => A.steps.knownLabels(Object.values(state.workspaces)),
            onFocusChange: () => { A.steps.warnIfOver(Object.values(state.workspaces)); if (state.mode === 'week') renderWork(true); },
        };
    }

    async function loadRefs(repo, numbers) {
        if (!repo) return;
        const map = work.refInfo[repo] || (work.refInfo[repo] = new Map());
        const missing = [...new Set(numbers)].filter((n) => !map.has(n));
        if (!missing.length) return;
        try {
            const list = await A.api(`/repo/refs?repo=${encodeURIComponent(repo)}&n=${missing.join(',')}`);
            list.forEach((r) => map.set(r.number, r));
        } catch { /* chips stay neutral */ }
    }

    // Fetch GitHub status for linked steps that are on screen, then repaint.
    function loadVisibleRefs(entries) {
        const byRepo = {};
        entries.forEach(({ id, s }) => {
            const repo = repoFor(id);
            if (repo && s.refs?.length) (byRepo[repo] ||= []).push(...s.refs);
        });
        const pending = Object.entries(byRepo).filter(([repo, nums]) => nums.some((n) => !work.refInfo[repo]?.has(n)));
        if (!pending.length) return;
        Promise.all(pending.map(([repo, nums]) => loadRefs(repo, nums))).then(() => renderWork());
    }

    function matchesSearch({ id, s }) {
        const q = state.search.toLowerCase();
        if (!q) return true;
        return [s.text, s.details, projectNameFor(id), (s.labels || []).join(' '), s.waitingOn].join(' ').toLowerCase().includes(q);
    }

    function workFilters(host, entries) {
        const bar = A.el('div', 'filter-chips step-filters');
        const chip = (label, on, onClick) => {
            const b = A.button(label, `filter-chip${on ? ' on' : ''}`, onClick);
            b.setAttribute('aria-pressed', String(on));
            bar.appendChild(b);
            return b;
        };
        if (state.mode === 'board') {
            chip(`This week ${entries.filter((e) => A.steps.isFocus(e.s)).length}`, work.focusOnly, () => { work.focusOnly = !work.focusOnly; renderWork(true); });
        }
        chip(`High priority ${entries.filter((e) => e.s.priority === 'high').length}`, work.high, () => { work.high = !work.high; renderWork(true); });
        [...new Set(entries.flatMap((e) => e.s.labels))].sort().forEach((l) => {
            const b = chip('', work.label === l, () => { work.label = work.label === l ? '' : l; renderWork(true); });
            b.classList.add('label-filter');
            b.style.setProperty('--label', A.steps.labelColor(l));
            b.appendChild(A.el('span', 'label-dot'));
            b.appendChild(A.el('span', null, l));
        });
        host.appendChild(bar);
    }

    function applyFilters(entries) {
        return entries.filter((e) => matchesSearch(e)
            && (!work.focusOnly || state.mode !== 'board' || A.steps.isFocus(e.s))
            && (!work.high || e.s.priority === 'high')
            && (!work.label || e.s.labels.includes(work.label)));
    }

    function sortEntries(entries) {
        const order = new Map(A.steps.sort(entries.map((e) => e.s)).map((s, i) => [s, i]));
        return [...entries].sort((a, b) => order.get(a.s) - order.get(b.s));
    }

    function renderBoard(host) {
        const all = allSteps();
        const panel = A.el('section', 'panel');
        const head = A.el('div', 'panel-head');
        const h2 = A.el('h2', null, 'All next steps');
        h2.appendChild(A.el('span', 'badge', String(all.length)));
        head.appendChild(h2);
        head.appendChild(A.el('span', 'panel-head-note', 'Drag between columns, or open a step to edit it'));
        panel.appendChild(head);
        if (!all.length) {
            panel.appendChild(A.el('p', 'hint', 'No next steps in any project yet. Add them on a project\'s tile or page.'));
            host.appendChild(panel);
            return;
        }
        workFilters(panel, all);
        const shown = sortEntries(applyFilters(all));
        panel.appendChild(A.steps.board(shown.map(({ id, s }) => ({ s, ctx: stepCtx(id, s) })), {
            onMove: () => { renderWork(true); renderSidebar(); },
        }));
        host.appendChild(panel);
        loadVisibleRefs(shown);
    }

    // Steps pinned to an earlier week and not finished, plus last week's wins.
    function reviewData() {
        const week = A.steps.thisWeek();
        const lastWeek = A.addDays(week, -7);
        const stale = allSteps().filter((e) => A.steps.isStale(e.s));
        const won = [];
        Object.entries(state.workspaces).forEach(([id, w]) => (w.achieved || []).forEach((a) => {
            if (a.date && a.date >= lastWeek && a.date < week) won.push({ id, a });
        }));
        return { stale, won, lastWeek };
    }

    function carryOver(entries, toThisWeek) {
        const touched = new Set();
        entries.forEach(({ id, s }) => { s.week = toThisWeek ? A.steps.thisWeek() : ''; touched.add(id); });
        touched.forEach((id) => A.store.workspace(id).save(true));
        if (toThisWeek) A.steps.warnIfOver(Object.values(state.workspaces));
        renderReviewBanner();
        renderWork(true);
        renderSidebar();
    }

    function reviewPanel() {
        const { stale, won, lastWeek } = reviewData();
        const panel = A.el('section', 'panel review-week');
        panel.id = 'weekly-review';
        const head = A.el('div', 'panel-head');
        head.appendChild(A.el('h2', null, 'Weekly review'));
        head.appendChild(A.el('span', 'panel-head-note', `Week of ${A.parseDate(lastWeek).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`));
        panel.appendChild(head);

        const cols = A.el('div', 'review-cols');
        const doneCol = A.el('div', 'review-col');
        doneCol.appendChild(A.el('div', 'subfield-label', `Done last week · ${won.length}`));
        if (!won.length) doneCol.appendChild(A.el('p', 'hint', 'Nothing logged last week.'));
        won.slice(0, 12).forEach(({ id, a }) => {
            const line = A.el('div', 'ptile-line');
            line.appendChild(A.icon('check', 12, 'ok-mark'));
            line.appendChild(A.el('span', 'grow', a.text));
            line.appendChild(A.el('span', 'when', projectNameFor(id)));
            doneCol.appendChild(line);
        });
        if (won.length > 12) doneCol.appendChild(A.el('div', 'ptile-more', `+${won.length - 12} more`));
        cols.appendChild(doneCol);

        const leftCol = A.el('div', 'review-col');
        leftCol.appendChild(A.el('div', 'subfield-label', `Left over · ${stale.length}`));
        if (!stale.length) {
            leftCol.appendChild(A.el('p', 'hint', 'Nothing left over from earlier weeks.'));
        } else {
            stale.forEach((e) => {
                const line = A.el('div', 'ptile-line review-line');
                line.appendChild(A.el('span', 'grow', e.s.text));
                line.appendChild(A.el('span', 'when', projectNameFor(e.id)));
                const carry = A.button('Carry', 'link-btn', () => carryOver([e], true));
                carry.title = 'Keep it in this week';
                line.appendChild(carry);
                const drop = A.button('Unpin', 'link-btn review-unpin', () => carryOver([e], false));
                drop.title = 'Take it out of the weekly focus (it stays a next step)';
                line.appendChild(drop);
                leftCol.appendChild(line);
            });
            const acts = A.el('div', 'review-actions');
            acts.appendChild(A.button(`Carry all ${stale.length} into this week`, 'btn btn-add-primary btn-small', () => carryOver(stale, true)));
            acts.appendChild(A.button('Unpin all', 'btn btn-ghost btn-small', () => carryOver(stale, false)));
            leftCol.appendChild(acts);
        }
        cols.appendChild(leftCol);
        panel.appendChild(cols);
        return panel;
    }

    function renderWeek(host) {
        const all = allSteps();
        const focus = all.filter((e) => A.steps.isFocus(e.s));
        const load = A.steps.weekLoad(Object.values(state.workspaces));
        const cap = A.steps.capacity();

        if (reviewData().stale.length) host.appendChild(reviewPanel());

        const panel = A.el('section', 'panel');
        const head = A.el('div', 'panel-head');
        const h2 = A.el('h2', null, 'This week');
        h2.appendChild(A.el('span', 'badge', String(focus.length)));
        head.appendChild(h2);
        const acts = A.el('div', 'panel-head-actions week-capacity');
        acts.appendChild(A.steps.capacityMeter(load, cap));
        const capInput = A.el('input', 'capacity-input');
        capInput.type = 'number';
        capInput.min = '1';
        capInput.max = '200';
        capInput.value = String(cap);
        capInput.title = 'How many points you can take on in a week (S = 1, M = 3, L = 5)';
        capInput.setAttribute('aria-label', 'Weekly capacity in points');
        capInput.addEventListener('change', () => {
            const n = Math.max(1, Math.min(200, Math.round(Number(capInput.value)) || A.steps.DEFAULT_CAPACITY));
            if (!A.store.plan.doc) return;
            A.store.plan.doc.weekCapacity = n;
            A.store.plan.save(true);
            renderWork(true);
        });
        acts.appendChild(A.el('span', 'capacity-cap-label', 'Capacity'));
        acts.appendChild(capInput);
        head.appendChild(acts);
        panel.appendChild(head);

        const unsized = focus.filter((e) => !e.s.size).length;
        panel.appendChild(A.el('p', 'hint', load > cap
            ? `That's ${load - cap} pts over what you said you can do. Unpin or resize something.`
            : `Pin steps with “Add to this week” (or * when adding one).${unsized ? ` ${unsized} pinned step${unsized === 1 ? ' has' : 's have'} no size, so they don't count toward capacity yet.` : ''}`));

        if (focus.length) {
            workFilters(panel, focus);
            const rows = A.el('div', 'step-list');
            sortEntries(applyFilters(focus)).forEach(({ id, s }) => rows.appendChild(A.steps.card(s, stepCtx(id, s))));
            panel.appendChild(rows);
            loadVisibleRefs(focus);
        }
        host.appendChild(panel);

        // What to pull in: in progress, high priority, or due within a week.
        const soon = A.addDays(A.todayKey(), 7);
        const ideas = sortEntries(all.filter((e) => !A.steps.isFocus(e.s) && matchesSearch(e)
            && (A.steps.statusOf(e.s) === 'doing' || e.s.priority === 'high' || (e.s.due && e.s.due <= soon))
            && A.steps.statusOf(e.s) !== 'blocked')).slice(0, 10);
        if (ideas.length) {
            const sug = A.el('section', 'panel');
            const sh = A.el('div', 'panel-head');
            sh.appendChild(A.el('h2', null, 'Worth pulling in'));
            sh.appendChild(A.el('span', 'panel-head-note', 'In progress, high priority, or due within a week'));
            sug.appendChild(sh);
            const list = A.el('div', 'row-list');
            ideas.forEach(({ id, s }) => {
                const row = A.el('div', 'item-row');
                const main = A.el('a', 'item-main');
                main.href = `${A.projectHref(id)}#step=${encodeURIComponent(s.id)}`;
                main.appendChild(A.el('span', 'item-title', s.text));
                main.appendChild(A.el('span', 'item-sub', [projectNameFor(id), A.steps.statusOf(s) === 'doing' ? 'In progress' : '', s.size ? `Size ${s.size.toUpperCase()}` : ''].filter(Boolean).join(' · ')));
                row.appendChild(main);
                const meta = A.el('div', 'item-meta');
                meta.appendChild(A.priorityFlag(s.priority));
                const chip = A.dueChip(s.due, s.time);
                if (chip) meta.appendChild(chip);
                const pin = A.button('', 'btn btn-edit btn-small', () => {
                    s.week = A.steps.thisWeek();
                    A.store.workspace(id).save(true);
                    A.steps.warnIfOver(Object.values(state.workspaces));
                    renderWork(true);
                    renderSidebar();
                });
                pin.appendChild(A.icon('flag', 13));
                pin.appendChild(A.el('span', 'btn-label', 'This week'));
                meta.appendChild(pin);
                row.appendChild(meta);
                list.appendChild(row);
            });
            sug.appendChild(list);
            host.appendChild(sug);
        }
    }

    function renderWork(force) {
        const host = document.getElementById('work-host');
        if (state.mode === 'grid') return;
        const a = document.activeElement;
        if (!force && a?.closest?.('#work-host .step-detail') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
        A.clear(host);
        if (!state.reposLoaded && !Object.keys(state.workspaces).length) {
            host.appendChild(A.el('p', 'hint', 'Loading…'));
            return;
        }
        if (state.mode === 'board') renderBoard(host);
        else renderWeek(host);
    }

    // On the other views, a nudge when last week left things unfinished.
    function renderReviewBanner() {
        const host = A.clear(document.getElementById('review-banner'));
        if (state.mode === 'week') return;
        const { stale } = reviewData();
        if (!stale.length) return;
        const note = A.el('div', 'notice');
        note.appendChild(A.icon('flag', 16));
        const t = A.el('div');
        t.appendChild(document.createTextNode(`${stale.length} step${stale.length === 1 ? ' was' : 's were'} pinned to an earlier week and ${stale.length === 1 ? "isn't" : "aren't"} done. `));
        t.appendChild(A.button('Do the weekly review', 'link-btn', () => setMode('week')));
        note.appendChild(t);
        host.appendChild(note);
    }

    function renderModeTabs() {
        const host = A.clear(document.getElementById('mode-tabs'));
        MODES.forEach((m) => {
            const b = A.button(m.label, `filter-chip${state.mode === m.key ? ' on' : ''}`, () => setMode(m.key));
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', String(state.mode === m.key));
            host.appendChild(b);
        });
    }

    function setMode(mode) {
        state.mode = mode;
        savePrefs();
        applyMode();
    }

    function applyMode() {
        const grid = state.mode === 'grid';
        document.getElementById('project-grid').hidden = !grid;
        document.getElementById('projects-hint').hidden = !grid;
        document.getElementById('work-host').hidden = grid;
        document.getElementById('project-sort').hidden = !grid;
        document.getElementById('project-search').placeholder = grid ? 'Search projects…' : 'Search steps…';
        renderModeTabs();
        renderReviewBanner();
        if (grid) renderGrid(); else renderWork(true);
        renderSidebar();
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
        search.addEventListener('input', A.debounce(() => {
            state.search = search.value.trim();
            if (state.mode === 'grid') renderGrid(); else renderWork(true);
        }, 150));
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
        applyMode();

        try {
            state.repos = await A.api('/repos');
        } catch (e) {
            A.toast(`GitHub: ${e.message}`, 'error');
            state.repos = [];
        }
        state.reposLoaded = true;
        buildProjects();
        if (state.mode === 'grid') renderGrid(); else renderWork();
        renderReviewBanner();
        renderSidebar();
    }

    load();
})();
