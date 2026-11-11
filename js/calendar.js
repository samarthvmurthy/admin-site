/**
 * Calendar: agenda and month views over all your Google calendars, with
 * create / edit / delete. The "Control Panel" calendar holds mirrors of
 * dated items from this site; those open their source instead of being
 * edited here (an edit in Google would be overwritten on the next save).
 */
(function () {
    const A = window.Admin;
    const HIDDEN_KEY = 'cp:cal-hidden';
    const VIEW_KEY = 'cp:cal-view';

    const state = {
        calendars: [],
        hidden: new Set(readJson(HIDDEN_KEY, [])),
        events: [],
        view: readView(),
        anchor: A.todayKey(),
        failed: [],
    };

    function readJson(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
    }
    function writeJson(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    }
    function readView() {
        const v = readJson(VIEW_KEY, null);
        if (v === 'agenda' || v === 'month') return v;
        return window.matchMedia('(max-width: 760px)').matches ? 'agenda' : 'month';
    }

    // ----------------------------------------------------------------- dates --

    function currentWindow() {
        if (state.view === 'month') {
            const a = A.parseDate(state.anchor);
            const first = A.dateKey(new Date(a.getFullYear(), a.getMonth(), 1));
            const from = A.startOfWeekKey(first);
            const lastOfMonth = A.dateKey(new Date(a.getFullYear(), a.getMonth() + 1, 0));
            const to = A.addDays(A.startOfWeekKey(lastOfMonth), 7);
            return { from, to, month: a.getMonth() };
        }
        const from = A.startOfWeekKey(state.anchor);
        return { from, to: A.addDays(from, 14) };
    }

    function shift(dir) {
        if (state.view === 'month') {
            const a = A.parseDate(state.anchor);
            state.anchor = A.dateKey(new Date(a.getFullYear(), a.getMonth() + dir, 1));
        } else {
            state.anchor = A.addDays(state.anchor, dir * 14);
        }
    }

    function rangeLabel() {
        const { from, to } = currentWindow();
        if (state.view === 'month') {
            return A.parseDate(state.anchor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        }
        const last = A.addDays(to, -1);
        const f = A.parseDate(from);
        const l = A.parseDate(last);
        const left = f.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const right = l.toLocaleDateString(undefined, f.getMonth() === l.getMonth() ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
        return `${left} – ${right}, ${l.getFullYear()}`;
    }

    // Day keys an event covers (all-day ends are exclusive).
    function eventDays(e) {
        const start = A.dateKey(A.parseDate(e.start));
        let end = e.end ? A.dateKey(A.parseDate(e.end)) : start;
        if (e.allDay) end = A.addDays(end, -1);
        else if (e.end && A.parseDate(e.end).getHours() === 0 && A.parseDate(e.end).getMinutes() === 0 && end > start) end = A.addDays(end, -1);
        const days = [];
        for (let d = start, i = 0; d <= end && i < 62; d = A.addDays(d, 1), i++) days.push(d);
        return days.length ? days : [start];
    }

    function byDay() {
        const map = new Map();
        state.events.forEach((e) => eventDays(e).forEach((d) => {
            if (!map.has(d)) map.set(d, []);
            map.get(d).push(e);
        }));
        map.forEach((list) => list.sort((a, b) => (a.allDay === b.allDay ? A.parseDate(a.start) - A.parseDate(b.start) : a.allDay ? -1 : 1)));
        return map;
    }

    const toLocalInput = (d) => `${A.dateKey(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    // ------------------------------------------------------------- rendering --

    function renderViewSwitch() {
        const host = A.clear(document.getElementById('view-switch'));
        [['agenda', 'Agenda'], ['month', 'Month']].forEach(([key, label]) => {
            host.appendChild(A.button(label, state.view === key ? 'on' : '', () => {
                state.view = key;
                writeJson(VIEW_KEY, key);
                renderViewSwitch();
                loadEvents();
            }));
        });
    }

    function eventRow(e) {
        const row = A.el('button', 'event-row');
        row.type = 'button';
        const time = A.el('span', 'event-time', e.allDay ? 'All day' : A.timeOfDay(e.start));
        row.appendChild(time);
        const sw = A.el('span', 'event-swatch');
        sw.style.setProperty('--swatch', e.color || 'var(--accent)');
        row.appendChild(sw);
        const body = A.el('span', 'event-body');
        body.appendChild(A.el('span', 'event-title', e.summary));
        const bits = [];
        if (!e.allDay && e.end) bits.push(`until ${A.timeOfDay(e.end)}`);
        if (e.location) bits.push(e.location);
        bits.push(e.calendarName);
        body.appendChild(A.el('span', 'event-meta', bits.join(' · ')));
        row.appendChild(body);
        if (e.controlPanel) row.appendChild(A.el('span', 'tag tag-accent', 'from site'));
        else if (e.recurringEventId) row.appendChild(A.el('span', 'tag', 'repeats'));
        row.appendChild(A.icon('chevronRight', 14, 'event-chev'));
        row.addEventListener('click', () => openEvent(e));
        return row;
    }

    function renderAgenda() {
        const host = A.clear(document.getElementById('agenda'));
        const hint = document.getElementById('agenda-hint');
        const { from, to } = currentWindow();
        const days = byDay();
        const today = A.todayKey();
        let any = false;

        for (let d = from; d < to; d = A.addDays(d, 1)) {
            const list = days.get(d);
            if (!list?.length) continue;
            any = true;
            const date = A.parseDate(d);
            const group = A.el('div', `day-group${d === today ? ' is-today' : ''}`);
            const head = A.el('div', 'day-head');
            head.appendChild(A.el('span', 'day-weekday', d === today ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'long' })));
            head.appendChild(A.el('span', 'day-date', date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
            group.appendChild(head);
            const ev = A.el('div', 'event-list');
            list.forEach((e) => ev.appendChild(eventRow(e)));
            group.appendChild(ev);
            host.appendChild(group);
        }
        hint.style.display = any ? 'none' : '';
        if (!any) hint.textContent = 'Nothing scheduled in these two weeks.';
    }

    function renderMonth() {
        const host = A.clear(document.getElementById('agenda'));
        document.getElementById('agenda-hint').style.display = 'none';
        const { from, to, month } = currentWindow();
        const days = byDay();
        const today = A.todayKey();
        const grid = A.el('div', 'month-grid');

        for (let i = 0; i < 7; i++) {
            grid.appendChild(A.el('div', 'month-dow', A.parseDate(A.addDays(from, i)).toLocaleDateString(undefined, { weekday: 'short' })));
        }
        const maxChips = window.matchMedia('(max-width: 760px)').matches ? 4 : 3;
        for (let d = from; d < to; d = A.addDays(d, 1)) {
            const date = A.parseDate(d);
            const cell = A.el('div', `month-cell${date.getMonth() !== month ? ' other' : ''}${d === today ? ' is-today' : ''}`);
            cell.appendChild(A.el('span', 'month-num', String(date.getDate())));
            const list = days.get(d) || [];
            list.slice(0, maxChips).forEach((e) => {
                const chip = A.el('button', 'month-chip');
                chip.type = 'button';
                chip.style.setProperty('--swatch', e.color || 'var(--accent)');
                chip.title = `${e.allDay ? '' : A.timeOfDay(e.start) + ' '}${e.summary}`;
                if (!e.allDay) chip.appendChild(A.el('span', 't', A.timeOfDay(e.start).replace(/:00(?=\s|$)/, '')));
                chip.appendChild(A.el('span', null, e.summary));
                chip.addEventListener('click', (ev) => { ev.stopPropagation(); openEvent(e); });
                cell.appendChild(chip);
            });
            if (list.length > maxChips) cell.appendChild(A.el('span', 'month-more', `+${list.length - maxChips} more`));
            // Click a day: on phones show that day's agenda, elsewhere add an event.
            cell.addEventListener('click', () => {
                if (list.length && window.matchMedia('(max-width: 760px)').matches) dayDialog(d, list);
                else eventDialog(null, d);
            });
            grid.appendChild(cell);
        }
        host.appendChild(grid);
    }

    function dayDialog(day, list) {
        A.modal.open({
            title: A.parseDate(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
            fields: [],
            submitLabel: 'New event',
            onSubmit: () => setTimeout(() => eventDialog(null, day), 0),
        });
        const body = document.querySelector('.modal .modal-body');
        const wrap = A.el('div', 'event-list');
        list.forEach((e) => {
            const row = eventRow(e);
            row.addEventListener('click', () => A.modal.close(), { capture: true });
            wrap.appendChild(row);
        });
        body.prepend(wrap);
    }

    function render() {
        document.getElementById('range-label').textContent = rangeLabel();
        if (state.view === 'month') renderMonth();
        else renderAgenda();
        renderNotice();
    }

    function renderNotice() {
        const host = A.clear(document.getElementById('cal-notice'));
        if (state.failed.length) {
            const n = A.el('div', 'notice warn');
            n.appendChild(A.icon('alert', 16));
            n.appendChild(A.el('div', null, `Couldn't load: ${state.failed.join(', ')}.`));
            host.appendChild(n);
        }
    }

    function renderSidebar() {
        const cp = state.calendars.find((c) => c.controlPanel);
        window.Nav.setSections([
            {
                label: 'View',
                items: [
                    { label: 'Agenda', icon: 'agenda', active: state.view === 'agenda', onClick: () => { state.view = 'agenda'; writeJson(VIEW_KEY, 'agenda'); renderViewSwitch(); loadEvents(); } },
                    { label: 'Month', icon: 'calendar', active: state.view === 'month', onClick: () => { state.view = 'month'; writeJson(VIEW_KEY, 'month'); renderViewSwitch(); loadEvents(); } },
                ],
            },
            {
                label: 'Calendars',
                items: state.calendars.map((c) => ({
                    label: c.controlPanel ? 'Control Panel (this site)' : c.summary,
                    dot: c.backgroundColor || 'var(--accent)',
                    dotOff: state.hidden.has(c.id),
                    title: state.hidden.has(c.id) ? 'Show' : 'Hide',
                    onClick: () => {
                        if (state.hidden.has(c.id)) state.hidden.delete(c.id);
                        else state.hidden.add(c.id);
                        writeJson(HIDDEN_KEY, [...state.hidden]);
                        renderSidebar();
                        loadEvents();
                    },
                })),
            },
            {
                label: 'Sync',
                items: [
                    {
                        label: cp ? 'Re-sync site items' : 'Create & sync site calendar',
                        icon: 'refresh',
                        onClick: async () => {
                            A.toast('Syncing…');
                            await A.calendarSync.now();
                            A.toast('Calendar is up to date', 'ok');
                            await loadCalendars();
                            loadEvents();
                        },
                    },
                ],
            },
        ]);
    }

    // --------------------------------------------------------------- dialogs --

    const SOURCE = {
        task: { label: 'a task in Plan', href: () => 'pages/plan.html#view=all' },
        phase: { label: 'a roadmap phase', href: (e) => `pages/plan.html#roadmap=${encodeURIComponent(e.cpOwner)}` },
        milestone: { label: 'a roadmap milestone', href: (e) => `pages/plan.html#roadmap=${encodeURIComponent(e.cpOwner)}` },
        subtask: { label: 'a milestone subtask', href: (e) => `pages/plan.html#roadmap=${encodeURIComponent(e.cpOwner)}` },
        step: { label: 'a project next step', href: (e) => `pages/project.html?id=${encodeURIComponent(e.cpOwner)}` },
    };

    function openEvent(e) {
        if (e.controlPanel && e.cpKind && SOURCE[e.cpKind]) {
            const src = SOURCE[e.cpKind];
            A.modal.open({
                title: e.summary.replace(/^[○✓◆▸]\s*/, ''),
                description: `This comes from ${src.label}. Edit it there — changes sync back to Google automatically.`,
                fields: [{ type: 'static', value: e.allDay ? A.shortDate(e.start) : `${A.shortDate(e.start)} · ${A.timeOfDay(e.start)}` }],
                submitLabel: 'Open source',
                onSubmit: () => { window.location.href = A.pageHref(src.href(e)); },
            });
            return;
        }
        if (!e.writable) {
            A.modal.open({
                title: e.summary,
                description: `Read-only calendar: ${e.calendarName}.`,
                fields: [{ type: 'static', value: e.allDay ? A.shortDate(e.start) : `${A.shortDate(e.start)}, ${A.timeOfDay(e.start)} – ${A.timeOfDay(e.end)}` }],
                submitLabel: 'Open in Google',
                onSubmit: () => { if (e.htmlLink) window.open(e.htmlLink, '_blank', 'noopener'); },
            });
            return;
        }
        eventDialog(e);
    }

    function writableCalendars() {
        return state.calendars.filter((c) => c.writable && !c.controlPanel);
    }

    function eventFields(event, dayKey) {
        let start;
        let end;
        if (event) {
            start = A.parseDate(event.start);
            end = event.allDay ? A.parseDate(A.addDays(A.dateKey(A.parseDate(event.end)), -1)) : A.parseDate(event.end);
        } else {
            const base = dayKey ? A.parseDate(dayKey) : new Date();
            start = new Date(base);
            if (dayKey) start.setHours(9, 0, 0, 0);
            else start.setHours(start.getHours() + 1, 0, 0, 0);
            end = new Date(start.getTime() + 3600000);
        }
        const cals = writableCalendars();
        const fields = [
            { name: 'summary', label: 'Title', required: true, value: event?.summary || '', placeholder: 'What is it?' },
            { name: 'start', label: 'Starts', type: 'datetime-local', required: true, value: toLocalInput(start), half: true },
            { name: 'end', label: 'Ends', type: 'datetime-local', required: true, value: toLocalInput(end), half: true },
            { name: 'allDay', label: 'All day', type: 'checkbox', value: Boolean(event?.allDay) },
        ];
        if (!event && cals.length > 1) {
            const primary = cals.find((c) => c.primary) || cals[0];
            fields.push({ name: 'calendarId', label: 'Calendar', type: 'select', value: primary.id, options: cals.map((c) => ({ value: c.id, label: c.summary })) });
        }
        fields.push(
            { name: 'location', label: 'Location', value: event?.location || '', placeholder: 'Place or link' },
            { name: 'description', label: 'Notes', type: 'textarea', rows: 3, value: event?.description || '' },
            { name: 'attendees', label: 'Guests', value: (event?.attendees || []).join(', '), placeholder: 'a@x.com, b@y.com', hint: 'Comma separated. Google emails invitations.' },
        );
        return fields;
    }

    function buildPayload(v) {
        const startDate = new Date(v.start);
        const endDate = new Date(v.end);
        if (isNaN(startDate) || isNaN(endDate)) throw new Error('Those dates could not be read.');
        const attendees = v.attendees ? v.attendees.split(',').map((s) => s.trim()).filter(Boolean) : [];
        const base = { summary: v.summary, description: v.description, location: v.location, attendees };
        if (v.allDay) {
            const s = A.dateKey(startDate);
            const e = A.dateKey(endDate);
            if (e < s) throw new Error('The end day is before the start day.');
            return { ...base, allDay: true, start: s, end: A.addDays(e, 1) }; // Google's all-day end is exclusive
        }
        if (endDate <= startDate) throw new Error('The end time must be after the start time.');
        return { ...base, allDay: false, start: startDate.toISOString(), end: endDate.toISOString(), timeZone: A.TIME_ZONE };
    }

    function eventDialog(event, dayKey) {
        const editing = Boolean(event);
        const fallbackCal = (writableCalendars().find((c) => c.primary) || writableCalendars()[0])?.id || 'primary';
        A.modal.open({
            title: editing ? 'Edit event' : 'New event',
            description: event?.recurringEventId ? 'One occurrence of a repeating event — changes apply only to this one.' : undefined,
            fields: eventFields(event, dayKey),
            submitLabel: editing ? 'Save changes' : 'Create event',
            destructiveLabel: editing ? 'Delete' : null,
            onDestructive: async () => {
                const ok = await A.confirm({ title: 'Delete this event?', description: event.summary, confirmLabel: 'Delete', danger: true });
                if (!ok) return;
                await A.api(`/calendar/events?calendarId=${encodeURIComponent(event.calendarId)}&eventId=${encodeURIComponent(event.id)}`, { method: 'DELETE' });
                A.toast('Event deleted', 'ok');
                loadEvents();
            },
            onSubmit: async (v) => {
                const payload = buildPayload(v);
                if (editing) {
                    await A.api(`/calendar/events?calendarId=${encodeURIComponent(event.calendarId)}&eventId=${encodeURIComponent(event.id)}`, { method: 'PATCH', body: payload });
                    A.toast('Event updated', 'ok');
                } else {
                    await A.api(`/calendar/events?calendarId=${encodeURIComponent(v.calendarId || fallbackCal)}`, { method: 'POST', body: payload });
                    A.toast('Event created', 'ok');
                }
                loadEvents();
            },
        });
    }

    // ------------------------------------------------------------------ load --

    async function loadEvents() {
        const hint = document.getElementById('agenda-hint');
        const { from, to } = currentWindow();
        document.getElementById('range-label').textContent = rangeLabel();
        renderSidebar();

        const ids = state.calendars.filter((c) => !state.hidden.has(c.id)).map((c) => c.id);
        if (!ids.length) {
            state.events = [];
            render();
            hint.style.display = '';
            hint.textContent = 'All calendars are hidden. Switch one on in the sidebar.';
            return;
        }
        if (state.view === 'agenda') { hint.style.display = ''; hint.textContent = 'Loading events…'; }
        try {
            const data = await A.api(
                `/calendar/agenda?calendars=${encodeURIComponent(ids.join(','))}` +
                `&timeMin=${encodeURIComponent(A.parseDate(from).toISOString())}` +
                `&timeMax=${encodeURIComponent(A.parseDate(to).toISOString())}`
            );
            state.events = data.events;
            state.failed = data.failed || [];
            render();
        } catch (e) {
            hint.style.display = '';
            hint.textContent = `Could not load events: ${e.message}`;
        }
    }

    async function loadCalendars() {
        state.calendars = await A.api('/calendar/calendars');
        // First visit: mirror what's switched on in Google (plus this site's calendar).
        if (!localStorage.getItem(HIDDEN_KEY)) {
            state.hidden = new Set(state.calendars.filter((c) => !c.selected && !c.primary && !c.controlPanel).map((c) => c.id));
        }
        state.calendars.sort((a, b) => (b.primary - a.primary) || (b.controlPanel - a.controlPanel) || a.summary.localeCompare(b.summary));
    }

    function initControls() {
        const prev = document.getElementById('range-prev');
        const next = document.getElementById('range-next');
        prev.innerHTML = window.Nav.svg('chevronLeft', 16);
        next.innerHTML = window.Nav.svg('chevronRight', 16);
        prev.addEventListener('click', () => { shift(-1); loadEvents(); });
        next.addEventListener('click', () => { shift(1); loadEvents(); });
        document.getElementById('range-today').addEventListener('click', () => { state.anchor = A.todayKey(); loadEvents(); });
        const newBtn = document.getElementById('new-event-btn');
        newBtn.disabled = false;
        newBtn.addEventListener('click', () => eventDialog(null));
        document.addEventListener('keydown', (e) => {
            if (e.target.closest('input, textarea, select, .modal')) return;
            if (e.key === 'ArrowLeft') { shift(-1); loadEvents(); }
            if (e.key === 'ArrowRight') { shift(1); loadEvents(); }
            if (e.key === 't') { state.anchor = A.todayKey(); loadEvents(); }
        });
    }

    async function load() {
        try {
            const status = await A.api('/calendar/status');
            if (!status.configured) {
                document.getElementById('setup-panel').style.display = '';
                window.Nav.setSections([{ label: 'Setup', items: [{ label: 'Connect Google Calendar', icon: 'calendar', href: '#setup-panel', active: true }] }]);
                return;
            }
            // First connection: create the site calendar and back-fill it.
            if (!status.cpCalendarId) await A.calendarSync.now();

            await loadCalendars();
            document.getElementById('app').style.display = '';
            initControls();
            renderViewSwitch();
            loadEvents();
        } catch (e) {
            document.getElementById('setup-panel').style.display = '';
            A.toast(`Calendar: ${e.message}`, 'error');
        }
    }

    load();
})();
