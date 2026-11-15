/**
 * Project next steps: the shared model and editor, attached as Admin.steps.
 * Used by the project page and by the cross-project board and weekly view on
 * Projects.
 *
 * Step: { id, text, status: todo|doing|blocked, due, time, priority,
 *         size: ''|s|m|l, labels: [name], week: 'YYYY-MM-DD' (the Monday it's
 *         pinned to), waitingOn, followUp, details,
 *         checklist: [{ id, text, done }], milestone: { roadmapId, id } | null,
 *         refs: [GitHub issue/PR number], createdAt }
 * Finished steps move to the workspace's `achieved` list with a `date`, and
 * can be given a `version` for release notes.
 *
 * Checklist templates and the weekly capacity live on the plan document
 * (`stepTemplates`, `weekCapacity`) so every project shares them.
 */
(function () {
    const A = window.Admin;

    const STATUSES = [
        { key: 'todo', label: 'To do' },
        { key: 'doing', label: 'In progress' },
        { key: 'blocked', label: 'Blocked' },
    ];
    const SIZES = [
        { value: '', label: 'No size', short: '', points: 0 },
        { value: 's', label: 'Small', short: 'S', points: 1 },
        { value: 'm', label: 'Medium', short: 'M', points: 3 },
        { value: 'l', label: 'Large', short: 'L', points: 5 },
    ];
    const DEFAULT_CAPACITY = 12;
    const SUGGESTED_LABELS = ['bug', 'feature', 'chore', 'research', 'design', 'docs'];
    const LABEL_COLORS = {
        bug: 'var(--danger)', feature: 'var(--accent)', chore: 'var(--text-dim)',
        research: '#8a5cf6', design: '#d6409f', docs: '#0f9b8e',
    };
    const WEEKDAYS = {
        sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
        thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
    };

    // ---------------------------------------------------------------- model --

    function normalize(s) {
        if (!STATUSES.some((x) => x.key === s.status)) s.status = 'todo';
        if (!Array.isArray(s.labels)) s.labels = [];
        if (!Array.isArray(s.checklist)) s.checklist = [];
        if (!Array.isArray(s.refs)) s.refs = [];
        return s;
    }

    function create(parsed) {
        return normalize({
            id: A.uid(), text: parsed.text, status: 'todo', due: parsed.due || '', time: '',
            priority: parsed.priority || 'medium', size: parsed.size || '', labels: parsed.labels || [],
            week: parsed.focus ? thisWeek() : '', waitingOn: '', followUp: '', details: '',
            checklist: [], milestone: null, refs: parsed.refs || [], createdAt: new Date().toISOString(),
        });
    }

    const statusOf = (s) => (STATUSES.some((x) => x.key === s.status) ? s.status : 'todo');
    const statusLabel = (key) => STATUSES.find((x) => x.key === key)?.label || 'To do';
    const points = (s) => SIZES.find((x) => x.value === (s.size || ''))?.points || 0;
    const thisWeek = () => A.startOfWeekKey(A.todayKey());
    const isFocus = (s) => s.week === thisWeek();
    const isStale = (s) => Boolean(s.week) && s.week < thisWeek();

    function checklistProgress(s) {
        const list = s.checklist || [];
        return { done: list.filter((c) => c.done).length, total: list.length };
    }

    function sort(list) {
        return [...list].sort((a, b) => {
            if (a.due && b.due) return a.due.localeCompare(b.due) || A.priorityRank(a.priority) - A.priorityRank(b.priority);
            if (a.due) return -1;
            if (b.due) return 1;
            return A.priorityRank(a.priority) - A.priorityRank(b.priority);
        });
    }

    // Points pinned to this week across every workspace given.
    function weekLoad(docs) {
        return docs.reduce((n, w) => n + (w?.next || []).filter(isFocus).reduce((m, s) => m + points(s), 0), 0);
    }

    function capacity() {
        return Number(A.store.plan.doc?.weekCapacity) || DEFAULT_CAPACITY;
    }

    function knownLabels(docs) {
        const set = new Set(SUGGESTED_LABELS);
        docs.forEach((w) => [...(w?.next || []), ...(w?.achieved || [])].forEach((s) => (s.labels || []).forEach((l) => set.add(l))));
        return [...set];
    }

    // -------------------------------------------------------- quick capture --
    //
    //   Fix login !high @fri #bug #12 ~m *
    //   !high/!med/!low   priority        @today @tomorrow @fri @11/20 @2026-11-20 @+3d @next-week
    //   #word             label           #12      GitHub issue or PR
    //   ~s ~m ~l          size            *        focus this week

    function parseWhen(word) {
        const w = word.toLowerCase();
        const today = A.todayKey();
        if (w === 'today' || w === 'tod') return today;
        if (w === 'tomorrow' || w === 'tmr' || w === 'tom') return A.addDays(today, 1);
        if (w === 'next-week' || w === 'nextweek') return A.addDays(thisWeek(), 7);
        const day = WEEKDAYS[w];
        if (day !== undefined) {
            const ahead = (day - A.parseDate(today).getDay() + 7) % 7;
            return A.addDays(today, ahead);
        }
        let m = w.match(/^\+?(\d{1,3})([dw])$/);
        if (m) return A.addDays(today, Number(m[1]) * (m[2] === 'w' ? 7 : 1));
        if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
        m = w.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (m) {
            const now = A.parseDate(today);
            const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
            if (d.getMonth() !== Number(m[1]) - 1) return '';
            if (A.dateKey(d) < today) d.setFullYear(d.getFullYear() + 1);
            return A.dateKey(d);
        }
        return '';
    }

    function parseQuick(input) {
        const out = { text: '', labels: [], refs: [] };
        const rest = [];
        String(input || '').trim().split(/\s+/).forEach((tok) => {
            const t = tok.toLowerCase();
            let m;
            if ((m = t.match(/^!(h|high|urgent|m|med|medium|l|low)$/))) {
                out.priority = m[1][0] === 'h' || m[1] === 'urgent' ? 'high' : m[1][0] === 'm' ? 'medium' : 'low';
            } else if (t.startsWith('@') && parseWhen(t.slice(1))) {
                out.due = parseWhen(t.slice(1));
            } else if ((m = t.match(/^#(\d+)$/))) {
                if (!out.refs.includes(Number(m[1]))) out.refs.push(Number(m[1]));
            } else if ((m = t.match(/^#([a-z][\w-]*)$/))) {
                if (!out.labels.includes(m[1])) out.labels.push(m[1]);
            } else if ((m = t.match(/^~(s|m|l)$/))) {
                out.size = m[1];
            } else if (t === '*') {
                out.focus = true;
            } else if (tok) {
                rest.push(tok);
            }
        });
        out.text = rest.join(' ');
        return out;
    }

    // What the shorthand in a quick-add box will set, as chips under it.
    function quickPreview(parsed, host) {
        A.clear(host);
        const bits = [];
        if (parsed.priority) bits.push([`${parsed.priority} priority`, '']);
        if (parsed.due) bits.push([A.dueLabel(parsed.due), '']);
        parsed.labels.forEach((l) => bits.push([l, 'label', l]));
        parsed.refs.forEach((n) => bits.push([`#${n}`, '']));
        if (parsed.size) bits.push([`Size ${parsed.size.toUpperCase()}`, '']);
        if (parsed.focus) bits.push(['This week', '']);
        bits.forEach(([text, kind, name]) => host.appendChild(kind === 'label' ? labelChip(name) : A.el('span', 'qa-chip', text)));
        host.hidden = !bits.length;
    }

    const QUICK_HINT = 'Shorthand: !high · @fri or @11/20 · #label · #12 for a GitHub issue/PR · ~s ~m ~l for size · * for this week';

    // A quick-add input that understands the shorthand. `onAdd(parsed)`.
    function quickAdd({ placeholder, onAdd, compact }) {
        const wrap = A.el('div', 'step-quick');
        const form = A.el('form', `quick-add${compact ? ' compact' : ''}`);
        const text = A.el('input', 'qa-title');
        text.type = 'text';
        text.placeholder = placeholder || 'What\'s the next step?';
        text.setAttribute('aria-label', 'Next step');
        text.title = QUICK_HINT;
        const add = A.el('button', 'btn btn-add-primary btn-small', 'Add');
        add.type = 'submit';
        form.appendChild(text);
        form.appendChild(add);
        const preview = A.el('div', 'qa-preview');
        preview.hidden = true;
        const help = A.el('p', 'qa-help', QUICK_HINT);
        help.hidden = true;
        text.addEventListener('input', () => {
            const parsed = parseQuick(text.value);
            quickPreview(parsed, preview);
        });
        text.addEventListener('focus', () => { help.hidden = false; });
        text.addEventListener('blur', () => { if (!text.value) help.hidden = true; });
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const parsed = parseQuick(text.value);
            if (!parsed.text) { text.focus(); return; }
            text.value = '';
            quickPreview(parseQuick(''), preview);
            onAdd(parsed);
        });
        wrap.appendChild(form);
        wrap.appendChild(preview);
        wrap.appendChild(help);
        wrap.focus = () => text.focus();
        return wrap;
    }

    // ---------------------------------------------------------- small parts --

    function labelColor(name) {
        if (LABEL_COLORS[name]) return LABEL_COLORS[name];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
        return `hsl(${hash} 55% 48%)`;
    }

    function labelChip(name, onRemove) {
        const chip = A.el('span', 'step-label');
        chip.style.setProperty('--label', labelColor(name));
        chip.appendChild(A.el('span', null, name));
        if (onRemove) {
            const x = A.button('×', 'step-label-x', (e) => { e.stopPropagation(); onRemove(); });
            x.setAttribute('aria-label', `Remove label ${name}`);
            chip.appendChild(x);
        }
        return chip;
    }

    function refState(info) {
        if (!info) return 'unknown';
        if (info.missing) return 'missing';
        if (info.isPull) return info.merged ? 'merged' : info.state === 'closed' ? 'closed' : 'open';
        return info.state === 'closed' ? 'done' : 'open';
    }

    function refChip(n, ctx) {
        const info = ctx.refInfo?.get(n);
        const st = refState(info);
        const chip = ctx.repo ? A.externalLink('', `https://github.com/${ctx.repo}/issues/${n}`, `step-ref ref-${st}`) : A.el('span', `step-ref ref-${st}`);
        chip.appendChild(A.icon('github', 11));
        chip.appendChild(A.el('span', null, `#${n}`));
        const what = info?.isPull ? 'Pull request' : 'Issue';
        chip.title = info && !info.missing
            ? `${what} #${n}: ${info.title} (${st === 'done' ? 'closed' : st})`
            : info?.missing ? `#${n} wasn't found on GitHub` : `#${n}`;
        chip.addEventListener('click', (e) => e.stopPropagation());
        return chip;
    }

    // Done means every linked issue is closed and every linked PR merged.
    function refsDone(s, refInfo) {
        if (!s.refs?.length) return false;
        return s.refs.every((n) => ['merged', 'done'].includes(refState(refInfo.get(n))));
    }

    function milestoneOf(s, roadmaps) {
        if (!s.milestone) return null;
        const r = (roadmaps || []).find((x) => x.id === s.milestone.roadmapId);
        for (const ph of r?.phases || []) {
            const it = (ph.items || []).find((x) => x.id === s.milestone.id);
            if (it) return { roadmap: r, phase: ph, item: it };
        }
        return null;
    }

    function autosize(ta) {
        const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight + 2}px`; };
        ta.addEventListener('input', fit);
        requestAnimationFrame(fit);
    }

    function select(options, value, label, className) {
        const sel = A.el('select', className);
        sel.setAttribute('aria-label', label);
        options.forEach((o) => {
            const opt = A.el('option', null, o.label);
            opt.value = o.value;
            if (o.value === value) opt.selected = true;
            sel.appendChild(opt);
        });
        return sel;
    }

    function field(label, input, className) {
        const wrap = A.el('div', `step-field${className ? ' ' + className : ''}`);
        if (/^(INPUT|SELECT)$/.test(input.tagName) && !input.getAttribute('aria-label')) input.setAttribute('aria-label', label);
        wrap.appendChild(A.el('span', 'step-field-label', label));
        wrap.appendChild(input);
        return wrap;
    }

    // ------------------------------------------------------------ templates --

    function templates() {
        const plan = A.store.plan.doc;
        if (!plan) return null;
        if (!Array.isArray(plan.stepTemplates)) plan.stepTemplates = [];
        return plan.stepTemplates;
    }

    function manageTemplates() {
        const list = templates();
        if (!list?.length) { A.toast('No templates yet. Save a step\'s checklist as one first.'); return; }
        const fields = [];
        list.forEach((t) => {
            fields.push({ name: `n_${t.id}`, label: 'Template name', value: t.name, half: true, required: true });
            fields.push({ name: `d_${t.id}`, label: 'Delete this template', type: 'checkbox', value: false, half: true });
            fields.push({ name: `i_${t.id}`, label: 'Steps (one per line)', type: 'textarea', rows: 4, value: t.items.join('\n') });
        });
        A.modal.open({
            title: 'Checklist templates',
            description: 'Shared by every project. Apply one from a step\'s checklist to add its steps.',
            wide: true,
            fields,
            submitLabel: 'Save templates',
            onSubmit: (v) => {
                const plan = A.store.plan.doc;
                plan.stepTemplates = list
                    .filter((t) => !v[`d_${t.id}`])
                    .map((t) => ({
                        ...t,
                        name: String(v[`n_${t.id}`] || t.name).trim() || t.name,
                        items: String(v[`i_${t.id}`] || '').split('\n').map((x) => x.trim()).filter(Boolean),
                    }))
                    .filter((t) => t.items.length);
                A.store.plan.save(true);
                A.toast('Templates saved', 'ok');
            },
        });
    }

    function templatePicker(s, onApply) {
        const list = templates();
        if (!list) return null;
        const sel = A.el('select', 'step-template');
        sel.setAttribute('aria-label', 'Checklist templates');
        const fill = () => {
            A.clear(sel);
            const opt = (value, label) => { const o = A.el('option', null, label); o.value = value; sel.appendChild(o); };
            opt('', 'Templates…');
            templates().forEach((t) => opt(t.id, `Add “${t.name}” (${t.items.length})`));
            opt('__save', 'Save these steps as a template…');
            if (templates().length) opt('__manage', 'Manage templates…');
        };
        fill();
        sel.addEventListener('focus', fill);
        sel.addEventListener('change', () => {
            const v = sel.value;
            sel.value = '';
            if (!v) return;
            if (v === '__manage') { manageTemplates(); return; }
            if (v === '__save') {
                if (!s.checklist.length) { A.toast('Add some steps first, then save them as a template.'); return; }
                A.modal.open({
                    title: 'Save as a template',
                    description: `Saves these ${s.checklist.length} steps so you can add them to any next step, in any project.`,
                    fields: [{ name: 'name', label: 'Template name', required: true, value: s.text }],
                    submitLabel: 'Save template',
                    onSubmit: (vals) => {
                        templates().push({ id: A.uid(), name: vals.name.trim(), items: s.checklist.map((c) => c.text).filter(Boolean) });
                        A.store.plan.save(true);
                        A.toast(`Template “${vals.name.trim()}” saved`, 'ok');
                    },
                });
                return;
            }
            const t = templates().find((x) => x.id === v);
            if (t) onApply(t.items);
        });
        return sel;
    }

    // ------------------------------------------------------------ checklist --

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
                onChange(true);
            }, `Mark "${c.text}" ${c.done ? 'not done' : 'done'}`));
            const text = A.el('input', 'subtask-title');
            text.type = 'text';
            text.value = c.text;
            text.setAttribute('aria-label', 'Step');
            text.addEventListener('input', () => { c.text = text.value; onChange(false); });
            text.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add.focus(); } });
            row.appendChild(text);
            row.appendChild(A.iconButton('x', 'Remove step', () => {
                s.checklist = s.checklist.filter((x) => x.id !== c.id);
                row.remove();
                onChange(true);
                add.focus();
            }, 'icon-btn sm danger'));
            return row;
        }

        s.checklist.forEach((c) => list.appendChild(rowFor(c)));
        wrap.appendChild(list);

        const addRow = A.el('div', 'subtask-add-row');
        const add = A.el('input', 'inline-add subtask-add');
        add.type = 'text';
        add.placeholder = '+ Add a step and press Enter';
        add.setAttribute('aria-label', `Add a step to ${s.text}`);
        add.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !add.value.trim()) return;
            e.preventDefault();
            const c = { id: A.uid(), text: add.value.trim(), done: false };
            s.checklist.push(c);
            list.appendChild(rowFor(c));
            add.value = '';
            onChange(true);
        });
        addRow.appendChild(add);
        const picker = templatePicker(s, (items) => {
            items.forEach((text) => {
                const c = { id: A.uid(), text, done: false };
                s.checklist.push(c);
                list.appendChild(rowFor(c));
            });
            onChange(true);
            A.toast(`Added ${items.length} step${items.length === 1 ? '' : 's'}`, 'ok');
        });
        if (picker) addRow.appendChild(picker);
        wrap.appendChild(addRow);
        return wrap;
    }

    function labelsEditor(s, ctx, onChange) {
        const wrap = A.el('div', 'step-labels');
        const chips = A.el('span', 'step-label-list');
        const input = A.el('input', 'step-label-add');
        input.type = 'text';
        input.placeholder = '+ label';
        input.setAttribute('aria-label', 'Add a label');
        const listId = `labels-${s.id}`;
        input.setAttribute('list', listId);
        const datalist = A.el('datalist');
        datalist.id = listId;
        const paint = () => {
            A.clear(chips);
            s.labels.forEach((l) => chips.appendChild(labelChip(l, () => {
                s.labels = s.labels.filter((x) => x !== l);
                paint();
                onChange();
                input.focus();
            })));
            A.clear(datalist);
            (ctx.knownLabels?.() || SUGGESTED_LABELS).filter((l) => !s.labels.includes(l)).forEach((l) => {
                const o = A.el('option');
                o.value = l;
                datalist.appendChild(o);
            });
        };
        const commit = () => {
            const name = input.value.trim().toLowerCase().replace(/^#/, '').replace(/[\s,]+/g, '-');
            input.value = '';
            if (!name || s.labels.includes(name)) return;
            s.labels.push(name);
            paint();
            onChange();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
            else if (e.key === 'Backspace' && !input.value && s.labels.length) {
                s.labels.pop();
                paint();
                onChange();
            }
        });
        input.addEventListener('change', commit);
        paint();
        wrap.appendChild(chips);
        wrap.appendChild(input);
        wrap.appendChild(datalist);
        return wrap;
    }

    function milestonePicker(s, ctx, onChange) {
        const groups = (ctx.roadmaps || []).filter((r) => (r.phases || []).some((p) => (p.items || []).length));
        if (!groups.length) return null;
        // Roadmaps linked to this project come first.
        groups.sort((a, b) => (b.projectId === ctx.projectId) - (a.projectId === ctx.projectId));
        const sel = A.el('select', 'step-milestone');
        sel.setAttribute('aria-label', 'Milestone');
        const none = A.el('option', null, 'No milestone');
        none.value = '';
        sel.appendChild(none);
        const current = s.milestone ? `${s.milestone.roadmapId}|${s.milestone.id}` : '';
        groups.forEach((r) => {
            const og = A.el('optgroup');
            og.label = r.title;
            r.phases.forEach((ph) => (ph.items || []).forEach((it) => {
                const o = A.el('option', null, `${it.done ? '✓ ' : ''}${it.title} · ${ph.title}`);
                o.value = `${r.id}|${it.id}`;
                if (o.value === current) o.selected = true;
                og.appendChild(o);
            }));
            sel.appendChild(og);
        });
        sel.addEventListener('change', () => {
            const [roadmapId, id] = sel.value.split('|');
            s.milestone = sel.value ? { roadmapId, id } : null;
            onChange(true);
        });
        return sel;
    }

    // ----------------------------------------------------------------- card --
    //
    // ctx: {
    //   doc()            the workspace document holding the step
    //   save(now)        save that workspace
    //   rerender(focus)  redraw the whole list (status moves, finish, delete);
    //                    `focus` is a selector inside this card to refocus
    //   changed()        counts elsewhere on the page may need refreshing
    //   expanded         Set of open step ids
    //   key              unique key (defaults to the step id)
    //   project          { name, href } to show which project it's from
    //   projectId, roadmaps, repo, refInfo (Map), loadRefs(numbers)
    //   knownLabels(), onFocusChange(step)
    //   draggable        for the board
    // }

    function card(s, ctx) {
        normalize(s);
        const key = ctx.key || s.id;
        const el = A.el('div', 'step-card');
        el.id = `step-${key.replace(/[^\w-]/g, '_')}`;
        el.dataset.key = key;
        const open = () => ctx.expanded.has(key);

        const row = A.el('div', `item-row step-row st-${statusOf(s)}`);
        const check = A.checkbox(false, () => finish(), `Mark "${s.text}" done`);
        row.appendChild(check);
        const main = A.el('div', 'item-main');
        main.tabIndex = 0;
        main.setAttribute('role', 'button');
        const title = A.el('span', 'item-title');
        const sub = A.el('span', 'item-sub step-sub');
        main.appendChild(title);
        main.appendChild(sub);
        row.appendChild(main);
        const meta = A.el('div', 'item-meta');
        row.appendChild(meta);
        const chev = A.iconButton('chevronRight', 'Show details', null, 'icon-btn sm step-chev');
        row.appendChild(chev);
        el.appendChild(row);

        if (ctx.draggable) {
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                if (e.target.closest?.('input, textarea, select')) { e.preventDefault(); return; }
                e.dataTransfer.setData('text/x-step', key);
                e.dataTransfer.effectAllowed = 'move';
                el.classList.add('dragging');
            });
            row.addEventListener('dragend', () => el.classList.remove('dragging'));
        }

        function paint() {
            title.textContent = s.text || 'Untitled step';
            row.className = `item-row step-row st-${statusOf(s)}`;
            A.clear(sub);
            if (ctx.project) {
                const p = A.el('a', 'step-project', ctx.project.name);
                p.href = ctx.project.href;
                p.addEventListener('click', (e) => e.stopPropagation());
                sub.appendChild(p);
            }
            if (statusOf(s) !== 'todo') sub.appendChild(A.el('span', `step-status-pill st-${statusOf(s)}`, statusLabel(statusOf(s))));
            if (statusOf(s) === 'blocked' && (s.waitingOn || s.followUp)) {
                const w = [s.waitingOn ? `Waiting on ${s.waitingOn}` : 'Waiting', s.followUp ? `follow up ${A.dueLabel(s.followUp)}` : ''].filter(Boolean).join(' · ');
                sub.appendChild(A.el('span', 'step-waiting', w));
            }
            s.labels.forEach((l) => sub.appendChild(labelChip(l)));
            s.refs.forEach((n) => sub.appendChild(refChip(n, ctx)));
            const ms = milestoneOf(s, ctx.roadmaps);
            if (ms) {
                const m = A.el('span', 'step-ms');
                m.title = `Milestone in ${ms.roadmap.title} · ${ms.phase.title}`;
                m.appendChild(A.icon('target', 11));
                m.appendChild(A.el('span', null, ms.item.title));
                sub.appendChild(m);
            }
            sub.hidden = !sub.childNodes.length;

            A.clear(meta);
            if (isFocus(s)) {
                const f = A.icon('flag', 12, 'inline-icon step-focus');
                f.title = 'In this week\'s focus';
                meta.appendChild(f);
            }
            if (s.size) {
                const z = A.el('span', 'step-size', s.size.toUpperCase());
                z.title = `${SIZES.find((x) => x.value === s.size).label} (${points(s)} pt${points(s) === 1 ? '' : 's'})`;
                meta.appendChild(z);
            }
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

        function finish() {
            row.classList.add('is-done');
            check.classList.add('on');
            setTimeout(() => {
                A.items.completeStep(ctx.doc(), s.id);
                ctx.expanded.delete(key);
                ctx.save(true);
                ctx.rerender();
                A.toast('Moved to Achieved', 'ok');
            }, 260);
        }

        let detail = null;
        function setOpen(next, focus) {
            if (next) ctx.expanded.add(key); else ctx.expanded.delete(key);
            el.classList.toggle('open', next);
            chev.title = next ? 'Hide details' : 'Show details';
            chev.setAttribute('aria-label', chev.title);
            chev.setAttribute('aria-expanded', String(next));
            main.setAttribute('aria-expanded', String(next));
            if (next && !detail) {
                detail = buildDetail(s, ctx, { key, paint, finish });
                el.appendChild(detail);
            }
            if (detail) detail.hidden = !next;
            if (next && focus) detail.querySelector('.step-name')?.focus();
        }
        const toggle = () => setOpen(!open(), true);
        main.addEventListener('click', toggle);
        main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        chev.addEventListener('click', toggle);

        paint();
        setOpen(open(), false);
        return el;
    }

    function buildDetail(s, ctx, { key, paint, finish }) {
        const panel = A.el('div', 'step-detail');
        // `now` saves at once (and lets the worker update the calendar);
        // otherwise the save is debounced like typing.
        const changed = (now) => { ctx.save(now); paint(); ctx.changed?.(); };

        const name = A.el('input', 'step-name');
        name.type = 'text';
        name.value = s.text;
        name.setAttribute('aria-label', 'Step');
        name.addEventListener('input', () => { s.text = name.value; changed(false); });
        name.addEventListener('blur', () => {
            if (name.value.trim()) return;
            s.text = 'Untitled step';
            name.value = s.text;
            changed(true);
        });
        panel.appendChild(name);

        // When, how big, how urgent, where it's at.
        const grid = A.el('div', 'step-grid');
        const status = select(STATUSES.map((x) => ({ value: x.key, label: x.label })), statusOf(s), 'Status', 'step-status');
        status.addEventListener('change', () => {
            s.status = status.value;
            blocked.hidden = s.status !== 'blocked';
            changed(true);
            if (ctx.statusMoves) ctx.rerender(`[data-key="${CSS.escape(key)}"] .step-status`);
        });
        grid.appendChild(field('Status', status));

        const due = A.el('input');
        due.type = 'date';
        due.value = s.due || '';
        const time = A.el('input');
        time.type = 'time';
        time.value = s.time || '';
        time.disabled = !s.due;
        time.title = s.due ? '' : 'Pick a date first';
        due.addEventListener('change', () => {
            s.due = due.value;
            if (!s.due) { s.time = ''; time.value = ''; }
            time.disabled = !s.due;
            time.title = s.due ? '' : 'Pick a date first';
            changed(true);
        });
        time.addEventListener('change', () => { s.time = time.value; changed(true); });
        grid.appendChild(field('Due', due));
        grid.appendChild(field('Time', time));

        const prio = select(A.PRIORITIES, s.priority || 'medium', 'Priority');
        prio.addEventListener('change', () => { s.priority = prio.value; changed(true); });
        grid.appendChild(field('Priority', prio));

        const size = select(SIZES.map((x) => ({ value: x.value, label: x.short ? `${x.short} · ${x.label} (${x.points} pt${x.points === 1 ? '' : 's'})` : x.label })), s.size || '', 'Size');
        size.addEventListener('change', () => { s.size = size.value; changed(true); ctx.onFocusChange?.(s); });
        grid.appendChild(field('Size', size));

        const focus = A.button('', 'btn btn-ghost btn-small step-week', () => {
            s.week = isFocus(s) ? '' : thisWeek();
            paintFocus();
            changed(true);
            ctx.onFocusChange?.(s);
        });
        const paintFocus = () => {
            A.clear(focus).appendChild(A.icon('flag', 13));
            focus.appendChild(A.el('span', null, isFocus(s) ? 'In this week' : 'Add to this week'));
            focus.classList.toggle('on', isFocus(s));
            focus.setAttribute('aria-pressed', String(isFocus(s)));
        };
        paintFocus();
        grid.appendChild(field('Focus', focus));
        panel.appendChild(grid);

        // Blocked: who or what it's waiting on, and when to chase it.
        const blocked = A.el('div', 'step-grid step-blocked');
        blocked.hidden = statusOf(s) !== 'blocked';
        const waiting = A.el('input');
        waiting.type = 'text';
        waiting.value = s.waitingOn || '';
        waiting.placeholder = 'A person, a review, a reply…';
        waiting.addEventListener('input', () => { s.waitingOn = waiting.value; changed(false); });
        blocked.appendChild(field('Waiting on', waiting, 'grow'));
        const follow = A.el('input');
        follow.type = 'date';
        follow.value = s.followUp || '';
        follow.title = 'Shows in Up next on this day';
        follow.addEventListener('change', () => { s.followUp = follow.value; changed(true); });
        blocked.appendChild(field('Follow up', follow));
        panel.appendChild(blocked);

        // Labels, milestone, GitHub.
        const links = A.el('div', 'step-grid');
        links.appendChild(field('Labels', labelsEditor(s, ctx, () => changed(true)), 'grow'));
        const ms = milestonePicker(s, ctx, changed);
        if (ms) links.appendChild(field('Milestone', ms, 'grow'));
        if (ctx.repo) {
            const refs = A.el('input', 'step-refs');
            refs.type = 'text';
            refs.placeholder = '#12 #15';
            refs.value = s.refs.map((n) => `#${n}`).join(' ');
            refs.title = 'Issues or pull requests on GitHub. The step ticks itself off once they\'re all closed or merged.';
            refs.addEventListener('change', () => {
                s.refs = [...new Set((refs.value.match(/\d+/g) || []).map(Number).filter((n) => n > 0))];
                refs.value = s.refs.map((n) => `#${n}`).join(' ');
                changed(true);
                ctx.loadRefs?.(s.refs).then(paint);
            });
            links.appendChild(field('GitHub', refs));
        }
        panel.appendChild(links);

        panel.appendChild(A.el('div', 'subfield-label', 'Details'));
        const details = A.el('textarea', 'step-details');
        details.rows = 3;
        details.value = s.details || '';
        details.placeholder = 'What this involves, how you\'ll approach it, what "done" looks like, links…';
        details.setAttribute('aria-label', 'Details');
        details.addEventListener('input', () => { s.details = details.value; changed(false); });
        autosize(details);
        panel.appendChild(details);

        const checkHead = A.el('div', 'subfield-label step-check-head');
        checkHead.appendChild(A.el('span', null, 'Steps'));
        const bar = A.el('span', 'step-check-bar');
        checkHead.appendChild(bar);
        panel.appendChild(checkHead);
        const paintBar = () => {
            A.clear(bar);
            const { done, total } = checklistProgress(s);
            if (total) bar.appendChild(A.progressBar(done, total));
        };
        paintBar();
        panel.appendChild(checklistEditor(s, (now) => { paintBar(); changed(now); }));

        const foot = A.el('div', 'step-foot');
        const doneBtn = A.button('', 'btn btn-add-primary btn-small', finish);
        doneBtn.appendChild(A.icon('check', 13));
        doneBtn.appendChild(A.el('span', null, 'Mark done'));
        foot.appendChild(doneBtn);
        foot.appendChild(A.button('Delete step', 'btn btn-ghost btn-small step-delete', async () => {
            const ok = await A.confirm({ title: `Delete "${s.text}"?`, description: 'Its details and checklist go with it. To keep a record, mark it done instead.', confirmLabel: 'Delete', danger: true });
            if (!ok) return;
            const doc = ctx.doc();
            doc.next = doc.next.filter((x) => x.id !== s.id);
            ctx.expanded.delete(key);
            ctx.save(true);
            ctx.rerender();
        }));
        panel.appendChild(foot);
        return panel;
    }

    // ---------------------------------------------------------------- board --
    //
    // entries: [{ s, ctx }]; onMove(entry, status) after a drop.

    function board(entries, { onMove } = {}) {
        const wrap = A.el('div', 'step-board');
        STATUSES.forEach((st) => {
            const col = A.el('section', `board-col st-${st.key}`);
            col.dataset.status = st.key;
            const mine = entries.filter((e) => statusOf(e.s) === st.key);
            const head = A.el('div', 'board-head');
            head.appendChild(A.el('span', `board-dot st-${st.key}`));
            head.appendChild(A.el('span', 'board-title', st.label));
            head.appendChild(A.el('span', 'count', String(mine.length)));
            const pts = mine.reduce((n, e) => n + points(e.s), 0);
            if (pts) {
                const p = A.el('span', 'board-points', `${pts} pt${pts === 1 ? '' : 's'}`);
                p.title = 'Total size (S = 1, M = 3, L = 5)';
                head.appendChild(p);
            }
            col.appendChild(head);
            const list = A.el('div', 'board-list');
            mine.forEach((e) => list.appendChild(card(e.s, { ...e.ctx, draggable: true, statusMoves: true })));
            if (!mine.length) list.appendChild(A.el('div', 'board-empty', st.key === 'blocked' ? 'Nothing blocked' : 'Drop steps here'));
            col.appendChild(list);

            col.addEventListener('dragover', (e) => {
                if (!e.dataTransfer.types.includes('text/x-step')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                col.classList.add('drop');
            });
            col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
            col.addEventListener('drop', (e) => {
                e.preventDefault();
                col.classList.remove('drop');
                const entry = entries.find((x) => (x.ctx.key || x.s.id) === e.dataTransfer.getData('text/x-step'));
                if (!entry || statusOf(entry.s) === st.key) return;
                entry.s.status = st.key;
                entry.ctx.save(true);
                onMove?.(entry, st.key);
            });
            wrap.appendChild(col);
        });
        return wrap;
    }

    // ------------------------------------------------------------ capacity --

    function capacityMeter(load, cap) {
        const wrap = A.el('div', `capacity${load > cap ? ' over' : ''}`);
        const track = A.el('div', 'progress-track');
        const fill = A.el('div', 'progress-fill');
        fill.style.width = `${Math.min(100, cap ? (load / cap) * 100 : 0)}%`;
        track.appendChild(fill);
        wrap.appendChild(track);
        wrap.appendChild(A.el('span', 'capacity-label', `${load} / ${cap} pts`));
        wrap.title = load > cap ? `Over your weekly capacity by ${load - cap} pts` : `${cap - load} pts left this week`;
        return wrap;
    }

    function warnIfOver(docs) {
        const load = weekLoad(docs);
        const cap = capacity();
        if (load > cap) A.toast(`This week is at ${load} of ${cap} pts. Consider moving something out.`, 'error');
    }

    // ----------------------------------------------------------- changelog --

    function versionCompare(a, b) {
        const pa = String(a).replace(/^v/i, '').split(/[.-]/);
        const pb = String(b).replace(/^v/i, '').split(/[.-]/);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const x = pa[i] ?? '';
            const y = pb[i] ?? '';
            const nx = Number(x);
            const ny = Number(y);
            if (!Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '') { if (nx !== ny) return nx - ny; }
            else if (x !== y) return x.localeCompare(y);
        }
        return 0;
    }

    // Achieved items grouped for release notes: by version (newest first,
    // untagged last) or by month.
    function groupAchieved(list, by) {
        const groups = new Map();
        list.forEach((a) => {
            const k = by === 'version'
                ? (a.version || '')
                : (a.date || '').slice(0, 7);
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(a);
        });
        const keys = [...groups.keys()].sort((a, b) => {
            if (!a) return 1;
            if (!b) return -1;
            return by === 'version' ? versionCompare(b, a) : b.localeCompare(a);
        });
        return keys.map((k) => ({
            key: k,
            label: by === 'version'
                ? (k || 'Not in a version yet')
                : (k ? A.parseDate(`${k}-01`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : 'No date'),
            items: groups.get(k),
        }));
    }

    function changelog(list, by, projectName) {
        const lines = [`# ${projectName} changelog`, ''];
        groupAchieved(list, by).forEach((g) => {
            lines.push(`## ${g.label}`, '');
            g.items.forEach((a) => {
                const refs = (a.refs || []).map((n) => `#${n}`).join(', ');
                const labels = (a.labels || []).length ? ` [${a.labels.join(', ')}]` : '';
                lines.push(`- ${a.text}${labels}${refs ? ` (${refs})` : ''}`);
            });
            lines.push('');
        });
        return lines.join('\n').trim() + '\n';
    }

    A.steps = {
        STATUSES, SIZES, DEFAULT_CAPACITY, SUGGESTED_LABELS,
        normalize, create, statusOf, statusLabel, points, thisWeek, isFocus, isStale, checklistProgress, sort,
        weekLoad, capacity, knownLabels, parseQuick, parseWhen, quickAdd,
        labelColor, labelChip, refState, refsDone, milestoneOf, templates, manageTemplates,
        card, board, capacityMeter, warnIfOver, groupAchieved, changelog,
    };
})();
