/**
 * Client-side documents with autosave, attached as Admin.store.
 *
 *   const plan = Admin.store.plan;      await plan.load();  plan.doc.tasks.push(…);  plan.save();
 *   const ws = Admin.store.workspace(id);
 *
 * Saves for one document are strictly serialised: a new PUT never starts
 * while another is in flight. That matters because the worker assigns
 * Google event ids during a save, and two overlapping saves would each
 * create an event for the same item.
 *
 * A save that can't get through (expired sign-in, no network) keeps its edits
 * in localStorage. An expired sign-in sends the page to the login, and the
 * edits are restored and saved when it comes back.
 */
(function () {
    const A = window.Admin;
    const listeners = new Set();
    const docs = new Map();

    // Visit every object carrying an `id`, at any depth.
    function walkIds(node, fn) {
        if (Array.isArray(node)) { node.forEach((n) => walkIds(n, fn)); return; }
        if (!node || typeof node !== 'object') return;
        if (typeof node.id === 'string') fn(node);
        for (const v of Object.values(node)) if (v && typeof v === 'object') walkIds(v, fn);
    }

    // Copy server-owned sync fields onto the local doc without touching
    // anything the user may have typed since the request was sent.
    function mergeServerFields(local, saved) {
        const byId = new Map();
        walkIds(saved, (n) => byId.set(n.id, n));
        walkIds(local, (n) => {
            const s = byId.get(n.id);
            if (!s) return;
            if (s.calEventId) n.calEventId = s.calEventId; else delete n.calEventId;
            if (s.calHash) n.calHash = s.calHash; else delete n.calHash;
        });
        local.updatedAt = saved.updatedAt;
        if ('calOrphans' in saved) local.calOrphans = saved.calOrphans;
        if ('timeZone' in saved) local.timeZone = saved.timeZone;
    }

    function emit(event) {
        listeners.forEach((fn) => { try { fn(event); } catch (e) { console.error(e); } });
    }

    function createDoc(name, path) {
        const d = {
            name,
            doc: null,
            status: 'idle', // idle | dirty | saving | saved | error
            _loading: null,
            _timer: null,
            _saving: false,
            _dirty: false,
            _readOnly: false,
        };

        const draftKey = `cp-draft:${name}`;
        const writeDraft = d._writeDraft = () => { try { localStorage.setItem(draftKey, JSON.stringify(d.doc)); } catch { /* full or blocked */ } };
        const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch { /* blocked */ } };
        function readDraft() {
            try { return JSON.parse(localStorage.getItem(draftKey)); } catch { return null; }
        }

        // Take a document from the server, unless edits that never made it are
        // waiting. They only apply on top of the version they were made from;
        // if the document has moved on, restoring them would undo newer work.
        function adopt(data) {
            d._readOnly = false;
            d.doc = data;
            const draft = readDraft();
            if (!draft) return data;
            if ((draft.updatedAt || null) === (data.updatedAt || null)) {
                d.doc = draft;
                d.save(true);
                A.toast('Restored changes that hadn\'t saved yet', 'ok');
            } else {
                clearDraft();
                A.toast('Some unsaved changes were dropped: newer changes had been saved since', 'error');
            }
            return d.doc;
        }

        d.load = function (force) {
            if (!d._loading || force) {
                d._loading = A.api(path).then((data) => {
                    delete data.sync;
                    return adopt(data);
                }).catch((e) => { d._loading = null; throw e; });
            }
            return d._loading;
        };

        // Use data that was fetched in bulk (e.g. /workspaces) without a refetch.
        d.seed = function (data) {
            if (d.doc && !d._readOnly) return d.doc;
            const doc = adopt(data);
            d._loading = Promise.resolve(doc);
            return doc;
        };

        // Stand-in for a document that failed to load, so the page can still
        // render. It can never be saved: that would overwrite the real one.
        d.fallback = function (data) {
            if (d.doc) return d.doc;
            d.doc = data;
            d._readOnly = true;
            d._loading = Promise.resolve(data);
            return data;
        };

        function setStatus(status, extra) {
            d.status = status;
            emit({ name, status, ...extra });
        }

        d.save = function (immediate) {
            if (!d.doc || d._readOnly) return;
            d._dirty = true;
            setStatus('dirty');
            clearTimeout(d._timer);
            d._timer = setTimeout(run, immediate ? 0 : 700);
        };

        d.flush = function () {
            clearTimeout(d._timer);
            return run();
        };

        async function run() {
            if (d._saving || !d._dirty) return;
            if (A.session.isExpired()) {
                writeDraft();
                setStatus('held');
                return;
            }
            const alreadyFailing = d.status === 'error';
            d._saving = true;
            d._dirty = false;
            setStatus('saving');
            const body = JSON.stringify(d.doc);
            // keepalive lets a save outlive the tab, but browsers cap its body
            // at 64 KB, so only use it when leaving and the doc is small.
            const keepalive = unloading && body.length < 60000;
            let failed = false;
            try {
                const saved = await A.api(path, { method: 'PUT', body, keepalive });
                mergeServerFields(d.doc, saved);
                clearDraft();
                setStatus(d._dirty ? 'dirty' : 'saved', { updatedAt: saved.updatedAt });
                if (saved.sync?.error) emit({ name, status: 'sync-error', error: saved.sync.error });
                if (saved.sync?.pending) A.calendarSync.kick();
            } catch (e) {
                failed = true;
                d._dirty = true;
                writeDraft();
                if (e.sessionExpired) {
                    setStatus('held');
                } else {
                    setStatus('error', { error: e });
                    if (!alreadyFailing) A.toast(`Couldn't save: ${e.message}`, 'error');
                    // No status means the network failed, which tends to pass.
                    if (!e.status) { clearTimeout(d._timer); d._timer = setTimeout(run, 15000); }
                }
            } finally {
                d._saving = false;
            }
            // Edits made while that request was in flight go out next. After a
            // failure, wait for the next edit (or flush) instead of hammering.
            if (d._dirty && !failed) run();
        }

        docs.set(name, d);
        return d;
    }

    function workspace(id) {
        const key = `ws:${id}`;
        return docs.get(key) || createDoc(key, `/workspace?id=${encodeURIComponent(id)}`);
    }

    // Don't lose the last edit when the tab goes away.
    let unloading = false;
    function flushAll() { return Promise.all([...docs.values()].map((d) => d.flush())); }
    A.session.onBack(flushAll);
    A.session.onLeaving(() => docs.forEach((d) => { if (d._dirty || d._saving) d._writeDraft(); }));
    window.addEventListener('pagehide', () => { unloading = true; flushAll(); });
    document.addEventListener('visibilitychange', () => {
        unloading = document.visibilityState === 'hidden';
        if (unloading) flushAll();
    });

    // Finishes calendar mirroring that a save couldn't complete in one request.
    A.calendarSync = (function () {
        let timer = null;
        let running = false;
        async function loop() {
            if (running) return;
            running = true;
            try {
                for (let i = 0; i < 10; i++) {
                    const res = await A.api('/calendar/sync', { method: 'POST' });
                    if (!res.enabled || !res.pending) break;
                    if (res.error) { emit({ name: 'calendar', status: 'sync-error', error: res.error }); break; }
                }
            } catch (e) {
                emit({ name: 'calendar', status: 'sync-error', error: e.message });
            } finally {
                running = false;
            }
        }
        return {
            kick() { clearTimeout(timer); timer = setTimeout(loop, 1500); },
            now: loop,
        };
    })();

    // A small "Saved · 2m ago" indicator any page can drop into its top bar.
    function indicator() {
        const node = A.el('span', 'save-indicator', '');
        node.setAttribute('aria-live', 'polite');
        const labels = { dirty: 'Unsaved…', saving: 'Saving…', saved: 'Saved', error: 'Not saved', held: 'Waiting for sign-in' };
        listeners.add((e) => {
            if (!labels[e.status]) return;
            node.textContent = labels[e.status];
            node.className = `save-indicator ${e.status}`;
            if (e.status === 'saved') setTimeout(() => { if (node.classList.contains('saved')) node.textContent = 'All changes saved'; }, 1500);
        });
        return node;
    }

    A.store = {
        plan: createDoc('plan', '/plan'),
        habits: createDoc('habits', '/habits'),
        review: createDoc('review', '/review'),
        workspace,
        on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        indicator,
        walkIds,
    };
})();
