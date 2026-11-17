/**
 * Jobs: operate career-ops (running on the Dell) from buttons.
 *
 * Everything shown here is a mirror the Dell runner syncs up; every change is
 * queued as a run that the runner applies through career-ops' own scripts.
 * Views live in the URL hash: #pipeline, #inbox, #activity, #insights, #job=<row id>.
 */
(function () {
    const A = window.Admin;

    const OPEN_STATES = ['Evaluated', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer'];
    const CLOSED_STATES = ['Hired', 'Rejected', 'Discarded', 'SKIP'];
    const ALL_STATES = [...OPEN_STATES, ...CLOSED_STATES];
    const ACTIVE_STATES = ['Applied', 'Responded', 'Assessment', 'Interview', 'Offer'];
    const VIEWS = [
        { key: 'pipeline', label: 'Pipeline', icon: 'layers' },
        { key: 'inbox', label: 'Inbox', icon: 'inbox' },
        { key: 'activity', label: 'Activity', icon: 'clock' },
        { key: 'insights', label: 'Insights', icon: 'target' },
    ];
    const FAST_POLL_MS = 3000;
    const SLOW_POLL_MS = 30000;

    const state = {
        data: null,
        loadError: null,
        search: '',
        minScore: 0,
        showClosed: false,
        // row id -> { state, runId }: status changes waiting for the runner.
        pendingStatus: {},
        openRuns: new Set(),
        runDetails: {},
        report: { file: null, body: null, error: null },
    };

    // ----------------------------------------------------------- helpers --

    function route() {
        const h = A.hashParams();
        if (h.get('job')) return { view: 'job', id: Number(h.get('job')) };
        const key = window.location.hash.replace(/^#/, '');
        return { view: VIEWS.some((v) => v.key === key) ? key : 'pipeline' };
    }

    function go(hash) {
        if (window.location.hash === `#${hash}`) render();
        else window.location.hash = hash;
    }

    const tracker = () => state.data?.tracker || [];
    const meta = () => state.data?.meta || {};
    const runs = () => state.data?.runs || [];
    const activeRuns = () => runs().filter((r) => r.status === 'queued' || r.status === 'running');

    function rowStatus(row) {
        return state.pendingStatus[row.id]?.state || row.status;
    }

    function scoreTone(v) {
        if (v == null) return 'none';
        if (v >= 4) return 'high';
        if (v >= 3) return 'mid';
        return 'low';
    }

    function scoreBadge(row) {
        const b = A.el('span', `job-score score-${scoreTone(row.scoreValue)}`, row.scoreValue != null ? row.scoreValue.toFixed(1) : '—');
        b.title = row.score ? `Fit score ${row.score}` : 'Not scored';
        return b;
    }

    function followupFor(row) {
        const entries = meta().followups?.entries || [];
        return entries.find((e) => Number(e.num) === Number(row.id)) || null;
    }

    // PDFs for a row: pdf-index.tsv entries for its report, plus the report's
    // own "**PDF:**" line (batch evaluations don't always reach the index).
    function pdfsFor(row) {
        if (!row.reportNum) return [];
        const synced = new Set((meta().pdfFiles || []).filter((p) => p.synced).map((p) => p.name));
        const names = (meta().pdfIndex || [])
            .filter((p) => p.report === row.reportNum && p.pdf)
            .map((p) => p.pdf);
        const fromReport = reportField(row, 'PDF', /\S+\.pdf/);
        if (fromReport) names.push(fromReport.split('/').pop());
        return [...new Set(names)].filter((n) => synced.has(n));
    }

    function pdfHref(name, download) {
        return `${A.API_BASE}/jobs/pdf?name=${encodeURIComponent(name)}${download ? '&download=1' : ''}`;
    }

    function hostOf(url) {
        try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
    }

    function describeRun(run) {
        const label = state.data?.actions?.[run.action]?.label || run.action;
        const p = run.params || {};
        if (run.action === 'set-status') {
            const row = tracker().find((r) => r.id === p.row);
            return `${row ? row.company : `Row ${p.row}`} → ${p.state}`;
        }
        if (run.action === 'scan' && p.company) return `${label}: ${p.company}`;
        if (run.action === 'check-liveness') return p.tracker ? 'Check tracked postings are still open' : `Check posting: ${hostOf(p.url)}`;
        if (run.action === 'merge-tracker' && p.dryRun) return `${label} (preview)`;
        return label;
    }

    // --------------------------------------------------------------- data --

    async function load() {
        try {
            state.data = await A.api('/jobs');
            state.loadError = null;
            settlePendingStatus();
        } catch (e) {
            state.loadError = e.message;
        }
        render();
        schedulePoll();
    }

    // Drop optimistic status changes once their run has finished.
    function settlePendingStatus() {
        const byId = Object.fromEntries(runs().map((r) => [r.id, r]));
        for (const [rowId, p] of Object.entries(state.pendingStatus)) {
            const run = byId[p.runId];
            if (!run || run.status === 'queued' || run.status === 'running') continue;
            if (run.status !== 'done') A.toast(`Couldn't change the status: ${run.error || run.status}`, 'error');
            delete state.pendingStatus[rowId];
        }
    }

    let pollTimer = null;
    function schedulePoll() {
        clearTimeout(pollTimer);
        const busy = activeRuns().length > 0 || state.openRuns.size > 0;
        pollTimer = setTimeout(async () => {
            if (document.hidden) { schedulePoll(); return; }
            await load();
            await refreshOpenRuns();
        }, busy ? FAST_POLL_MS : SLOW_POLL_MS);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

    async function queue(action, params = {}, { quiet = false } = {}) {
        try {
            const { run, duplicate } = await A.api('/jobs/run', { method: 'POST', body: { action, params } });
            if (!quiet) {
                const where = state.data?.runner?.online ? '' : ' It will run when the Dell is back online.';
                A.toast(duplicate ? `Already queued: ${describeRun(run)}` : `Queued: ${describeRun(run)}.${where}`);
            }
            await load();
            return run;
        } catch (e) {
            A.toast(e.message, 'error');
            return null;
        }
    }

    async function changeStatus(row, newState, note) {
        if (rowStatus(row) === newState && !note) return;
        const run = await queue('set-status', { row: row.id, state: newState, ...(note ? { note } : {}) }, { quiet: true });
        if (!run) return;
        state.pendingStatus[row.id] = { state: newState, runId: run.id };
        A.toast(`${row.company} → ${newState}. Saving on the Dell…`);
        render();
    }

    function askStatus(row, newState) {
        A.modal.open({
            title: `Move to ${newState}`,
            description: `${row.company} — ${row.role}`,
            fields: [
                { name: 'state', label: 'Status', type: 'select', options: ALL_STATES, value: newState },
                { name: 'note', label: 'Note (optional)', placeholder: 'e.g. applied via referral from …' },
            ],
            submitLabel: 'Save',
            onSubmit: async (v) => { await changeStatus(row, v.state, v.note); },
        });
        // modal.js has no "value" for selects; set it after it opens.
        const select = document.querySelector('#modal-backdrop select[name="state"]');
        if (select) select.value = newState;
    }

    async function refreshOpenRuns() {
        for (const id of state.openRuns) {
            const summary = runs().find((r) => r.id === id);
            const cached = state.runDetails[id];
            if (cached && summary && cached.status === summary.status && !['queued', 'running'].includes(summary.status)) continue;
            try {
                state.runDetails[id] = (await A.api(`/jobs/run?id=${encodeURIComponent(id)}`)).run;
            } catch { /* keep the old copy */ }
        }
        if (route().view === 'activity') render();
    }

    // ------------------------------------------------------------ chrome --

    function renderStatus() {
        const host = document.getElementById('runner-status');
        A.clear(host);
        const r = state.data?.runner;
        if (state.loadError) {
            host.appendChild(A.el('span', 'runner-dot off'));
            host.appendChild(document.createTextNode(state.loadError));
            return;
        }
        if (!r) return;
        const dot = A.el('span', `runner-dot ${r.online ? 'on' : 'off'}`);
        host.appendChild(dot);
        let text;
        if (!r.lastSeen) text = 'The Dell runner hasn’t connected yet.';
        else if (r.online) text = `Dell online · checked in ${A.relativeTime(r.lastSeen)}`;
        else text = `Dell offline · last seen ${A.relativeTime(r.lastSeen)}. Queued work runs when it’s back.`;
        const busy = activeRuns();
        if (busy.length) text += ` · ${busy.length} job${busy.length === 1 ? '' : 's'} in progress`;
        host.appendChild(document.createTextNode(text));
    }

    function renderActions() {
        const host = A.clear(document.getElementById('topbar-actions'));
        const refresh = A.button('', 'btn btn-ghost btn-small', () => queue('sync'));
        refresh.appendChild(A.icon('refresh', 14));
        refresh.appendChild(A.el('span', 'btn-label', ' Refresh'));
        refresh.title = 'Re-read everything from career-ops on the Dell';
        host.appendChild(refresh);
        const scan = A.button('', 'btn btn-add-primary btn-small', () => queue('scan'));
        scan.appendChild(A.icon('refresh', 14));
        scan.appendChild(A.el('span', 'btn-label', ' Scan portals'));
        scan.title = 'Search every company in portals.yml for new postings';
        host.appendChild(scan);
    }

    function renderNav() {
        const rows = tracker();
        const active = rows.filter((r) => ACTIVE_STATES.includes(rowStatus(r))).length;
        const toReview = rows.filter((r) => rowStatus(r) === 'Evaluated').length;
        const followups = meta().followups?.metadata;
        const due = (followups?.overdue || 0) + (followups?.urgent || 0);
        const counts = {
            pipeline: { count: toReview || '', title: `${toReview} to review, ${active} active` },
            inbox: { count: state.data?.pipeline?.pending?.length || '' },
            activity: { count: activeRuns().length || '', countTone: activeRuns().length ? 'accent' : '' },
            insights: { count: due || '', countTone: due ? 'danger' : '' },
        };
        const current = route().view;
        window.Nav.setSections([{
            label: 'Jobs',
            items: VIEWS.map((v) => ({
                label: v.label,
                icon: v.icon,
                active: current === v.key || (current === 'job' && v.key === 'pipeline'),
                ...counts[v.key],
                onClick: () => go(v.key),
            })),
        }]);
    }

    function renderBanners() {
        const host = A.clear(document.getElementById('jobs-banners'));
        const m = meta();
        if (m.trackerError) {
            host.appendChild(banner('alert', 'danger',
                `career-ops couldn’t read the tracker on the Dell, so this page shows the last good copy. ${m.trackerError}`,
                'Run health check', () => queue('verify')));
        }
        if (m.pendingAdditions > 0) {
            const n = m.pendingAdditions;
            host.appendChild(banner('inbox', 'accent',
                `${n} finished evaluation${n === 1 ? ' isn’t' : 's aren’t'} in your tracker yet.`,
                'Add to tracker', () => queue('merge-tracker')));
        }
    }

    function banner(iconName, tone, text, actionLabel, onAction) {
        const b = A.el('div', `jobs-banner tone-${tone}`);
        b.appendChild(A.icon(iconName, 16));
        b.appendChild(A.el('span', 'jobs-banner-text', text));
        if (actionLabel) b.appendChild(A.button(actionLabel, 'btn btn-ghost btn-small', onAction));
        return b;
    }

    // ---------------------------------------------------------- pipeline --

    function filteredRows() {
        const q = state.search.trim().toLowerCase();
        return tracker().filter((r) => {
            if (state.minScore && !(r.scoreValue >= state.minScore)) return false;
            if (!q) return true;
            return `${r.company} ${r.role} ${r.notes || ''}`.toLowerCase().includes(q);
        });
    }

    function toolbar(placeholder, extra) {
        const bar = A.el('div', 'toolbar');
        const search = A.el('input', 'toolbar-search');
        search.type = 'search';
        search.placeholder = placeholder;
        search.value = state.search;
        search.setAttribute('aria-label', placeholder);
        search.addEventListener('input', () => {
            state.search = search.value;
            const pos = search.selectionStart;
            render();
            const again = document.querySelector('#jobs-view .toolbar-search');
            if (again) { again.focus(); again.setSelectionRange(pos, pos); }
        });
        bar.appendChild(search);
        if (extra) bar.appendChild(extra);
        return bar;
    }

    function renderPipeline(host) {
        const chips = A.el('div', 'filter-chips');
        [[0, 'Any score'], [3.5, '3.5+'], [4, '4.0+']].forEach(([v, label]) => {
            chips.appendChild(A.button(label, `filter-chip${state.minScore === v ? ' on' : ''}`, () => { state.minScore = v; render(); }));
        });
        chips.appendChild(A.button('Show closed', `filter-chip${state.showClosed ? ' on' : ''}`, () => { state.showClosed = !state.showClosed; render(); }));
        host.appendChild(toolbar('Search company, role or notes…', chips));

        const rows = filteredRows();
        if (!tracker().length) {
            host.appendChild(emptyState('No applications yet',
                state.data?.runner?.lastSeen
                    ? 'Your career-ops tracker is empty. Scan portals to find postings, then evaluate them.'
                    : 'Once the runner on the Dell connects, your career-ops tracker appears here.'));
            return;
        }

        const columns = state.showClosed ? ALL_STATES : OPEN_STATES;
        const board = A.el('div', 'job-board');
        board.style.setProperty('--cols', columns.length);
        columns.forEach((st) => {
            const inCol = rows.filter((r) => rowStatus(r) === st)
                .sort((a, b) => (b.scoreValue ?? -1) - (a.scoreValue ?? -1) || String(b.date).localeCompare(String(a.date)));
            const col = A.el('section', 'board-col job-col');
            col.dataset.state = st;
            const head = A.el('div', 'board-head');
            head.appendChild(A.el('span', `board-dot job-dot-${st.toLowerCase()}`));
            head.appendChild(A.el('span', null, st));
            head.appendChild(A.el('span', 'count', String(inCol.length)));
            col.appendChild(head);
            const list = A.el('div', 'board-list');
            if (!inCol.length) list.appendChild(A.el('div', 'board-empty', 'Nothing here'));
            inCol.forEach((r) => list.appendChild(jobCard(r)));
            col.appendChild(list);
            wireDrop(col, st);
            board.appendChild(col);
        });
        host.appendChild(board);
    }

    function jobCard(row) {
        const card = A.el('a', 'job-card');
        card.href = `#job=${row.id}`;
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/job-row', String(row.id));
            e.dataTransfer.effectAllowed = 'move';
            card.classList.add('dragging');
        });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));

        const top = A.el('div', 'job-card-top');
        top.appendChild(A.el('span', 'job-company', row.company));
        top.appendChild(scoreBadge(row));
        card.appendChild(top);
        card.appendChild(A.el('div', 'job-role', row.role));

        const metaRow = A.el('div', 'job-card-meta');
        if (row.date) metaRow.appendChild(A.el('span', null, A.shortDate(row.date)));
        if (pdfsFor(row).length) {
            const p = A.el('span', 'job-tag', 'CV');
            p.title = 'Tailored CV PDF ready';
            metaRow.appendChild(p);
        }
        const fu = followupFor(row);
        if (fu && ['overdue', 'urgent'].includes(fu.urgency)) {
            metaRow.appendChild(A.el('span', 'job-tag tag-danger', 'Follow up'));
        } else if (fu?.nextFollowupDate && fu.urgency === 'waiting') {
            const t = A.el('span', 'job-tag', `Follow up ${A.shortDate(fu.nextFollowupDate).replace(/, \d{4}$/, '')}`);
            metaRow.appendChild(t);
        }
        if (state.pendingStatus[row.id]) metaRow.appendChild(A.el('span', 'job-tag tag-accent', 'Saving…'));
        card.appendChild(metaRow);
        return card;
    }

    function wireDrop(col, st) {
        col.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('text/job-row')) return;
            e.preventDefault();
            col.classList.add('drop');
        });
        col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
        col.addEventListener('drop', (e) => {
            e.preventDefault();
            col.classList.remove('drop');
            const id = Number(e.dataTransfer.getData('text/job-row'));
            const row = tracker().find((r) => r.id === id);
            if (row && rowStatus(row) !== st) changeStatus(row, st);
        });
    }

    function emptyState(title, text) {
        const box = A.el('div', 'empty-state');
        box.appendChild(A.el('strong', null, title));
        box.appendChild(document.createTextNode(text));
        return box;
    }

    // --------------------------------------------------------------- job --

    function renderJob(host, id) {
        const row = tracker().find((r) => r.id === id);
        const back = A.button('← Pipeline', 'btn btn-ghost btn-small job-back', () => go('pipeline'));
        host.appendChild(back);
        if (!row) {
            host.appendChild(emptyState('Not found', 'This application isn’t in the tracker (it may have been removed on the Dell).'));
            return;
        }

        const head = A.el('section', 'panel job-head');
        const titleRow = A.el('div', 'job-head-top');
        const titles = A.el('div', 'job-head-titles');
        titles.appendChild(A.el('h2', null, row.company));
        titles.appendChild(A.el('p', 'job-head-role', row.role));
        titleRow.appendChild(titles);
        titleRow.appendChild(scoreBadge(row));
        head.appendChild(titleRow);

        const facts = A.el('div', 'job-facts');
        const select = A.el('select', 'toolbar-select job-status-select');
        select.setAttribute('aria-label', 'Status');
        ALL_STATES.forEach((s) => {
            const o = A.el('option', null, s);
            o.value = s;
            select.appendChild(o);
        });
        select.value = rowStatus(row);
        select.addEventListener('change', () => { const v = select.value; select.value = rowStatus(row); askStatus(row, v); });
        facts.appendChild(select);
        if (state.pendingStatus[row.id]) facts.appendChild(A.el('span', 'job-tag tag-accent', 'Saving on the Dell…'));
        if (row.date) facts.appendChild(A.el('span', 'job-fact', `Evaluated ${A.shortDate(row.date)}`));
        const fu = followupFor(row);
        if (fu?.nextFollowupDate) facts.appendChild(A.el('span', `job-fact${['overdue', 'urgent'].includes(fu.urgency) ? ' tone-danger' : ''}`, `Follow up ${A.shortDate(fu.nextFollowupDate)}`));
        head.appendChild(facts);

        if (row.notes) head.appendChild(A.el('p', 'job-notes', row.notes));

        const actions = A.el('div', 'job-actions');
        const postingUrl = row.url || reportField(row, 'URL');
        if (postingUrl) {
            const open = A.externalLink('', postingUrl, 'btn btn-ghost btn-small');
            open.appendChild(A.icon('external', 14));
            open.appendChild(document.createTextNode(' Open posting'));
            actions.appendChild(open);
            actions.appendChild(A.button('Check if still open', 'btn btn-ghost btn-small', () => queue('check-liveness', { url: postingUrl })));
        }
        pdfsFor(row).forEach((name) => {
            const a = A.externalLink('', pdfHref(name), 'btn btn-ghost btn-small');
            a.appendChild(A.icon('download', 14));
            a.appendChild(document.createTextNode(name.includes('cover') ? ' Cover letter' : ' Tailored CV'));
            a.title = name;
            actions.appendChild(a);
        });
        if (actions.childNodes.length) head.appendChild(actions);
        host.appendChild(head);

        const reportPanel = A.el('section', 'panel job-report');
        if (!row.reportFile) {
            reportPanel.appendChild(A.el('p', 'hint', 'No evaluation report for this application.'));
        } else if (state.report.file !== row.reportFile) {
            reportPanel.appendChild(A.el('p', 'hint', 'Loading the evaluation report…'));
            loadReport(row.reportFile);
        } else if (state.report.error) {
            reportPanel.appendChild(A.el('p', 'hint', state.report.error));
        } else {
            reportPanel.appendChild(renderMarkdown(state.report.body));
        }
        host.appendChild(reportPanel);
    }

    // Reads a "**Field:** value" line from the loaded report (URL, PDF).
    function reportField(row, field, pattern = /https?:\/\/[^\s)>\]]+/) {
        if (!row.reportFile || state.report.file !== row.reportFile || !state.report.body) return null;
        const line = new RegExp(`^\\*\\*${field}:\\*\\*(.*)$`, 'mi').exec(state.report.body);
        const m = line && pattern.exec(line[1]);
        return m ? m[0] : null;
    }

    async function loadReport(file) {
        state.report = { file, body: null, error: null };
        try {
            const res = await A.api(`/jobs/report?file=${encodeURIComponent(file)}`);
            if (state.report.file === file) state.report.body = res.body;
        } catch (e) {
            if (state.report.file === file) state.report.error = e.message;
        }
        render();
    }

    let purifyHooked = false;
    function renderMarkdown(md) {
        const box = A.el('div', 'md-body');
        if (!window.marked || !window.DOMPurify) {
            box.appendChild(A.el('pre', 'md-fallback', md));
            return box;
        }
        if (!purifyHooked) {
            window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
                if (node.tagName === 'A') {
                    node.setAttribute('target', '_blank');
                    node.setAttribute('rel', 'noopener noreferrer');
                }
            });
            purifyHooked = true;
        }
        box.innerHTML = window.DOMPurify.sanitize(window.marked.parse(md, { gfm: true, breaks: true }), { FORBID_TAGS: ['style', 'img'] });
        return box;
    }

    // ------------------------------------------------------------- inbox --

    function renderInbox(host) {
        const pending = state.data?.pipeline?.pending || [];
        host.appendChild(toolbar('Search the inbox…'));
        const intro = A.el('p', 'hint',
            `${pending.length} posting${pending.length === 1 ? '' : 's'} found by your scans, waiting to be evaluated. ` +
            'Evaluating them from here arrives in the next phase.');
        host.appendChild(intro);
        const q = state.search.trim().toLowerCase();
        const items = pending.filter((p) => !q || `${p.company} ${p.role} ${p.location || ''}`.toLowerCase().includes(q));
        if (!items.length) {
            host.appendChild(emptyState(pending.length ? 'No matches' : 'Inbox is empty', pending.length ? 'Try another search.' : 'Scan portals to find new postings.'));
            return;
        }
        const list = A.el('div', 'panel inbox-list');
        items.forEach((p) => {
            const item = A.el('div', 'inbox-item');
            const main = A.el('div', 'inbox-main');
            const title = A.el('div', 'inbox-title');
            title.appendChild(A.el('span', 'job-company', p.company || hostOf(p.url)));
            title.appendChild(A.el('span', 'inbox-role', p.role));
            main.appendChild(title);
            const bits = [p.location, p.salary, p.posted ? `posted ${A.relativeTime(p.posted)}` : null].filter(Boolean);
            if (bits.length) main.appendChild(A.el('div', 'inbox-meta', bits.join(' · ')));
            item.appendChild(main);
            const acts = A.el('div', 'inbox-actions');
            if (/^https?:\/\//.test(p.url)) {
                acts.appendChild(A.button('Still open?', 'btn btn-ghost btn-small', () => queue('check-liveness', { url: p.url })));
                const open = A.externalLink('', p.url, 'icon-btn');
                open.title = 'Open posting';
                open.setAttribute('aria-label', 'Open posting');
                open.innerHTML = window.Nav.svg('external', 15);
                acts.appendChild(open);
            }
            item.appendChild(acts);
            list.appendChild(item);
        });
        host.appendChild(list);
    }

    // ---------------------------------------------------------- activity --

    function renderActivity(host) {
        const all = runs();
        if (!all.length) {
            host.appendChild(emptyState('Nothing has run yet', 'Buttons on this page queue work for the Dell; each run shows up here with its output.'));
            return;
        }
        const list = A.el('div', 'panel run-list');
        all.forEach((run) => {
            const item = A.el('div', `run-item status-${run.status}`);
            const head = A.el('button', 'run-head');
            head.type = 'button';
            head.setAttribute('aria-expanded', String(state.openRuns.has(run.id)));
            head.appendChild(A.el('span', `run-pill pill-${run.status}`, run.status));
            head.appendChild(A.el('span', 'run-title', describeRun(run)));
            const when = run.finishedAt
                ? `${A.relativeTime(run.finishedAt)} · ${duration(run.startedAt, run.finishedAt)}`
                : run.startedAt ? `started ${A.relativeTime(run.startedAt)}` : `queued ${A.relativeTime(run.createdAt)}`;
            head.appendChild(A.el('span', 'run-when', `${run.source === 'cron' ? 'scheduled · ' : ''}${when}`));
            head.addEventListener('click', () => toggleRun(run.id));
            item.appendChild(head);

            if (state.openRuns.has(run.id)) {
                const body = A.el('div', 'run-body');
                const d = state.runDetails[run.id];
                if (run.error) body.appendChild(A.el('p', 'run-error', run.error));
                if (['queued', 'running'].includes(run.status)) {
                    body.appendChild(A.button(run.status === 'queued' ? 'Cancel' : 'Stop', 'btn btn-danger btn-small', () => cancelRun(run)));
                }
                body.appendChild(A.el('pre', 'run-log', d ? (d.log || '(no output yet)') : 'Loading…'));
                item.appendChild(body);
            }
            list.appendChild(item);
        });
        host.appendChild(list);
    }

    function duration(a, b) {
        if (!a || !b) return '';
        const s = Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000));
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
    }

    async function toggleRun(id) {
        if (state.openRuns.has(id)) state.openRuns.delete(id);
        else state.openRuns.add(id);
        render();
        if (state.openRuns.has(id)) { await refreshOpenRuns(); schedulePoll(); }
    }

    async function cancelRun(run) {
        try {
            await A.api(`/jobs/cancel?id=${encodeURIComponent(run.id)}`, { method: 'POST' });
            A.toast(run.status === 'queued' ? 'Cancelled.' : 'Asked the Dell to stop it.');
        } catch (e) {
            A.toast(e.message, 'error');
        }
        load();
    }

    // ---------------------------------------------------------- insights --

    function renderInsights(host) {
        const stats = meta().stats;
        const fu = meta().followups;
        const grid = A.el('div', 'insight-grid');

        // Status breakdown
        const byStatus = A.el('section', 'panel');
        byStatus.appendChild(A.el('h2', null, 'Applications'));
        const counts = {};
        tracker().forEach((r) => { counts[rowStatus(r)] = (counts[rowStatus(r)] || 0) + 1; });
        const max = Math.max(1, ...Object.values(counts));
        const bars = A.el('div', 'status-bars');
        ALL_STATES.filter((s) => counts[s]).forEach((s) => {
            const line = A.el('div', 'status-bar');
            line.appendChild(A.el('span', 'status-bar-label', s));
            const track = A.el('span', 'status-bar-track');
            const fill = A.el('span', `status-bar-fill job-dot-${s.toLowerCase()}`);
            fill.style.width = `${(counts[s] / max) * 100}%`;
            track.appendChild(fill);
            line.appendChild(track);
            line.appendChild(A.el('span', 'status-bar-n', String(counts[s])));
            bars.appendChild(line);
        });
        byStatus.appendChild(bars.childNodes.length ? bars : A.el('p', 'hint', 'No applications yet.'));
        grid.appendChild(byStatus);

        // Funnel numbers
        const funnel = A.el('section', 'panel');
        funnel.appendChild(A.el('h2', null, 'Funnel'));
        if (stats && !stats.error) {
            const f = stats.funnel || {};
            const t = stats.tracker || {};
            const tiles = A.el('div', 'stat-tiles');
            [
                ['Applied', f.everApplied ?? 0],
                ['Response rate', pct(f.responseRate)],
                ['Interview rate', pct(f.interviewRate)],
                ['Avg fit score', t.avgScore != null ? t.avgScore.toFixed(1) : '—'],
                ['Companies watched', stats.portals?.configuredCompanies ?? '—'],
                ['Postings seen', stats.scan?.totalRecorded ?? '—'],
            ].forEach(([label, value]) => {
                const tile = A.el('div', 'stat-tile');
                tile.appendChild(A.el('div', 'stat-value', String(value)));
                tile.appendChild(A.el('div', 'stat-label', label));
                tiles.appendChild(tile);
            });
            funnel.appendChild(tiles);
            if (f.smallSample) funnel.appendChild(A.el('p', 'hint', 'Too few applications yet for the rates to mean much.'));
        } else {
            funnel.appendChild(A.el('p', 'hint', stats?.error ? `Stats unavailable: ${stats.error}` : 'Stats appear after the Dell’s first sync.'));
        }
        grid.appendChild(funnel);
        host.appendChild(grid);

        // Follow-ups
        const fuPanel = A.el('section', 'panel');
        const fuHead = A.el('div', 'panel-head');
        fuHead.appendChild(A.el('h2', null, 'Follow-ups'));
        fuPanel.appendChild(fuHead);
        const entries = (fu?.entries || []).filter((e) => e.nextFollowupDate || ['overdue', 'urgent'].includes(e.urgency))
            .sort((a, b) => String(a.nextFollowupDate).localeCompare(String(b.nextFollowupDate)));
        if (!entries.length) {
            fuPanel.appendChild(A.el('p', 'hint', 'Nothing to chase. Follow-ups appear once you’ve applied somewhere.'));
        } else {
            const list = A.el('div', 'fu-list');
            entries.forEach((e) => {
                const item = A.el('a', 'fu-item');
                item.href = `#job=${e.num}`;
                item.appendChild(A.el('span', `run-pill pill-${['overdue', 'urgent'].includes(e.urgency) ? 'failed' : 'queued'}`, e.urgency));
                item.appendChild(A.el('span', 'fu-title', `${e.company} — ${e.role}`));
                item.appendChild(A.el('span', 'run-when', e.nextFollowupDate ? A.shortDate(e.nextFollowupDate) : ''));
                list.appendChild(item);
            });
            fuPanel.appendChild(list);
        }
        host.appendChild(fuPanel);

        // Maintenance
        const tools = A.el('section', 'panel');
        tools.appendChild(A.el('h2', null, 'Maintenance'));
        tools.appendChild(A.el('p', 'hint', 'Housekeeping career-ops can do on the Dell. None of these use your Claude allowance.'));
        const row = A.el('div', 'job-actions');
        row.appendChild(A.button('Check tracked postings are still open', 'btn btn-ghost btn-small', () => queue('check-liveness', { tracker: true })));
        row.appendChild(A.button('Health check', 'btn btn-ghost btn-small', () => queue('verify')));
        row.appendChild(A.button('Preview tracker merge', 'btn btn-ghost btn-small', () => queue('merge-tracker', { dryRun: true })));
        tools.appendChild(row);
        const m = meta();
        if (m.careerOpsVersion) tools.appendChild(A.el('p', 'hint', `career-ops ${m.careerOpsVersion} · runner ${m.runnerVersion || '?'}${state.data?.syncedAt ? ` · data changed ${A.relativeTime(state.data.syncedAt)}` : ''}`));
        host.appendChild(tools);
    }

    // stats.mjs already reports rates as percentages.
    function pct(v) {
        return typeof v === 'number' ? `${Math.round(v)}%` : '—';
    }

    // ------------------------------------------------------------ render --

    function render() {
        renderStatus();
        renderActions();
        renderNav();
        renderBanners();
        const host = A.clear(document.getElementById('jobs-view'));
        if (!state.data) {
            host.appendChild(A.el('p', 'hint', state.loadError ? `Couldn’t load jobs: ${state.loadError}` : 'Loading…'));
            return;
        }
        const r = route();
        if (r.view === 'job') renderJob(host, r.id);
        else if (r.view === 'inbox') renderInbox(host);
        else if (r.view === 'activity') renderActivity(host);
        else if (r.view === 'insights') renderInsights(host);
        else renderPipeline(host);
    }

    window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
    load();
})();
