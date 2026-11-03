/**
 * Everything that has to be done, from every module, in one shape — used by
 * the Up next page and the dashboard tile. Attached as Admin.items.
 *
 * Item: { key, kind: task|step|milestone|phase|event, title, due, time,
 *         priority, context, href, color?, ownerId?, refId }
 */
(function () {
    const A = window.Admin;

    const KIND_LABEL = { task: 'Task', step: 'Next step', milestone: 'Milestone', phase: 'Phase', event: 'Event' };

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

    function collect({ plan, workspaces, projectNames = {}, events = [] }) {
        const today = A.todayKey();
        const out = [];

        (plan?.tasks || []).forEach((t) => {
            if (t.done) return;
            out.push({
                key: `task:${t.id}`, kind: 'task', title: t.title, due: t.due || '', time: t.time || '',
                priority: t.priority || 'medium', context: 'Task', href: 'pages/plan.html', refId: t.id,
            });
        });

        (plan?.roadmaps || []).forEach((r) => {
            (r.phases || []).forEach((ph) => {
                (ph.items || []).forEach((it) => {
                    if (it.done || !it.due) return;
                    out.push({
                        key: `milestone:${it.id}`, kind: 'milestone', title: it.title, due: it.due, time: '',
                        priority: 'medium', context: r.title, href: `pages/plan.html#roadmap=${encodeURIComponent(r.id)}`,
                        refId: it.id, ownerId: r.id,
                    });
                });
                // Flag phases that wrap up within the week.
                if (ph.end && ph.end >= today && A.daysBetween(today, ph.end) <= 7) {
                    const open = (ph.items || []).some((it) => !it.done);
                    if (open || !(ph.items || []).length) {
                        out.push({
                            key: `phase:${ph.id}`, kind: 'phase', title: `${ph.title} wraps up`, due: ph.end, time: '',
                            priority: 'low', context: r.title, href: `pages/plan.html#roadmap=${encodeURIComponent(r.id)}`,
                            refId: ph.id, ownerId: r.id,
                        });
                    }
                }
            });
        });

        Object.entries(workspaces || {}).forEach(([id, ws]) => {
            (ws.next || []).forEach((s) => {
                out.push({
                    key: `step:${id}:${s.id}`, kind: 'step', title: s.text, due: s.due || '', time: s.time || '',
                    priority: s.priority || 'medium', context: projectNames[id] || ws.projectName || A.projectLabel(id),
                    href: A.projectHref(id).replace(/^\.\.\//, ''), refId: s.id, ownerId: id,
                });
            });
        });

        events.forEach((e) => {
            if (e.controlPanel || e.cpKind) return; // mirrors of the items above
            const item = eventItem(e, today);
            if (item) out.push(item);
        });

        return out;
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
        return A.priorityRank(a.priority) - A.priorityRank(b.priority) || a.due.localeCompare(b.due);
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
        if (item.kind === 'milestone') {
            const plan = A.store.plan;
            await plan.load();
            for (const r of plan.doc.roadmaps) for (const ph of r.phases) for (const it of ph.items) {
                if (it.id === item.refId) { it.done = true; plan.save(true); return true; }
            }
            return false;
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

    const COMPLETABLE = new Set(['task', 'step', 'milestone']);

    function row(item, { onComplete, showKind = true } = {}) {
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
        sub.textContent = showKind && item.kind !== 'task' ? `${KIND_LABEL[item.kind]} · ${item.context}` : item.context;
        main.appendChild(sub);
        r.appendChild(main);

        const meta = A.el('div', 'item-meta');
        if (item.priority && COMPLETABLE.has(item.kind)) meta.appendChild(A.priorityFlag(item.priority));
        const chip = item.due ? A.dueChip(item.due, item.time) : null;
        if (chip) {
            if (item.kind === 'event' && !item.time) chip.textContent = `${A.dueLabel(item.due)} · all day`;
            meta.appendChild(chip);
        }
        r.appendChild(meta);
        return r;
    }

    A.items = { KIND_LABEL, BUCKETS, collect, group, top, fetchEvents, complete, completeStep, reopenStep, row };
})();
