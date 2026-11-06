/**
 * Plan: tasks with due dates + roadmaps for long-running work.
 *
 * Routes (in the hash so the sidebar can link to them):
 *   #view=all|today|upcoming|overdue|someday|done   task lists
 *   #roadmaps                                        roadmap overview
 *   #roadmap=<id>                                    one roadmap
 */
(function () {
    const A = window.Admin;
    const store = A.store.plan;
    const main = document.getElementById('main');

    const VIEWS = [
        { key: 'all', label: 'All tasks', icon: 'list' },
        { key: 'today', label: 'Today', icon: 'sunrise' },
        { key: 'upcoming', label: 'Next 7 days', icon: 'calendar' },
        { key: 'overdue', label: 'Overdue', icon: 'alert' },
        { key: 'someday', label: 'No date', icon: 'inbox' },
        { key: 'done', label: 'Completed', icon: 'check' },
    ];

    let projects = []; // [{ id, name }] for linking a roadmap to a project
    const plan = () => store.doc;

    document.getElementById('topbar-actions').appendChild(A.store.indicator());

    // --------------------------------------------------------------- route --

    function route() {
        const h = A.hashParams();
        if (h.has('roadmap')) return { kind: 'roadmap', id: h.get('roadmap') };
        if (window.location.hash === '#roadmaps') return { kind: 'roadmaps' };
        const view = h.get('view');
        return { kind: 'tasks', view: VIEWS.some((v) => v.key === view) ? view : 'all' };
    }

    function go(hash) {
        if (window.location.hash === hash) render();
        else window.location.hash = hash;
    }

    // --------------------------------------------------------------- tasks --

    function taskMatches(t, view, today) {
        if (view === 'done') return t.done;
        if (t.done) return false;
        switch (view) {
            case 'today': return t.due && t.due <= today; // today + anything overdue
            case 'upcoming': return t.due && t.due >= today && A.daysBetween(today, t.due) <= 7;
            case 'overdue': return t.due && t.due < today;
            case 'someday': return !t.due;
            default: return true;
        }
    }

    function counts() {
        const today = A.todayKey();
        const out = {};
        VIEWS.forEach((v) => { out[v.key] = plan().tasks.filter((t) => taskMatches(t, v.key, today)).length; });
        return out;
    }

    function sortTasks(list) {
        return list.sort((a, b) => {
            if (a.due !== b.due) {
                if (!a.due) return 1;
                if (!b.due) return -1;
                return a.due.localeCompare(b.due);
            }
            if ((a.time || '') !== (b.time || '')) {
                if (!a.time) return 1;
                if (!b.time) return -1;
                return a.time.localeCompare(b.time);
            }
            return A.priorityRank(a.priority) - A.priorityRank(b.priority);
        });
    }

    function taskDialog(task) {
        const editing = Boolean(task);
        A.modal.open({
            title: editing ? 'Edit task' : 'New task',
            fields: [
                { name: 'title', label: 'Task', required: true, value: task?.title || '', placeholder: 'What needs doing?' },
                { name: 'due', label: 'Due date', type: 'date', value: task?.due || '', half: true },
                { name: 'time', label: 'Time (optional)', type: 'time', value: task?.time || '', half: true, hint: 'Leave empty for an all-day item.' },
                { name: 'priority', label: 'Priority', type: 'select', value: task?.priority || 'medium', options: A.PRIORITIES, half: true },
                { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, value: task?.notes || '' },
                ...(task?.source ? [{
                    name: 'onCalendar', label: 'Block this time on my calendar', type: 'checkbox', value: !task.noCalendar,
                    hint: `Made from an event in ${task.source.calendarName}. Leave off if that event is already at the same time.`,
                }] : []),
            ],
            submitLabel: editing ? 'Save' : 'Add task',
            destructiveLabel: editing ? 'Delete' : null,
            onDestructive: () => deleteTask(task),
            onSubmit: (v) => {
                if (v.time && !v.due) throw new Error('Pick a date to go with that time.');
                const target = task || { id: A.uid(), done: false, createdAt: new Date().toISOString() };
                Object.assign(target, { title: v.title, due: v.due, time: v.time, priority: v.priority, notes: v.notes });
                if (target.source) target.noCalendar = !v.onCalendar;
                if (!editing) plan().tasks.unshift(target);
                store.save(true);
                render();
            },
        });
    }

    function deleteTask(task) {
        plan().tasks = plan().tasks.filter((t) => t.id !== task.id);
        store.save(true);
        render();
        A.toast('Task deleted');
    }

    function toggleTask(task, done) {
        task.done = done;
        if (done) task.doneAt = new Date().toISOString();
        else delete task.doneAt;
        store.save(true);
        // Let the tick register before the row leaves the list.
        setTimeout(render, done ? 280 : 0);
    }

    function taskRow(t) {
        const row = A.el('div', `item-row${t.done ? ' is-done' : ''}`);
        row.appendChild(A.checkbox(t.done, (v) => {
            row.classList.toggle('is-done', v);
            row.querySelector('.check').classList.toggle('on', v);
            toggleTask(t, v);
        }, `Mark "${t.title}" ${t.done ? 'not done' : 'done'}`));

        const main = A.el('div', 'item-main');
        main.tabIndex = 0;
        main.setAttribute('role', 'button');
        main.appendChild(A.el('span', 'item-title', t.title));
        const subBits = [];
        if (t.source?.calendarName) subBits.push(`from ${t.source.calendarName}`);
        if (t.notes) subBits.push(t.notes.split('\n')[0]);
        if (t.done && t.doneAt) subBits.push(`done ${A.relativeTime(t.doneAt)}`);
        if (subBits.length) main.appendChild(A.el('span', 'item-sub', subBits.join(' · ')));
        main.addEventListener('click', () => taskDialog(t));
        main.addEventListener('keydown', (e) => { if (e.key === 'Enter') taskDialog(t); });
        row.appendChild(main);

        const meta = A.el('div', 'item-meta');
        if (!t.done) meta.appendChild(A.priorityFlag(t.priority));
        const chip = A.dueChip(t.due, t.time, t.done);
        if (chip) meta.appendChild(chip);
        if (t.calEventId) {
            const cal = A.icon('calendar', 13, 'kind-icon');
            cal.title = 'On your Google Calendar';
            meta.appendChild(cal);
        }
        const actions = A.el('div', 'item-actions');
        actions.appendChild(A.iconButton('trash', 'Delete task', () => deleteTask(t), 'icon-btn sm danger'));
        meta.appendChild(actions);
        row.appendChild(meta);
        return row;
    }

    function quickAdd(view) {
        const form = A.el('form', 'quick-add');
        const title = A.el('input', 'qa-title');
        title.type = 'text';
        title.placeholder = 'Add a task and press Enter…';
        title.setAttribute('aria-label', 'Task');
        const due = A.el('input');
        due.type = 'date';
        due.setAttribute('aria-label', 'Due date');
        if (view === 'today') due.value = A.todayKey();
        if (view === 'upcoming') due.value = A.addDays(A.todayKey(), 1);
        const time = A.el('input');
        time.type = 'time';
        time.setAttribute('aria-label', 'Time (optional)');
        const prio = A.el('select');
        prio.setAttribute('aria-label', 'Priority');
        A.PRIORITIES.forEach((p) => {
            const o = A.el('option', null, `${p.label} priority`);
            o.value = p.value;
            if (p.value === 'medium') o.selected = true;
            prio.appendChild(o);
        });
        const add = A.el('button', 'btn btn-add-primary btn-small', 'Add');
        add.type = 'submit';
        [title, due, time, prio, add].forEach((n) => form.appendChild(n));

        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = title.value.trim();
            if (!text) { title.focus(); return; }
            if (time.value && !due.value) { A.toast('Pick a date to go with that time', 'error'); due.focus(); return; }
            plan().tasks.unshift({
                id: A.uid(), title: text, notes: '', due: due.value, time: time.value,
                priority: prio.value, done: false, createdAt: new Date().toISOString(),
            });
            store.save(true);
            render();
            main.querySelector('.qa-title')?.focus();
        });
        return form;
    }

    function renderTasks(view) {
        const meta = VIEWS.find((v) => v.key === view);
        setTitle(meta.label, view === 'done' ? 'Everything you have ticked off.' : 'Dated tasks also appear in Up next and on your calendar.');
        A.clear(main);
        if (view !== 'done') main.appendChild(quickAdd(view));

        const today = A.todayKey();
        const list = plan().tasks.filter((t) => taskMatches(t, view, today));
        const panel = A.el('section', 'panel');

        if (!list.length) {
            const empty = A.el('div', 'empty-state');
            const msgs = {
                all: ['Nothing on your plate', 'Add a task above. Give it a date to see it in Up next and on your calendar.'],
                today: ['Nothing due today', 'Enjoy it — or pull something forward.'],
                upcoming: ['A clear week ahead', 'Nothing is due in the next seven days.'],
                overdue: ['Nothing overdue', 'You are on top of things.'],
                someday: ['No undated tasks', 'Everything has a date.'],
                done: ['Nothing completed yet', 'Ticked-off tasks land here.'],
            };
            empty.appendChild(A.el('strong', null, msgs[view][0]));
            empty.appendChild(document.createTextNode(msgs[view][1]));
            panel.appendChild(empty);
            main.appendChild(panel);
            return;
        }

        if (view === 'done') {
            const head = A.el('div', 'panel-head');
            head.appendChild(A.el('h2', null, `${list.length} completed`));
            head.appendChild(A.button('Clear completed', 'btn btn-danger btn-small', async () => {
                const ok = await A.confirm({
                    title: 'Clear completed tasks?',
                    description: `Permanently removes ${list.length} completed task${list.length === 1 ? '' : 's'} (and their calendar entries).`,
                    confirmLabel: 'Clear', danger: true,
                });
                if (!ok) return;
                plan().tasks = plan().tasks.filter((t) => !t.done);
                store.save(true);
                render();
            }));
            panel.appendChild(head);
            const rows = A.el('div', 'row-list');
            list.sort((a, b) => new Date(b.doneAt || 0) - new Date(a.doneAt || 0)).forEach((t) => rows.appendChild(taskRow(t)));
            panel.appendChild(rows);
            main.appendChild(panel);
            return;
        }

        // Group by when it's due.
        const groups = [
            { key: 'overdue', label: 'Overdue', tone: 'danger', test: (t) => t.due && t.due < today },
            { key: 'today', label: 'Today', tone: 'accent', test: (t) => t.due === today },
            { key: 'tomorrow', label: 'Tomorrow', test: (t) => t.due && A.daysBetween(today, t.due) === 1 },
            { key: 'week', label: 'This week', test: (t) => t.due && A.daysBetween(today, t.due) > 1 && A.daysBetween(today, t.due) <= 7 },
            { key: 'later', label: 'Later', test: (t) => t.due && A.daysBetween(today, t.due) > 7 },
            { key: 'someday', label: 'No date', test: (t) => !t.due },
        ];
        groups.forEach((g) => {
            const items = sortTasks(list.filter(g.test));
            if (!items.length) return;
            const head = A.el('div', `group-head${g.tone ? ' tone-' + g.tone : ''}`);
            head.appendChild(A.el('span', null, g.label));
            head.appendChild(A.el('span', 'count', String(items.length)));
            panel.appendChild(head);
            const rows = A.el('div', 'row-list');
            items.forEach((t) => rows.appendChild(taskRow(t)));
            panel.appendChild(rows);
        });
        main.appendChild(panel);
    }

    // ------------------------------------------------------------ roadmaps --

    function phaseDone(ph) {
        return ph.items.length > 0 && ph.items.every((i) => i.done);
    }

    function roadmapProgress(r) {
        const items = r.phases.flatMap((p) => p.items);
        return { done: items.filter((i) => i.done).length, total: items.length, phasesDone: r.phases.filter(phaseDone).length };
    }

    function roadmapSpan(r) {
        const dates = [];
        r.phases.forEach((p) => {
            if (p.start) dates.push(p.start);
            if (p.end) dates.push(p.end);
            p.items.forEach((i) => { if (i.due) dates.push(i.due); });
        });
        if (!dates.length) return null;
        dates.sort();
        return { from: dates[0], to: dates[dates.length - 1] };
    }

    function spanLabel(span) {
        if (!span) return 'Unscheduled';
        const f = (k) => A.parseDate(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return `${f(span.from)} → ${f(span.to)}`;
    }

    function newRoadmapDialog() {
        A.modal.open({
            title: 'New roadmap',
            description: 'A roadmap breaks long work into phases with dates and milestones. Phases and dated milestones are mirrored to your calendar.',
            fields: [
                { name: 'title', label: 'Name', required: true, placeholder: 'e.g. Ship v2, Learn Rust, Thesis' },
                { name: 'description', label: 'What is it for?', type: 'textarea', rows: 2 },
                { name: 'phases', label: 'Start with this many phases', type: 'number', value: '3', half: true },
                { name: 'start', label: 'First phase starts', type: 'date', half: true, hint: 'Optional — fills in dates one week per phase.' },
            ],
            submitLabel: 'Create roadmap',
            onSubmit: (v) => {
                const n = Math.max(0, Math.min(52, Number(v.phases) || 0));
                const r = {
                    id: A.uid(), title: v.title, description: v.description, projectId: '',
                    createdAt: new Date().toISOString(),
                    phases: Array.from({ length: n }, (_, i) => ({ id: A.uid(), title: `Phase ${i + 1}`, start: '', end: '', notes: '', items: [] })),
                };
                if (v.start && n) schedule(r, v.start, 1, false);
                plan().roadmaps.push(r);
                store.save(true);
                go(`#roadmap=${encodeURIComponent(r.id)}`);
            },
        });
    }

    // Lay phases back-to-back from `start`, `weeks` long each.
    function schedule(r, start, weeks, setMilestones) {
        let cursor = start;
        r.phases.forEach((p) => {
            p.start = cursor;
            p.end = A.addDays(cursor, weeks * 7 - 1);
            if (setMilestones) p.items.forEach((i) => { if (!i.due) i.due = p.end; });
            cursor = A.addDays(p.end, 1);
        });
    }

    function scheduleDialog(r) {
        const today = A.todayKey();
        const nextMonday = A.addDays(A.startOfWeekKey(today), 7);
        A.modal.open({
            title: 'Schedule phases',
            description: `Lays all ${r.phases.length} phases back to back from a start date. Existing phase dates are replaced.`,
            fields: [
                { name: 'start', label: 'Start on', type: 'date', required: true, value: r.phases[0]?.start || nextMonday, half: true },
                { name: 'weeks', label: 'Weeks per phase', type: 'number', value: '1', half: true },
                { name: 'milestones', label: 'Due undated milestones on the last day of their phase', type: 'checkbox', value: true },
            ],
            submitLabel: 'Schedule',
            onSubmit: (v) => {
                const weeks = Math.max(1, Math.min(26, Number(v.weeks) || 1));
                schedule(r, v.start, weeks, v.milestones);
                store.save(true);
                render();
                A.toast('Phases scheduled — they are on your calendar too', 'ok');
            },
        });
    }

    function renderRoadmaps() {
        setTitle('Roadmaps', 'Long projects, broken into phases and milestones.');
        A.clear(main);
        const grid = A.el('div', 'roadmap-cards');
        plan().roadmaps.forEach((r) => {
            const card = A.el('a', 'roadmap-card');
            card.href = `#roadmap=${encodeURIComponent(r.id)}`;
            card.appendChild(A.el('h3', null, r.title));
            if (r.description) card.appendChild(A.el('p', null, r.description));
            const prog = roadmapProgress(r);
            card.appendChild(A.progressBar(prog.done, prog.total));
            const meta = A.el('div', 'rc-meta');
            meta.appendChild(A.el('span', 'tag', `${r.phases.length} phase${r.phases.length === 1 ? '' : 's'}`));
            meta.appendChild(A.el('span', null, spanLabel(roadmapSpan(r))));
            const today = A.todayKey();
            const current = r.phases.find((p) => p.start && p.end && p.start <= today && p.end >= today);
            if (current) meta.appendChild(A.el('span', 'tag tag-accent', `Now: ${current.title}`));
            card.appendChild(meta);
            grid.appendChild(card);
        });
        const add = A.button('+ New roadmap', 'roadmap-card new', newRoadmapDialog);
        grid.appendChild(add);
        main.appendChild(grid);
    }

    function renderTimeline(r, host) {
        const span = roadmapSpan(r);
        if (!span) return;
        const today = A.todayKey();
        const from = span.from;
        const to = A.addDays(span.to, 1);
        const total = Math.max(1, A.daysBetween(from, to));
        const pct = (key) => `${(A.daysBetween(from, key) / total) * 100}%`;

        const tl = A.el('div', 'timeline');
        tl.style.setProperty('--tl-label', window.matchMedia('(max-width: 760px)').matches ? '6.5rem' : '12rem');

        // Weekly ticks for short roadmaps, monthly for long ones.
        const scale = A.el('div', 'tl-scale');
        const weekly = total <= 120;
        let tick = weekly ? A.startOfWeekKey(from) : A.dateKey(new Date(A.parseDate(from).getFullYear(), A.parseDate(from).getMonth() + 1, 1));
        if (weekly && tick < from) tick = A.addDays(tick, 7);
        let guard = 0;
        while (tick < to && guard++ < 80) {
            const t = A.el('span', 'tl-tick', A.parseDate(tick).toLocaleDateString(undefined, weekly ? { month: 'short', day: 'numeric' } : { month: 'short', year: '2-digit' }));
            t.style.left = pct(tick);
            scale.appendChild(t);
            if (weekly) tick = A.addDays(tick, weekly && total > 60 ? 14 : 7);
            else { const d = A.parseDate(tick); tick = A.dateKey(new Date(d.getFullYear(), d.getMonth() + 1, 1)); }
        }
        tl.appendChild(scale);

        const rows = A.el('div', 'tl-rows');
        r.phases.forEach((p) => {
            const row = A.el('div', 'tl-row');
            const label = A.button(p.title, 'tl-label', () => document.getElementById(`phase-${p.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
            label.title = p.title;
            row.appendChild(label);
            const track = A.el('div', 'tl-track');
            if (p.start && p.end) {
                const done = phaseDone(p);
                const isCurrent = p.start <= today && p.end >= today;
                const bar = A.el('div', `tl-bar${done ? ' done' : ''}${isCurrent ? ' current' : ''}`);
                bar.style.left = pct(p.start);
                bar.style.width = `${(Math.max(1, A.daysBetween(p.start, A.addDays(p.end, 1))) / total) * 100}%`;
                const fill = A.el('div', 'tl-bar-fill');
                fill.style.width = `${p.items.length ? (p.items.filter((x) => x.done).length / p.items.length) * 100 : 0}%`;
                bar.appendChild(fill);
                bar.title = `${p.title}: ${A.shortDate(p.start)} – ${A.shortDate(p.end)}`;
                track.appendChild(bar);
            } else {
                track.appendChild(A.el('span', 'tl-unscheduled', 'not scheduled'));
            }
            p.items.forEach((it) => {
                if (!it.due) return;
                const ms = A.el('span', `tl-ms${it.done ? ' done' : ''}`);
                ms.style.left = pct(it.due);
                ms.title = `${it.title} — ${A.shortDate(it.due)}`;
                track.appendChild(ms);
            });
            row.appendChild(track);
            rows.appendChild(row);
        });
        if (today >= from && today < to) {
            const line = A.el('div', 'tl-today');
            line.style.left = `calc(var(--tl-label) + (100% - var(--tl-label)) * ${A.daysBetween(from, today) / total})`;
            rows.appendChild(line);
        }
        tl.appendChild(rows);
        host.appendChild(tl);
    }

    function textField(value, className, placeholder, onInput, multiline) {
        const input = A.el(multiline ? 'textarea' : 'input', className);
        if (!multiline) input.type = 'text';
        else input.rows = 2;
        input.value = value || '';
        input.placeholder = placeholder || '';
        input.addEventListener('input', () => { onInput(input.value); store.save(); });
        return input;
    }

    function dateField(value, label, onChange) {
        const input = A.el('input');
        input.type = 'date';
        input.value = value || '';
        input.setAttribute('aria-label', label);
        input.addEventListener('change', () => { onChange(input.value); store.save(true); render(); });
        return input;
    }

    // Milestones whose subtask list is open; survives this page's re-renders.
    const openSubtasks = new Set();

    function phaseCard(r, p, index) {
        const today = A.todayKey();
        const done = phaseDone(p);
        const current = p.start && p.end && p.start <= today && p.end >= today;
        const card = A.el('div', `phase${done ? ' done' : ''}${current ? ' current' : ''}`);
        card.id = `phase-${p.id}`;

        const head = A.el('div', 'phase-head');
        head.appendChild(A.el('span', 'phase-num', done ? '✓' : String(index + 1)));
        const title = textField(p.title, 'phase-title', 'Phase name', (v) => { p.title = v; });
        title.setAttribute('aria-label', 'Phase name');
        head.appendChild(title);

        const dates = A.el('div', 'phase-dates');
        dates.appendChild(dateField(p.start, 'Phase start', (v) => {
            p.start = v;
            if (v && (!p.end || p.end < v)) p.end = A.addDays(v, 6);
        }));
        dates.appendChild(A.el('span', null, '→'));
        dates.appendChild(dateField(p.end, 'Phase end', (v) => {
            p.end = v;
            if (v && p.start && p.start > v) p.start = v;
        }));
        head.appendChild(dates);

        const actions = A.el('div', 'phase-actions');
        if (index > 0) actions.appendChild(A.iconButton('chevronLeft', 'Move up', () => move(r.phases, index, -1), 'icon-btn sm'));
        if (index < r.phases.length - 1) actions.appendChild(A.iconButton('chevronRight', 'Move down', () => move(r.phases, index, 1), 'icon-btn sm'));
        actions.querySelectorAll('svg').forEach((s) => { s.style.transform = 'rotate(90deg)'; });
        actions.appendChild(A.iconButton('trash', 'Delete phase', async () => {
            const ok = await A.confirm({ title: `Delete "${p.title}"?`, description: 'Its milestones and calendar entries go with it.', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            r.phases = r.phases.filter((x) => x.id !== p.id);
            store.save(true);
            render();
        }, 'icon-btn sm danger'));
        head.appendChild(actions);
        card.appendChild(head);

        const body = A.el('div', 'phase-body');
        p.items.forEach((it) => {
            const row = A.el('div', `phase-item${it.done ? ' done' : ''}`);
            row.appendChild(A.checkbox(it.done, (v) => { it.done = v; store.save(true); render(); }));
            const text = textField(it.title, '', 'Milestone', (v) => { it.title = v; });
            text.setAttribute('aria-label', 'Milestone');
            row.appendChild(text);
            const toggle = A.button('', 'subtask-toggle', () => {
                const open = !openSubtasks.has(it.id);
                if (open) openSubtasks.add(it.id); else openSubtasks.delete(it.id);
                subtasks.hidden = !open;
                if (open) subtasks.focusAdd();
            });
            const toggleLabel = () => {
                const { done, total } = A.items.subtaskProgress(it);
                A.clear(toggle).appendChild(A.icon('list', 13));
                if (total) toggle.appendChild(A.el('span', null, `${done}/${total}`));
                toggle.title = total ? `Subtasks: ${done} of ${total} done` : 'Add subtasks';
                toggle.setAttribute('aria-label', toggle.title);
            };
            toggleLabel();
            const subtasks = A.items.subtaskEditor(it, { onChange: toggleLabel });
            subtasks.hidden = !openSubtasks.has(it.id);
            row.appendChild(toggle);
            row.appendChild(dateField(it.due, 'Milestone due date', (v) => { it.due = v; }));
            row.appendChild(A.iconButton('x', 'Remove milestone', () => {
                p.items = p.items.filter((x) => x.id !== it.id);
                store.save(true);
                render();
            }, 'icon-btn sm danger'));
            body.appendChild(row);
            body.appendChild(subtasks);
        });

        const add = A.el('input', 'inline-add');
        add.type = 'text';
        add.placeholder = '+ Add a milestone and press Enter';
        add.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !add.value.trim()) return;
            p.items.push({ id: A.uid(), title: add.value.trim(), due: '', done: false });
            store.save(true);
            render();
            document.querySelector(`#phase-${p.id} .inline-add`)?.focus();
        });
        body.appendChild(add);

        const notes = textField(p.notes, 'phase-notes', 'Notes for this phase…', (v) => { p.notes = v; }, true);
        notes.setAttribute('aria-label', 'Phase notes');
        body.appendChild(notes);
        card.appendChild(body);
        return card;
    }

    function move(list, index, dir) {
        const [item] = list.splice(index, 1);
        list.splice(index + dir, 0, item);
        store.save(true);
        render();
    }

    function renderRoadmap(id) {
        const r = plan().roadmaps.find((x) => x.id === id);
        if (!r) {
            setTitle('Roadmap not found', '');
            A.clear(main).appendChild(A.el('div', 'empty-state', 'That roadmap no longer exists.'));
            return;
        }
        setTitle(r.title, 'Roadmap');
        A.clear(main);
        const scrollY = window.scrollY;

        // Header
        const headPanel = A.el('section', 'panel');
        const header = A.el('div', 'rm-header');
        const titles = A.el('div', 'rm-titles');
        const titleInput = textField(r.title, 'rm-title-input', 'Roadmap name', (v) => {
            r.title = v;
            document.getElementById('view-title').textContent = v || 'Roadmap';
        });
        titleInput.setAttribute('aria-label', 'Roadmap name');
        titles.appendChild(titleInput);
        const desc = textField(r.description, 'rm-desc-input', 'What is this roadmap for?', (v) => { r.description = v; }, true);
        desc.setAttribute('aria-label', 'Description');
        titles.appendChild(desc);

        const prog = roadmapProgress(r);
        const facts = A.el('div', 'rm-facts');
        facts.appendChild(A.el('span', 'tag', spanLabel(roadmapSpan(r))));
        facts.appendChild(A.el('span', 'tag', `${prog.phasesDone}/${r.phases.length} phases done`));
        facts.appendChild(A.el('span', 'tag', `${prog.done}/${prog.total} milestones`));
        if (r.projectId) {
            const p = projects.find((x) => x.id === r.projectId);
            const tag = A.el('a', 'tag tag-violet', `Project: ${p?.name || A.projectLabel(r.projectId)}`);
            tag.href = A.projectHref(r.projectId);
            tag.style.textDecoration = 'none';
            facts.appendChild(tag);
        }
        titles.appendChild(facts);
        header.appendChild(titles);

        const actions = A.el('div', 'panel-head-actions');
        if (r.phases.length) actions.appendChild(A.button('Schedule…', 'btn btn-edit btn-small', () => scheduleDialog(r)));
        actions.appendChild(A.button('Link project…', 'btn btn-edit btn-small', () => linkDialog(r)));
        actions.appendChild(A.iconButton('trash', 'Delete roadmap', async () => {
            const ok = await A.confirm({
                title: `Delete "${r.title}"?`,
                description: 'All phases, milestones and their calendar entries are removed. This cannot be undone.',
                confirmLabel: 'Delete roadmap', danger: true,
            });
            if (!ok) return;
            plan().roadmaps = plan().roadmaps.filter((x) => x.id !== r.id);
            store.save(true);
            go('#roadmaps');
        }, 'icon-btn danger'));
        header.appendChild(actions);
        headPanel.appendChild(header);
        if (prog.total) {
            const bar = A.progressBar(prog.done, prog.total, true);
            bar.style.marginTop = '0.9rem';
            headPanel.appendChild(bar);
        }
        main.appendChild(headPanel);

        // Timeline
        if (roadmapSpan(r)) {
            const tlPanel = A.el('section', 'panel');
            tlPanel.appendChild(A.el('h2', null, 'Timeline'));
            renderTimeline(r, tlPanel);
            main.appendChild(tlPanel);
        } else if (r.phases.length) {
            const note = A.el('div', 'notice');
            note.appendChild(A.icon('calendar', 16));
            const text = A.el('div');
            text.appendChild(document.createTextNode('No dates yet. '));
            const btn = A.el('a', 'inline-link', 'Schedule the phases');
            btn.href = '#';
            btn.addEventListener('click', (e) => { e.preventDefault(); scheduleDialog(r); });
            text.appendChild(btn);
            text.appendChild(document.createTextNode(' to see a timeline and put them on your calendar.'));
            note.appendChild(text);
            main.appendChild(note);
        }

        // Phases
        const list = A.el('div', 'phase-list');
        r.phases.forEach((p, i) => list.appendChild(phaseCard(r, p, i)));
        main.appendChild(list);

        const addPhase = A.button('+ Add phase', 'btn-add', () => {
            const last = r.phases[r.phases.length - 1];
            const start = last?.end ? A.addDays(last.end, 1) : '';
            const len = last?.start && last?.end ? A.daysBetween(last.start, last.end) : 6;
            r.phases.push({ id: A.uid(), title: `Phase ${r.phases.length + 1}`, start, end: start ? A.addDays(start, len) : '', notes: '', items: [] });
            store.save(true);
            render();
            const cards = main.querySelectorAll('.phase-title');
            cards[cards.length - 1]?.select();
        });
        main.appendChild(addPhase);
        window.scrollTo(0, scrollY);
    }

    function linkDialog(r) {
        A.modal.open({
            title: 'Link to a project',
            description: 'The roadmap\'s progress shows on that project\'s tile and page.',
            fields: [{
                name: 'projectId', label: 'Project', type: 'select', value: r.projectId || '',
                options: [{ value: '', label: '— None —' }, ...projects.map((p) => ({ value: p.id, label: p.name }))],
            }],
            submitLabel: 'Save',
            onSubmit: (v) => { r.projectId = v.projectId; store.save(true); render(); },
        });
    }

    // ------------------------------------------------------------- chrome --

    function setTitle(title, sub) {
        document.getElementById('view-title').textContent = title;
        document.getElementById('view-sub').textContent = sub;
        document.title = `${title} — Plan`;
    }

    function renderSidebar() {
        const r = route();
        const c = counts();
        window.Nav.setSections([
            {
                label: 'Tasks',
                items: VIEWS.map((v) => ({
                    label: v.label,
                    icon: v.icon,
                    href: `#view=${v.key}`,
                    active: r.kind === 'tasks' && r.view === v.key,
                    count: c[v.key] || '',
                    countTone: v.key === 'overdue' && c.overdue ? 'danger' : v.key === 'today' && c.today ? 'accent' : '',
                })),
            },
            {
                label: 'Roadmaps',
                action: { label: 'New roadmap', onClick: newRoadmapDialog },
                items: [
                    { label: 'All roadmaps', icon: 'map', href: '#roadmaps', active: r.kind === 'roadmaps' },
                    ...plan().roadmaps.map((rm) => {
                        const p = roadmapProgress(rm);
                        return {
                            label: rm.title || 'Untitled',
                            icon: 'flag',
                            href: `#roadmap=${encodeURIComponent(rm.id)}`,
                            active: r.kind === 'roadmap' && r.id === rm.id,
                            count: p.total ? `${Math.round((p.done / p.total) * 100)}%` : '',
                        };
                    }),
                ],
            },
        ]);
    }

    function render() {
        if (!plan()) return;
        const r = route();
        main.className = r.kind === 'tasks' ? 'narrow' : '';
        if (r.kind === 'roadmap') renderRoadmap(r.id);
        else if (r.kind === 'roadmaps') renderRoadmaps();
        else renderTasks(r.view);
        renderSidebar();
    }

    window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
    // Sidebar counts follow typing in roadmap fields without a full re-render.
    A.store.on((e) => { if (e.name === 'plan' && e.status === 'saved') renderSidebar(); });

    async function load() {
        try {
            await store.load();
        } catch (e) {
            A.clear(main).appendChild(A.el('div', 'empty-state', `Couldn't load your plan: ${e.message}`));
            return;
        }
        render();
        // Project names for roadmap links; not needed for first paint.
        Promise.all([A.api('/projects').catch(() => []), A.api('/repos').catch(() => [])]).then(([custom, repos]) => {
            projects = [
                ...custom.map((p) => ({ id: p.id, name: p.name })),
                ...repos.filter((x) => !x.archived).map((x) => ({ id: `gh:${x.full_name}`, name: x.name })),
            ].sort((a, b) => a.name.localeCompare(b.name));
            if (route().kind === 'roadmap') render();
        });
    }

    load();
})();
