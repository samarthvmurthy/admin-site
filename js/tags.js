/**
 * Your own tags for tasks, attached as Admin.tags.
 *
 * The list lives in the plan document (plan.tags: [{ id, name, color }]) so
 * every page shares it. A task, subtask or project step carries the ids it's
 * tagged with (item.tags: [id]); renaming a tag renames it everywhere, and a
 * deleted tag simply stops showing.
 */
(function () {
    const A = window.Admin;

    // Mid-tone colours that read on both the light and dark theme.
    const COLORS = [
        { value: 'blue', label: 'Blue', hex: '#3f7ee8' },
        { value: 'green', label: 'Green', hex: '#2a9a4a' },
        { value: 'amber', label: 'Amber', hex: '#c98410' },
        { value: 'red', label: 'Red', hex: '#d9484e' },
        { value: 'violet', label: 'Violet', hex: '#8360dc' },
        { value: 'pink', label: 'Pink', hex: '#d2468f' },
        { value: 'teal', label: 'Teal', hex: '#18998c' },
        { value: 'slate', label: 'Grey', hex: '#6b7686' },
    ];

    const plan = () => A.store.plan.doc;
    function list(p = plan()) {
        if (!p) return [];
        if (!Array.isArray(p.tags)) p.tags = [];
        return p.tags;
    }
    const byId = (id, p) => list(p).find((t) => t.id === id) || null;
    const colorOf = (tag) => (COLORS.find((c) => c.value === tag?.color) || COLORS[COLORS.length - 1]).hex;

    // Tags in the order you arranged them, dropping any that were deleted.
    function resolve(ids, p) {
        const set = new Set(ids || []);
        return list(p).filter((t) => set.has(t.id));
    }

    function create(name, p = plan()) {
        const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        if (!clean) return null;
        const tags = list(p);
        const existing = tags.find((t) => t.name.toLowerCase() === clean.toLowerCase());
        if (existing) return existing;
        const used = new Set(tags.map((t) => t.color));
        const color = (COLORS.find((c) => !used.has(c.value)) || COLORS[tags.length % COLORS.length]).value;
        const tag = { id: A.uid(), name: clean, color };
        tags.push(tag);
        return tag;
    }

    function chip(tag, { onClick } = {}) {
        const node = A.el(onClick ? 'button' : 'span', 'tag-chip');
        if (onClick) { node.type = 'button'; node.addEventListener('click', onClick); }
        node.style.setProperty('--tag', colorOf(tag));
        node.textContent = tag.name;
        return node;
    }

    function chips(ids, p) {
        const tags = resolve(ids, p);
        if (!tags.length) return null;
        const wrap = A.el('span', 'tag-chips');
        tags.forEach((t) => wrap.appendChild(chip(t)));
        return wrap;
    }

    // -------------------------------------------------------------- picker --
    //
    // A small menu under `anchor`: tick tags on and off, or type a new name
    // and press Enter to create it. onChange(ids) runs on every change.

    let openPicker = null;

    function closePicker() {
        if (!openPicker) return;
        const { node, cleanup, anchor } = openPicker;
        openPicker = null;
        anchor?.setAttribute('aria-expanded', 'false');
        cleanup();
        node.remove();
    }

    function picker(anchor, { selected = [], onChange, onManage }) {
        closePicker();
        let ids = [...selected];
        const node = A.el('div', 'tag-picker');
        node.setAttribute('role', 'dialog');
        node.setAttribute('aria-label', 'Tags');
        const input = A.el('input', 'tag-picker-input');
        input.type = 'text';
        input.placeholder = 'Find or create a tag…';
        input.setAttribute('aria-label', 'Find or create a tag');
        input.maxLength = 40;
        const options = A.el('div', 'tag-picker-list');
        node.appendChild(input);
        node.appendChild(options);

        function toggle(id) {
            ids = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
            onChange(ids);
            paint();
        }

        function paint() {
            A.clear(options);
            const q = input.value.trim().toLowerCase();
            const shown = list().filter((t) => !q || t.name.toLowerCase().includes(q));
            shown.forEach((t) => {
                const on = ids.includes(t.id);
                const opt = A.button('', `tag-option${on ? ' on' : ''}`, () => { toggle(t.id); input.focus(); });
                opt.setAttribute('role', 'menuitemcheckbox');
                opt.setAttribute('aria-checked', String(on));
                const box = A.el('span', 'tag-option-check');
                if (on) box.appendChild(A.icon('check', 11));
                opt.appendChild(box);
                opt.appendChild(chip(t));
                options.appendChild(opt);
            });
            const exact = list().some((t) => t.name.toLowerCase() === q);
            if (q && !exact) {
                const make = A.button('', 'tag-option tag-create', createFromInput);
                make.appendChild(A.icon('plus', 12));
                make.appendChild(A.el('span', null, `Create "${input.value.trim()}"`));
                options.appendChild(make);
            }
            if (!list().length && !q) {
                options.appendChild(A.el('p', 'tag-picker-empty', 'No tags yet. Type a name, like Work or Errand, and press Enter.'));
            }
            if (onManage && list().length) {
                const manage = A.button('Edit tags…', 'link-btn tag-picker-manage', () => { closePicker(); onManage(); });
                options.appendChild(manage);
            }
        }

        function createFromInput() {
            const tag = create(input.value);
            if (!tag) return;
            input.value = '';
            if (!ids.includes(tag.id)) toggle(tag.id); else paint();
            input.focus();
        }

        input.addEventListener('input', paint);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const q = input.value.trim().toLowerCase();
                if (!q) return;
                const match = list().find((t) => t.name.toLowerCase() === q);
                if (match) { toggle(match.id); input.value = ''; paint(); } else createFromInput();
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                closePicker();
                anchor.focus?.();
            }
        });

        document.body.appendChild(node);
        paint();
        place();

        function place() {
            const r = anchor.getBoundingClientRect();
            const w = node.offsetWidth;
            const h = node.offsetHeight;
            let left = Math.min(r.right - w, window.innerWidth - w - 12);
            left = Math.max(12, left);
            let top = r.bottom + 6;
            if (top + h > window.innerHeight - 12 && r.top - h - 6 > 12) top = r.top - h - 6;
            node.style.left = `${left}px`;
            node.style.top = `${top}px`;
        }

        const onDown = (e) => { if (!node.contains(e.target) && !anchor.contains(e.target)) closePicker(); };
        const onScroll = (e) => { if (!node.contains(e.target)) closePicker(); };
        setTimeout(() => {
            document.addEventListener('pointerdown', onDown, true);
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', closePicker);
        }, 0);
        openPicker = {
            node,
            cleanup: () => {
                document.removeEventListener('pointerdown', onDown, true);
                window.removeEventListener('scroll', onScroll, true);
                window.removeEventListener('resize', closePicker);
            },
        };
        // Don't pop the keyboard up on a phone just for ticking a box.
        if (window.matchMedia('(hover: hover)').matches) input.focus();
    }

    // A button that shows an item's tags and opens the picker when clicked.
    function button(ids, { onChange, onManage, label = 'Tags' }) {
        const btn = A.el('button', 'tag-btn');
        btn.type = 'button';
        function paint(current) {
            A.clear(btn);
            const tags = resolve(current);
            btn.classList.toggle('empty', !tags.length);
            btn.title = tags.length ? `Tags: ${tags.map((t) => t.name).join(', ')}` : 'Add tags';
            btn.setAttribute('aria-label', tags.length ? `${label}: ${tags.map((t) => t.name).join(', ')}. Change` : 'Add tags');
            if (tags.length) tags.forEach((t) => btn.appendChild(chip(t)));
            else btn.appendChild(A.icon('tag', 13));
        }
        paint(ids);
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (openPicker?.anchor === btn) { closePicker(); return; }
            picker(btn, {
                selected: ids,
                onManage,
                onChange: (next) => { ids = next; paint(next); onChange(next); },
            });
            openPicker.anchor = btn;
            btn.setAttribute('aria-expanded', 'true');
        });
        return btn;
    }

    // For forms: every tag as a toggle, plus a box to create one.
    // Returns { node, value() } (see the modal's 'custom' field).
    function editor(ids = []) {
        let selected = [...ids];
        const node = A.el('div', 'tag-editor');
        const row = A.el('div', 'tag-editor-list');
        const input = A.el('input', 'tag-editor-new');
        input.type = 'text';
        input.placeholder = '+ New tag';
        input.maxLength = 40;
        input.setAttribute('aria-label', 'New tag');
        function paint() {
            A.clear(row);
            list().forEach((t) => {
                const on = selected.includes(t.id);
                const c = chip(t, {
                    onClick: () => {
                        selected = on ? selected.filter((x) => x !== t.id) : [...selected, t.id];
                        paint();
                    },
                });
                c.classList.toggle('off', !on);
                c.setAttribute('aria-pressed', String(on));
                c.title = on ? `Remove ${t.name}` : `Add ${t.name}`;
                row.appendChild(c);
            });
            row.appendChild(input);
        }
        input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const tag = create(input.value);
            input.value = '';
            if (tag && !selected.includes(tag.id)) selected.push(tag.id);
            paint();
            input.focus();
        });
        paint();
        node.appendChild(row);
        return {
            node,
            value: () => {
                // A name typed but not entered still counts.
                const tag = create(input.value);
                if (tag && !selected.includes(tag.id)) selected.push(tag.id);
                return selected.filter((id) => byId(id));
            },
        };
    }

    // -------------------------------------------------------------- manage --

    function manage({ onSave } = {}) {
        const tags = list();
        const fields = [];
        tags.forEach((t) => {
            fields.push({ name: `n_${t.id}`, label: 'Name', value: t.name, half: true, required: true });
            fields.push({ name: `c_${t.id}`, label: 'Colour', type: 'select', value: t.color, half: true, options: COLORS });
            fields.push({ name: `d_${t.id}`, label: `Delete "${t.name}"`, type: 'checkbox', value: false });
        });
        fields.push({ name: '__new', label: 'New tag', placeholder: 'e.g. Errand, Deep work, Waiting', hint: 'Optional. You can also create tags straight from a task.' });
        A.modal.open({
            title: 'Tags',
            description: 'Tags you create here can be put on any task, subtask or project step, and Up next can filter by them.',
            fields,
            submitLabel: 'Save tags',
            onSubmit: (v) => {
                const names = new Set();
                const keep = [];
                tags.forEach((t) => {
                    if (v[`d_${t.id}`]) return;
                    const name = v[`n_${t.id}`].replace(/\s+/g, ' ').slice(0, 40);
                    if (names.has(name.toLowerCase())) throw new Error(`Two tags are called "${name}".`);
                    names.add(name.toLowerCase());
                    keep.push({ ...t, name, color: v[`c_${t.id}`] || t.color });
                });
                const removed = new Set(tags.filter((t) => !keep.some((k) => k.id === t.id)).map((t) => t.id));
                plan().tags = keep;
                if (v.__new) create(v.__new);
                if (removed.size) forgetTags(removed);
                A.store.plan.save(true);
                onSave?.();
            },
        });
    }

    // Take deleted tags off everything in the plan. Project steps keep the
    // stale id until they're next tagged; it's never shown either way.
    function forgetTags(removed) {
        const strip = (o) => { if (Array.isArray(o.tags)) o.tags = o.tags.filter((id) => !removed.has(id)); };
        (plan().tasks || []).forEach(strip);
        (plan().roadmaps || []).forEach((r) => (r.phases || []).forEach((ph) => (ph.items || []).forEach((it) => (it.subtasks || []).forEach(strip))));
    }

    A.tags = { COLORS, list, byId, resolve, create, chip, chips, picker, button, editor, manage, close: closePicker };
})();
