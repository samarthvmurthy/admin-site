/**
 * Up next: tasks, project next steps, roadmap milestones and calendar
 * events in one list, bucketed by when they're due and ranked by priority.
 */
(function () {
    const A = window.Admin;

    const FILTERS = [
        { key: 'all', label: 'Everything' },
        { key: 'task', label: 'Tasks' },
        { key: 'step', label: 'Project steps' },
        { key: 'milestone', label: 'Milestones' },
        { key: 'event', label: 'Events' },
    ];

    const state = { filter: 'all', plan: null, workspaces: {}, names: {}, events: [], calendar: null, showSomeday: false };

    function items() {
        const all = A.items.collect({ plan: state.plan, workspaces: state.workspaces, projectNames: state.names, events: state.events });
        if (state.filter === 'all') return all;
        if (state.filter === 'milestone') return all.filter((i) => i.kind === 'milestone' || i.kind === 'phase');
        return all.filter((i) => i.kind === state.filter);
    }

    function refreshFromStore() {
        if (A.store.plan.doc) state.plan = A.store.plan.doc;
        Object.keys(state.workspaces).forEach((id) => {
            const d = A.store.workspace(id).doc;
            if (d) state.workspaces[id] = d;
        });
        render();
    }

    function renderFilters() {
        const host = A.clear(document.getElementById('kind-filters'));
        FILTERS.forEach((f) => {
            host.appendChild(A.button(f.label, `filter-chip${state.filter === f.key ? ' on' : ''}`, () => {
                state.filter = f.key;
                renderFilters();
                render();
            }));
        });
    }

    function render() {
        const panel = A.clear(document.getElementById('upnext-panel'));
        const groups = A.items.group(items());
        const total = groups.reduce((n, g) => n + g.items.length, 0);
        const overdue = groups[0].items.length;
        const today = groups[1].items.length;

        document.getElementById('upnext-summary').textContent = total
            ? [overdue ? `${overdue} overdue` : '', `${today} today`, `${total} in total`].filter(Boolean).join(' · ')
            : 'Nothing due.';

        if (!total) {
            const empty = A.el('div', 'empty-state');
            empty.appendChild(A.el('strong', null, 'All clear'));
            empty.appendChild(document.createTextNode('Add tasks in Plan or next steps on a project, and they appear here.'));
            panel.appendChild(empty);
        }

        groups.forEach((g) => {
            if (!g.items.length) return;
            const head = A.el('div', `group-head${g.key === 'overdue' ? ' tone-danger' : g.key === 'today' ? ' tone-accent' : ''}`);
            head.id = `group-${g.key}`;
            head.appendChild(A.icon(g.icon, 13));
            head.appendChild(A.el('span', null, g.label));
            head.appendChild(A.el('span', 'count', String(g.items.length)));
            panel.appendChild(head);

            // Undated work can pile up; keep it folded unless asked for.
            const list = g.key === 'someday' && !state.showSomeday ? g.items.slice(0, 5) : g.items;
            const rows = A.el('div', 'row-list');
            list.forEach((item) => rows.appendChild(A.items.row(item, { onComplete: refreshFromStore })));
            panel.appendChild(rows);
            if (list.length < g.items.length) {
                panel.appendChild(A.button(`Show ${g.items.length - list.length} more`, 'btn-add', () => { state.showSomeday = true; render(); }));
            }
        });

        window.Nav.setSections([
            {
                label: 'Jump to',
                items: groups.map((g) => ({
                    label: g.label,
                    icon: g.icon,
                    href: `#group-${g.key}`,
                    count: g.items.length || '',
                    countTone: g.key === 'overdue' && g.items.length ? 'danger' : g.key === 'today' && g.items.length ? 'accent' : '',
                })),
            },
            {
                label: 'Add',
                items: [
                    { label: 'New task', icon: 'plus', href: 'pages/plan.html#view=all' },
                    { label: 'Project next step', icon: 'projects', href: 'pages/projects.html' },
                    { label: 'Calendar event', icon: 'calendar', href: 'pages/calendar.html' },
                ],
            },
        ]);
    }

    function renderCalendarNote() {
        const host = A.clear(document.getElementById('calendar-note'));
        if (state.calendar?.configured === false) {
            const note = A.el('div', 'notice');
            note.appendChild(A.icon('calendar', 16));
            const t = A.el('div');
            t.appendChild(document.createTextNode('Google Calendar isn\'t connected, so events aren\'t included yet. '));
            t.appendChild(A.link('Connect it', 'pages/calendar.html', 'inline-link'));
            note.appendChild(t);
            host.appendChild(note);
        } else if (state.calendar?.error) {
            const note = A.el('div', 'notice warn');
            note.appendChild(A.icon('alert', 16));
            note.appendChild(A.el('div', null, `Calendar events couldn't be loaded: ${state.calendar.error}`));
            host.appendChild(note);
        }
    }

    async function load() {
        renderFilters();
        const [plan, workspaces, custom, cal] = await Promise.all([
            A.store.plan.load().catch(() => ({ tasks: [], roadmaps: [] })),
            A.api('/workspaces').catch(() => ({})),
            A.api('/projects').catch(() => []),
            A.items.fetchEvents(21),
        ]);
        state.plan = plan;
        Object.entries(workspaces).forEach(([id, ws]) => { state.workspaces[id] = A.store.workspace(id).seed(ws); });
        custom.forEach((p) => { state.names[p.id] = p.name; });
        state.events = cal.events;
        state.calendar = cal;
        renderCalendarNote();
        render();

        A.api('/repos').then((repos) => {
            repos.forEach((r) => { state.names[`gh:${r.full_name}`] = r.name; });
            render();
        }).catch(() => {});
    }

    document.getElementById('refresh-btn').prepend(A.icon('refresh', 14));
    document.getElementById('refresh-btn').addEventListener('click', async () => {
        const cal = await A.items.fetchEvents(21);
        state.events = cal.events;
        state.calendar = cal;
        renderCalendarNote();
        render();
        A.toast('Up to date', 'ok');
    });

    load();
})();
