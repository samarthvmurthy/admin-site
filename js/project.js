/**
 * Project page: two halves side by side.
 *   Left  — Repository: live, read-only truth pulled from GitHub.
 *   Right — Workspace: your next steps, what's shipped, and room to think.
 *
 * The workspace autosaves to KV a short beat after you stop typing.
 */
(function () {
    const A = window.Admin;

    const LANES = [
        { key: 'next', label: 'Next steps', hint: 'What you do when you next sit down' },
        { key: 'doing', label: 'In progress', hint: 'Started, not finished' },
        { key: 'live', label: 'Shipped & live', hint: 'Done and out in the world' },
    ];
    const STATUSES = [
        { value: 'idea', label: 'Idea' },
        { value: 'active', label: 'Active' },
        { value: 'paused', label: 'Paused' },
        { value: 'shipped', label: 'Shipped' },
    ];

    const state = {
        id: A.param('id'),
        project: null,   // custom-project record, when this is a manual project
        repoName: null,  // owner/name, when a repo is attached
        detail: null,    // GitHub payload
        ws: null,        // workspace doc
    };

    // ------------------------------------------------------------- persistence

    function setSaveState(text, cls) {
        const node = document.getElementById('save-indicator');
        node.textContent = text;
        node.className = `save-indicator${cls ? ' ' + cls : ''}`;
    }

    async function saveNow() {
        setSaveState('Saving…', 'saving');
        try {
            const saved = await A.api(`/workspace?id=${encodeURIComponent(state.id)}`, {
                method: 'PUT',
                body: state.ws,
            });
            state.ws.updatedAt = saved.updatedAt;
            setSaveState(`Saved ${A.relativeTime(saved.updatedAt)}`, 'ok');
        } catch (e) {
            setSaveState('Not saved', 'error');
            A.toast(`Save failed: ${e.message}`, 'error');
        }
    }

    const queueSave = A.debounce(saveNow, 700);

    function touch(immediate) {
        setSaveState('Unsaved…', 'dirty');
        if (immediate) queueSave.flush();
        else queueSave();
    }

    // Don't lose the last few keystrokes when the tab goes away.
    window.addEventListener('beforeunload', () => queueSave.flush());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') queueSave.flush();
    });

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
        const row = A.el('a', 'repo-list-item');
        row.href = href;
        row.target = '_blank';
        row.rel = 'noopener';
        row.appendChild(A.el('span', 'repo-list-text', text));
        if (trailing) row.appendChild(A.el('span', 'repo-list-meta', trailing));
        return row;
    }

    function collapsible(title, buildBody) {
        const block = A.el('div', 'repo-block');
        const head = A.el('button', 'collapse-head');
        head.type = 'button';
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
                        description: 'Once linked, this side fills with live data from GitHub.',
                        fields: [{ name: 'repo', label: 'Repository', required: true, placeholder: 'owner/name' }],
                        submitLabel: 'Link',
                        onSubmit: async (values) => {
                            await A.api(`/projects?id=${encodeURIComponent(state.id)}`, {
                                method: 'PATCH', body: { repo: values.repo },
                            });
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

        // Headline facts
        host.appendChild(statRow([
            ['Commits shown', commits.length ? `${commits.length}` : null],
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

        host.appendChild(listBlock('Open issues', issues.map((i) =>
            linkRow(i.title, i.html_url, `#${i.number}`)
        ), 'No open issues.'));

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

    // ------------------------------------------------------- workspace side --

    function textarea(value, rows, onInput) {
        const ta = A.el('textarea');
        ta.rows = rows;
        ta.value = value || '';
        ta.addEventListener('input', () => { onInput(ta.value); touch(); });
        return ta;
    }

    function fieldRow(label, inputEl) {
        const row = A.el('div', 'field-row');
        row.appendChild(A.el('div', 'field-label', label));
        const val = A.el('div', 'field-value-plain');
        val.appendChild(inputEl);
        row.appendChild(val);
        return row;
    }

    function renderBoard(host) {
        const board = A.el('div', 'board');

        LANES.forEach((lane) => {
            const col = A.el('div', 'board-col');
            const head = A.el('div', 'board-col-head');
            head.appendChild(A.el('span', 'board-col-title', lane.label));
            const tasks = state.ws.tasks.filter((t) => t.lane === lane.key);
            head.appendChild(A.el('span', 'board-col-count', String(tasks.length)));
            col.appendChild(head);
            col.appendChild(A.el('div', 'board-col-hint', lane.hint));

            const list = A.el('div', 'board-list');
            tasks.forEach((task) => list.appendChild(taskCard(task)));
            col.appendChild(list);

            const input = A.el('input', 'board-add');
            input.type = 'text';
            input.placeholder = '+ add';
            input.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || !input.value.trim()) return;
                state.ws.tasks.push({
                    id: A.uid(), text: input.value.trim(), lane: lane.key, created: new Date().toISOString(),
                });
                input.value = '';
                touch(true);
                renderWorkspace();
                // Keep typing in the same column after a re-render.
                const next = document.querySelector(`.board-col[data-lane="${lane.key}"] .board-add`);
                if (next) next.focus();
            });
            col.appendChild(input);

            col.dataset.lane = lane.key;
            board.appendChild(col);
        });

        host.appendChild(board);
    }

    function taskCard(task) {
        const card = A.el('div', 'task-card');

        const text = A.el('div', 'task-text');
        text.contentEditable = 'true';
        text.textContent = task.text;
        text.addEventListener('blur', () => {
            const next = text.textContent.trim();
            if (next && next !== task.text) { task.text = next; touch(true); }
            else text.textContent = task.text;
        });
        text.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
        });
        card.appendChild(text);

        const actions = A.el('div', 'task-actions');

        // Move between lanes without dragging — faster on a phone, too.
        const laneIndex = LANES.findIndex((l) => l.key === task.lane);
        if (laneIndex > 0) {
            actions.appendChild(A.button('←', 'task-btn', () => {
                task.lane = LANES[laneIndex - 1].key;
                touch(true);
                renderWorkspace();
            }));
        }
        if (laneIndex < LANES.length - 1) {
            actions.appendChild(A.button('→', 'task-btn', () => {
                task.lane = LANES[laneIndex + 1].key;
                touch(true);
                renderWorkspace();
            }));
        }
        actions.appendChild(A.button('✕', 'task-btn task-btn-danger', () => {
            state.ws.tasks = state.ws.tasks.filter((t) => t.id !== task.id);
            touch(true);
            renderWorkspace();
        }));

        card.appendChild(actions);
        return card;
    }

    function renderMilestones(host) {
        const block = A.el('div', 'subsection');
        const head = A.el('div', 'subsection-head');
        const done = state.ws.milestones.filter((m) => m.done).length;
        head.appendChild(A.el('div', 'subfield-label', `Milestones ${state.ws.milestones.length ? `— ${done}/${state.ws.milestones.length} done` : ''}`));
        block.appendChild(head);

        if (state.ws.milestones.length) {
            const track = A.el('div', 'progress-track progress-track-lg');
            const fill = A.el('div', 'progress-fill');
            fill.style.width = `${(done / state.ws.milestones.length) * 100}%`;
            track.appendChild(fill);
            block.appendChild(track);
        }

        const list = A.el('div', 'milestone-list');
        state.ws.milestones.forEach((m) => {
            const row = A.el('div', `milestone-row${m.done ? ' done' : ''}`);

            const box = A.el('input');
            box.type = 'checkbox';
            box.checked = Boolean(m.done);
            box.addEventListener('change', () => {
                m.done = box.checked;
                touch(true);
                renderWorkspace();
            });
            row.appendChild(box);

            const label = A.el('div', 'milestone-label');
            label.contentEditable = 'true';
            label.textContent = m.label;
            label.addEventListener('blur', () => {
                const next = label.textContent.trim();
                if (next && next !== m.label) { m.label = next; touch(true); }
            });
            row.appendChild(label);

            const due = A.el('input', 'milestone-due');
            due.type = 'date';
            due.value = m.due || '';
            due.addEventListener('change', () => { m.due = due.value; touch(true); });
            row.appendChild(due);

            row.appendChild(A.button('✕', 'task-btn task-btn-danger', () => {
                state.ws.milestones = state.ws.milestones.filter((x) => x.id !== m.id);
                touch(true);
                renderWorkspace();
            }));

            list.appendChild(row);
        });
        block.appendChild(list);

        block.appendChild(A.button('+ Add milestone', 'btn-add', () => {
            state.ws.milestones.push({ id: A.uid(), label: 'New milestone', done: false, due: '' });
            touch(true);
            renderWorkspace();
        }));

        host.appendChild(block);
    }

    function renderLinks(host) {
        const block = A.el('div', 'subsection');
        block.appendChild(A.el('div', 'subfield-label', 'Links'));

        const list = A.el('div', 'repeater-inline');
        state.ws.links.forEach((link, i) => {
            const row = A.el('div', 'repeater-item-row');

            const label = A.el('input', 'input-narrow');
            label.type = 'text';
            label.placeholder = 'Label';
            label.value = link.label || '';
            label.addEventListener('input', () => { link.label = label.value; touch(); });
            row.appendChild(label);

            const url = A.el('input');
            url.type = 'url';
            url.placeholder = 'https://…';
            url.value = link.url || '';
            url.addEventListener('input', () => { link.url = url.value; touch(); });
            row.appendChild(url);

            if (link.url) {
                const open = A.el('a', 'task-btn', '↗');
                open.href = link.url;
                open.target = '_blank';
                open.rel = 'noopener';
                row.appendChild(open);
            }

            row.appendChild(A.button('✕', 'task-btn task-btn-danger', () => {
                state.ws.links.splice(i, 1);
                touch(true);
                renderWorkspace();
            }));

            list.appendChild(row);
        });
        block.appendChild(list);

        block.appendChild(A.button('+ Add link', 'btn-add', () => {
            state.ws.links.push({ label: '', url: '' });
            touch();
            renderWorkspace();
        }));

        host.appendChild(block);
    }

    function renderWorkspace() {
        const host = A.clear(document.getElementById('workspace-body'));

        // Status + the one-liner that explains the project to future you.
        const statusSelect = A.el('select', 'select-plain');
        STATUSES.forEach((s) => {
            const o = A.el('option', null, s.label);
            o.value = s.value;
            if (s.value === state.ws.status) o.selected = true;
            statusSelect.appendChild(o);
        });
        statusSelect.addEventListener('change', () => {
            state.ws.status = statusSelect.value;
            touch(true);
        });
        host.appendChild(fieldRow('Status', statusSelect));

        host.appendChild(fieldRow('Summary', textarea(state.ws.summary, 2, (v) => { state.ws.summary = v; })));

        const liveInput = A.el('input');
        liveInput.type = 'url';
        liveInput.placeholder = 'https://…';
        liveInput.value = state.ws.liveUrl || '';
        liveInput.addEventListener('input', () => { state.ws.liveUrl = liveInput.value; touch(); });
        host.appendChild(fieldRow('Live URL', liveInput));

        const boardBlock = A.el('div', 'subsection');
        boardBlock.appendChild(A.el('div', 'subfield-label', 'Board'));
        renderBoard(boardBlock);
        host.appendChild(boardBlock);

        renderMilestones(host);

        // Thinking and design: deliberately big, unstructured boxes.
        const thinking = A.el('div', 'subsection');
        thinking.appendChild(A.el('div', 'subfield-label', 'Thinking'));
        thinking.appendChild(A.el('p', 'hint', 'Open questions, trade-offs, things you decided and why.'));
        thinking.appendChild(textarea(state.ws.thinking, 10, (v) => { state.ws.thinking = v; }));
        host.appendChild(thinking);

        const design = A.el('div', 'subsection');
        design.appendChild(A.el('div', 'subfield-label', 'Design'));
        design.appendChild(A.el('p', 'hint', 'Architecture, data shapes, UI notes, sketches in words.'));
        design.appendChild(textarea(state.ws.design, 10, (v) => { state.ws.design = v; }));
        host.appendChild(design);

        renderLinks(host);
    }

    // ---------------------------------------------------------------- chrome --

    function renderHeader() {
        const name = state.project?.name || state.detail?.repo?.name || state.repoName || 'Project';
        document.getElementById('project-title').textContent = name;
        document.title = `${name} — Admin`;

        const parts = [];
        if (state.repoName) parts.push(state.repoName);
        if (state.project && !state.repoName) parts.push(state.project.kind === 'program' ? 'Program' : 'Manual project');
        const desc = state.project?.description || state.detail?.repo?.description;
        if (desc) parts.push(desc);
        document.getElementById('project-subtitle').textContent = parts.join(' · ') || '—';

        const actions = A.clear(document.getElementById('project-actions'));
        if (state.detail?.repo?.html_url) {
            const gh = A.el('a', 'btn btn-edit btn-small', 'GitHub ↗');
            gh.href = state.detail.repo.html_url;
            gh.target = '_blank';
            gh.rel = 'noopener';
            actions.appendChild(gh);
        }
        const live = state.ws?.liveUrl || state.detail?.repo?.homepage;
        if (live) {
            const btn = A.el('a', 'btn btn-edit btn-small', 'Live ↗');
            btn.href = live;
            btn.target = '_blank';
            btn.rel = 'noopener';
            actions.appendChild(btn);
        }
        if (state.project) {
            actions.appendChild(A.button('Delete', 'btn btn-danger btn-small', () => {
                A.modal.open({
                    title: `Delete "${state.project.name}"?`,
                    description: 'This removes the project and its workspace — next steps, milestones, thinking and design notes. It cannot be undone.',
                    fields: [],
                    submitLabel: 'Delete project',
                    onSubmit: async () => {
                        await A.api(`/projects?id=${encodeURIComponent(state.id)}`, { method: 'DELETE' });
                        window.location.href = '../index.html';
                    },
                });
            }));
        }
    }

    async function load() {
        const hint = document.getElementById('load-hint');
        if (!state.id) {
            hint.textContent = 'No project id in the URL.';
            return;
        }

        try {
            if (state.id.startsWith('gh:')) {
                state.repoName = state.id.slice(3);
            } else {
                const customList = await A.api('/projects');
                state.project = customList.find((p) => p.id === state.id) || null;
                if (!state.project) {
                    hint.textContent = 'That project no longer exists.';
                    return;
                }
                state.repoName = state.project.repo || null;
            }

            const [ws, detail] = await Promise.all([
                A.api(`/workspace?id=${encodeURIComponent(state.id)}`),
                state.repoName
                    ? A.api(`/repo?repo=${encodeURIComponent(state.repoName)}`).catch(() => null)
                    : Promise.resolve(null),
            ]);

            state.ws = ws;
            state.detail = detail;

            hint.style.display = 'none';
            document.getElementById('app').style.display = '';

            renderHeader();
            renderRepoSide();
            renderWorkspace();
            setSaveState(ws.updatedAt ? `Saved ${A.relativeTime(ws.updatedAt)}` : 'Nothing saved yet');
        } catch (e) {
            hint.textContent = `Could not load this project: ${e.message}`;
        }
    }

    load();
})();
