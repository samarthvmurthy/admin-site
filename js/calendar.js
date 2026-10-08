/**
 * Calendar page: a day-grouped agenda over your Google Calendar, with create,
 * edit and delete. All writes go through the worker, which holds the Google
 * refresh token — no Google credentials ever reach the browser.
 */
(function () {
    const A = window.Admin;

    const RANGES = [
        { key: 'week', label: 'Week', days: 7 },
        { key: 'fortnight', label: '2 weeks', days: 14 },
        { key: 'month', label: 'Month', days: 0 }, // calendar month, not 30 days
    ];

    const state = {
        calendars: [],
        calendarId: null,
        events: [],
        range: 'week',
        anchor: startOfDay(new Date()),
    };

    // ----------------------------------------------------------------- dates --

    function startOfDay(d) {
        const out = new Date(d);
        out.setHours(0, 0, 0, 0);
        return out;
    }

    function addDays(d, n) {
        const out = new Date(d);
        out.setDate(out.getDate() + n);
        return out;
    }

    function startOfWeek(d) {
        const out = startOfDay(d);
        // Week starts Monday.
        const shift = (out.getDay() + 6) % 7;
        return addDays(out, -shift);
    }

    function currentWindow() {
        if (state.range === 'month') {
            const from = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
            const to = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + 1, 1);
            return { from, to };
        }
        const days = RANGES.find((r) => r.key === state.range).days;
        const from = startOfWeek(state.anchor);
        return { from, to: addDays(from, days) };
    }

    function shiftAnchor(direction) {
        if (state.range === 'month') {
            state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + direction, 1);
        } else {
            const days = RANGES.find((r) => r.key === state.range).days;
            state.anchor = addDays(state.anchor, direction * days);
        }
    }

    function rangeLabel() {
        const { from, to } = currentWindow();
        if (state.range === 'month') {
            return from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        }
        const last = addDays(to, -1);
        const sameMonth = from.getMonth() === last.getMonth();
        const left = from.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const right = last.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
        return `${left} – ${right}, ${last.getFullYear()}`;
    }

    // A datetime-local input reads/writes local wall time with no zone, so
    // convert through a Date to keep the offset correct.
    function toLocalInputValue(iso) {
        const d = iso ? A.parseDate(iso) : new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function localInputToIso(value) {
        return new Date(value).toISOString();
    }

    function dayKey(iso) {
        return startOfDay(A.parseDate(iso)).toDateString();
    }

    // ------------------------------------------------------------- rendering --

    function renderRangeChips() {
        const host = A.clear(document.getElementById('range-chips'));
        RANGES.forEach((r) => {
            host.appendChild(A.button(r.label, `filter-chip${state.range === r.key ? ' on' : ''}`, () => {
                state.range = r.key;
                renderRangeChips();
                loadEvents();
            }));
        });
    }

    function eventRow(event) {
        const row = A.el('button', 'event-row');
        row.type = 'button';

        const time = A.el('span', 'event-time');
        if (event.allDay) {
            time.textContent = 'all day';
            time.classList.add('event-time-allday');
        } else {
            time.textContent = A.timeOfDay(event.start);
        }
        row.appendChild(time);

        const body = A.el('span', 'event-body');
        body.appendChild(A.el('span', 'event-title', event.summary));
        const bits = [];
        if (!event.allDay && event.end) bits.push(`until ${A.timeOfDay(event.end)}`);
        if (event.location) bits.push(event.location);
        if (event.attendees.length) bits.push(`${event.attendees.length} guest${event.attendees.length === 1 ? '' : 's'}`);
        if (bits.length) body.appendChild(A.el('span', 'event-meta', bits.join(' · ')));
        row.appendChild(body);

        if (event.recurringEventId) row.appendChild(A.el('span', 'tag', 'repeats'));
        row.appendChild(A.el('span', 'event-chev', '›'));

        row.addEventListener('click', () => eventDialog(event));
        return row;
    }

    function renderAgenda() {
        const host = A.clear(document.getElementById('agenda'));
        const hint = document.getElementById('agenda-hint');
        document.getElementById('range-label').textContent = rangeLabel();
        document.getElementById('event-count-note').textContent =
            state.events.length ? `${state.events.length} event${state.events.length === 1 ? '' : 's'}` : '';

        if (!state.events.length) {
            hint.textContent = 'Nothing scheduled in this range.';
            return;
        }
        hint.style.display = 'none';

        const groups = new Map();
        state.events.forEach((e) => {
            const key = dayKey(e.start);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(e);
        });

        const today = new Date().toDateString();
        groups.forEach((events, key) => {
            const date = new Date(key);  // dayKey() already normalised to a local day
            const group = A.el('div', `day-group${key === today ? ' is-today' : ''}`);

            const head = A.el('div', 'day-head');
            head.appendChild(A.el('span', 'day-weekday', date.toLocaleDateString(undefined, { weekday: 'long' })));
            head.appendChild(A.el('span', 'day-date', date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })));
            if (key === today) head.appendChild(A.el('span', 'pill pill-active', 'today'));
            group.appendChild(head);

            const list = A.el('div', 'event-list');
            events.forEach((e) => list.appendChild(eventRow(e)));
            group.appendChild(list);

            host.appendChild(group);
        });
    }

    // --------------------------------------------------------------- dialogs --

    function eventFields(event) {
        const now = new Date();
        const defaultStart = event ? event.start : new Date(now.setMinutes(0, 0, 0) + 3600000).toISOString();
        const defaultEnd = event
            ? event.end
            : new Date(new Date(defaultStart).getTime() + 3600000).toISOString();

        // All-day events come back with an exclusive end date; show the day the
        // event actually ends on.
        const endValue = event?.allDay
            ? toLocalInputValue(addDays(A.parseDate(event.end), -1))
            : toLocalInputValue(defaultEnd);

        return [
            { name: 'summary', label: 'Title', required: true, value: event?.summary || '', placeholder: 'What is it?' },
            { name: 'start', label: 'Starts', type: 'datetime-local', required: true, value: toLocalInputValue(defaultStart) },
            { name: 'end', label: 'Ends', type: 'datetime-local', required: true, value: endValue },
            { name: 'allDay', label: 'All day', type: 'checkbox', value: Boolean(event?.allDay), hint: 'Times are ignored when this is on.' },
            { name: 'location', label: 'Location', value: event?.location || '', placeholder: 'Place or link' },
            { name: 'description', label: 'Notes', type: 'textarea', rows: 4, value: event?.description || '' },
            { name: 'attendees', label: 'Guests', value: (event?.attendees || []).join(', '), placeholder: 'a@x.com, b@y.com', hint: 'Comma separated. Google emails invitations.' },
        ];
    }

    function buildPayload(values) {
        if (!values.summary) throw new Error('A title is required.');

        const startDate = new Date(values.start);
        const endDate = new Date(values.end);
        if (isNaN(startDate) || isNaN(endDate)) throw new Error('Those dates could not be read.');

        if (values.allDay) {
            // Google treats an all-day end date as exclusive, so push it a day.
            if (startOfDay(endDate) < startOfDay(startDate)) throw new Error('The end day is before the start day.');
            return {
                summary: values.summary,
                description: values.description,
                location: values.location,
                allDay: true,
                start: toLocalInputValue(startDate).slice(0, 10),
                end: toLocalInputValue(addDays(endDate, 1)).slice(0, 10),
                attendees: values.attendees ? values.attendees.split(',').map((s) => s.trim()).filter(Boolean) : [],
            };
        }

        if (endDate <= startDate) throw new Error('The end time must be after the start time.');
        return {
            summary: values.summary,
            description: values.description,
            location: values.location,
            allDay: false,
            start: localInputToIso(values.start),
            end: localInputToIso(values.end),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            attendees: values.attendees ? values.attendees.split(',').map((s) => s.trim()).filter(Boolean) : [],
        };
    }

    function eventDialog(event) {
        const editing = Boolean(event);
        const calendarId = event?.calendarId || state.calendarId;

        A.modal.open({
            title: editing ? 'Edit event' : 'New event',
            description: event?.recurringEventId
                ? 'This is one occurrence of a repeating event. Changes here affect only this occurrence.'
                : undefined,
            fields: eventFields(event),
            submitLabel: editing ? 'Save changes' : 'Create event',
            destructiveLabel: editing ? 'Delete' : null,
            onDestructive: async () => {
                await A.api(`/calendar/events?calendarId=${encodeURIComponent(calendarId)}&eventId=${encodeURIComponent(event.id)}`, {
                    method: 'DELETE',
                });
                A.toast('Event deleted', 'ok');
                loadEvents();
            },
            onSubmit: async (values) => {
                const payload = buildPayload(values);
                if (editing) {
                    await A.api(`/calendar/events?calendarId=${encodeURIComponent(calendarId)}&eventId=${encodeURIComponent(event.id)}`, {
                        method: 'PATCH', body: payload,
                    });
                    A.toast('Event updated', 'ok');
                } else {
                    await A.api(`/calendar/events?calendarId=${encodeURIComponent(calendarId)}`, {
                        method: 'POST', body: payload,
                    });
                    A.toast('Event created', 'ok');
                }
                loadEvents();
            },
        });
    }

    // ------------------------------------------------------------------ load --

    async function loadEvents() {
        const hint = document.getElementById('agenda-hint');
        hint.style.display = '';
        hint.textContent = 'Loading events…';
        A.clear(document.getElementById('agenda'));

        const { from, to } = currentWindow();
        try {
            const data = await A.api(
                `/calendar/events?calendarId=${encodeURIComponent(state.calendarId)}` +
                `&timeMin=${encodeURIComponent(from.toISOString())}` +
                `&timeMax=${encodeURIComponent(to.toISOString())}`
            );
            state.events = data.events;
            renderAgenda();
        } catch (e) {
            hint.textContent = `Could not load events: ${e.message}`;
        }
    }

    function initControls() {
        document.getElementById('new-event-btn').addEventListener('click', () => eventDialog(null));
        document.getElementById('range-prev').addEventListener('click', () => { shiftAnchor(-1); loadEvents(); });
        document.getElementById('range-next').addEventListener('click', () => { shiftAnchor(1); loadEvents(); });
        document.getElementById('range-today').addEventListener('click', () => {
            state.anchor = startOfDay(new Date());
            loadEvents();
        });

        const picker = document.getElementById('calendar-picker');
        picker.addEventListener('change', () => {
            state.calendarId = picker.value;
            localStorage.setItem('admin:calendarId', picker.value);
            loadEvents();
        });
    }

    async function load() {
        try {
            const status = await A.api('/calendar/status');
            if (!status.configured) {
                document.getElementById('setup-panel').style.display = '';
                return;
            }

            state.calendars = await A.api('/calendar/calendars');
            if (!state.calendars.length) {
                document.getElementById('setup-panel').style.display = '';
                A.toast('No writable calendars found on that Google account', 'error');
                return;
            }

            // Remember the last calendar you looked at.
            const remembered = localStorage.getItem('admin:calendarId');
            const match = state.calendars.find((c) => c.id === remembered);
            state.calendarId = match ? match.id : (state.calendars.find((c) => c.primary) || state.calendars[0]).id;

            const picker = document.getElementById('calendar-picker');
            state.calendars.forEach((c) => {
                const o = A.el('option', null, c.summary + (c.primary ? ' (primary)' : ''));
                o.value = c.id;
                if (c.id === state.calendarId) o.selected = true;
                picker.appendChild(o);
            });

            document.getElementById('app').style.display = '';
            document.getElementById('new-event-btn').disabled = false;
            initControls();
            renderRangeChips();
            loadEvents();
        } catch (e) {
            document.getElementById('setup-panel').style.display = '';
            A.toast(`Calendar: ${e.message}`, 'error');
        }
    }

    load();
})();
