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
        return [done ? null : repeatChip(t), workChip(t, done), deadlineChip(t, done)].filter(Boolean);
    }

    // ------------------------------------------------------- task family --
    //
    // A task can be part of a bigger one (`parentId`). A parent with smaller
    // tasks is finished exactly when all of them are: ticking the last one
    // ticks the parent, and reopening one reopens it.

    const childrenOf = (tasks, id) => (tasks || []).filter((t) => t.parentId === id);
    const parentOf = (tasks, t) => (t?.parentId ? (tasks || []).find((x) => x.id === t.parentId) || null : null);

    function taskProgress(tasks, t) {
        const kids = childrenOf(tasks, t.id);
        return { done: kids.filter((k) => k.done).length, total: kids.length };
    }

    // Every task under `id`, at any depth.
    function descendantsOf(tasks, id) {
        const out = [];
        const walk = (pid) => childrenOf(tasks, pid).forEach((k) => { if (!out.includes(k)) { out.push(k); walk(k.id); } });
        walk(id);
        return out;
    }

    // Tasks `t` could be put under: open ones that aren't itself or below it.
    function parentChoices(tasks, t) {
        const below = new Set(t?.id ? [t.id, ...descendantsOf(tasks, t.id).map((d) => d.id)] : []);
        return (tasks || []).filter((x) => !below.has(x.id) && (!x.done || x.id === t?.parentId));
    }

    function markDone(t, done) {
        t.done = done;
        if (done) t.doneAt = t.doneAt || new Date().toISOString();
        else delete t.doneAt;
    }

    // Bring the parents above `t` in line with their smaller tasks. Returns
    // the parents that changed, nearest first.
    function settleParents(tasks, t) {
        const changed = [];
        const seen = new Set();
        for (let p = parentOf(tasks, t); p && !seen.has(p.id); p = parentOf(tasks, p)) {
            seen.add(p.id);
            const { done, total } = taskProgress(tasks, p);
            if (!total || Boolean(p.done) === (done === total)) break;
            markDone(p, done === total);
            changed.push(p);
        }
        return changed;
    }

    // Settle every parent at once, deepest first (after loading, say).
    function settleAllParents(tasks) {
        let changed = false;
        const depth = (t, n = 0, seen = new Set()) => (t.parentId && !seen.has(t.id) ? depth(parentOf(tasks, t) || {}, n + 1, seen.add(t.id)) : n);
        [...(tasks || [])].filter((t) => childrenOf(tasks, t.id).length)
            .sort((a, b) => depth(b) - depth(a))
            .forEach((p) => {
                const { done, total } = taskProgress(tasks, p);
                if (Boolean(p.done) !== (done === total)) { markDone(p, done === total); changed = true; }
            });
        return changed;
    }

    // ----------------------------------------------------------- repeats --
    //
    // A repeating task carries `repeat`:
    //   { every: n, unit: day|week|month|year, days?: [0–6] (weekly, Sun = 0),
    //     from: 'due' (on a fixed schedule) | 'done' (n after you finish it),
    //     until?: 'YYYY-MM-DD', monthDay?: 1–31 }
    // Ticking it off keeps it in Completed and adds the next one, with its
    // due date and set-aside day moved along together (and fresh copies of
    // its smaller tasks). Unticking it takes that next one back, as long as
    // you haven't started on it.

    const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const UNIT_WORD = { day: 'day', week: 'week', month: 'month', year: 'year' };

    const dayOfMonth = (key) => Number(key.slice(8, 10));

    // `key` moved by `n` months, on `day` of the month (or its last day).
    function addMonths(key, n, day) {
        const d = A.parseDate(key);
        const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
        const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
        first.setDate(Math.min(day || d.getDate(), last));
        return A.dateKey(first);
    }

    function stepRepeat(rep, key, fixed) {
        const every = Math.max(1, Number(rep.every) || 1);
        if (rep.unit === 'week' && rep.days?.length) {
            // The next listed weekday, in every n-th week counted from `key`'s.
            const week0 = A.startOfWeekKey(key);
            for (let i = 1; i <= 7 * every + 7; i++) {
                const d = A.addDays(key, i);
                const weekNo = Math.floor(A.daysBetween(week0, d) / 7);
                if (weekNo % every === 0 && rep.days.includes(A.parseDate(d).getDay())) return d;
            }
            return A.addDays(key, 7 * every);
        }
        if (rep.unit === 'week') return A.addDays(key, 7 * every);
        if (rep.unit === 'month') return addMonths(key, every, fixed ? rep.monthDay : 0);
        if (rep.unit === 'year') return addMonths(key, 12 * every, fixed ? rep.monthDay : 0);
        return A.addDays(key, every);
    }

    // The date a repeating task's next one lands on: after today, or null
    // once it's past its end date.
    function nextRepeatDate(t, today = A.todayKey()) {
        const rep = t.repeat;
        const anchor = t.due || t.workDate;
        if (!rep || !anchor) return null;
        const fixed = rep.from !== 'done';
        let next = stepRepeat(rep, fixed ? anchor : today, fixed);
        // On a fixed schedule, skip the ones that slipped by unticked.
        for (let guard = 0; next <= today && guard < 5000; guard++) next = stepRepeat(rep, next, fixed);
        return rep.until && next > rep.until ? null : next;
    }

    function repeatLabel(rep) {
        if (!rep) return '';
        const every = Math.max(1, Number(rep.every) || 1);
        const days = rep.unit === 'week' && rep.days?.length ? [...rep.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) : null;
        let text;
        if (days && every === 1 && days.join() === '1,2,3,4,5') text = 'Every weekday';
        else if (every === 1) text = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[rep.unit] || 'Daily';
        else text = `Every ${every} ${UNIT_WORD[rep.unit] || 'day'}s`;
        if (days && text !== 'Every weekday') text += ` on ${days.map((d) => WEEKDAYS[d]).join(', ')}`;
        if (rep.from === 'done') text += ' after done';
        if (rep.until) text += ` until ${A.shortDate(rep.until)}`;
        return text;
    }

    function repeatChip(t) {
        if (!t.repeat) return null;
        const chip = A.el('span', 'repeat-chip');
        chip.appendChild(A.icon('repeat', 11));
        const label = repeatLabel(t.repeat);
        chip.title = label;
        chip.setAttribute('aria-label', label);
        return chip;
    }

    // Add the next one of a repeating task that's just been ticked off.
    function spawnRepeat(tasks, t) {
        if (!t.repeat || (t.repeatedTo && tasks.some((x) => x.id === t.repeatedTo))) return null;
        const next = nextRepeatDate(t);
        if (!next) return null;
        const delta = A.daysBetween(t.due || t.workDate, next);
        const now = new Date().toISOString();
        const ids = new Map();
        const copy = (x, parentId) => {
            const c = { ...x, id: A.uid(), parentId, done: false, createdAt: now };
            ['doneAt', 'calEventId', 'calHash', 'repeatedTo', 'source', 'noCalendar'].forEach((k) => delete c[k]);
            if (c.due) c.due = A.addDays(c.due, delta);
            if (c.workDate) c.workDate = A.addDays(c.workDate, delta);
            ids.set(x.id, c.id);
            return c;
        };
        // It stands on its own: a bigger task it was part of can still finish.
        const head = copy(t, '');
        const below = descendantsOf(tasks, t.id);
        const kids = below.map((d) => copy(d, ''));
        kids.forEach((k, i) => { k.parentId = ids.get(below[i].parentId) || head.id; });
        const at = tasks.indexOf(t);
        tasks.splice(at === -1 ? 0 : at, 0, head, ...kids);
        t.repeatedTo = head.id;
        return head;
    }

    // Take back the next one of a repeating task, if it's untouched.
    function unspawnRepeat(tasks, t) {
        const next = t.repeatedTo && tasks.find((x) => x.id === t.repeatedTo);
        if (!next) { delete t.repeatedTo; return null; }
        const below = descendantsOf(tasks, next.id);
        // Already started on: keep it, and don't add another when re-ticked.
        if (next.done || below.some((d) => d.done)) return null;
        delete t.repeatedTo;
        const gone = new Set([next.id, ...below.map((d) => d.id)]);
        tasks.splice(0, tasks.length, ...tasks.filter((x) => !gone.has(x.id)));
        return next;
    }

    // Tick a task (and everything under it). Returns { finished, parents, next }:
    // how many smaller tasks were ticked with it, parents that finished, and
    // the next one if it repeats.
    function finishTask(tasks, t) {
        const open = descendantsOf(tasks, t.id).filter((d) => !d.done);
        open.forEach((d) => markDone(d, true));
        markDone(t, true);
        const parents = settleParents(tasks, t);
        return { finished: open.length, parents, next: spawnRepeat(tasks, t) };
    }

    // Untick a task; parents above it reopen with it.
    function reopenTask(tasks, t) {
        markDone(t, false);
        unspawnRepeat(tasks, t);
        return settleParents(tasks, t);
    }

    // "Repeats · next one Tomorrow" after ticking off a repeating task.
    function announceNext(next) {
        if (next) A.toast(`Repeats · next one ${A.dueLabel(next.due || next.workDate)}`, 'ok');
    }

    // Removing a task moves its smaller tasks up to its own parent.
    function removeTask(plan, t) {
        plan.tasks.forEach((x) => { if (x.parentId === t.id) x.parentId = t.parentId || ''; });
        plan.tasks = plan.tasks.filter((x) => x.id !== t.id);
        return settleParents(plan.tasks, t); // t still names its old parent
    }

    // "Part of …" and "2/5 smaller tasks" for a task's row.
    function familyText(tasks, t) {
        const parent = parentOf(tasks, t);
        const { done, total } = taskProgress(tasks, t);
        return [
            parent ? `Part of ${parent.title}` : '',
            total ? `${done}/${total} smaller task${total === 1 ? '' : 's'} done` : '',
        ].filter(Boolean).join(' · ');
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
                priority: t.priority || 'medium',
                context: [t.source?.calendarName ? `Task · from ${t.source.calendarName}` : 'Task', familyText(plan.tasks, t)].filter(Boolean).join(' · '),
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
            const { parents, next } = finishTask(plan.doc.tasks, t);
            parents.forEach((p) => A.toast(`All parts done: ${p.title}`, 'ok'));
            announceNext(next);
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
                // Finishing a bigger task ticks its open smaller tasks too.
                const open = item.kind === 'task' ? descendantsOf(A.store.plan.doc?.tasks, item.refId).filter((d) => !d.done).length : 0;
                if (open && !(await A.confirm({
                    title: `Finish "${item.title}"?`,
                    description: `${open} smaller task${open === 1 ? ' is' : 's are'} still open and will be ticked off with it.`,
                    confirmLabel: 'Finish all',
                }))) return;
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

    A.items = { KIND_LABEL, BUCKETS, milestones, reachedMilestones, settleMilestone, settleMilestones, phasesEnding, subtaskProgress, subtaskEditor, collect, group, top, fetchEvents, complete, setTags, taskWhen, taskChips, childrenOf, parentOf, taskProgress, descendantsOf, parentChoices, settleParents, settleAllParents, finishTask, reopenTask, removeTask, nextRepeatDate, repeatLabel, announceNext, WEEKDAYS, familyText, completeStep, reopenStep, row, review, reviewQueue, taskFromEvent, linkTask, syncAccepted };
})();
