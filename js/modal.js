/**
 * Modal dialogs built from a field spec, attached to window.Admin.
 * Requires <div class="modal-backdrop" id="modal-backdrop"></div> on the page.
 */
(function () {
    const A = window.Admin;

    function backdrop() {
        let node = document.getElementById('modal-backdrop');
        if (!node) {
            node = A.el('div', 'modal-backdrop');
            node.id = 'modal-backdrop';
            document.body.appendChild(node);
        }
        return node;
    }

    let onCloseHook = null;

    function close() {
        const hook = onCloseHook;
        onCloseHook = null;
        if (hook) setTimeout(hook, 0);
        const node = backdrop();
        node.classList.remove('visible');
        A.clear(node);
        document.removeEventListener('keydown', onKeydown);
    }

    function onKeydown(e) {
        if (e.key === 'Escape') close();
    }

    function buildField(field) {
        const wrap = A.el('div', `modal-field${field.half ? ' half' : ''}${field.type === 'checkbox' ? ' is-check' : ''}`);
        const label = A.el('label', 'modal-label', field.label);
        if (field.required) label.appendChild(A.el('span', 'req', ' *'));
        wrap.appendChild(label);

        let input;
        if (field.type === 'textarea') {
            input = A.el('textarea');
            input.rows = field.rows || 4;
        } else if (field.type === 'select') {
            input = A.el('select', 'select-plain');
            (field.options || []).forEach((opt) => {
                const o = A.el('option', null, opt.label ?? opt);
                o.value = opt.value ?? opt;
                input.appendChild(o);
            });
        } else if (field.type === 'checkbox') {
            input = A.el('input');
            input.type = 'checkbox';
            input.className = 'modal-checkbox';
        } else {
            input = A.el('input');
            input.type = field.type || 'text';
        }

        input.name = field.name;
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.type === 'checkbox') input.checked = Boolean(field.value);
        else if (field.value != null) input.value = field.value;
        if (field.required) input.required = true;

        wrap.appendChild(input);
        if (field.hint) wrap.appendChild(A.el('div', 'modal-hint', field.hint));
        return { wrap, input };
    }

    /**
     * open({ title, description, fields, submitLabel, destructiveLabel, onSubmit, onDestructive })
     * onSubmit receives a plain {name: value} object and may return a promise;
     * the dialog stays open and shows the error if it rejects.
     */
    function open(spec) {
        const node = backdrop();
        A.clear(node);
        onCloseHook = spec.onClose || null;

        const dialog = A.el('div', `modal${spec.wide ? ' modal-wide' : ''}`);
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const head = A.el('div', 'modal-head');
        head.appendChild(A.el('h3', null, spec.title || ''));
        const closeBtn = A.button('✕', 'modal-close', close);
        closeBtn.setAttribute('aria-label', 'Close');
        head.appendChild(closeBtn);
        dialog.appendChild(head);

        if (spec.description) dialog.appendChild(A.el('p', 'modal-desc', spec.description));

        const form = A.el('form', 'modal-body');
        const inputs = {};
        (spec.fields || []).forEach((field) => {
            if (field.type === 'static') {
                form.appendChild(A.el('p', 'modal-desc', field.value));
                return;
            }
            const { wrap, input } = buildField(field);
            inputs[field.name] = input;
            form.appendChild(wrap);
        });

        const error = A.el('div', 'modal-error');
        error.style.display = 'none';
        form.appendChild(error);

        const footer = A.el('div', 'modal-foot');
        if (spec.destructiveLabel) {
            footer.appendChild(A.button(spec.destructiveLabel, 'btn btn-danger', async () => {
                try {
                    await spec.onDestructive();
                    close();
                } catch (e) {
                    error.textContent = e.message;
                    error.style.display = 'block';
                }
            }));
        }
        footer.appendChild(A.el('div', 'modal-foot-spacer'));
        footer.appendChild(A.button('Cancel', 'btn btn-edit', close));
        const submit = A.el('button', `btn ${spec.danger ? 'btn-danger-solid' : 'btn-add-primary'}`, spec.submitLabel || 'Save');
        submit.type = 'submit';
        footer.appendChild(submit);
        form.appendChild(footer);

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const values = {};
            for (const [name, input] of Object.entries(inputs)) {
                values[name] = input.type === 'checkbox' ? input.checked : input.value.trim();
            }
            submit.disabled = true;
            error.style.display = 'none';
            try {
                await spec.onSubmit(values);
                close();
            } catch (err) {
                error.textContent = err.message;
                error.style.display = 'block';
                submit.disabled = false;
            }
        });

        dialog.appendChild(form);
        node.appendChild(dialog);
        node.classList.add('visible');
        document.addEventListener('keydown', onKeydown);

        // Clicking the dim area outside the dialog dismisses it.
        node.onclick = (e) => { if (e.target === node) close(); };

        const first = Object.values(inputs)[0];
        if (first) setTimeout(() => first.focus(), 50);
    }

    // Promise-based yes/no dialog.
    function confirm({ title, description, confirmLabel = 'Confirm', danger = false }) {
        return new Promise((resolve) => {
            let answered = false;
            open({
                title, description, fields: [], submitLabel: confirmLabel, danger,
                onSubmit: () => { answered = true; resolve(true); },
                onClose: () => { if (!answered) resolve(false); },
            });
        });
    }

    A.modal = { open, close, confirm };
    A.confirm = confirm;
})();
