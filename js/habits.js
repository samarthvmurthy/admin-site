/**
 * Habit tracker: one row per habit, one cell per day, tap to tick.
 * Rendered into any host with Admin.habits.mount(host, { rangeHost, subHost }).
 *
 * Doc shape: { habits: [{ id, name, color, createdAt, log: { 'YYYY-MM-DD': true } }] }
 */
(function () {
    const A = window.Admin;
    const COLORS = ['#3b6fed', '#23883b', '#d93a40', '#c4801a', '#7a55d6', '#0e9aa7', '#d6336c'];
    const RANGES = [7, 14, 30];
    const RANGE_KEY = 'cp:habit-range';

    function readRange() {
        try {
            const v = Number(localStorage.getItem(RANGE_KEY));
            if (RANGES.includes(v)) return v;
        } catch { /* storage blocked */ }
        return window.matchMedia('(max-width: 760px)').matches ? 7 : 14;
    }

    function streak(h, today) {
        let day = h.log?.[today] ? today : A.addDays(today, -1);
        let n = 0;
        while (h.log?.[day]) { n++; day = A.addDays(day, -1); }
        return n;
    }

    function rate(h, today) {
        const created = h.createdAt ? A.dateKey(new Date(h.createdAt)) : today;
        const span = Math.max(1, Math.min(30, A.daysBetween(created, today) + 1));
        let done = 0;
        for (let i = 0; i < span; i++) if (h.log?.[A.addDays(today, -i)]) done++;
        return Math.round((done / span) * 100);
    }

    function mount(host, { rangeHost, subHost } = {}) {
        const store = A.store.habits;
        let range = readRange();
        let newColor = COLORS[0];

        function save() { store.save(); }

        function editDialog(h) {
            A.modal.open({
                title: 'Edit habit',
                fields: [
                    { name: 'name', label: 'Name', required: true, value: h.name },
                    { name: 'color', label: 'Colour', type: 'select', value: h.color, options: COLORS.map((c, i) => ({ value: c, label: ['Blue', 'Green', 'Red', 'Amber', 'Violet', 'Teal', 'Pink'][i] })) },
                ],
                submitLabel: 'Save',
                destructiveLabel: 'Delete habit',
                onDestructive: async () => {
                    const ok = await A.confirm({
                        title: `Delete "${h.name}"?`,
                        description: 'Its whole history goes with it. This cannot be undone.',
                        confirmLabel: 'Delete', danger: true,
                    });
                    if (!ok) return;
                    store.doc.habits = store.doc.habits.filter((x) => x.id !== h.id);
                    save();
                    render();
                },
                onSubmit: (v) => {
                    h.name = v.name;
                    h.color = v.color;
                    save();
                    render();
                },
            });
        }

        function renderRange() {
            if (!rangeHost) return;
            A.clear(rangeHost);
            RANGES.forEach((r) => {
                rangeHost.appendChild(A.button(`${r}d`, r === range ? 'on' : '', () => {
                    range = r;
                    try { localStorage.setItem(RANGE_KEY, String(r)); } catch { /* ignore */ }
                    renderRange();
                    render();
                }));
            });
        }

        function render() {
            A.clear(host);
            const habits = store.doc?.habits || [];
            const today = A.todayKey();
            const days = [];
            for (let i = range - 1; i >= 0; i--) days.push(A.addDays(today, -i));

            if (subHost) {
                const doneToday = habits.filter((h) => h.log?.[today]).length;
                subHost.textContent = habits.length
                    ? `${doneToday} of ${habits.length} done today`
                    : 'Tick off each day you show up.';
            }

            if (habits.length) {
                const wrap = A.el('div', 'habits-wrap');
                const table = A.el('table', 'habit-grid');
                const thead = A.el('thead');
                const hr = A.el('tr');
                hr.appendChild(A.el('th', 'habit-name-col', 'Habit'));
                days.forEach((d) => {
                    const th = A.el('th', d === today ? 'is-today' : '');
                    const date = A.parseDate(d);
                    th.appendChild(document.createTextNode(date.toLocaleDateString(undefined, { weekday: 'narrow' })));
                    th.appendChild(A.el('span', 'dnum', String(date.getDate())));
                    hr.appendChild(th);
                });
                hr.appendChild(A.el('th', null, 'Streak'));
                hr.appendChild(A.el('th', null, '30d'));
                thead.appendChild(hr);
                table.appendChild(thead);

                const tbody = A.el('tbody');
                habits.forEach((h) => {
                    const tr = A.el('tr');
                    tr.style.setProperty('--hc', h.color || COLORS[0]);

                    const nameCell = A.el('td', 'habit-name-cell');
                    const nameBtn = A.button('', 'habit-name', () => editDialog(h));
                    nameBtn.title = 'Edit or delete';
                    nameBtn.appendChild(A.el('i', 'habit-swatch'));
                    nameBtn.appendChild(A.el('span', null, h.name));
                    nameCell.appendChild(nameBtn);
                    tr.appendChild(nameCell);

                    days.forEach((d) => {
                        const td = A.el('td');
                        const on = Boolean(h.log?.[d]);
                        const cell = A.el('button', `habit-cell${on ? ' on' : ''}${d === today ? ' is-today' : ''}`);
                        cell.type = 'button';
                        cell.innerHTML = window.Nav.svg('check', 13);
                        const label = A.parseDate(d).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
                        cell.setAttribute('aria-label', `${h.name}, ${label}: ${on ? 'done' : 'not done'}`);
                        cell.setAttribute('aria-pressed', String(on));
                        cell.title = label;
                        cell.addEventListener('click', () => {
                            h.log = h.log || {};
                            if (h.log[d]) delete h.log[d];
                            else h.log[d] = true;
                            save();
                            render();
                        });
                        td.appendChild(cell);
                        tr.appendChild(td);
                    });

                    const s = streak(h, today);
                    const st = A.el('td');
                    st.appendChild(A.el('span', `habit-streak${s >= 3 ? ' hot' : ''}`, s ? `${s} day${s === 1 ? '' : 's'}` : '—'));
                    tr.appendChild(st);
                    const rt = A.el('td');
                    rt.appendChild(A.el('span', 'habit-rate', `${rate(h, today)}%`));
                    tr.appendChild(rt);

                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
                wrap.appendChild(table);
                host.appendChild(wrap);
            } else {
                const empty = A.el('div', 'empty-state');
                empty.appendChild(A.el('strong', null, 'No habits yet'));
                empty.appendChild(document.createTextNode('Add one below — e.g. "LeetCode", "Gym", "Read 20 min".'));
                host.appendChild(empty);
            }

            // Add row
            const add = A.el('form', 'habit-add');
            const input = A.el('input');
            input.type = 'text';
            input.placeholder = 'New habit…';
            input.setAttribute('aria-label', 'New habit name');
            input.maxLength = 60;
            add.appendChild(input);

            const dots = A.el('div', 'color-dots');
            COLORS.forEach((c) => {
                const dot = A.el('button', `color-dot${c === newColor ? ' on' : ''}`);
                dot.type = 'button';
                dot.style.setProperty('--hc', c);
                dot.setAttribute('aria-label', 'Habit colour');
                dot.addEventListener('click', () => {
                    newColor = c;
                    dots.querySelectorAll('.color-dot').forEach((n) => n.classList.toggle('on', n === dot));
                });
                dots.appendChild(dot);
            });
            add.appendChild(dots);

            const submit = A.el('button', 'btn btn-add-primary btn-small', 'Add habit');
            submit.type = 'submit';
            add.appendChild(submit);
            add.addEventListener('submit', (e) => {
                e.preventDefault();
                const name = input.value.trim();
                if (!name) { input.focus(); return; }
                store.doc.habits.push({ id: A.uid(), name, color: newColor, createdAt: new Date().toISOString(), log: {} });
                // Rotate the default colour so the next habit looks different.
                newColor = COLORS[(COLORS.indexOf(newColor) + 1) % COLORS.length];
                save();
                render();
                host.querySelector('.habit-add input')?.focus();
            });
            host.appendChild(add);
        }

        renderRange();
        A.clear(host).appendChild(A.el('p', 'hint', 'Loading habits…'));
        store.load().then(render).catch((e) => {
            A.clear(host).appendChild(A.el('p', 'hint', `Couldn't load habits: ${e.message}`));
        });

        return { render };
    }

    A.habits = { mount, streak };
})();
