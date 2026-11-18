/**
 * The task dialog, with a task's deadline kept apart from the time you set
 * aside to work on it. Picking that time shows the day's schedule with
 * overlaps flagged; only the set-aside time goes on your calendar.
 *
 *   Admin.schedule.open(event, { events, workspaces, onDone })   add a calendar event as a task
 *   Admin.schedule.taskDialog({ task, events, onSave, onDelete }) new or existing Plan task
 */
(function () {
    const A = window.Admin;
    const pad = (n) => String(n).padStart(2, '0');
    const DAY_START = 7 * 60;
    const DAY_END = 22 * 60;
    const LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240];

    const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
    const toHHMM = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
    const fmtLen = (m) => (m < 60 ? `${m} min` : `${m / 60} hr${m === 60 ? '' : 's'}`.replace('.5 hrs', '½ hrs'));
    const fmtRange = (s, e) => `${A.formatTime(toHHMM(s))}–${A.formatTime(toHHMM(Math.min(e, 1439)))}`;

    // Everything with a time on `day`: calendar events plus timed tasks and
    // next steps from this site. Returns { timed: [{title,start,end,color}], allDay: [...] }.
    function dayItems(day, { events, workspaces, exclude }) {
        const timed = [];
        const allDay = [];
        // Events you've already turned into tasks are shown as those tasks,
        // at the time you chose, not at the event's original time.
        const tasks = A.store.plan.doc?.tasks || [];
        const taken = new Set(tasks.filter((t) => t.source?.eventId).map((t) => `${t.source.calendarId}|${t.source.eventId}`));
        (events || []).forEach((e) => {
            if (e.controlPanel || e.cpKind) return; // our own tasks are listed below
            if (taken.has(`${e.calendarId}|${e.id}`)) return;
            if (exclude && e.id === exclude.id && e.calendarId === exclude.calendarId) return;
            const s = A.parseDate(e.start);
            const en = e.end ? A.parseDate(e.end) : s;
            if (e.allDay) {
                const last = A.addDays(A.dateKey(en), -1);
                if (A.dateKey(s) <= day && last >= day) allDay.push({ title: e.summary, color: e.color });
                return;
            }
            const sk = A.dateKey(s);
            const ek = A.dateKey(en);
            if (sk > day || ek < day) return;
            const start = sk < day ? 0 : s.getHours() * 60 + s.getMinutes();
            const end = ek > day ? 1440 : en.getHours() * 60 + en.getMinutes();
            if (end > start) timed.push({ title: e.summary, start, end, color: e.color || 'var(--accent)', source: e.calendarName });
        });
        tasks.forEach((t) => {
            if (t.done) return;
            if (exclude && (t.id === exclude.taskId || (exclude.id && t.source?.eventId === exclude.id))) return;
            if (t.workDate === day) {
                if (!t.workTime) { allDay.push({ title: t.title, color: 'var(--accent)', task: true }); return; }
                const start = toMin(t.workTime);
                timed.push({ title: t.title, start, end: start + (Number(t.duration) || 30), color: 'var(--accent)', source: 'Task', task: true });
            } else if (!t.workDate && t.due === day) {
                allDay.push({ title: `Due: ${t.title}`, color: 'var(--accent)', task: true });
            }
        });
        Object.values(workspaces || {}).forEach((ws) => {
            (ws.next || []).forEach((st) => {
                if (st.due !== day || !st.time) return;
                const start = toMin(st.time);
                timed.push({ title: `${st.text} · ${ws.projectName || 'project'}`, start, end: start + 30, color: 'var(--violet)', source: 'Next step', task: true });
            });
        });
        timed.sort((a, b) => a.start - b.start);
        return { timed, allDay };
    }

    const overlaps = (a, b) => a.start < b.end && b.start < a.end;

    // First gap of `len` minutes at or after `from`, in 15-minute steps.
    function nextFree(timed, from, len) {
        for (let s = Math.ceil(from / 15) * 15; s + len <= DAY_END; s += 15) {
            const slot = { start: s, end: s + len };
            if (!timed.some((t) => overlaps(t, slot))) return s;
        }
        return null;
    }

    function renderPanel(panel, state, ctx) {
        A.clear(panel);
        const { timed, allDay } = dayItems(state.due, ctx);
        const slot = state.time ? { start: toMin(state.time), end: toMin(state.time) + state.duration } : null;
        const clashes = slot ? timed.filter((t) => overlaps(t, slot)) : [];
        const now = new Date();
        const earliest = state.due === A.todayKey() ? Math.max(DAY_START, now.getHours() * 60 + now.getMinutes()) : DAY_START;
        const free = nextFree(timed, slot ? Math.max(slot.start, earliest) : earliest, state.duration);

        // Status
        const status = A.el('div', `conflict-status ${!slot ? 'neutral' : clashes.length ? 'bad' : 'good'}`);
        status.appendChild(A.icon(!slot ? 'clock' : clashes.length ? 'alert' : 'check', 15));
        const text = A.el('div', 'conflict-text');
        if (!slot) {
            text.textContent = state.noSlotText;
        } else if (!clashes.length) {
            text.textContent = `${fmtRange(slot.start, slot.end)} is free.`;
        } else {
            text.textContent = `${fmtRange(slot.start, slot.end)} overlaps with ${clashes.map((c) => `${c.title} (${fmtRange(c.start, c.end)})`).join(', ')}.`;
        }
        status.appendChild(text);
        if ((clashes.length || !slot) && free != null && free !== slot?.start) {
            status.appendChild(A.button(`Use ${A.formatTime(toHHMM(free))}`, 'btn btn-edit btn-small', () => ctx.setTime(toHHMM(free))));
        }
        panel.appendChild(status);

        // All-day items
        if (allDay.length) {
            const row = A.el('div', 'conflict-allday');
            row.appendChild(A.el('span', 'mini-label', 'All day'));
            allDay.forEach((a) => {
                const chip = A.el('span', 'month-chip', a.title);
                chip.style.setProperty('--swatch', a.color || 'var(--accent)');
                row.appendChild(chip);
            });
            panel.appendChild(row);
        }

        // Day timeline
        const lo = Math.min(DAY_START, ...timed.map((t) => t.start), slot ? slot.start : DAY_START);
        const hi = Math.max(DAY_END, ...timed.map((t) => t.end), slot ? slot.end : DAY_END);
        const startHour = Math.floor(lo / 60);
        const endHour = Math.min(24, Math.ceil(hi / 60));
        const PX = 0.6; // px per minute → 36px per hour
        const tl = A.el('div', 'day-timeline');
        const inner = A.el('div', 'day-timeline-inner');
        inner.style.height = `${(endHour - startHour) * 60 * PX}px`;
        for (let h = startHour; h <= endHour; h++) {
            const line = A.el('div', 'dt-hour');
            line.style.top = `${(h - startHour) * 60 * PX}px`;
            if (h < 24) line.appendChild(A.el('span', null, A.formatTime(`${pad(h)}:00`).replace(':00', '')));
            inner.appendChild(line);
        }
        const place = (node, s, e) => {
            node.style.top = `${(s - startHour * 60) * PX}px`;
            node.style.height = `${Math.max(14, (e - s) * PX - 2)}px`;
        };
        // Overlapping items share the width in columns instead of stacking.
        const lanes = [];
        timed.forEach((t) => {
            let lane = lanes.findIndex((end) => end <= t.start);
            if (lane === -1) { lane = lanes.length; lanes.push(0); }
            lanes[lane] = t.end;
            t.lane = lane;
        });
        timed.forEach((t) => {
            const group = timed.filter((o) => overlaps(o, t));
            t.cols = Math.max(...group.map((o) => o.lane)) + 1;
        });
        timed.forEach((t) => {
            const b = A.el('div', `dt-block${slot && overlaps(t, slot) ? ' clash' : ''}`);
            b.style.left = `calc(0.25rem + (100% - 0.65rem) * ${t.lane / t.cols})`;
            b.style.width = `calc((100% - 0.65rem) / ${t.cols} - 2px)`;
            b.style.right = 'auto';
            b.style.setProperty('--swatch', t.color);
            b.title = `${t.title} · ${fmtRange(t.start, t.end)}${t.source ? ' · ' + t.source : ''}`;
            b.appendChild(A.el('span', 'dt-title', t.title));
            b.appendChild(A.el('span', 'dt-time', fmtRange(t.start, t.end)));
            place(b, t.start, t.end);
            inner.appendChild(b);
        });
        if (slot) {
            const b = A.el('div', `dt-block dt-proposed${clashes.length ? ' clash' : ''}`);
            b.appendChild(A.el('span', 'dt-title', state.title || 'This task'));
            b.appendChild(A.el('span', 'dt-time', fmtRange(slot.start, slot.end)));
            place(b, slot.start, slot.end);
            inner.appendChild(b);
        }
        // Click an empty part of the day to move the task there.
        inner.addEventListener('click', (ev) => {
            if (ev.target.closest('.dt-block')) return;
            const y = ev.clientY - inner.getBoundingClientRect().top;
            const min = Math.round((startHour * 60 + y / PX) / 15) * 15;
            ctx.setTime(toHHMM(Math.max(0, Math.min(1440 - state.duration, min))));
        });
        tl.appendChild(inner);
        panel.appendChild(tl);
        panel.appendChild(A.el('div', 'modal-hint', `${A.parseDate(state.due).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })} · click an empty spot to move it there.`));

        // Keep the proposed block in view.
        if (slot) requestAnimationFrame(() => { tl.scrollTop = Math.max(0, (slot.start - startHour * 60) * PX - 60); });
    }

    const LENGTH_DEFAULT = 60;
    const nearestLength = (m) => LENGTHS.reduce((best, x) => (Math.abs(x - m) < Math.abs(best - m) ? x : best), LENGTH_DEFAULT);

    /**
     * taskDialog({ task, title, description, submitLabel, events, workspaces,
     *              exclude, onSave(values), onDelete })
     * `events` may be a promise; the day's schedule fills in when it arrives.
     * onSave gets { title, due, dueTime, priority, tags, workDate, workTime,
     * duration, notes }.
     */
    function taskDialog(spec) {
        const t = spec.task || {};
        const ctx = { events: Array.isArray(spec.events) ? spec.events : [], workspaces: spec.workspaces, exclude: spec.exclude || (t.id ? { taskId: t.id } : null) };

        A.modal.open({
            title: spec.title,
            description: spec.description,
            wide: true,
            fields: [
                { name: 'title', label: 'Task', required: true, value: t.title || '', placeholder: 'What needs doing?' },
                { name: 'due', label: 'Due date', type: 'date', value: t.due || '', half: true },
                { name: 'dueTime', label: 'Due time (optional)', type: 'time', value: t.dueTime || '', half: true },
                { name: 'priority', label: 'Priority', type: 'select', value: t.priority || 'medium', half: true, options: A.PRIORITIES },
                { name: 'tags', label: 'Tags', type: 'custom', render: () => A.tags.editor(t.tags || []) },
                { type: 'static', value: 'Time to work on it — optional. This is what goes on your calendar, separate from the due date.' },
                { name: 'workDate', label: 'Day', type: 'date', value: t.workDate || '', half: true },
                { name: 'workTime', label: 'Start', type: 'time', value: t.workTime || '', half: true },
                { name: 'duration', label: 'Length', type: 'select', value: String(nearestLength(Number(t.duration) || LENGTH_DEFAULT)), half: true, options: LENGTHS.map((m) => ({ value: String(m), label: fmtLen(m) })) },
                { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, value: t.notes || '' },
            ],
            submitLabel: spec.submitLabel || 'Save',
            destructiveLabel: spec.onDelete ? 'Delete' : null,
            onDestructive: spec.onDelete,
            onSubmit: (v) => {
                if (v.dueTime && !v.due) throw new Error('Pick a due date to go with that due time.');
                if (v.workTime && !v.workDate) throw new Error('Pick a day to go with that start time.');
                spec.onSave({ ...v, duration: Number(v.duration) || LENGTH_DEFAULT });
            },
        });

        const form = document.querySelector('.modal .modal-body');
        const field = (n) => form.querySelector(`[name="${n}"]`);
        const panel = A.el('div', 'conflict-panel');
        field('duration').closest('.modal-field').after(panel);
        // The static line above the work fields reads as a section heading.
        const heading = [...form.querySelectorAll(':scope > .modal-desc')].pop();
        heading?.classList.add('modal-section');

        // The day shown: the one you're working on it, else the due date.
        const read = () => {
            const workDate = field('workDate').value;
            const date = workDate || field('due').value || A.todayKey();
            return {
                title: field('title').value.trim(),
                date: workDate,
                due: date,
                time: workDate ? field('workTime').value : '',
                duration: Number(field('duration').value) || LENGTH_DEFAULT,
                noSlotText: workDate
                    ? `Set aside on ${A.dueLabel(workDate)}, no start time. Pick one to check for overlaps.`
                    : 'No time set aside yet. Pick a day and start time, or click a free spot below.',
            };
        };
        ctx.setTime = (hhmm) => {
            if (!field('workDate').value) field('workDate').value = read().due;
            field('workTime').value = hhmm;
            refresh();
        };
        function refresh() { renderPanel(panel, read(), ctx); }
        ['due', 'workDate', 'workTime', 'duration', 'title'].forEach((n) => {
            field(n).addEventListener('input', refresh);
            field(n).addEventListener('change', refresh);
        });
        refresh();
        if (spec.events && typeof spec.events.then === 'function') {
            spec.events.then((list) => { ctx.events = list || []; if (panel.isConnected) refresh(); }).catch(() => {});
        }
    }

    // Add a calendar event as a task: its date and time become the due date,
    // and you choose separately when you'll work on it.
    function open(event, { events, workspaces, onDone } = {}) {
        const draft = A.items.taskFromEvent(event);
        taskDialog({
            task: { ...draft, duration: LENGTH_DEFAULT },
            title: 'Add to Up next',
            description: `From ${event.calendarName || 'your calendar'}. Its date is the due date; set aside time to work on it if you like.`,
            submitLabel: 'Add task',
            events, workspaces, exclude: event,
            onSave: (v) => {
                const task = { ...draft, ...v };
                A.store.plan.doc.tasks.push(task);
                A.items.linkTask(A.store.review.doc, event, task.id);
                A.store.plan.save(true);
                A.store.review.save(true);
                A.toast(`Added "${task.title}" to Up next`, 'ok');
                onDone?.(task);
            },
        });
    }

    A.schedule = { open, taskDialog, dayItems };
})();
