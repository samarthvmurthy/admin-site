/**
 * Dashboard: an "up next" strip (calendar + next steps), the tool cards, and a
 * unified project grid combining every GitHub repo with hand-added projects.
 */
(function () {
    const A = window.Admin;

    const STATUS_LABELS = { idea: 'Idea', active: 'Active', paused: 'Paused', shipped: 'Shipped' };
    const PRIMARY_FILTERS = [
        { key: 'all', label: 'All' },
        { key: 'active', label: 'Active' },
        { key: 'shipped', label: 'Shipped' },
        { key: 'paused', label: 'Paused' },
        { key: 'untracked', label: 'Untracked' },
    ];

    const state = {
        repos: [],
        custom: [],
        workspaces: {},
        projects: [],
        filter: 'all',
        includeForks: false,
        includeArchived: false,
        search: '',
        sort: 'pushed',
    };

    // ------------------------------------------------------------ modelling --

    function openSteps(ws) {
        return (ws?.tasks || []).filter((t) => t.lane === 'next' || t.lane === 'doing').length;
    }

    function buildProjects() {
        const fromRepos = state.repos.map((r) => ({
            id: `gh:${r.full_name}`,
            name: r.name,
            description: r.description || '',
            kind: 'repo',
            repo: r.full_name,
            liveUrl: r.homepage || '',
            pushedAt: r.pushed_at,
            language: r.language,
            private: r.private,
            fork: r.fork,
            archived: r.archived,
            stars: r.stargazers_count,
            openIssues: r.open_issues_count,
            htmlUrl: r.html_url,
            topics: r.topics || [],
        }));

        const fromCustom = state.custom.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description || '',
            kind: p.kind === 'program' ? 'program' : 'custom',
            repo: p.repo || '',
            liveUrl: p.liveUrl || '',
            pushedAt: p.createdAt,
            language: null,
            private: true,
            fork: false,
            archived: false,
            stars: 0,
            openIssues: 0,
            htmlUrl: p.repo ? `https://github.com/${p.repo}` : '',
            topics: [],
        }));

        state.projects = [...fromCustom, ...fromRepos].map((p) => {
            const ws = state.workspaces[p.id] || null;
            return {
                ...p,
                ws,
                // A workspace's own liveUrl wins — it's the one you curated.
                liveUrl: ws?.liveUrl || p.liveUrl,
                status: ws?.status || null,
                openSteps: openSteps(ws),
                touchedAt: ws?.updatedAt || null,
            };
        });
    }

    function visibleProjects() {
        const q = state.search.toLowerCase();
        let list = state.projects.filter((p) => {
            if (!state.includeForks && p.fork) return false;
            if (!state.includeArchived && p.archived) return false;
            if (state.filter === 'untracked' && p.ws) return false;
            if (state.filter !== 'all' && state.filter !== 'untracked' && p.status !== state.filter) return false;
            if (!q) return true;
            return [p.name, p.description, p.repo, (p.topics || []).join(' ')]
                .join(' ').toLowerCase().includes(q);
        });

        const byName = (a, b) => a.name.localeCompare(b.name);
        const sorters = {
            name: byName,
            pushed: (a, b) => new Date(b.pushedAt || 0) - new Date(a.pushedAt || 0),
            touched: (a, b) => new Date(b.touchedAt || 0) - new Date(a.touchedAt || 0),
            tasks: (a, b) => b.openSteps - a.openSteps || byName(a, b),
        };
        return list.sort(sorters[state.sort] || sorters.pushed);
    }

    // ------------------------------------------------------------ rendering --

    function statusPill(status) {
        const pill = A.el('span', `pill pill-${status || 'none'}`, STATUS_LABELS[status] || 'No workspace');
        return pill;
    }

    function projectCard(p) {
        const card = A.el('a', 'project-card');
        card.href = A.projectHref(p.id);

        const head = A.el('div', 'project-card-head');
        const title = A.el('div', 'project-card-title', p.name);
        head.appendChild(title);
        head.appendChild(statusPill(p.status));
        card.appendChild(head);

        const tags = A.el('div', 'project-card-tags');
        if (p.kind === 'program') tags.appendChild(A.el('span', 'tag tag-program', 'Program'));
        else if (p.kind === 'custom') tags.appendChild(A.el('span', 'tag', 'Manual'));
        if (p.private && p.kind === 'repo') tags.appendChild(A.el('span', 'tag', 'Private'));
        if (p.fork) tags.appendChild(A.el('span', 'tag', 'Fork'));
        if (p.archived) tags.appendChild(A.el('span', 'tag', 'Archived'));
        if (tags.children.length) card.appendChild(tags);

        card.appendChild(A.el('p', 'project-card-desc', p.description || 'No description.'));

        // Milestone progress makes multi-week programs readable at a glance.
        const milestones = p.ws?.milestones || [];
        if (milestones.length) {
            const done = milestones.filter((m) => m.done).length;
            const wrap = A.el('div', 'progress-wrap');
            const bar = A.el('div', 'progress-track');
            const fill = A.el('div', 'progress-fill');
            fill.style.width = `${(done / milestones.length) * 100}%`;
            bar.appendChild(fill);
            wrap.appendChild(bar);
            wrap.appendChild(A.el('span', 'progress-label', `${done}/${milestones.length}`));
            card.appendChild(wrap);
        }

        const meta = A.el('div', 'project-card-meta');
        if (p.language) {
            const lang = A.el('span', 'meta-item');
            const dot = A.el('span', 'lang-dot');
            dot.style.background = A.langColor(p.language);
            lang.appendChild(dot);
            lang.appendChild(A.el('span', null, p.language));
            meta.appendChild(lang);
        }
        if (p.openSteps) meta.appendChild(A.el('span', 'meta-item meta-accent', `${p.openSteps} open step${p.openSteps === 1 ? '' : 's'}`));
        if (p.openIssues) meta.appendChild(A.el('span', 'meta-item', `${p.openIssues} issue${p.openIssues === 1 ? '' : 's'}`));
        if (p.pushedAt && p.kind === 'repo') meta.appendChild(A.el('span', 'meta-item', `pushed ${A.relativeTime(p.pushedAt)}`));
        if (p.liveUrl) meta.appendChild(A.el('span', 'meta-item meta-live', 'live'));
        card.appendChild(meta);

        return card;
    }

    function renderGrid() {
        const grid = A.clear(document.getElementById('project-grid'));
        const list = visibleProjects();

        document.getElementById('project-count-badge').textContent = `${list.length}`;
        const hint = document.getElementById('projects-hint');

        if (!list.length) {
            hint.textContent = state.search
                ? `Nothing matches "${state.search}".`
                : 'No projects match these filters.';
            return;
        }
        hint.textContent = `${state.projects.length} total — ${state.repos.length} from GitHub, ${state.custom.length} added by hand.`;
        list.forEach((p) => grid.appendChild(projectCard(p)));
    }

    function renderFilters() {
        const host = A.clear(document.getElementById('project-filters'));

        PRIMARY_FILTERS.forEach((f) => {
            const chip = A.button(f.label, `filter-chip${state.filter === f.key ? ' on' : ''}`, () => {
                state.filter = f.key;
                renderFilters();
                renderGrid();
            });
            host.appendChild(chip);
        });

        host.appendChild(A.el('span', 'filter-divider'));

        const toggles = [
            ['includeForks', 'Forks'],
            ['includeArchived', 'Archived'],
        ];
        toggles.forEach(([key, label]) => {
            host.appendChild(A.button(label, `filter-chip filter-toggle${state[key] ? ' on' : ''}`, () => {
                state[key] = !state[key];
                renderFilters();
                renderGrid();
            }));
        });
    }

    // ------------------------------------------------------------- up next ---

    function renderUpNextTasks() {
        const host = A.clear(document.getElementById('upnext-tasks'));
        const rows = [];
        state.projects.forEach((p) => {
            (p.ws?.tasks || [])
                .filter((t) => t.lane === 'next' || t.lane === 'doing')
                .forEach((t) => rows.push({ project: p, task: t }));
        });

        if (!rows.length) {
            host.appendChild(A.el('p', 'hint', 'No next steps written down yet. Open a project and add some.'));
            return;
        }

        // Things already in progress belong at the top of the list.
        rows.sort((a, b) => (a.task.lane === 'doing' ? -1 : 0) - (b.task.lane === 'doing' ? -1 : 0));

        const list = A.el('div', 'upnext-list');
        rows.slice(0, 8).forEach(({ project, task }) => {
            const row = A.el('a', 'upnext-item');
            row.href = A.projectHref(project.id);
            if (task.lane === 'doing') row.appendChild(A.el('span', 'pill pill-doing', 'doing'));
            row.appendChild(A.el('span', 'upnext-text', task.text));
            row.appendChild(A.el('span', 'upnext-project', project.name));
            list.appendChild(row);
        });
        host.appendChild(list);
        if (rows.length > 8) host.appendChild(A.el('p', 'hint', `+${rows.length - 8} more across your projects.`));
    }

    async function renderUpNextEvents() {
        const host = document.getElementById('upnext-events');
        try {
            const status = await A.api('/calendar/status');
            if (!status.configured) {
                A.clear(host);
                host.appendChild(A.el('p', 'hint', 'Google Calendar is not connected yet.'));
                const link = A.el('a', 'inline-link', 'Set it up →');
                link.href = 'pages/calendar.html';
                host.appendChild(link);
                return;
            }

            const now = new Date();
            const end = new Date(now);
            end.setDate(end.getDate() + 2);
            end.setHours(0, 0, 0, 0);

            const data = await A.api(`/calendar/events?timeMin=${encodeURIComponent(now.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}&maxResults=10`);
            A.clear(host);

            if (!data.events.length) {
                host.appendChild(A.el('p', 'hint', 'Nothing scheduled in the next two days.'));
                return;
            }

            const list = A.el('div', 'upnext-list');
            data.events.forEach((e) => {
                const row = A.el('a', 'upnext-item');
                row.href = 'pages/calendar.html';
                const when = e.allDay ? 'all day' : A.timeOfDay(e.start);
                row.appendChild(A.el('span', 'upnext-time', when));
                row.appendChild(A.el('span', 'upnext-text', e.summary));
                const day = A.parseDate(e.start).toDateString() === now.toDateString() ? 'today' : 'tomorrow';
                row.appendChild(A.el('span', 'upnext-project', day));
                list.appendChild(row);
            });
            host.appendChild(list);
        } catch (e) {
            A.clear(host);
            host.appendChild(A.el('p', 'hint', `Calendar unavailable: ${e.message}`));
        }
    }

    // ------------------------------------------------------------- actions ---

    function newProjectDialog() {
        A.modal.open({
            title: 'New project',
            description: 'For work that has no repo yet, or that lives outside GitHub. Repos appear here automatically.',
            fields: [
                { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Interview prep, Side app idea' },
                { name: 'description', label: 'Description', type: 'textarea', rows: 3, placeholder: 'One or two lines on what this is.' },
                {
                    name: 'kind', label: 'Type', type: 'select',
                    options: [
                        { value: 'project', label: 'Project' },
                        { value: 'program', label: 'Program (multi-week, has milestones)' },
                    ],
                },
                { name: 'repo', label: 'Linked repo (optional)', placeholder: 'owner/name', hint: 'Fill this in later to pull live GitHub data into the project page.' },
                { name: 'liveUrl', label: 'Live URL (optional)', placeholder: 'https://…' },
            ],
            submitLabel: 'Create project',
            onSubmit: async (values) => {
                const created = await A.api('/projects', { method: 'POST', body: values });
                window.location.href = A.projectHref(created.id);
            },
        });
    }

    async function exportBackup() {
        try {
            const data = await A.api('/export');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `admin-workspace-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            URL.revokeObjectURL(link.href);
            A.toast('Backup downloaded', 'ok');
        } catch (e) {
            A.toast(e.message, 'error');
        }
    }

    // Restores an exported file. Projects and workspaces present in the file
    // overwrite what's in KV; anything not in the file is left alone.
    function restoreBackup(file) {
        const reader = new FileReader();
        reader.onload = () => {
            let parsed;
            try {
                parsed = JSON.parse(reader.result);
            } catch {
                A.toast('That file is not valid JSON', 'error');
                return;
            }
            if (!parsed.workspaces && !parsed.customProjects) {
                A.toast('That does not look like an admin backup', 'error');
                return;
            }

            const projectCount = (parsed.customProjects || []).length;
            const wsCount = Object.keys(parsed.workspaces || {}).length;
            A.modal.open({
                title: 'Restore from backup?',
                description: `This overwrites ${projectCount} manual project${projectCount === 1 ? '' : 's'} and ${wsCount} workspace${wsCount === 1 ? '' : 's'} with the contents of ${file.name}. Anything not in the file is left as it is.`,
                fields: [],
                submitLabel: 'Restore',
                onSubmit: async () => {
                    await A.api('/import', { method: 'POST', body: parsed });
                    A.toast('Backup restored', 'ok');
                    window.location.reload();
                },
            });
        };
        reader.onerror = () => A.toast('Could not read that file', 'error');
        reader.readAsText(file);
    }

    // ---------------------------------------------------------------- init ---

    function initControls() {
        document.getElementById('new-project-btn').addEventListener('click', newProjectDialog);
        document.getElementById('export-btn').addEventListener('click', exportBackup);

        const fileInput = document.getElementById('restore-file');
        document.getElementById('restore-btn').addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            const file = fileInput.files[0];
            if (file) restoreBackup(file);
            fileInput.value = '';
        });

        const search = document.getElementById('project-search');
        const onSearch = A.debounce(() => { state.search = search.value.trim(); renderGrid(); }, 180);
        search.addEventListener('input', onSearch);

        document.getElementById('project-sort').addEventListener('change', (e) => {
            state.sort = e.target.value;
            renderGrid();
        });
    }

    async function load() {
        initControls();
        renderFilters();
        renderUpNextEvents();

        // Workspaces and custom projects come from KV; repos from GitHub. Each
        // is allowed to fail on its own without blanking the whole dashboard.
        const [repos, custom, workspaces] = await Promise.all([
            A.api('/repos').catch((e) => { A.toast(`GitHub: ${e.message}`, 'error'); return []; }),
            A.api('/projects').catch((e) => { A.toast(`Projects: ${e.message}`, 'error'); return []; }),
            A.api('/workspaces').catch(() => ({})),
        ]);

        state.repos = repos;
        state.custom = custom;
        state.workspaces = workspaces;

        buildProjects();
        renderGrid();
        renderUpNextTasks();
    }

    load();
})();
