/**
 * Up next: tasks, project next steps, milestone subtasks and the calendar
 * events you've let in, bucketed by when they're due and ranked by priority.
 * Milestones themselves sit apart as markers of how far you've got.
 *
 * Calendar events start in a "To review" list. Adding one opens a scheduling
 * dialog (with the day's conflicts) and saves it as a Plan task you can tick
 * off; series and calendar rules add tasks at the events' own times.
 */
(function () {
    const A = window.Admin;
    const R = A.items.review;

    const FILTERS = [
        { key: 'all', label: 'All' },
        { key: 'task', label: 'Tasks' },
        { key: 'step', label: 'Project steps' },
        { key: 'subtask', label: 'Subtasks' },
    ];

    const state = {
        filter: 'all', plan: null, workspaces: {}, names: {}, events: [], calendar: null,
        calendars: [], showSomeday: false, showSkipped: false, showUndated: false,
        subtasksOpen: new Map(), // milestone id → open or closed, once you've chosen
    };
    const reviewDoc = () => A.store.review.doc;

    function items() {
        const all = A.items.collect({ plan: state.plan, workspaces: state.workspaces, projectNames: state.names });
        return state.filter === 'all' ? all : all.filter((i) => i.kind === state.filter);
    }

    function refreshFromStore() {
        if (A.store.plan.doc) state.plan = A.store.plan.doc;
        Object.keys(state.workspaces).forEach((id) => {
            const d = A.store.workspace(id).doc;
            if (d) state.workspaces[id] = d;
        });
        render();
    }

    function decide(event, decision, scope) {
        R.set(reviewDoc(), event, decision, scope);
        A.store.review.save(true);
        render();
    }

    // After a rule change: create tasks for anything it now lets in.
    async function applyRules(message) {
        const created = await A.items.syncAccepted(state.events);
        render();
        if (message) A.toast(created ? `${message} — ${created} task${created === 1 ? '' : 's'} added` : message, 'ok');
    }

    function schedule(event) {
        A.schedule.open(event, { events: state.events, workspaces: state.workspaces, onDone: render });
    }

    function whenLabel(e) {
        const day = A.dueLabel(A.dateKey(A.parseDate(e.start)));
        return e.allDay ? `${day} · all day` : `${day} · ${A.timeOfDay(e.start)}`;
    }

    // ------------------------------------------------------------- review --

    function reviewRow(c, skipped) {
        const e = c.event;
        const row = A.el('div', 'item-row review-row');
        const sw = A.el('span', 'event-swatch');
        sw.style.setProperty('--swatch', e.color || 'var(--accent)');
        row.appendChild(A.el('span', 'kind-icon')).appendChild(sw);

        const main = A.el('div', 'item-main');
        main.style.cursor = 'default';
        main.appendChild(A.el('span', 'item-title', e.summary));
        const sub = A.el('span', 'item-sub', `${whenLabel(e)} · ${e.calendarName || 'Calendar'}`);
        main.appendChild(sub);
        if (e.recurringEventId && !skipped) {
            const series = A.el('span', 'review-series');
            series.appendChild(A.el('span', null, 'Repeats —'));
            series.appendChild(A.button('add every time', 'link-btn', () => {
                R.set(reviewDoc(), e, 'accept', 'series');
                applyRules('Every repeat will be added');
            }));
            series.appendChild(A.el('span', null, '·'));
            series.appendChild(A.button('always skip', 'link-btn', () => decide(e, 'dismiss', 'series')));
            main.appendChild(series);
        }
        row.appendChild(main);

        const actions = A.el('div', 'review-actions');
        if (skipped) {
            actions.appendChild(A.button('Add…', 'btn btn-edit btn-small', () => schedule(e)));
        } else {
            actions.appendChild(A.button('Skip', 'btn btn-ghost btn-small', () => decide(e, 'dismiss', 'event')));
            const add = A.button('', 'btn btn-add-primary btn-small', () => schedule(e));
            add.title = 'Choose a time and add it as a task';
            add.appendChild(A.icon('plus', 13));
            add.appendChild(A.el('span', null, 'Add…'));
            actions.appendChild(add);
        }
        row.appendChild(actions);
        return row;
    }

    function renderReview() {
        const host = A.clear(document.getElementById('review-panel'));
        if (!state.calendar?.configured || state.calendar.error) { host.style.display = 'none'; return; }
        const { pending, dismissed } = A.items.reviewQueue(state.events, reviewDoc());
        host.style.display = '';

        const head = A.el('div', 'panel-head');
        const h2 = A.el('h2', null, 'To review');
        h2.appendChild(A.el('span', `badge${pending.length ? ' badge-accent' : ''}`, String(pending.length)));
        head.appendChild(h2);
        const acts = A.el('div', 'panel-head-actions');
        if (pending.length > 1) {
            acts.appendChild(A.button('Skip all', 'btn btn-ghost btn-small', () => {
                pending.forEach((c) => R.set(reviewDoc(), c.event, 'dismiss', 'event'));
                A.store.review.save(true);
                render();
            }));
            const addAll = A.button('Add all', 'btn btn-edit btn-small', () => {
                pending.forEach((c) => R.set(reviewDoc(), c.event, 'accept', 'event'));
                applyRules('Added at their calendar times');
            });
            addAll.title = 'Add every event as a task at its own time';
            acts.appendChild(addAll);
        }
        acts.appendChild(A.iconButton('flag', 'Review rules for each calendar', rulesDialog, 'icon-btn sm'));
        head.appendChild(acts);
        host.appendChild(head);

        if (!pending.length) {
            host.appendChild(A.el('p', 'hint', 'Nothing new from your calendar. Events from Google wait here until you add them to Up next.'));
        } else {
            host.appendChild(A.el('p', 'hint', 'From your Google Calendar for the next three weeks. Adding one lets you pick a time (with conflicts shown) and turns it into a task you can tick off.'));
            const list = A.el('div', 'row-list');
            pending.forEach((c) => list.appendChild(reviewRow(c, false)));
            host.appendChild(list);
        }

        if (dismissed.length) {
            const toggle = A.button(state.showSkipped ? `Hide skipped (${dismissed.length})` : `Show skipped (${dismissed.length})`, 'link-btn review-toggle', () => {
                state.showSkipped = !state.showSkipped;
                renderReview();
            });
            host.appendChild(toggle);
            if (state.showSkipped) {
                const list = A.el('div', 'row-list review-skipped');
                dismissed.forEach((c) => list.appendChild(reviewRow(c, true)));
                host.appendChild(list);
            }
        }
    }

    function rulesDialog() {
        const doc = reviewDoc();
        const cals = state.calendars.filter((c) => !c.controlPanel);
        const seriesCount = Object.keys(doc.series || {}).length;
        const fields = cals.map((c) => ({
            name: c.id, label: c.summary, type: 'select', half: true, value: doc.calendars?.[c.id] || '',
            options: [{ value: '', label: 'Ask me' }, { value: 'accept', label: 'Always add' }, { value: 'dismiss', label: 'Never add' }],
        }));
        if (seriesCount) {
            fields.push({ name: '__resetSeries', label: `Forget my ${seriesCount} repeating-event rule${seriesCount === 1 ? '' : 's'}`, type: 'checkbox', value: false });
        }
        A.modal.open({
            title: 'Review rules',
            description: 'Choose what happens to new events from each calendar. "Ask me" puts them in To review.',
            wide: true,
            fields: fields.length ? fields : [{ type: 'static', value: 'No calendars loaded.' }],
            submitLabel: 'Save rules',
            onSubmit: (v) => {
                doc.calendars = {};
                cals.forEach((c) => { if (v[c.id]) doc.calendars[c.id] = v[c.id]; });
                if (v.__resetSeries) doc.series = {};
                applyRules('Rules saved');
            },
        });
    }

    // --------------------------------------------------------- milestones --

    // A marker of progress, not a to-do: its subtasks are what show up in the
    // task list, and it's reached when they're done. The list here is only
    // for adding and tidying them.
    function milestoneCard(item) {
        const it = item.ref;
        const card = A.el('article', 'ms-card');

        const head = A.el('div', 'ms-head');
        const main = A.el('a', 'ms-main');
        main.href = A.pageHref(item.href);
        main.appendChild(A.el('span', 'ms-title', item.title));
        main.appendChild(A.el('span', 'ms-context', `${item.context} · ${item.phase}`));
        head.appendChild(main);
        const chip = A.dueChip(item.due);
        if (chip) head.appendChild(chip);
        card.appendChild(head);

        const open = () => state.subtasksOpen.get(it.id) === true;
        const editor = A.items.subtaskEditor(it, {
            onChange: (settled) => {
                renderFoot();
                renderList();
                renderSidebar();
                if (settled) { document.activeElement?.blur(); renderMilestones(); }
            },
        });
        editor.hidden = !open();
        const foot = A.el('div', 'ms-foot');

        function renderFoot() {
            A.clear(foot);
            const { done, total } = A.items.subtaskProgress(it);
            if (total) foot.appendChild(A.progressBar(done, total));
            const toggle = A.button('', `ms-toggle${open() ? ' open' : ''}`, () => {
                const next = !open();
                state.subtasksOpen.set(it.id, next);
                editor.hidden = !next;
                renderFoot();
                if (next) editor.focusAdd();
            });
            toggle.setAttribute('aria-expanded', String(open()));
            toggle.appendChild(A.icon(total ? 'chevronRight' : 'plus', 13));
            toggle.appendChild(A.el('span', null, total ? 'Subtasks' : 'Add subtasks'));
            foot.appendChild(toggle);
            if (!total) {
                foot.appendChild(A.button('Mark reached', 'link-btn ms-reach', async () => {
                    if (await A.items.complete(item)) {
                        A.toast(`Milestone reached: ${item.title}`, 'ok');
                        refreshFromStore();
                    }
                }));
            }
        }
        renderFoot();
        card.appendChild(foot);
        card.appendChild(editor);
        return card;
    }

    function renderMilestones() {
        const panel = document.getElementById('milestones-panel');
        // Never pull a subtask box out from under someone typing in it.
        if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;

        A.clear(panel);
        const all = A.items.milestones(state.plan);
        const reached = A.items.reachedMilestones(state.plan);
        const dated = all.filter((m) => m.due);
        const undated = all.filter((m) => !m.due);

        const head = A.el('div', 'panel-head');
        const h2 = A.el('h2', null, 'Milestones');
        const count = A.el('span', 'badge', `${reached.length}/${all.length + reached.length}`);
        count.title = `${reached.length} of ${all.length + reached.length} reached`;
        h2.appendChild(count);
        head.appendChild(h2);
        const acts = A.el('div', 'panel-head-actions');
        acts.appendChild(A.link('Roadmaps', 'pages/plan.html#roadmaps', 'inline-link'));
        head.appendChild(acts);
        panel.appendChild(head);

        if (!all.length && !reached.length) {
            panel.appendChild(A.el('p', 'hint', 'No milestones yet. Add them to a phase of a roadmap in Plan.'));
        }

        if (reached.length) {
            const badges = A.el('div', 'ms-reached-list');
            reached.forEach((m) => {
                const badge = A.link('', m.href, 'ms-reached');
                badge.title = `${m.context} · ${m.phase}`;
                badge.appendChild(A.icon('check', 12));
                badge.appendChild(A.el('span', null, m.title));
                badges.appendChild(badge);
            });
            panel.appendChild(badges);
        }

        const cards = A.el('div', 'ms-list');
        dated.forEach((m) => cards.appendChild(milestoneCard(m)));
        if (state.showUndated) undated.forEach((m) => cards.appendChild(milestoneCard(m)));
        panel.appendChild(cards);

        if (undated.length) {
            panel.appendChild(A.button(
                state.showUndated ? 'Hide milestones without a date' : `Show ${undated.length} without a date`,
                'link-btn review-toggle',
                () => { state.showUndated = !state.showUndated; renderMilestones(); },
            ));
        }

        const wrapping = A.items.phasesEnding(state.plan);
        if (wrapping.length) {
            panel.appendChild(A.el('div', 'group-head ms-phases-head', 'Phases ending soon'));
            const rows = A.el('div', 'row-list');
            wrapping.forEach((p) => rows.appendChild(A.items.row(p, { showKind: false })));
            panel.appendChild(rows);
        }
    }

    // --------------------------------------------------------------- list --

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

    function renderList() {
        const panel = A.clear(document.getElementById('upnext-list'));
        const groups = A.items.group(items());
        const total = groups.reduce((n, g) => n + g.items.length, 0);
        const overdue = groups[0].items.length;
        const today = groups[1].items.length;

        const milestoneCount = A.items.milestones(state.plan).length;
        document.getElementById('upnext-summary').textContent = [
            overdue ? `${overdue} overdue` : '',
            total ? `${today} today` : '',
            total ? `${total} task${total === 1 ? '' : 's'}` : 'No tasks due',
            milestoneCount ? `${milestoneCount} milestone${milestoneCount === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' · ');

        if (!total) {
            const empty = A.el('div', 'empty-state');
            empty.appendChild(A.el('strong', null, 'All clear'));
            empty.appendChild(document.createTextNode('Add tasks in Plan, next steps on a project, or events from the review list.'));
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

            const list = g.key === 'someday' && !state.showSomeday ? g.items.slice(0, 5) : g.items;
            const rows = A.el('div', 'row-list');
            list.forEach((item) => rows.appendChild(A.items.row(item, { onComplete: refreshFromStore })));
            panel.appendChild(rows);
            if (list.length < g.items.length) {
                panel.appendChild(A.button(`Show ${g.items.length - list.length} more`, 'btn-add', () => { state.showSomeday = true; render(); }));
            }
        });
    }

    function renderSidebar() {
        const groups = A.items.group(items());
        const open = A.items.milestones(state.plan);
        const pending = state.calendar?.configured ? A.items.reviewQueue(state.events, reviewDoc()).pending.length : 0;
        window.Nav.setSections([
            ...(state.calendar?.configured ? [{
                label: 'Calendar',
                items: [
                    { label: 'To review', icon: 'inbox', href: '#review-panel', count: pending || '', countTone: pending ? 'accent' : '' },
                    { label: 'Review rules', icon: 'flag', onClick: rulesDialog },
                ],
            }] : []),
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
                label: 'Milestones',
                items: [{ label: 'All milestones', icon: 'target', href: '#milestones-panel', count: open.length || '' }],
            },
            {
                label: 'Add',
                items: [
                    { label: 'New task', icon: 'plus', href: 'pages/plan.html#view=all' },
                    { label: 'Milestone', icon: 'map', href: 'pages/plan.html#roadmaps' },
                    { label: 'Project next step', icon: 'projects', href: 'pages/projects.html' },
                    { label: 'Calendar event', icon: 'calendar', href: 'pages/calendar.html' },
                ],
            },
        ]);
    }

    function render() {
        renderList();
        renderMilestones();
        renderReview();
        renderSidebar();
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

    async function loadEvents() {
        const cal = await A.items.fetchEvents(21);
        state.events = cal.events;
        state.calendar = cal;
        if (cal.configured && !state.calendars.length) {
            state.calendars = await A.api('/calendar/calendars').catch(() => []);
        }
    }

    async function load() {
        renderFilters();
        const [plan, workspaces, custom] = await Promise.all([
            A.store.plan.load().catch(() => ({ tasks: [], roadmaps: [] })),
            A.api('/workspaces').catch(() => ({})),
            A.api('/projects').catch(() => []),
            A.store.review.load().catch(() => A.store.review.fallback({ events: {}, series: {}, calendars: {} })),
            loadEvents(),
        ]);
        state.plan = plan;
        if (A.items.reachFinishedMilestones(plan)) A.store.plan.save(true);
        Object.entries(workspaces).forEach(([id, ws]) => { state.workspaces[id] = A.store.workspace(id).seed(ws); });
        custom.forEach((p) => { state.names[p.id] = p.name; });
        renderCalendarNote();
        if (state.calendar.configured) await A.items.syncAccepted(state.events).catch(() => 0);
        render();

        A.api('/repos').then((repos) => {
            repos.forEach((r) => { state.names[`gh:${r.full_name}`] = r.name; });
            render();
        }).catch(() => {});
    }

    document.getElementById('refresh-btn').prepend(A.icon('refresh', 14));
    document.getElementById('refresh-btn').addEventListener('click', async () => {
        await loadEvents();
        renderCalendarNote();
        if (state.calendar.configured) await A.items.syncAccepted(state.events);
        render();
        A.toast('Up to date', 'ok');
    });

    load();
})();
