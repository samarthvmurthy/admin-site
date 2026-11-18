/**
 * Everything that has to be done, from every module, in one shape — used by
 * the Up next page and the dashboard tile. Attached as Admin.items.
 *
 * Item: { key, kind: task|step|subtask|milestone|phase|event, title, due, time,
 *         priority, context, href, color?, ownerId?, refId }
 *
 * Subtasks are the work; a milestone is only a marker of progress, so
 * collect() returns its open, dated subtasks and never the milestone itself.
 * A milestone with subtasks is reached exactly when all of them are done
 * (see settleMilestone); one without subtasks is marked reached by hand.
 */
(function () {
    const A = window.Admin;

    const KIND_LABEL = { task: 'Task', step: 'Next step', subtask: 'Subtask', milestone: 'Milestone', phase: 'Phase', event: 'Event' };

    function pad(n) { return String(n).padStart(2, '0'); }

    function eventItem(e, today) {
        const start = A.parseDate(e.start);
        const end = e.end ? A.parseDate(e.end) : start;
        if (end < new Date() && !e.allDay) return null; // already over
        let due = A.dateKey(start);
        // All-day ends are exclusive; multi-day events in progress count as today.
        if (e.allDay) {
            const lastDay = A.addDays(A.dateKey(end), -1);
            if (lastDay < today) return null;
            if (due < today) due = today;
        } else if (due < today) {
            due = today;
        }
        return {
            key: `event:${e.calendarId}:${e.id}`,
            kind: 'event',
            title: e.summary,
            due,
            time: e.allDay ? '' : `${pad(start.getHours())}:${pad(start.getMinutes())}`,
            priority: null,
            context: e.calendarName || 'Calendar',
            color: e.color,
            href: 'pages/calendar.html',
            external: e.htmlLink,
            refId: e.id,
        };
    }

    // ------------------------------------------------------------ review --
    //
    // Calendar events wait for review before they count in Up next. A
    // decision can be made for one event, a repeating series, or a whole
    // calendar; the most specific one wins.

    const review = {
        key: (e) => `${e.calendarId}|${e.id}`,
        seriesKey: (e) => (e.recurringEventId ? `${e.calendarId}|${e.recurringEventId}` : null),

        decision(doc, e) {
            if (!doc) return 'pending';
            const ev = doc.events?.[review.key(e)];
            if (ev) return ev.decision;
            const sk = review.seriesKey(e);
            if (sk && doc.series?.[sk]) return doc.series[sk];
            return doc.calendars?.[e.calendarId] || 'pending';
        },

        // scope: 'event' | 'series' | 'calendar'; decision null clears it.
        set(doc, e, decision, scope = 'event') {
            doc.events = doc.events || {};
            doc.series = doc.series || {};
            doc.calendars = doc.calendars || {};
            if (scope === 'series' && review.seriesKey(e)) {
                const sk = review.seriesKey(e);
                if (decision) doc.series[sk] = decision; else delete doc.series[sk];
                // A series-wide call overrides one-off calls on its instances.
                Object.keys(doc.events).forEach((k) => { if (k.startsWith(`${e.calendarId}|${e.recurringEventId}_`)) delete doc.events[k]; });
            } else if (scope === 'calendar') {
                if (decision) doc.calendars[e.calendarId] = decision; else delete doc.calendars[e.calendarId];
            } else if (decision) {
                doc.events[review.key(e)] = { decision, date: A.dateKey(A.parseDate(e.start)) };
            } else {
                delete doc.events[review.key(e)];
            }
        },
    };

    // Events worth reviewing at all: not mirrors of our own items, not over.
    function candidates(events) {
        const today = A.todayKey();
        return (events || [])
            .filter((e) => !(e.controlPanel || e.cpKind))
            .map((e) => ({ event: e, item: eventItem(e, today) }))
            .filter((c) => c.item);
    }

    function reviewQueue(events, doc) {
        const out = { pending: [], dismissed: [] };
        candidates(events).forEach((c) => {
            const d = review.decision(doc, c.event);
            if (d === 'pending') out.pending.push(c);
            else if (d === 'dismiss') out.dismissed.push(c);
        });
        const byStart = (a, b) => A.parseDate(a.event.start) - A.parseDate(b.event.start);
        out.pending.sort(byStart);
        out.dismissed.sort(byStart);
        return out;
    }

    const pad2 = (n) => String(n).padStart(2, '0');

    // ------------------------------------------------------- task timing --
    //
    // A task's deadline (due, dueTime) is separate from the time you set
    // aside for it (workDate, workTime, duration), which is what goes on the
    // calendar. It's listed on the day you'll work on it; once that day has
    // passed without it being done, it goes back to its due date.
    function taskWhen(t, today = A.todayKey()) {
        if (t.workDate && (t.workDate >= today || !t.due)) return { date: t.workDate, time: t.workTime || '', scheduled: true };
        return { date: t.due || '', time: t.dueTime || '', scheduled: false };
    }

    function deadlineChip(t, done) {
        if (!t.due) return null;
        const chip = A.dueChip(t.due, t.dueTime, done);
        chip.classList.add('deadline-chip');
        chip.textContent = `Due ${chip.textContent}`;
        chip.title = `Due ${chip.title}${t.dueTime ? ` at ${A.formatTime(t.dueTime)}` : ''}`;
        return chip;
    }

    function workChip(t, done) {
        if (!t.workDate) return null;
        const chip = A.dueChip(t.workDate, t.workTime, done);
        chip.classList.add('work-chip');
        chip.prepend(A.icon('clock', 11));
        const len = Number(t.duration) || 0;
        chip.title = `Time set aside: ${chip.title}${t.workTime ? ` at ${A.formatTime(t.workTime)}${len ? ` for ${len < 60 ? `${len} min` : `${len / 60} h`}` : ''}` : ''}`;
        return chip;
    }

    // The chips for a task's row: when you'll do it, then when it's due.
    function taskChips(t, done) {
        return [workChip(t, done), deadlineChip(t, done)].filter(Boolean);
    }

    // A tickable Plan task for a calendar event. `overrides` carries what you
    // chose in the scheduling dialog; without it the event's own time is used.
    function taskFromEvent(e, overrides = {}) {
        const start = A.parseDate(e.start);
        const end = e.end ? A.parseDate(e.end) : null;
        const minutes = !e.allDay && end ? Math.max(15, Math.round((end - start) / 60000)) : 60;
        // The event's own date and time are the deadline. Time to work on it
        // is yours to choose, and starts unset.
        const today = A.todayKey();
        let due = A.dateKey(start);
        if (e.allDay && due < today) due = today; // multi-day event already under way
        return {
            id: A.uid(),
            title: e.summary,
            notes: e.location ? `Location: ${e.location}` : '',
            due,
            dueTime: e.allDay ? '' : `${pad2(start.getHours())}:${pad2(start.getMinutes())}`,
            workDate: '',
            workTime: '',
            duration: minutes,
            priority: 'medium',
            done: false,
            createdAt: new Date().toISOString(),
            source: { calendarId: e.calendarId, eventId: e.id, calendarName: e.calendarName || 'Calendar' },
            // The deadline is the event itself, already on your calendar.
            noCalendar: true,
            ...overrides,
        };
    }

    function linkTask(reviewDoc, e, taskId) {
        review.set(reviewDoc, e, 'accept', 'event');
        reviewDoc.events[review.key(e)].taskId = taskId;
    }

    // Make sure every accepted event (one-off, by series rule or by calendar
    // rule) has its task. A task you later delete is not recreated.
    async function syncAccepted(events) {
        const plan = A.store.plan;
        const rev = A.store.review;
        await Promise.all([plan.load(), rev.load()]);
        let created = 0;
        candidates(events).forEach(({ event }) => {
            if (review.decision(rev.doc, event) !== 'accept') return;
            const rec = rev.doc.events?.[review.key(event)];
            if (rec?.taskId) return;
            const existing = plan.doc.tasks.find((t) => t.source?.eventId === event.id && t.source?.calendarId === event.calendarId);
            const task = existing || taskFromEvent(event);
            if (!existing) { plan.doc.tasks.push(task); created++; }
            linkTask(rev.doc, event, task.id);
        });
        if (created) plan.save(true);
        rev.save(true);
        return created;
    }

    // ---------------------------------------------------------- milestones --

    function subtaskProgress(it) {
        const list = it.subtasks || [];
        return { done: list.filter((s) => s.done).length, total: list.length };
    }

    function milestoneItem(r, ph, it) {
        return {
            key: `milestone:${it.id}`, kind: 'milestone', title: it.title, due: it.due || '', time: '',
            priority: 'medium', context: r.title, phase: ph.title,
            href: `pages/plan.html#roadmap=${encodeURIComponent(r.id)}`,
            refId: it.id, ownerId: r.id, ref: it,
        };
    }

    function eachMilestone(plan, fn) {
        (plan?.roadmaps || []).forEach((r) => (r.phases || []).forEach((ph) => (ph.items || []).forEach((it) => fn(r, ph, it))));
    }

    // Open milestones, soonest first, with the undated ones last.
    function milestones(plan) {
        const out = [];
        eachMilestone(plan, (r, ph, it) => { if (!it.done) out.push(milestoneItem(r, ph, it)); });
        return out.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    }

    function reachedMilestones(plan) {
        const out = [];
        eachMilestone(plan, (r, ph, it) => { if (it.done) out.push(milestoneItem(r, ph, it)); });
        return out;
    }

    // A milestone with subtasks is reached exactly when they're all done.
    // Returns whether that changed anything.
    function settleMilestone(it) {
        const { done, total } = subtaskProgress(it);
        if (!total || Boolean(it.done) === (done === total)) return false;
        it.done = done === total;
        return true;
    }

    // Bring every milestone with subtasks in line with them, whichever way it
    // has drifted (ticked by hand with work left, or finished elsewhere).
    // Returns whether any changed.
    function settleMilestones(plan) {
        let changed = false;
        eachMilestone(plan, (r, ph, it) => { if (settleMilestone(it)) changed = true; });
        return changed;
    }

    function isLate(it, s) {
        return Boolean(it.due && s.due && s.due > it.due);
    }

    // Tickable, editable, dated subtasks for a milestone. Updates itself in
    // place so inputs keep focus; `onChange(settled)` lets the host refresh,
    // and `settled` says the milestone was reached or reopened as a result.
    // Only subtasks with a date show up in Up next (and on the calendar).
    function subtaskEditor(it, { onChange } = {}) {
        const store = A.store.plan;
        const wrap = A.el('div', 'subtasks');
        const list = A.el('div', 'subtask-list');
        const note = A.el('p', 'subtask-note');

        function renderNote() {
            const undated = (it.subtasks || []).filter((s) => !s.done && !s.due).length;
            note.textContent = undated
                ? `${undated} without a date ${undated === 1 ? "doesn't" : "don't"} show in Up next yet.`
                : '';
            note.hidden = !undated;
        }

        function changed() {
            const settled = settleMilestone(it);
            renderNote();
            store.save(true);
            onChange?.(settled);
        }

        function dateInput(value, label, onSet) {
            const input = A.el('input', 'subtask-due');
            input.type = 'date';
            input.value = value || '';
            input.setAttribute('aria-label', label);
            input.addEventListener('change', () => onSet(input.value));
            return input;
        }

        function rowFor(s) {
            const row = A.el('div', `subtask${s.done ? ' done' : ''}${isLate(it, s) ? ' late' : ''}`);
            row.appendChild(A.checkbox(s.done, (v) => {
                s.done = v;
                const next = rowFor(s);
                row.replaceWith(next);
                next.querySelector('.check').focus();
                changed();
            }, `Mark "${s.title}" ${s.done ? 'not done' : 'done'}`));

            const title = A.el('input', 'subtask-title');
            title.type = 'text';
            title.value = s.title;
            title.setAttribute('aria-label', 'Subtask');
            title.addEventListener('input', () => { s.title = title.value; store.save(); });
            title.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.focus(); });
            row.appendChild(title);

            const due = dateInput(s.due, `Due date for "${s.title}"`, (v) => {
                if (v) s.due = v; else delete s.due;
                row.classList.toggle('late', isLate(it, s));
                due.title = isLate(it, s) ? `After the milestone's due date (${A.dueLabel(it.due)})` : '';
                changed();
            });
            if (isLate(it, s)) due.title = `After the milestone's due date (${A.dueLabel(it.due)})`;
            row.appendChild(due);

            row.appendChild(A.iconButton('x', 'Remove subtask', () => {
                it.subtasks = it.subtasks.filter((x) => x.id !== s.id);
                row.remove();
                changed();
            }, 'icon-btn sm danger'));
            return row;
        }

        (it.subtasks || []).forEach((s) => list.appendChild(rowFor(s)));
        wrap.appendChild(list);

        // The add row keeps its date between entries, so a run of subtasks
        // for the same day is quick to type in.
        const addRow = A.el('div', 'subtask-add-row');
        const add = A.el('input', 'inline-add subtask-add');
        add.type = 'text';
        add.placeholder = '+ Add a subtask and press Enter';
        add.setAttribute('aria-label', `Add a subtask to ${it.title}`);
        const addDue = dateInput('', 'Due date for the new subtask', () => {});
        addDue.title = 'Due date for the new subtask';
        add.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !add.value.trim()) return;
            const s = { id: A.uid(), title: add.value.trim(), done: false };
            if (addDue.value) s.due = addDue.value;
            it.subtasks = [...(it.subtasks || []), s];
            list.appendChild(rowFor(s));
            add.value = '';
            changed();
        });
        addDue.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.focus(); });
        addRow.appendChild(add);
        addRow.appendChild(addDue);
        wrap.appendChild(addRow);
        renderNote();
        wrap.appendChild(note);
        wrap.focusAdd = () => add.focus();
        return wrap;
    }

    // "Project · In progress · 2/5 steps", or who a blocked step waits on.
    function stepContext(project, s) {
        const list = s.checklist || [];
        return [
            project,
            s.status === 'doing' ? 'In progress' : '',
            s.status === 'blocked' ? (s.waitingOn ? `Waiting on ${s.waitingOn}` : 'Blocked') : '',
            list.length ? `${list.filter((c) => c.done).length}/${list.length} steps` : '',
        ].filter(Boolean).join(' · ');
    }

    function collect({ plan, workspaces, projectNames = {} }) {
        const out = [];

        const today = A.todayKey();
        (plan?.tasks || []).forEach((t) => {
            if (t.done) return;
            const when = taskWhen(t, today);
            out.push({
                key: `task:${t.id}`, kind: 'task', title: t.title, due: when.date, time: when.time, task: t,
                // Past its deadline counts as overdue, whenever it's scheduled.
                late: Boolean(t.due && t.due < today),
                priority: t.priority || 'medium', context: t.source?.calendarName ? `Task · from ${t.source.calendarName}` : 'Task',
                href: 'pages/plan.html', refId: t.id, tags: t.tags || [],
            });
        });

        // Each dated, open subtask is a task in its own right. Undated ones
        // stay with their milestone until you give them a day.
        eachMilestone(plan, (r, ph, it) => {
            (it.subtasks || []).forEach((s) => {
                if (s.done || !s.due) return;
                out.push({
                    key: `subtask:${s.id}`, kind: 'subtask', title: s.title || 'Untitled subtask', due: s.due, time: '',
                    priority: 'medium', context: `${it.title} · ${r.title}`,
                    href: `pages/plan.html#roadmap=${encodeURIComponent(r.id)}`, refId: s.id, ownerId: r.id, milestoneId: it.id,
                    tags: s.tags || [],
                });
            });
        });

        Object.entries(workspaces || {}).forEach(([id, ws]) => {
            (ws.next || []).forEach((s) => {
                // A blocked step comes up on its follow-up day, to chase it.
                const chase = s.status === 'blocked' && s.followUp;
                out.push({
                    key: `step:${id}:${s.id}`, kind: 'step', title: chase ? `Follow up: ${s.text}` : s.text,
                    due: chase ? s.followUp : s.due || '', time: chase ? '' : s.time || '',
                    priority: s.priority || 'medium', context: stepContext(projectNames[id] || ws.projectName || A.projectLabel(id), s),
                    href: `${A.projectHref(id).replace(/^\.\.\//, '')}#step=${encodeURIComponent(s.id)}`, refId: s.id, ownerId: id,
                    tags: s.tags || [],
                });
            });
        });

        // Calendar events never enter directly: adding one creates a task
        // (see syncAccepted), so it can be ticked off like everything else.

        return out;
    }

    // Phases that wrap up within the week.
    function phasesEnding(plan) {
        const today = A.todayKey();
        const out = [];
        (plan?.roadmaps || []).forEach((r) => (r.phases || []).forEach((ph) => {
            if (!ph.end || ph.end < today || A.daysBetween(today, ph.end) > 7) return;
            const items = ph.items || [];
            if (items.length && items.every((it) => it.done)) return;
            out.push({
                key: `phase:${ph.id}`, kind: 'phase', title: `${ph.title} wraps up`, due: ph.end, time: '',
                priority: 'low', context: r.title, href: `pages/plan.html#roadmap=${encodeURIComponent(r.id)}`,
                refId: ph.id, ownerId: r.id,
            });
        }));
        return out.sort((a, b) => a.due.localeCompare(b.due));
    }

    const BUCKETS = [
        { key: 'overdue', label: 'Overdue', icon: 'alert' },
        { key: 'today', label: 'Today', icon: 'sunrise' },
        { key: 'tomorrow', label: 'Tomorrow', icon: 'clock' },
        { key: 'week', label: 'This week', icon: 'calendar' },
        { key: 'later', label: 'Later', icon: 'layers' },
        { key: 'someday', label: 'No date', icon: 'inbox' },
    ];

    function bucketOf(item, today) {
        if (item.late) return 'overdue';
        if (!item.due) return 'someday';
        const diff = A.daysBetween(today, item.due);
        if (diff < 0) return 'overdue';
        if (diff === 0) return 'today';
        if (diff === 1) return 'tomorrow';
        if (diff <= 7) return 'week';
        return 'later';
    }

    // Timed things in clock order first, then by priority, then by date.
    function compare(a, b) {
        if (a.due !== b.due) {
            if (!a.due) return 1;
            if (!b.due) return -1;
        }
        const pa = A.priorityRank(a.priority);
        const pb = A.priorityRank(b.priority);
        if (a.due === b.due) {
            if (a.time && b.time) return a.time.localeCompare(b.time);
            if (a.time) return -1;
            if (b.time) return 1;
            return pa - pb || a.title.localeCompare(b.title);
        }
        return a.due.localeCompare(b.due) || pa - pb;
    }

    // Overdue work is ranked by priority first: the oldest low-priority chore
    // shouldn't bury something important that slipped yesterday.
    function compareOverdue(a, b) {
        return A.priorityRank(a.priority) - A.priorityRank(b.priority) || (a.due || '').localeCompare(b.due || '');
    }

    function group(items) {
        const today = A.todayKey();
        const map = new Map(BUCKETS.map((b) => [b.key, []]));
        items.forEach((it) => map.get(bucketOf(it, today)).push(it));
        return BUCKETS.map((b) => ({
            ...b,
            items: map.get(b.key).sort(b.key === 'overdue' ? compareOverdue : compare),
        }));
    }

    // Next N things worth looking at, most urgent first.
    function top(items, n) {
        return group(items)
            .filter((g) => g.key !== 'someday')
            .flatMap((g) => g.items)
            .concat(group(items).find((g) => g.key === 'someday').items.filter((i) => i.priority === 'high'))
            .slice(0, n);
    }

    // ---------------------------------------------------------- fetching --

    async function fetchEvents(days = 8) {
        try {
            const status = await A.api('/calendar/status');
            if (!status.configured) return { configured: false, events: [] };
            const from = new Date();
            from.setHours(0, 0, 0, 0);
            const to = new Date(from);
            to.setDate(to.getDate() + days);
            const data = await A.api(`/calendar/agenda?timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`);
            return { configured: true, events: data.events || [] };
        } catch (e) {
            return { configured: true, events: [], error: e.message };
        }
    }

    // ------------------------------------------------------------ actions --

    // A finished next step moves to Achieved, keeping its date (and its
    // calendar event, which the worker re-titles with a tick).
    function completeStep(ws, stepId) {
        const idx = (ws.next || []).findIndex((s) => s.id === stepId);
        if (idx === -1) return null;
        const [step] = ws.next.splice(idx, 1);
        const done = { ...step, date: A.todayKey() };
        ws.achieved = [done, ...(ws.achieved || [])];
        return done;
    }

    function reopenStep(ws, stepId) {
        const idx = (ws.achieved || []).findIndex((s) => s.id === stepId);
        if (idx === -1) return null;
        const [step] = ws.achieved.splice(idx, 1);
        delete step.date;
        ws.next = [...(ws.next || []), step];
        return step;
    }

    // The task, subtask or step an item was made from, and the document that
    // saves it.
    function source(item) {
        if (item.kind === 'step') {
            const ws = A.store.workspace(item.ownerId);
            return { obj: (ws.doc?.next || []).find((s) => s.id === item.refId), doc: ws };
        }
        const plan = A.store.plan;
        if (item.kind === 'task') return { obj: (plan.doc?.tasks || []).find((t) => t.id === item.refId), doc: plan };
        let obj = null;
        if (item.kind === 'subtask') {
            eachMilestone(plan.doc, (r, ph, it) => { obj = obj || (it.subtasks || []).find((s) => s.id === item.refId); });
        }
        return { obj, doc: plan };
    }

    function setTags(item, ids) {
        const { obj, doc } = source(item);
        if (!obj) return false;
        obj.tags = [...ids];
        item.tags = [...ids];
        doc.save(true);
        // A new tag is created in the plan, so that needs saving too.
        if (doc !== A.store.plan) A.store.plan.save(true);
        return true;
    }

    async function complete(item) {
        if (item.kind === 'task') {
            const plan = A.store.plan;
            await plan.load();
            const t = plan.doc.tasks.find((x) => x.id === item.refId);
            if (!t) return false;
            t.done = true;
            t.doneAt = new Date().toISOString();
            plan.save(true);
            return true;
        }
        // Only a milestone without subtasks is reached by hand; the rest
        // follow their subtasks.
        if (item.kind === 'milestone') {
            const plan = A.store.plan;
            await plan.load();
            let found = false;
            eachMilestone(plan.doc, (r, ph, it) => {
                if (it.id !== item.refId || (it.subtasks || []).length) return;
                it.done = true;
                found = true;
            });
            if (found) plan.save(true);
            return found;
        }
        if (item.kind === 'subtask') {
            const plan = A.store.plan;
            await plan.load();
            let found = false;
            eachMilestone(plan.doc, (r, ph, it) => {
                const s = it.id === item.milestoneId && (it.subtasks || []).find((x) => x.id === item.refId);
                if (!s) return;
                s.done = true;
                found = true;
                if (settleMilestone(it)) A.toast(`Milestone reached: ${it.title}`, 'ok');
            });
            if (found) plan.save(true);
            return found;
        }
        if (item.kind === 'step') {
            const ws = A.store.workspace(item.ownerId);
            await ws.load();
            if (!completeStep(ws.doc, item.refId)) return false;
            ws.save(true);
            return true;
        }
        return false;
    }

    // ------------------------------------------------------------ render --

    const COMPLETABLE = new Set(['task', 'step', 'subtask']);

    // onTags(item, ids): show a tag button that edits this item's tags.
    function row(item, { onComplete, showKind = true, onTags, onManageTags } = {}) {
        const r = A.el('div', 'item-row');

        if (COMPLETABLE.has(item.kind)) {
            r.appendChild(A.checkbox(false, async () => {
                r.classList.add('is-done');
                r.querySelector('.check')?.classList.add('on');
                try {
                    const ok = await complete(item);
                    if (ok) {
                        A.toast(`Done: ${item.title}`, 'ok');
                        setTimeout(() => onComplete?.(item), 350);
                    }
                } catch (e) {
                    r.classList.remove('is-done');
                    A.toast(e.message, 'error');
                }
            }, `Mark "${item.title}" done`));
        } else if (item.kind === 'event') {
            const sw = A.el('span', 'event-swatch');
            sw.style.setProperty('--swatch', item.color || 'var(--accent)');
            r.appendChild(A.el('span', 'kind-icon')).appendChild(sw);
        } else {
            r.appendChild(A.icon('flag', 14, 'kind-icon'));
        }

        const main = A.el('a', 'item-main');
        main.href = A.pageHref(item.href);
        main.appendChild(A.el('span', 'item-title', item.title));
        const sub = A.el('span', 'item-sub');
        const tagChips = !onTags && A.tags ? A.tags.chips(item.tags) : null;
        if (tagChips) sub.appendChild(tagChips);
        sub.appendChild(A.el('span', 'item-context', showKind && item.kind !== 'task' ? `${KIND_LABEL[item.kind]} · ${item.context}` : item.context));
        main.appendChild(sub);
        r.appendChild(main);

        const meta = A.el('div', 'item-meta');
        if (onTags && A.tags && COMPLETABLE.has(item.kind)) {
            meta.appendChild(A.tags.button(item.tags || [], {
                onChange: (ids) => onTags(item, ids),
                onManage: onManageTags,
            }));
        }
        if (item.priority && COMPLETABLE.has(item.kind)) meta.appendChild(A.priorityFlag(item.priority));
        const chip = item.task ? null : item.due ? A.dueChip(item.due, item.time) : null;
        if (item.task) taskChips(item.task).forEach((c) => meta.appendChild(c));
        if (chip) {
            if (item.kind === 'event' && !item.time) chip.textContent = `${A.dueLabel(item.due)} · all day`;
            meta.appendChild(chip);
        }
        r.appendChild(meta);
        return r;
    }

    A.items = { KIND_LABEL, BUCKETS, milestones, reachedMilestones, settleMilestone, settleMilestones, phasesEnding, subtaskProgress, subtaskEditor, collect, group, top, fetchEvents, complete, setTags, taskWhen, taskChips, completeStep, reopenStep, row, review, reviewQueue, taskFromEvent, linkTask, syncAccepted };
})();
