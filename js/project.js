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
    };
    const ws = () => state.store.doc;
    const indicator = A.store.indicator();
    const save = (now) => state.store.save(now);

    // ---------------------------------------------------------- next steps --

    function sortSteps(list) {
        return [...list].sort((a, b) => {
            if (a.due && b.due) return a.due.localeCompare(b.due) || A.priorityRank(a.priority) - A.priorityRank(b.priority);
            if (a.due) return -1;
            if (b.due) return 1;
            return A.priorityRank(a.priority) - A.priorityRank(b.priority);
        });
    }

    // Each next step opens in place into its full detail: when, how urgent,
    // what it involves (details) and the smaller steps to get it done
    // (checklist). Edits save as you type and update the row without a
    // redraw, so nothing jumps while you work; the list re-sorts next time.

    function checklistProgress(s) {
        const list = s.checklist || [];
        return { done: list.filter((c) => c.done).length, total: list.length };
    }

    function autosize(ta) {
        const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
        ta.addEventListener('input', fit);
        requestAnimationFrame(fit);
    }

    function deleteStep(s) {
        ws().next = ws().next.filter((x) => x.id !== s.id);
        state.expanded.delete(s.id);
        save(true);
        renderWorkspace();
    }

    function finishStep(s, row) {
        row?.classList.add('is-done');
        row?.querySelector('.check')?.classList.add('on');
        setTimeout(() => {
            A.items.completeStep(ws(), s.id);
            state.expanded.delete(s.id);
            save(true);
            renderWorkspace();
            A.toast('Moved to Achieved', 'ok');
        }, 260);
    }

    // The row's right-hand side: checklist progress, priority, due date.
    function stepMeta(s, meta) {
        A.clear(meta);
        const { done, total } = checklistProgress(s);
        if (total) {
            const chip = A.el('span', `step-progress${done === total ? ' complete' : ''}`);
            chip.title = `${done} of ${total} steps done`;
            chip.appendChild(A.icon('list', 12));
            chip.appendChild(A.el('span', null, `${done}/${total}`));
            meta.appendChild(chip);
        }
        if (s.details?.trim()) {
            const note = A.icon('pencil', 12, 'inline-icon step-has-details');
            note.title = 'Has details';
            meta.appendChild(note);
        }
        meta.appendChild(A.priorityFlag(s.priority));
        const chip = A.dueChip(s.due, s.time);
        if (chip) meta.appendChild(chip);
    }

    function checklistEditor(s, onChange) {
        const wrap = A.el('div', 'step-checklist');
        const list = A.el('div', 'subtask-list');

        function rowFor(c) {
            const row = A.el('div', `subtask${c.done ? ' done' : ''}`);
            row.appendChild(A.checkbox(c.done, (v) => {
                c.done = v;
                const next = rowFor(c);
                row.replaceWith(next);
                next.querySelector('.check').focus();
                save(true);
                onChange();
            }, `Mark "${c.text}" ${c.done ? 'not done' : 'done'}`));
            const text = A.el('input', 'subtask-title');
            text.type = 'text';
            text.value = c.text;
            text.setAttribute('aria-label', 'Step');
            text.addEventListener('input', () => { c.text = text.value; save(); });
            text.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.focus(); });
            row.appendChild(text);
            row.appendChild(A.iconButton('x', 'Remove step', () => {
                s.checklist = s.checklist.filter((x) => x.id !== c.id);
                row.remove();
                save(true);
                onChange();
                add.focus();
            }, 'icon-btn sm danger'));
            return row;
        }

        (s.checklist || []).forEach((c) => list.appendChild(rowFor(c)));
        wrap.appendChild(list);

        const add = A.el('input', 'inline-add subtask-add');
        add.type = 'text';
        add.placeholder = '+ Add a step and press Enter';
        add.setAttribute('aria-label', `Add a step to ${s.text}`);
        add.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !add.value.trim()) return;
            e.preventDefault();
            const c = { id: A.uid(), text: add.value.trim(), done: false };
            s.checklist = [...(s.checklist || []), c];
            list.appendChild(rowFor(c));
            add.value = '';
            save(true);
            onChange();
        });
        const addRow = A.el('div', 'subtask-add-row');
        addRow.appendChild(add);
        wrap.appendChild(addRow);
        wrap.focusAdd = () => add.focus();
        return wrap;
    }

    function stepDetail(s, { row, title, meta }) {
        const panel = A.el('div', 'step-detail');
        const refresh = () => stepMeta(s, meta);

        const fields = A.el('div', 'step-fields');
        const name = A.el('input', 'step-name');
        name.type = 'text';
        name.value = s.text;
        name.setAttribute('aria-label', 'Step');
        name.addEventListener('input', () => {
            s.text = name.value;
            title.textContent = name.value || 'Untitled step';
            save();
        });
        name.addEventListener('blur', () => {
            if (name.value.trim()) return;
            s.text = 'Untitled step';
            name.value = s.text;
            title.textContent = s.text;
            save(true);
        });
        fields.appendChild(name);

        const due = A.el('input');
        due.type = 'date';
        due.value = s.due || '';
        due.setAttribute('aria-label', 'Due date');
        const time = A.el('input');
        time.type = 'time';
        time.value = s.time || '';
        time.setAttribute('aria-label', 'Time (optional)');
        time.disabled = !s.due;
        time.title = s.due ? 'Time (optional)' : 'Pick a date first';
        due.addEventListener('change', () => {
            s.due = due.value;
            if (!s.due) { s.time = ''; time.value = ''; }
            time.disabled = !s.due;
            time.title = s.due ? 'Time (optional)' : 'Pick a date first';
            save(true);
            refresh();
        });
        time.addEventListener('change', () => { s.time = time.value; save(true); refresh(); });
        const prio = A.el('select');
        prio.setAttribute('aria-label', 'Priority');
        A.PRIORITIES.forEach((p) => {
            const o = A.el('option', null, p.label);
            o.value = p.value;
            if (p.value === (s.priority || 'medium')) o.selected = true;
            prio.appendChild(o);
        });
        prio.addEventListener('change', () => { s.priority = prio.value; save(true); refresh(); });
        [due, time, prio].forEach((n) => fields.appendChild(n));
        panel.appendChild(fields);

        panel.appendChild(A.el('div', 'subfield-label', 'Details'));
        const details = A.el('textarea', 'step-details');
        details.rows = 3;
        details.value = s.details || '';
        details.placeholder = 'What this involves, how you\'ll approach it, what "done" looks like, links…';
        details.setAttribute('aria-label', 'Details');
        details.addEventListener('input', () => { s.details = details.value; save(); refresh(); });
        autosize(details);
        panel.appendChild(details);

        const checkHead = A.el('div', 'subfield-label step-check-head');
        checkHead.appendChild(A.el('span', null, 'Steps'));
        const bar = A.el('span', 'step-check-bar');
        checkHead.appendChild(bar);
        panel.appendChild(checkHead);
        const renderBar = () => {
            A.clear(bar);
            const { done, total } = checklistProgress(s);
            if (total) bar.appendChild(A.progressBar(done, total));
        };
        renderBar();
        const checklist = checklistEditor(s, () => { renderBar(); refresh(); });
        panel.appendChild(checklist);

        const foot = A.el('div', 'step-foot');
        const doneBtn = A.button('', 'btn btn-add-primary btn-small', () => finishStep(s, row));
        doneBtn.appendChild(A.icon('check', 13));
        doneBtn.appendChild(A.el('span', null, 'Mark done'));
        foot.appendChild(doneBtn);
        foot.appendChild(A.button('Delete step', 'btn btn-ghost btn-small step-delete', () => deleteStep(s)));
        panel.appendChild(foot);

        panel.focusName = () => name.focus();
        return panel;
    }

    function stepCard(s) {
        const card = A.el('div', 'step-card');
        card.id = `step-${s.id}`;
        const open = () => state.expanded.has(s.id);

        const row = A.el('div', 'item-row step-row');
        row.appendChild(A.checkbox(false, () => finishStep(s, row), `Mark "${s.text}" done`));
        const main = A.el('div', 'item-main');
        main.tabIndex = 0;
        main.setAttribute('role', 'button');
        const title = A.el('span', 'item-title', s.text);
        main.appendChild(title);
        row.appendChild(main);
        const meta = A.el('div', 'item-meta');
        stepMeta(s, meta);
        row.appendChild(meta);
        const chev = A.iconButton('chevronRight', 'Show details', null, 'icon-btn sm step-chev');
        row.appendChild(chev);
        card.appendChild(row);

        let detail = null;
        function setOpen(next, focus) {
            if (next) state.expanded.add(s.id); else state.expanded.delete(s.id);
            card.classList.toggle('open', next);
            chev.title = next ? 'Hide details' : 'Show details';
            chev.setAttribute('aria-label', chev.title);
            main.setAttribute('aria-expanded', String(next));
            chev.setAttribute('aria-expanded', String(next));
            if (next && !detail) {
                detail = stepDetail(s, { row, title, meta });
                card.appendChild(detail);
            }
            if (detail) detail.hidden = !next;
            if (next && focus) detail.focusName();
        }
        const toggle = () => setOpen(!open(), true);
        main.addEventListener('click', toggle);
        main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        chev.addEventListener('click', toggle);
        setOpen(open(), false);
        return card;
    }

    function renderNext() {
        const host = document.getElementById('next-body');
        // Never pull a field out from under someone typing in it.
        const typing = document.activeElement?.closest?.('#next-body .step-detail');
        if (typing && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
        A.clear(host);
        document.getElementById('next-count').textContent = String(ws().next.length);

        const form = A.el('form', 'quick-add compact');
        form.style.marginBottom = '0.6rem';
        const text = A.el('input', 'qa-title');
        text.type = 'text';
        text.placeholder = 'What\'s the next step?';
        text.setAttribute('aria-label', 'Next step');
        const due = A.el('input');
        due.type = 'date';
        due.setAttribute('aria-label', 'Due date');
        const prio = A.el('select');
        prio.setAttribute('aria-label', 'Priority');
        A.PRIORITIES.forEach((p) => {
            const o = A.el('option', null, p.label);
            o.value = p.value;
            if (p.value === 'medium') o.selected = true;
            prio.appendChild(o);
        });
        const add = A.el('button', 'btn btn-add-primary btn-small', 'Add');
        add.type = 'submit';
        [text, due, prio, add].forEach((n) => form.appendChild(n));
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const value = text.value.trim();
            if (!value) { text.focus(); return; }
            ws().next.push({ id: A.uid(), text: value, due: due.value, time: '', priority: prio.value, details: '', checklist: [], createdAt: new Date().toISOString() });
            save(true);
            renderWorkspace();
            document.querySelector('#next-body .qa-title')?.focus();
        });
        host.appendChild(form);

        if (!ws().next.length) {
            host.appendChild(A.el('p', 'hint', 'No next steps. Write down what you\'ll do the next time you sit down with this, then open it to add details and smaller steps.'));
            return;
        }

        const rows = A.el('div', 'step-list');
        sortSteps(ws().next).forEach((s) => rows.appendChild(stepCard(s)));
        host.appendChild(rows);
    }

    // Opened from elsewhere (Up next, calendar) as project.html?id=…#step=<id>.
    function openStepFromHash() {
        const id = new URLSearchParams(window.location.hash.slice(1)).get('step');
        if (!id || !ws().next.some((s) => s.id === id)) return;
        state.expanded.add(id);
        renderNext();
        document.getElementById(`step-${id}`)?.scrollIntoView({ block: 'center' });
    }

    // ------------------------------------------------------------ achieved --

    // A finished step keeps its details and checklist, read-only, behind a
    // small toggle; move it back to Next steps to edit them.
    function achievedDetail(a, body) {
        const { done, total } = checklistProgress(a);
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

    function renderAchieved() {
        const host = A.clear(document.getElementById('achieved-body'));
        document.getElementById('achieved-count').textContent = String(ws().achieved.length);

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
            const value = text.value.trim();
            if (!value) { text.focus(); return; }
            ws().achieved.unshift({ id: A.uid(), text: value, date: date.value || A.todayKey() });
            ws().achieved.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            save(true);
            renderWorkspace();
        });
        host.appendChild(form);

        if (!ws().achieved.length) {
            host.appendChild(A.el('p', 'hint', 'Tick off a next step, or log a win here, and it builds a record of progress.'));
            return;
        }

        const list = A.el('div', 'achieved-list');
        ws().achieved.forEach((a) => {
            const item = A.el('div', 'achieved-item item-row');
            item.appendChild(A.el('span', 'achieved-dot'));
            const body = A.el('div', 'achieved-body');
            body.appendChild(A.el('div', 'achieved-text', a.text));
            if (a.date) body.appendChild(A.el('div', 'achieved-date', A.parseDate(a.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })));
            achievedDetail(a, body);
            item.appendChild(body);
            const actions = A.el('div', 'item-actions');
            actions.appendChild(A.iconButton('refresh', 'Move back to next steps', () => {
                A.items.reopenStep(ws(), a.id);
                save(true);
                renderWorkspace();
            }, 'icon-btn sm'));
            actions.appendChild(A.iconButton('trash', 'Delete', () => {
                ws().achieved = ws().achieved.filter((x) => x.id !== a.id);
                save(true);
                renderWorkspace();
            }, 'icon-btn sm danger'));
            item.appendChild(actions);
            list.appendChild(item);
        });
        host.appendChild(list);
    }

    // ------------------------------------------------------- notes/details --

    function renderNotes() {
        const host = A.clear(document.getElementById('notes-body'));
        const ta = A.el('textarea');
        ta.rows = 12;
        ta.value = ws().notes || '';
        ta.placeholder = 'Thinking, design, architecture, decisions…';
        ta.setAttribute('aria-label', 'Notes');
        ta.addEventListener('input', () => { ws().notes = ta.value; save(); });
        host.appendChild(ta);
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

    function renderWorkspace() {
        renderNext();
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
                    { label: 'Achieved', icon: 'check', href: '#sec-achieved', count: ws()?.achieved.length || '' },
                    { label: 'Notes', icon: 'pencil', href: '#sec-notes' },
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
        } catch (e) {
            hint.textContent = `Could not load this project: ${e.message}`;
        }
    }

    load();
})();
