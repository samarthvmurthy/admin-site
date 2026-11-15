/**
 * Project page.
 *   Left  — your workspace: next steps, what's been achieved, notes.
 *   Right — details you curate, and live read-only data from GitHub.
 *
 * The workspace autosaves; dated next steps are mirrored to your calendar.
 */
(function () {
    const A = window.Admin;

    const STATUSES = [
        { value: 'active', label: 'Active' },
        { value: 'idea', label: 'Idea' },
        { value: 'paused', label: 'Paused' },
        { value: 'shipped', label: 'Shipped' },
    ];

    const state = {
        id: A.param('id'),
        project: null,   // custom-project record, when this is a manual project
        repoName: null,  // owner/name, when a repo is attached
        detail: null,    // GitHub payload
        store: null,     // Admin.store workspace doc
        roadmaps: [],
        others: {},      // other workspaces, for the sidebar
        expanded: new Set(), // next steps open to their details
        refInfo: new Map(),  // GitHub issue/PR number → { title, state, merged, isPull }
    };
    const ws = () => state.store.doc;
    const indicator = A.store.indicator();
    const save = (now) => state.store.save(now);

    // ---------------------------------------------------------- next steps --
    //
    // A list or a board (To do / In progress / Blocked) of next steps. Each
    // opens in place to its full detail; see steps.js for the editor.

    const prefs = (() => {
        try { return JSON.parse(localStorage.getItem('cp:project') || '{}'); } catch { return {}; }
    })();
    prefs.stepView = prefs.stepView === 'board' ? 'board' : 'list';
    prefs.achievedBy = prefs.achievedBy === 'version' ? 'version' : 'month';
    prefs.notesTab = prefs.notesTab === 'decisions' ? 'decisions' : 'notes';
    function savePrefs() {
        try { localStorage.setItem('cp:project', JSON.stringify(prefs)); } catch { /* blocked */ }
    }

    const filter = { scope: 'all', label: '' };
    const SCOPES = [
        { key: 'all', label: 'All', test: () => true },
        { key: 'week', label: 'This week', test: (s) => A.steps.isFocus(s) },
        { key: 'doing', label: 'In progress', test: (s) => A.steps.statusOf(s) === 'doing' },
        { key: 'blocked', label: 'Blocked', test: (s) => A.steps.statusOf(s) === 'blocked' },
    ];

    // This workspace plus every other one, for labels and weekly capacity.
    const allDocs = () => [ws(), ...Object.entries(state.others).filter(([id]) => id !== state.id).map(([, w]) => w)];

    function stepCtx() {
        return {
            doc: ws,
            save,
            expanded: state.expanded,
            rerender: (focus) => {
                renderWorkspace(true);
                if (focus) document.querySelector(focus)?.focus();
            },
            changed: renderCounts,
            projectId: state.id,
            roadmaps: state.roadmaps,
            repo: state.repoName,
            refInfo: state.refInfo,
            loadRefs,
            knownLabels: () => A.steps.knownLabels(allDocs()),
            onFocusChange: () => A.steps.warnIfOver(allDocs()),
        };
    }

    // GitHub issue/PR status for linked steps, fetched once per number.
    async function loadRefs(numbers) {
        const missing = [...new Set(numbers)].filter((n) => !state.refInfo.has(n));
        if (!state.repoName || !missing.length) return;
        try {
            const list = await A.api(`/repo/refs?repo=${encodeURIComponent(state.repoName)}&n=${missing.join(',')}`);
            list.forEach((r) => state.refInfo.set(r.number, r));
        } catch { /* chips stay neutral */ }
    }

    // A step whose linked issues are all closed and PRs all merged is done.
    async function closeStepsByRefs() {
        const linked = ws().next.filter((s) => s.refs?.length);
        if (!linked.length) return;
        await loadRefs(linked.flatMap((s) => s.refs));
        const closed = [];
        linked.forEach((s) => {
            if (!A.steps.refsDone(s, state.refInfo)) return;
            const done = A.items.completeStep(ws(), s.id);
            if (done) {
                done.closedBy = s.refs.map((n) => `#${n}`).join(', ');
                closed.push(done);
            }
        });
        if (closed.length) {
            save(true);
            A.toast(closed.length === 1
                ? `Ticked off "${closed[0].text}": ${closed[0].closedBy} done on GitHub`
                : `Ticked off ${closed.length} steps whose GitHub issues and PRs are done`, 'ok');
        }
        renderWorkspace(true);
    }

    function renderCounts() {
        document.getElementById('next-count').textContent = String(ws().next.length);
        renderSidebar();
    }

    function renderStepTools() {
        const host = A.clear(document.getElementById('next-tools'));
        [['list', 'List'], ['board', 'Board']].forEach(([key, label]) => {
            const b = A.button(label, `filter-chip${prefs.stepView === key ? ' on' : ''}`, () => {
                prefs.stepView = key;
                savePrefs();
                renderNext(true);
            });
            b.setAttribute('aria-pressed', String(prefs.stepView === key));
            host.appendChild(b);
        });
    }

    function renderFilters(host) {
        const steps = ws().next;
        const bar = A.el('div', 'filter-chips step-filters');
        SCOPES.forEach((sc) => {
            const n = steps.filter(sc.test).length;
            if (sc.key !== 'all' && !n && filter.scope !== sc.key) return;
            bar.appendChild(A.button(`${sc.label}${sc.key === 'all' ? '' : ` ${n}`}`, `filter-chip${filter.scope === sc.key ? ' on' : ''}`, () => {
                filter.scope = sc.key;
                renderNext(true);
            }));
        });
        const labels = [...new Set(steps.flatMap((s) => s.labels || []))].sort();
        labels.forEach((l) => {
            const chip = A.button('', `filter-chip label-filter${filter.label === l ? ' on' : ''}`, () => {
                filter.label = filter.label === l ? '' : l;
                renderNext(true);
            });
            chip.style.setProperty('--label', A.steps.labelColor(l));
            chip.appendChild(A.el('span', 'label-dot'));
            chip.appendChild(A.el('span', null, l));
            bar.appendChild(chip);
        });
        if (steps.some(A.steps.isFocus)) {
            const load = A.steps.weekLoad(allDocs());
            const meter = A.steps.capacityMeter(load, A.steps.capacity());
            meter.classList.add('step-filters-capacity');
            meter.title = `${meter.title}, across all projects`;
            bar.appendChild(meter);
        }
        if (bar.children.length > 1) host.appendChild(bar);
    }

    function renderNext(force) {
        const host = document.getElementById('next-body');
        // Never pull a field out from under someone typing in it.
        const a = document.activeElement;
        if (!force && a?.closest?.('#next-body .step-detail') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
        A.clear(host);
        renderCounts();
        renderStepTools();

        const quick = A.steps.quickAdd({
            compact: true,
            onAdd: (parsed) => {
                const s = A.steps.create(parsed);
                ws().next.push(s);
                save(true);
                renderWorkspace(true);
                document.querySelector('#next-body .qa-title')?.focus();
                if (parsed.focus) A.steps.warnIfOver(allDocs());
                if (parsed.refs.length) loadRefs(parsed.refs).then(() => renderNext());
            },
        });
        host.appendChild(quick);

        ws().next.forEach(A.steps.normalize);
        if (!ws().next.length) {
            host.appendChild(A.el('p', 'hint', 'No next steps. Write down what you\'ll do the next time you sit down with this, then open it to add details and smaller steps.'));
            return;
        }
        renderFilters(host);

        const scope = SCOPES.find((x) => x.key === filter.scope) || SCOPES[0];
        const list = A.steps.sort(ws().next.filter((s) => scope.test(s) && (!filter.label || s.labels.includes(filter.label))));
        if (!list.length) {
            host.appendChild(A.el('p', 'hint', 'Nothing matches this filter.'));
            return;
        }
        if (prefs.stepView === 'board') {
            host.appendChild(A.steps.board(list.map((s) => ({ s, ctx: stepCtx() })), { onMove: () => renderWorkspace(true) }));
        } else {
            const rows = A.el('div', 'step-list');
            list.forEach((s) => rows.appendChild(A.steps.card(s, stepCtx())));
            host.appendChild(rows);
        }
    }

    // Opened from elsewhere (Up next, calendar) as project.html?id=…#step=<id>.
    function openStepFromHash() {
        const id = new URLSearchParams(window.location.hash.slice(1)).get('step');
        if (!id || !ws().next.some((s) => s.id === id)) return;
        state.expanded.add(id);
        filter.scope = 'all';
        filter.label = '';
        renderNext(true);
        document.querySelector(`[data-key="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' });
    }

    // ------------------------------------------------------------ achieved --
    //
    // A record of progress that doubles as release notes: group it by month
    // or by version, and copy it out as a Markdown changelog.

    function versions() {
        return [...new Set(ws().achieved.map((a) => a.version).filter(Boolean))];
    }

    function versionTag(a) {
        const wrap = A.el('span', 'achieved-version');
        const show = () => {
            A.clear(wrap);
            const b = A.button(a.version || '+ version', a.version ? 'version-chip' : 'link-btn version-add', edit);
            b.title = a.version ? 'Change version' : 'Put this in a release';
            wrap.appendChild(b);
        };
        const edit = () => {
            A.clear(wrap);
            const input = A.el('input', 'version-input');
            input.type = 'text';
            input.value = a.version || '';
            input.placeholder = 'v1.2';
            input.setAttribute('aria-label', 'Version');
            const listId = `versions-${a.id}`;
            input.setAttribute('list', listId);
            const dl = A.el('datalist');
            dl.id = listId;
            versions().forEach((v) => { const o = A.el('option'); o.value = v; dl.appendChild(o); });
            let doneEditing = false;
            const commit = (keep) => {
                if (doneEditing) return;
                doneEditing = true;
                if (keep) {
                    const v = input.value.trim();
                    if (v) a.version = v; else delete a.version;
                    save(true);
                    if (prefs.achievedBy === 'version') { renderAchieved(); return; }
                }
                show();
            };
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(true); }
                if (e.key === 'Escape') commit(false);
            });
            input.addEventListener('blur', () => commit(true));
            wrap.appendChild(input);
            wrap.appendChild(dl);
            input.focus();
        };
        show();
        return wrap;
    }

    // A finished step keeps its details and checklist, read-only, behind a
    // small toggle; move it back to Next steps to edit them.
    function achievedDetail(a, body) {
        const { done, total } = A.steps.checklistProgress(a);
        const details = (a.details || '').trim();
        if (!total && !details) return;
        const more = A.el('div', 'achieved-more');
        more.hidden = true;
        if (details) more.appendChild(A.el('p', 'achieved-details', details));
        if (total) {
            const list = A.el('ul', 'achieved-checklist');
            a.checklist.forEach((c) => list.appendChild(A.el('li', c.done ? 'done' : '', c.text)));
            more.appendChild(list);
        }
        const label = [total ? `${done}/${total} steps` : '', details ? 'details' : ''].filter(Boolean).join(' · ');
        const toggle = A.button(`Show ${label}`, 'link-btn achieved-toggle', () => {
            more.hidden = !more.hidden;
            toggle.textContent = `${more.hidden ? 'Show' : 'Hide'} ${label}`;
        });
        body.appendChild(toggle);
        body.appendChild(more);
    }

    function achievedItem(a) {
        const item = A.el('div', 'achieved-item item-row');
        item.appendChild(A.el('span', 'achieved-dot'));
        const body = A.el('div', 'achieved-body');
        const line = A.el('div', 'achieved-line');
        line.appendChild(A.el('span', 'achieved-text', a.text));
        (a.labels || []).forEach((l) => line.appendChild(A.steps.labelChip(l)));
        body.appendChild(line);
        const sub = A.el('div', 'achieved-date');
        if (a.date) sub.appendChild(A.el('span', null, A.parseDate(a.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })));
        if (a.closedBy) sub.appendChild(A.el('span', null, `· via ${a.closedBy}`));
        sub.appendChild(versionTag(a));
        body.appendChild(sub);
        achievedDetail(a, body);
        item.appendChild(body);
        const actions = A.el('div', 'item-actions');
        actions.appendChild(A.iconButton('refresh', 'Move back to next steps', () => {
            A.items.reopenStep(ws(), a.id);
            save(true);
            renderWorkspace(true);
        }, 'icon-btn sm'));
        actions.appendChild(A.iconButton('trash', 'Delete', () => {
            ws().achieved = ws().achieved.filter((x) => x.id !== a.id);
            save(true);
            renderWorkspace(true);
        }, 'icon-btn sm danger'));
        item.appendChild(actions);
        return item;
    }

    function renderAchievedTools() {
        const host = A.clear(document.getElementById('achieved-tools'));
        [['month', 'By month'], ['version', 'By version']].forEach(([key, label]) => {
            const b = A.button(label, `filter-chip${prefs.achievedBy === key ? ' on' : ''}`, () => {
                prefs.achievedBy = key;
                savePrefs();
                renderAchieved();
            });
            b.setAttribute('aria-pressed', String(prefs.achievedBy === key));
            host.appendChild(b);
        });
        if (!ws().achieved.length) return;
        const copy = A.iconButton('download', 'Copy as a Markdown changelog', async () => {
            const text = A.steps.changelog(ws().achieved, prefs.achievedBy, projectName());
            try {
                await navigator.clipboard.writeText(text);
                A.toast('Changelog copied', 'ok');
            } catch {
                A.modal.open({ title: 'Changelog', fields: [{ name: 'text', label: 'Markdown', type: 'textarea', rows: 14, value: text }], submitLabel: 'Close', onSubmit: () => {} });
            }
        }, 'icon-btn sm');
        host.appendChild(copy);
    }

    function renderAchieved() {
        const host = A.clear(document.getElementById('achieved-body'));
        document.getElementById('achieved-count').textContent = String(ws().achieved.length);
        renderAchievedTools();

        const form = A.el('form', 'quick-add compact');
        form.style.marginBottom = '0.6rem';
        const text = A.el('input', 'qa-title');
        text.type = 'text';
        text.placeholder = 'Log something you shipped or finished…';
        text.setAttribute('aria-label', 'Achievement');
        const date = A.el('input');
        date.type = 'date';
        date.value = A.todayKey();
        date.setAttribute('aria-label', 'Date');
        const add = A.el('button', 'btn btn-edit btn-small', 'Log');
        add.type = 'submit';
        [text, date, add].forEach((n) => form.appendChild(n));
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const parsed = A.steps.parseQuick(text.value);
            if (!parsed.text) { text.focus(); return; }
            ws().achieved.unshift({ id: A.uid(), text: parsed.text, labels: parsed.labels, refs: parsed.refs, date: date.value || A.todayKey() });
            ws().achieved.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            save(true);
            renderWorkspace(true);
        });
        host.appendChild(form);

        if (!ws().achieved.length) {
            host.appendChild(A.el('p', 'hint', 'Tick off a next step, or log a win here, and it builds a record of progress. Give items a version to turn it into release notes.'));
            return;
        }

        const untagged = ws().achieved.filter((a) => !a.version);
        if (prefs.achievedBy === 'version' && untagged.length) {
            const tagAll = A.button(`Put ${untagged.length} untagged in a version…`, 'link-btn achieved-tag-all', () => {
                A.modal.open({
                    title: 'Cut a version',
                    description: `Tags the ${untagged.length} item${untagged.length === 1 ? '' : 's'} not in a version yet.`,
                    fields: [{ name: 'version', label: 'Version', required: true, placeholder: 'v1.2' }],
                    submitLabel: 'Tag them',
                    onSubmit: (v) => {
                        untagged.forEach((a) => { a.version = v.version.trim(); });
                        save(true);
                        renderAchieved();
                    },
                });
            });
            host.appendChild(tagAll);
        }

        A.steps.groupAchieved(ws().achieved, prefs.achievedBy).forEach((g) => {
            host.appendChild(A.el('div', 'group-head achieved-group', `${g.label} · ${g.items.length}`));
            const list = A.el('div', 'achieved-list');
            g.items.forEach((a) => list.appendChild(achievedItem(a)));
            host.appendChild(list);
        });
    }

    // ------------------------------------------------------- notes/details --
    //
    // Notes are one free-form page. Decisions are dated entries — what was
    // decided and why — so the reasoning stays findable later.

    function renderNotesTabs() {
        const host = A.clear(document.getElementById('notes-tools'));
        const count = (ws().decisions || []).length;
        [['notes', 'Notes'], ['decisions', `Decisions${count ? ` ${count}` : ''}`]].forEach(([key, label]) => {
            const b = A.button(label, `filter-chip${prefs.notesTab === key ? ' on' : ''}`, () => {
                prefs.notesTab = key;
                savePrefs();
                renderNotes();
            });
            b.setAttribute('aria-pressed', String(prefs.notesTab === key));
            host.appendChild(b);
        });
    }

    function decisionEntry(d) {
        const item = A.el('article', 'decision');
        const head = A.el('div', 'decision-head');
        const date = A.el('input', 'decision-date');
        date.type = 'date';
        date.value = d.date || '';
        date.setAttribute('aria-label', 'Date decided');
        date.addEventListener('change', () => { d.date = date.value; save(true); });
        const title = A.el('input', 'decision-title');
        title.type = 'text';
        title.value = d.title || '';
        title.placeholder = 'What was decided';
        title.setAttribute('aria-label', 'Decision');
        title.addEventListener('input', () => { d.title = title.value; save(); });
        head.appendChild(title);
        head.appendChild(date);
        head.appendChild(A.iconButton('trash', 'Delete decision', async () => {
            const ok = await A.confirm({ title: `Delete "${d.title || 'this decision'}"?`, confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            ws().decisions = ws().decisions.filter((x) => x.id !== d.id);
            save(true);
            renderNotes();
        }, 'icon-btn sm danger'));
        item.appendChild(head);
        const why = A.el('textarea', 'decision-why');
        why.rows = 2;
        why.value = d.why || '';
        why.placeholder = 'Why: the options, the trade-off, what would change your mind…';
        why.setAttribute('aria-label', 'Why');
        why.addEventListener('input', () => { d.why = why.value; save(); });
        requestAnimationFrame(() => { why.style.height = 'auto'; why.style.height = `${why.scrollHeight + 2}px`; });
        why.addEventListener('input', () => { why.style.height = 'auto'; why.style.height = `${why.scrollHeight + 2}px`; });
        item.appendChild(why);
        return item;
    }

    function renderNotes() {
        const host = A.clear(document.getElementById('notes-body'));
        if (!Array.isArray(ws().decisions)) ws().decisions = [];
        renderNotesTabs();
        const hint = document.getElementById('notes-hint');

        if (prefs.notesTab === 'notes') {
            hint.textContent = 'Open questions, design thinking, trade-offs — whatever future you needs.';
            const ta = A.el('textarea');
            ta.rows = 12;
            ta.value = ws().notes || '';
            ta.placeholder = 'Thinking, design, architecture…';
            ta.setAttribute('aria-label', 'Notes');
            ta.addEventListener('input', () => { ws().notes = ta.value; save(); });
            host.appendChild(ta);
            return;
        }

        hint.textContent = 'A dated log of what you decided and why, newest first.';
        const form = A.el('form', 'quick-add compact');
        form.style.marginBottom = '0.6rem';
        const text = A.el('input', 'qa-title');
        text.type = 'text';
        text.placeholder = 'Record a decision…';
        text.setAttribute('aria-label', 'New decision');
        const add = A.el('button', 'btn btn-edit btn-small', 'Add');
        add.type = 'submit';
        form.appendChild(text);
        form.appendChild(add);
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!text.value.trim()) { text.focus(); return; }
            const d = { id: A.uid(), date: A.todayKey(), title: text.value.trim(), why: '' };
            ws().decisions.unshift(d);
            save(true);
            renderNotes();
            document.querySelector('#notes-body .decision-why')?.focus();
        });
        host.appendChild(form);

        if (!ws().decisions.length) {
            host.appendChild(A.el('p', 'hint', 'Nothing logged yet. When you pick a library, an approach or a trade-off, note it here with the reason.'));
            return;
        }
        const list = A.el('div', 'decision-list');
        [...ws().decisions]
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
            .forEach((d) => list.appendChild(decisionEntry(d)));
        host.appendChild(list);
    }

    function fieldRow(label, input) {
        const row = A.el('div', 'field-row');
        row.appendChild(A.el('div', 'field-label', label));
        const val = A.el('div', 'field-value-plain');
        val.appendChild(input);
        row.appendChild(val);
        return row;
    }

    function renderDetails() {
        const host = A.clear(document.getElementById('details-body'));

        const status = A.el('select');
        STATUSES.forEach((s) => {
            const o = A.el('option', null, s.label);
            o.value = s.value;
            if (s.value === ws().status) o.selected = true;
            status.appendChild(o);
        });
        status.addEventListener('change', () => { ws().status = status.value; save(true); });
        host.appendChild(fieldRow('Status', status));

        const summary = A.el('textarea');
        summary.rows = 2;
        summary.value = ws().summary || '';
        summary.placeholder = 'One line that explains this project to future you.';
        summary.addEventListener('input', () => { ws().summary = summary.value; save(); });
        host.appendChild(fieldRow('Summary', summary));

        const live = A.el('input');
        live.type = 'url';
        live.placeholder = 'https://…';
        live.value = ws().liveUrl || '';
        live.addEventListener('input', () => { ws().liveUrl = live.value; save(); renderHeader(); });
        host.appendChild(fieldRow('Live URL', live));

        // Links
        const links = A.el('div', 'repeater-inline');
        ws().links.forEach((link, i) => {
            const row = A.el('div', 'repeater-item-row');
            const label = A.el('input', 'input-narrow');
            label.type = 'text';
            label.placeholder = 'Label';
            label.value = link.label || '';
            label.style.maxWidth = '9rem';
            label.addEventListener('input', () => { link.label = label.value; save(); });
            row.appendChild(label);
            const url = A.el('input');
            url.type = 'url';
            url.placeholder = 'https://…';
            url.value = link.url || '';
            url.addEventListener('input', () => { link.url = url.value; save(); });
            row.appendChild(url);
            if (link.url) {
                const open = A.el('a', 'icon-btn sm');
                open.href = link.url;
                open.target = '_blank';
                open.rel = 'noopener';
                open.title = 'Open';
                open.innerHTML = window.Nav.svg('external', 14);
                row.appendChild(open);
            }
            row.appendChild(A.iconButton('x', 'Remove link', () => { ws().links.splice(i, 1); save(true); renderDetails(); }, 'icon-btn sm danger'));
            links.appendChild(row);
        });
        const linkWrap = A.el('div');
        linkWrap.appendChild(links);
        linkWrap.appendChild(A.button('+ Add link', 'btn-add', () => { ws().links.push({ label: '', url: '' }); renderDetails(); }));
        host.appendChild(fieldRow('Links', linkWrap));

        // Roadmaps that point at this project
        const linked = state.roadmaps.filter((r) => r.projectId === state.id);
        const rmWrap = A.el('div');
        if (linked.length) {
            linked.forEach((r) => {
                const items = r.phases.flatMap((p) => p.items);
                const a = A.link(r.title, `pages/plan.html#roadmap=${encodeURIComponent(r.id)}`, 'inline-link');
                rmWrap.appendChild(a);
                rmWrap.appendChild(A.progressBar(items.filter((i) => i.done).length, items.length));
            });
        } else {
            const p = A.el('p', 'hint');
            p.style.margin = '0.4rem 0 0';
            p.appendChild(document.createTextNode('None. Long project? '));
            p.appendChild(A.link('Plan a roadmap', 'pages/plan.html#roadmaps', 'inline-link'));
            p.appendChild(document.createTextNode(' and link it here.'));
            rmWrap.appendChild(p);
        }
        host.appendChild(fieldRow('Roadmap', rmWrap));

        const tools = A.projectTools(state.id);
        if (tools.length) {
            const wrap = A.el('div');
            tools.forEach((t) => {
                wrap.appendChild(A.link(`${t.label} →`, t.href, 'inline-link'));
                if (t.hint) wrap.appendChild(A.el('div', 'hint', t.hint));
            });
            host.appendChild(fieldRow('Tools', wrap));
        }
    }

    function renderWorkspace(force) {
        renderNext(force);
        renderAchieved();
        renderSidebar();
    }

    // ------------------------------------------------------------ repo side --

    function statRow(items) {
        const grid = A.el('div', 'stat-grid');
        items.forEach(([label, value]) => {
            if (value == null || value === '') return;
            const cell = A.el('div', 'stat-cell');
            cell.appendChild(A.el('div', 'stat-value', String(value)));
            cell.appendChild(A.el('div', 'stat-label', label));
            grid.appendChild(cell);
        });
        return grid;
    }

    function listBlock(title, rows, emptyText) {
        const block = A.el('div', 'repo-block');
        block.appendChild(A.el('div', 'subfield-label', title));
        if (!rows.length) {
            block.appendChild(A.el('p', 'hint', emptyText));
            return block;
        }
        const list = A.el('div', 'repo-list');
        rows.forEach((row) => list.appendChild(row));
        block.appendChild(list);
        return block;
    }

    function linkRow(text, href, trailing) {
        const row = A.externalLink('', href, 'repo-list-item');
        row.appendChild(A.el('span', 'repo-list-text', text));
        if (trailing) row.appendChild(A.el('span', 'repo-list-meta', trailing));
        return row;
    }

    function collapsible(title, buildBody) {
        const block = A.el('div', 'repo-block');
        const head = A.el('button', 'collapse-head');
        head.type = 'button';
        head.setAttribute('aria-expanded', 'false');
        head.appendChild(A.el('span', 'subfield-label', title));
        const chev = A.el('span', 'collapse-chev', '▾');
        head.appendChild(chev);
        const body = A.el('div', 'collapse-body');
        body.style.display = 'none';
        let built = false;
        head.addEventListener('click', () => {
            const open = body.style.display === 'none';
            body.style.display = open ? 'block' : 'none';
            chev.textContent = open ? '▴' : '▾';
            head.setAttribute('aria-expanded', String(open));
            if (open && !built) { buildBody(body); built = true; }
        });
        block.appendChild(head);
        block.appendChild(body);
        return block;
    }

    function renderRepoSide() {
        const host = A.clear(document.getElementById('repo-body'));
        const note = document.getElementById('repo-head-note');

        if (!state.repoName) {
            note.textContent = '';
            host.appendChild(A.el('p', 'hint', 'No repository linked to this project.'));
            if (state.project) {
                host.appendChild(A.button('Link a GitHub repo', 'btn btn-edit btn-small', () => {
                    A.modal.open({
                        title: 'Link a repository',
                        description: 'Once linked, this panel fills with live data from GitHub.',
                        fields: [{ name: 'repo', label: 'Repository', required: true, placeholder: 'owner/name' }],
                        submitLabel: 'Link',
                        onSubmit: async (values) => {
                            if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('Use the form owner/name.');
                            await A.api(`/projects?id=${encodeURIComponent(state.id)}`, { method: 'PATCH', body: { repo: values.repo } });
                            window.location.reload();
                        },
                    });
                }));
            }
            return;
        }

        if (!state.detail) {
            note.textContent = '';
            host.appendChild(A.el('p', 'hint', `Could not load ${state.repoName} from GitHub.`));
            return;
        }

        const { repo, languages, commits, branches, issues, pulls, readmeHtml } = state.detail;
        note.textContent = repo.private ? 'private' : 'public';

        host.appendChild(statRow([
            ['Branches', branches.length],
            ['Open issues', issues.length],
            ['Open PRs', pulls.length],
            ['Stars', repo.stargazers_count || null],
            ['Size', repo.size ? `${(repo.size / 1024).toFixed(1)} MB` : null],
        ]));

        const meta = A.el('div', 'repo-meta-line');
        meta.appendChild(A.el('span', null, `Default branch ${repo.default_branch}`));
        meta.appendChild(A.el('span', null, `Last push ${A.relativeTime(repo.pushed_at)}`));
        meta.appendChild(A.el('span', null, `Created ${A.shortDate(repo.created_at)}`));
        host.appendChild(meta);

        if (repo.topics?.length) {
            const chips = A.el('div', 'chip-list repo-topics');
            repo.topics.forEach((t) => chips.appendChild(A.el('span', 'chip chip-static', t)));
            host.appendChild(chips);
        }

        const bar = A.langBar(languages);
        if (bar) {
            const block = A.el('div', 'repo-block');
            block.appendChild(A.el('div', 'subfield-label', 'Languages'));
            block.appendChild(bar);
            host.appendChild(block);
        }

        host.appendChild(listBlock('Recent commits', commits.map((c) =>
            linkRow(c.message || c.short, c.html_url, `${c.short} · ${A.relativeTime(c.date)}`)
        ), 'No commits found.'));

        if (pulls.length) {
            host.appendChild(listBlock('Open pull requests', pulls.map((p) =>
                linkRow(p.title, p.html_url, `#${p.number}${p.draft ? ' · draft' : ''}`)
            ), ''));
        }

        host.appendChild(listBlock('Open issues', issues.map((i) => linkRow(i.title, i.html_url, `#${i.number}`)), 'No open issues.'));
        host.appendChild(listBlock('Branches', branches.map((b) =>
            linkRow(b.name, `${repo.html_url}/tree/${encodeURIComponent(b.name)}`, b.protected ? 'protected' : '')
        ), 'No branches found.'));

        if (readmeHtml) {
            host.appendChild(collapsible('README', (body) => {
                const readme = A.el('div', 'readme');
                readme.innerHTML = readmeHtml; // sanitised server-side in the worker
                body.appendChild(readme);
            }));
        }
    }

    // --------------------------------------------------------------- chrome --

    function projectName() {
        return state.project?.name || state.detail?.repo?.name || A.projectLabel(state.repoName || state.id) || 'Project';
    }

    function renderHeader() {
        const name = projectName();
        document.getElementById('project-title').textContent = name;
        document.title = `${name} — Projects`;

        const parts = [];
        if (state.repoName) parts.push(state.repoName);
        else if (state.project) parts.push('Manual project');
        const desc = state.project?.description || state.detail?.repo?.description;
        if (desc) parts.push(desc);
        document.getElementById('project-subtitle').textContent = parts.join(' · ') || '—';

        const theme = document.getElementById('theme-quick');
        const actions = A.clear(document.getElementById('project-actions'));
        actions.appendChild(indicator);
        if (state.detail?.repo?.html_url) {
            const gh = A.externalLink('', state.detail.repo.html_url, 'btn btn-edit btn-small');
            gh.appendChild(A.icon('github', 14));
            gh.appendChild(A.el('span', 'btn-label', 'GitHub'));
            actions.appendChild(gh);
        }
        const live = ws()?.liveUrl || state.detail?.repo?.homepage;
        if (live) {
            const btn = A.externalLink('', live, 'btn btn-edit btn-small');
            btn.appendChild(A.icon('external', 14));
            btn.appendChild(A.el('span', 'btn-label', 'Live'));
            actions.appendChild(btn);
        }
        A.projectTools(state.id).forEach((t) => {
            const btn = A.link('', t.href, 'btn btn-add-primary btn-small');
            btn.title = t.hint || t.label;
            btn.appendChild(A.icon(t.icon || 'pencil', 14));
            btn.appendChild(A.el('span', 'btn-label', t.label));
            actions.appendChild(btn);
        });
        if (state.project) {
            actions.appendChild(A.iconButton('trash', 'Delete project', async () => {
                const ok = await A.confirm({
                    title: `Delete "${state.project.name}"?`,
                    description: 'This removes the project and its workspace — next steps, achievements, notes — plus their calendar entries. It cannot be undone.',
                    confirmLabel: 'Delete project', danger: true,
                });
                if (!ok) return;
                await A.api(`/projects?id=${encodeURIComponent(state.id)}`, { method: 'DELETE' });
                window.location.href = 'projects.html';
            }, 'icon-btn danger'));
        }
        // nav.js adds the theme toggle once; keep it last.
        if (theme) actions.appendChild(theme);
    }

    function renderSidebar() {
        const others = Object.entries(state.others)
            .filter(([id, w]) => id !== state.id && w.updatedAt)
            .sort((a, b) => new Date(b[1].updatedAt) - new Date(a[1].updatedAt))
            .slice(0, 8);
        window.Nav.setSections([
            {
                label: projectName(),
                items: [
                    { label: 'Next steps', icon: 'upnext', href: '#sec-next', count: ws()?.next.length || '' },
                    { label: 'This week', icon: 'flag', count: ws()?.next.filter(A.steps.isFocus).length || '', onClick: () => { filter.scope = 'week'; renderNext(true); document.getElementById('sec-next').scrollIntoView(); } },
                    { label: 'Blocked', icon: 'alert', count: ws()?.next.filter((s) => A.steps.statusOf(s) === 'blocked').length || '', countTone: 'danger', onClick: () => { filter.scope = 'blocked'; renderNext(true); document.getElementById('sec-next').scrollIntoView(); } },
                    { label: 'Achieved', icon: 'check', href: '#sec-achieved', count: ws()?.achieved.length || '' },
                    { label: 'Notes & decisions', icon: 'pencil', href: '#sec-notes' },
                    { label: 'Details', icon: 'list', href: '#sec-details' },
                    { label: 'Repository', icon: 'github', href: '#sec-repo' },
                    ...A.projectTools(state.id).map((t) => ({ label: t.label, icon: t.icon || 'pencil', href: t.href })),
                ],
            },
            {
                label: 'Recently worked on',
                empty: 'Nothing else yet.',
                items: others.map(([id, w]) => ({
                    label: w.projectName || A.projectLabel(id),
                    icon: 'projects',
                    href: A.projectHref(id).replace(/^\.\.\//, ''),
                    count: w.next?.length || '',
                })),
            },
            {
                label: 'Projects',
                items: [
                    { label: 'All projects', icon: 'projects', href: 'pages/projects.html' },
                ],
            },
        ]);
    }

    async function load() {
        const hint = document.getElementById('load-hint');
        if (!state.id) { hint.textContent = 'No project id in the URL.'; return; }

        try {
            if (state.id.startsWith('gh:')) {
                state.repoName = state.id.slice(3);
            } else {
                const customList = await A.api('/projects');
                state.project = customList.find((p) => p.id === state.id) || null;
                if (!state.project) { hint.textContent = 'That project no longer exists.'; return; }
                state.repoName = state.project.repo || null;
            }

            state.store = A.store.workspace(state.id);
            const [, detail, plan, others] = await Promise.all([
                state.store.load(),
                state.repoName ? A.api(`/repo?repo=${encodeURIComponent(state.repoName)}`).catch(() => null) : Promise.resolve(null),
                A.store.plan.load().catch(() => ({ roadmaps: [] })),
                A.api('/workspaces').catch(() => ({})),
            ]);
            state.detail = detail;
            state.roadmaps = plan.roadmaps || [];
            state.others = others;

            // Keep the name on the workspace so calendar events can say which
            // project a step belongs to.
            if (ws().projectName !== projectName()) {
                ws().projectName = projectName();
                if (ws().updatedAt) save();
            }

            hint.style.display = 'none';
            document.getElementById('app').style.display = '';
            renderHeader();
            renderWorkspace();
            renderNotes();
            renderDetails();
            renderRepoSide();
            openStepFromHash();
            window.addEventListener('hashchange', openStepFromHash);
            closeStepsByRefs();
        } catch (e) {
            hint.textContent = `Could not load this project: ${e.message}`;
        }
    }

    load();
})();
