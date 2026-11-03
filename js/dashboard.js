/**
 * Dashboard: one tile per module, each a live summary that links through,
 * plus the habit tracker across the bottom.
 */
(function () {
    const A = window.Admin;

    const state = {
        plan: null,
        workspaces: {},
        custom: [],
        repos: null,
        events: [],
        calendar: { configured: null },
    };

    document.querySelectorAll('[data-icon]').forEach((n) => { n.innerHTML = window.Nav.svg(n.dataset.icon, 17); });
    document.getElementById('greeting').textContent = A.greeting();
    document.getElementById('today-line').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    // ------------------------------------------------------------- helpers --

    function projectNames() {
        const names = {};
        state.custom.forEach((p) => { names[p.id] = p.name; });
        (state.repos || []).forEach((r) => { names[`gh:${r.full_name}`] = r.name; });
        return names;
    }

    function allItems() {
        return A.items.collect({
            plan: state.plan,
            workspaces: state.workspaces,
            projectNames: projectNames(),
            events: state.events,
            reviewDoc: A.store.review.doc,
        });
    }

    function stat(value, label, tone, href) {
        const s = A.el(href ? 'a' : 'div', `stat${tone ? ' ' + tone : ''}`);
        if (href) s.href = A.pageHref(href);
        s.appendChild(A.el('div', 'stat-value', String(value)));
        s.appendChild(A.el('div', 'stat-label', label));
        return s;
    }

    // ------------------------------------------------------------ up next --

    function renderUpNext() {
        const host = A.clear(document.getElementById('upnext-body'));
        const items = allItems();
        const groups = A.items.group(items);
        const overdue = groups.find((g) => g.key === 'overdue').items.length;
        const today = groups.find((g) => g.key === 'today').items.length;
        document.getElementById('upnext-sub').textContent =
            [overdue ? `${overdue} overdue` : '', `${today} today`].filter(Boolean).join(' · ');

        const pending = state.calendar.configured ? A.items.reviewQueue(state.events, A.store.review.doc).pending.length : 0;
        if (pending) {
            const nudge = A.link('', 'pages/upnext.html#review-panel', 'review-nudge');
            nudge.appendChild(A.icon('inbox', 14));
            nudge.appendChild(A.el('span', null, `${pending} calendar event${pending === 1 ? '' : 's'} to review`));
            nudge.appendChild(A.icon('chevronRight', 14));
            host.appendChild(nudge);
        }

        const list = A.items.top(items, 7);
        if (!list.length) {
            const empty = A.el('div', 'empty-state');
            empty.appendChild(A.el('strong', null, 'All clear'));
            empty.appendChild(document.createTextNode('Nothing due. Add tasks in Plan or next steps on a project.'));
            host.appendChild(empty);
            return;
        }
        const rows = A.el('div', 'row-list');
        list.forEach((item) => rows.appendChild(A.items.row(item, { onComplete: refreshDerived })));
        host.appendChild(rows);

        const remaining = items.length - list.length;
        if (remaining > 0) {
            const more = A.link(`${remaining} more in Up next →`, 'pages/upnext.html', 'inline-link');
            host.appendChild(more);
        }
    }

    // ----------------------------------------------------------- calendar --

    function renderCalendar() {
        const host = A.clear(document.getElementById('calendar-body'));
        const sub = document.getElementById('calendar-sub');

        if (state.calendar.configured === null) { sub.textContent = 'Loading…'; return; }
        if (!state.calendar.configured) {
            sub.textContent = 'Not connected';
            const box = A.el('div', 'coming-soon');
            box.appendChild(A.el('strong', null, 'Connect Google Calendar'));
            box.appendChild(document.createTextNode('Your events, plus every dated task and milestone, will show up here.'));
            box.appendChild(A.link('Set it up →', 'pages/calendar.html', 'inline-link'));
            host.appendChild(box);
            return;
        }

        const today = A.todayKey();
        const now = new Date();
        const todays = state.events
            .filter((e) => {
                const startKey = A.dateKey(A.parseDate(e.start));
                const endKey = e.allDay ? A.addDays(A.dateKey(A.parseDate(e.end)), -1) : startKey;
                return startKey <= today && endKey >= today;
            })
            .sort((a, b) => (a.allDay === b.allDay ? A.parseDate(a.start) - A.parseDate(b.start) : a.allDay ? -1 : 1));

        const upcoming = todays.filter((e) => e.allDay || A.parseDate(e.end) > now);
        sub.textContent = todays.length ? `${todays.length} today` : 'Nothing today';

        host.appendChild(A.el('div', 'mini-label', 'Today'));
        if (!upcoming.length) {
            host.appendChild(A.el('p', 'hint', todays.length ? "That's everything for today." : 'Your day is open.'));
        } else {
            const list = A.el('div', 'mini-list');
            upcoming.slice(0, 6).forEach((e) => {
                const row = A.link('', 'pages/calendar.html', 'mini-row');
                const sw = A.el('span', 'event-swatch');
                sw.style.setProperty('--swatch', e.color || 'var(--accent)');
                row.appendChild(sw);
                row.appendChild(A.el('span', 'dim', e.allDay ? 'All day' : A.timeOfDay(e.start)));
                row.appendChild(A.el('span', 'grow', e.summary));
                list.appendChild(row);
            });
            host.appendChild(list);
        }

        // Next thing after today, so the tile is useful in the evening too.
        const later = state.events
            .filter((e) => A.dateKey(A.parseDate(e.start)) > today)
            .sort((a, b) => A.parseDate(a.start) - A.parseDate(b.start))[0];
        if (later) {
            const foot = A.el('div', 'tile-foot');
            foot.appendChild(A.el('span', 'mini-label', 'Next'));
            const when = A.dueLabel(A.dateKey(A.parseDate(later.start))) + (later.allDay ? '' : ` · ${A.timeOfDay(later.start)}`);
            foot.appendChild(A.el('span', 'muted', `${later.summary} — ${when}`));
            host.appendChild(foot);
        }
    }

    // --------------------------------------------------------------- plan --

    function renderPlan() {
        const host = A.clear(document.getElementById('plan-body'));
        if (!state.plan) { host.appendChild(A.el('p', 'hint', 'Loading…')); return; }

        const today = A.todayKey();
        const open = state.plan.tasks.filter((t) => !t.done);
        const dueToday = open.filter((t) => t.due === today).length;
        const overdue = open.filter((t) => t.due && t.due < today).length;

        const stats = A.el('div', 'stat-row');
        stats.appendChild(stat(dueToday, 'Due today', dueToday ? 'accent' : '', 'pages/plan.html#view=today'));
        stats.appendChild(stat(overdue, 'Overdue', overdue ? 'danger' : '', 'pages/plan.html#view=overdue'));
        stats.appendChild(stat(open.length, 'Open tasks', '', 'pages/plan.html#view=all'));
        host.appendChild(stats);

        // Quick add straight from the dashboard.
        const form = A.el('form', 'quick-add compact');
        const input = A.el('input', 'qa-title');
        input.type = 'text';
        input.placeholder = 'Add a task…';
        input.setAttribute('aria-label', 'New task');
        const due = A.el('input');
        due.type = 'date';
        due.setAttribute('aria-label', 'Due date');
        form.appendChild(input);
        form.appendChild(due);
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;
            state.plan.tasks.unshift({
                id: A.uid(), title, notes: '', due: due.value || '', time: '', priority: 'medium',
                done: false, createdAt: new Date().toISOString(),
            });
            A.store.plan.save(true);
            A.toast('Task added', 'ok');
            refreshDerived();
            document.querySelector('#plan-body .qa-title')?.focus();
        });
        host.appendChild(form);

        // Active roadmaps at a glance.
        const roadmaps = state.plan.roadmaps.slice(0, 2);
        if (roadmaps.length) {
            host.appendChild(A.el('div', 'mini-label', 'Roadmaps'));
            const list = A.el('div', 'mini-list');
            roadmaps.forEach((r) => {
                const total = r.phases.length;
                const done = r.phases.filter((p) => p.items.length && p.items.every((i) => i.done)).length;
                const current = r.phases.find((p) => p.start && p.end && p.start <= today && p.end >= today);
                const row = A.link('', `pages/plan.html#roadmap=${encodeURIComponent(r.id)}`, 'mini-row');
                row.style.flexDirection = 'column';
                row.style.alignItems = 'stretch';
                row.style.gap = '0.3rem';
                const top = A.el('div', 'ptile-line');
                top.appendChild(A.el('span', 'grow', r.title));
                top.appendChild(A.el('span', 'when', current ? current.title.replace(/ — .*/, '') : (r.phases.some((p) => p.start) ? '' : 'Unscheduled')));
                row.appendChild(top);
                row.appendChild(A.progressBar(done, total));
                list.appendChild(row);
            });
            host.appendChild(list);
        }
    }

    // ----------------------------------------------------------- projects --

    function renderProjects() {
        const host = A.clear(document.getElementById('projects-body'));
        const wsEntries = Object.entries(state.workspaces);
        const openSteps = wsEntries.reduce((n, [, ws]) => n + (ws.next || []).length, 0);
        const shippedThisWeek = wsEntries.reduce((n, [, ws]) => n + (ws.achieved || [])
            .filter((a) => a.date && A.daysBetween(a.date, A.todayKey()) < 7).length, 0);

        const stats = A.el('div', 'stat-row');
        const projectCount = (state.repos ? state.repos.filter((r) => !r.fork && !r.archived).length : 0) + state.custom.length;
        stats.appendChild(stat(state.repos ? projectCount : '…', 'Projects', '', 'pages/projects.html'));
        stats.appendChild(stat(openSteps, 'Next steps', openSteps ? 'accent' : '', 'pages/projects.html'));
        stats.appendChild(stat(shippedThisWeek, 'Achieved (7d)', '', 'pages/projects.html'));
        host.appendChild(stats);

        const names = projectNames();
        const recent = wsEntries
            .filter(([, ws]) => ws.updatedAt)
            .sort((a, b) => new Date(b[1].updatedAt) - new Date(a[1].updatedAt))
            .slice(0, 4);

        host.appendChild(A.el('div', 'mini-label', 'Recently worked on'));
        if (!recent.length) {
            host.appendChild(A.el('p', 'hint', 'Open a project and add a next step to start tracking it.'));
        } else {
            const list = A.el('div', 'mini-list');
            recent.forEach(([id, ws]) => {
                const row = A.el('a', 'mini-row');
                row.href = A.projectHref(id);
                row.appendChild(A.el('span', 'grow', names[id] || ws.projectName || A.projectLabel(id)));
                const next = (ws.next || [])[0];
                row.appendChild(A.el('span', 'dim', next ? `→ ${next.text}` : `${(ws.achieved || []).length} achieved`));
                list.appendChild(row);
            });
            host.appendChild(list);
        }

    }

    // ------------------------------------------------------------- sidebar --

    function renderSidebar() {
        const items = allItems();
        const groups = A.items.group(items);
        const urgent = groups.find((g) => g.key === 'overdue').items.length;
        const today = groups.find((g) => g.key === 'today').items.length;
        const openTasks = state.plan ? state.plan.tasks.filter((t) => !t.done).length : '';

        window.Nav.setSections([
            {
                label: 'Modules',
                items: [
                    { label: 'Plan', href: 'pages/plan.html', icon: 'plan', count: openTasks },
                    { label: 'Up next', href: 'pages/upnext.html', icon: 'upnext', count: urgent || today || '', countTone: urgent ? 'danger' : 'accent' },
                    { label: 'Projects', href: 'pages/projects.html', icon: 'projects' },
                    { label: 'Calendar', href: 'pages/calendar.html', icon: 'calendar' },
                    { label: 'Jobs', href: 'pages/jobs.html', icon: 'jobs', count: 'soon' },
                    { label: 'Habit tracker', href: '#habits', icon: 'habits' },
                ],
            },
            {
                label: 'Data',
                items: [
                    { label: 'Export backup', icon: 'download', onClick: exportBackup, title: 'Download everything as JSON' },
                    { label: 'Restore backup', icon: 'upload', onClick: () => document.getElementById('restore-file').click() },
                    ...(state.calendar.configured ? [{ label: 'Re-sync calendar', icon: 'refresh', onClick: resync }] : []),
                ],
            },
        ]);
    }

    function refreshDerived() {
        // Pull in whatever the store now holds (a tick from a tile changes it).
        if (A.store.plan.doc) state.plan = A.store.plan.doc;
        Object.keys(state.workspaces).forEach((id) => {
            const ws = A.store.workspace(id);
            if (ws.doc) state.workspaces[id] = ws.doc;
        });
        renderUpNext();
        renderPlan();
        renderProjects();
        renderSidebar();
    }

    // ------------------------------------------------------------- backup --

    async function exportBackup() {
        try {
            const data = await A.api('/export');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `control-panel-backup-${A.todayKey()}.json`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            A.toast('Backup downloaded', 'ok');
        } catch (e) {
            A.toast(e.message, 'error');
        }
    }

    function restoreBackup(file) {
        const reader = new FileReader();
        reader.onload = () => {
            let parsed;
            try { parsed = JSON.parse(reader.result); } catch { A.toast('That file is not valid JSON', 'error'); return; }
            if (!parsed.workspaces && !parsed.customProjects && !parsed.plan && !parsed.habits) {
                A.toast('That does not look like a Control Panel backup', 'error');
                return;
            }
            const parts = [];
            if (parsed.plan) parts.push('your plan');
            if (parsed.habits) parts.push('habits');
            if (parsed.customProjects) parts.push(`${parsed.customProjects.length} manual projects`);
            const wsCount = Object.keys(parsed.workspaces || {}).length;
            if (wsCount) parts.push(`${wsCount} project workspaces`);
            A.modal.open({
                title: 'Restore from backup?',
                description: `This overwrites ${parts.join(', ')} with the contents of ${file.name}. Anything not in the file is left as it is.`,
                fields: [],
                submitLabel: 'Restore',
                danger: true,
                onSubmit: async () => {
                    await A.api('/import', { method: 'POST', body: parsed });
                    A.toast('Backup restored', 'ok');
                    setTimeout(() => window.location.reload(), 600);
                },
            });
        };
        reader.onerror = () => A.toast('Could not read that file', 'error');
        reader.readAsText(file);
    }

    async function resync() {
        A.toast('Syncing with Google Calendar…');
        await A.calendarSync.now();
        A.toast('Calendar is up to date', 'ok');
    }

    const fileInput = document.getElementById('restore-file');
    fileInput.addEventListener('change', () => {
        if (fileInput.files[0]) restoreBackup(fileInput.files[0]);
        fileInput.value = '';
    });

    // --------------------------------------------------------------- load --

    async function load() {
        renderSidebar();
        renderPlan();
        renderCalendar();
        A.habits.mount(document.getElementById('habits-body'), {
            rangeHost: document.getElementById('habit-range'),
            subHost: document.getElementById('habits-sub'),
        });

        // Each source can fail on its own without blanking the dashboard.
        const [plan, workspaces, custom, cal] = await Promise.all([
            A.store.plan.load().catch((e) => { A.toast(`Plan: ${e.message}`, 'error'); return null; }),
            A.api('/workspaces').catch(() => ({})),
            A.api('/projects').catch(() => []),
            A.items.fetchEvents(8),
            A.store.review.load().catch(() => A.store.review.seed({ events: {}, series: {}, calendars: {} })),
        ]);

        state.plan = plan || { tasks: [], roadmaps: [] };
        state.custom = custom;
        Object.entries(workspaces).forEach(([id, ws]) => { state.workspaces[id] = A.store.workspace(id).seed(ws); });
        state.calendar = { configured: cal.configured };
        state.events = cal.events;
        if (cal.error) A.toast(`Calendar: ${cal.error}`, 'error');

        renderUpNext();
        renderCalendar();
        renderPlan();
        renderProjects();
        renderSidebar();

        // Repos are the slow call; fill in names and counts when they land.
        A.api('/repos')
            .then((repos) => { state.repos = repos; renderProjects(); renderUpNext(); })
            .catch(() => { state.repos = []; renderProjects(); });
    }

    load();
})();
