/**
 * Shared API client + DOM/format/date helpers, exposed as window.Admin.
 * Namespaced on purpose: portfolio.js declares its own top-level `toast` and
 * `API_BASE`, and two scripts on one page must not collide.
 */
window.Admin = (function () {
    const API_BASE = '/api';
    const TIME_ZONE = (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
    })();

    // ------------------------------------------------------------- network --

    // The site sits behind Cloudflare Access, whose sessions end at a fixed
    // time. After that, /api answers with a redirect to the login page. A
    // fetch that follows it dies on CORS with a bare "Failed to fetch", so
    // redirects are never followed. An expired session sends the whole page
    // to the login instead, which returns here afterwards; unsaved edits wait
    // in localStorage and are restored on the way back (see store.js).
    const session = (function () {
        const CHECK_EVERY = 5 * 60 * 1000;
        const LOOP_GUARD = 60 * 1000;
        const GUARD_KEY = 'cp-sign-in-redirect';
        const backFns = new Set();
        const leavingFns = new Set();
        let expired = false;
        let checking = false;
        let lastCheck = Date.now();

        function isSignedOut(res) {
            if (res.type === 'opaqueredirect') return true;
            // The worker's own errors (including ones relayed from Google or
            // GitHub) are JSON; a bare 401/403 can only have come from Access.
            const isJson = (res.headers.get('Content-Type') || '').includes('application/json');
            return (res.status === 401 || res.status === 403) && !isJson;
        }

        function goToSignIn() {
            // A half-filled dialog isn't saved anywhere, so let it finish first.
            if (document.querySelector('.modal-backdrop.visible')) {
                setTimeout(goToSignIn, 500);
                return;
            }
            leavingFns.forEach((fn) => fn());
            // If the page loads but /api still refuses it, reloading again
            // would only loop.
            let last = 0;
            try { last = Number(sessionStorage.getItem(GUARD_KEY)) || 0; } catch { /* blocked */ }
            if (Date.now() - last < LOOP_GUARD) {
                toast('Still signed out after signing in. Your changes are kept; try reloading in a minute.', 'error');
                return;
            }
            try { sessionStorage.setItem(GUARD_KEY, String(Date.now())); } catch { /* blocked */ }
            window.location.reload();
        }

        function expire() {
            if (!expired) {
                expired = true;
                if (document.querySelector('.modal-backdrop.visible')) toast('Your sign-in expired. You\'ll sign in again when you close this dialog.', 'error');
                goToSignIn();
            }
            const err = new Error('Your sign-in expired.');
            err.status = 401;
            err.sessionExpired = true;
            return err;
        }

        async function check() {
            if (checking) return;
            checking = true;
            lastCheck = Date.now();
            try {
                const res = await fetch(`${API_BASE}/calendar/status`, { redirect: 'manual', cache: 'no-store' });
                if (isSignedOut(res)) {
                    expire();
                } else if (res.ok) {
                    expired = false;
                    backFns.forEach((fn) => fn());
                }
            } catch {
                // Offline: says nothing about the session.
            } finally {
                checking = false;
            }
        }

        function checkIfDue() {
            if (document.visibilityState === 'visible' && (expired || Date.now() - lastCheck >= CHECK_EVERY)) check();
        }

        window.addEventListener('focus', checkIfDue);
        window.addEventListener('online', check);
        document.addEventListener('visibilitychange', checkIfDue);
        setInterval(checkIfDue, CHECK_EVERY);

        return {
            isExpired: () => expired,
            // Runs after any successful check, to retry what failed earlier.
            onBack(fn) { backFns.add(fn); },
            // Runs just before the page leaves for the login: back up edits.
            onLeaving(fn) { leavingFns.add(fn); },
            async fetch(url, init = {}) {
                const res = await window.fetch(url, { ...init, redirect: 'manual' });
                if (isSignedOut(res)) throw expire();
                return res;
            },
        };
    })();

    async function api(path, options = {}) {
        const res = await session.fetch(`${API_BASE}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', 'X-Time-Zone': TIME_ZONE, ...options.headers },
            body: options.body != null && typeof options.body !== 'string'
                ? JSON.stringify(options.body)
                : options.body,
        });
        const text = await res.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text.slice(0, 200) }; }
        if (!res.ok) {
            const err = new Error(payload?.error || `Request failed (${res.status})`);
            err.status = res.status;
            throw err;
        }
        return payload;
    }

    // ----------------------------------------------------------------- DOM --

    function el(tag, className, text) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text != null) e.textContent = text;
        return e;
    }

    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
        return node;
    }

    // Named icon from the shared set in nav.js.
    function icon(name, size = 15, className = 'inline-icon') {
        const span = el('span', className);
        span.innerHTML = window.Nav ? window.Nav.svg(name, size) : '';
        return span;
    }

    function toast(msg, kind) {
        let host = document.getElementById('toast-host');
        if (!host) {
            host = el('div', 'toast-host');
            host.id = 'toast-host';
            host.setAttribute('role', 'status');
            document.body.appendChild(host);
        }
        const t = el('div', `toast${kind ? ' ' + kind : ''}`, msg);
        host.appendChild(t);
        setTimeout(() => t.classList.add('leaving'), 3600);
        setTimeout(() => t.remove(), 4000);
    }

    function button(label, className, onClick) {
        const b = el('button', className, label);
        b.type = 'button';
        if (onClick) b.addEventListener('click', onClick);
        return b;
    }

    function iconButton(name, title, onClick, className = 'icon-btn') {
        const b = el('button', className);
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        b.innerHTML = window.Nav ? window.Nav.svg(name, 15) : '';
        if (onClick) b.addEventListener('click', onClick);
        return b;
    }

    function link(text, href, className) {
        const a = el('a', className, text);
        a.href = window.Nav ? window.Nav.href(href) : href;
        return a;
    }

    function externalLink(text, href, className) {
        const a = el('a', className, text);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        return a;
    }

    function checkbox(checked, onChange, label) {
        const box = el('button', `check${checked ? ' on' : ''}`);
        box.type = 'button';
        box.setAttribute('role', 'checkbox');
        box.setAttribute('aria-checked', String(Boolean(checked)));
        box.setAttribute('aria-label', label || (checked ? 'Mark not done' : 'Mark done'));
        box.innerHTML = window.Nav ? window.Nav.svg('check', 12) : '';
        box.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); onChange(!checked); });
        return box;
    }

    // Collapse bursts of keystrokes into one call.
    function debounce(fn, ms = 800) {
        let timer = null;
        const wrapped = (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), ms);
        };
        wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
        wrapped.cancel = () => clearTimeout(timer);
        return wrapped;
    }

    function uid() {
        return Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 8);
    }

    // --------------------------------------------------------------- dates --
    //
    // Due dates are stored as local "YYYY-MM-DD" keys, never as UTC instants,
    // so "due Tuesday" means Tuesday wherever you are.

    const pad = (n) => String(n).padStart(2, '0');

    function dateKey(d = new Date()) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }

    // Google returns all-day events as a bare "YYYY-MM-DD". `new Date()` reads
    // that as UTC midnight, which is the *previous* day west of Greenwich, so
    // date-only values are built as a local date instead.
    function parseDate(value) {
        if (value instanceof Date) return value;
        if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
            const [y, m, d] = value.split('-').map(Number);
            return new Date(y, m - 1, d);
        }
        return new Date(value);
    }

    function addDays(key, n) {
        const d = parseDate(key);
        d.setDate(d.getDate() + n);
        return dateKey(d);
    }

    // Whole days from a to b (b later → positive).
    function daysBetween(a, b) {
        return Math.round((parseDate(b) - parseDate(a)) / 86400000);
    }

    function todayKey() {
        return dateKey(new Date());
    }

    function startOfWeekKey(key) {
        const d = parseDate(key);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // weeks start Monday
        return dateKey(d);
    }

    function dueLabel(key) {
        if (!key) return '';
        const diff = daysBetween(todayKey(), key);
        if (diff === 0) return 'Today';
        if (diff === 1) return 'Tomorrow';
        if (diff === -1) return 'Yesterday';
        if (diff < 0) return `${-diff}d overdue`;
        const d = parseDate(key);
        if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'short' });
        const sameYear = d.getFullYear() === new Date().getFullYear();
        return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function dueTone(key, done) {
        if (!key || done) return '';
        const diff = daysBetween(todayKey(), key);
        if (diff < 0) return 'overdue';
        if (diff === 0) return 'today';
        if (diff <= 2) return 'soon';
        return '';
    }

    function relativeTime(iso) {
        if (!iso) return '—';
        const diff = Date.now() - parseDate(iso).getTime();
        const mins = Math.round(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.round(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.round(hours / 24);
        if (days < 30) return `${days}d ago`;
        const months = Math.round(days / 30);
        if (months < 12) return `${months}mo ago`;
        return `${Math.round(months / 12)}y ago`;
    }

    function shortDate(iso) {
        if (!iso) return '';
        return parseDate(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    function timeOfDay(iso) {
        if (!iso) return '';
        return parseDate(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    // "14:30" → "2:30 PM" in the viewer's locale.
    function formatTime(hhmm) {
        if (!hhmm) return '';
        const [h, m] = hhmm.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    function greeting() {
        const h = new Date().getHours();
        if (h < 5) return 'Working late';
        if (h < 12) return 'Good morning';
        if (h < 17) return 'Good afternoon';
        return 'Good evening';
    }

    // ------------------------------------------------------------ priority --

    const PRIORITIES = [
        { value: 'high', label: 'High' },
        { value: 'medium', label: 'Medium' },
        { value: 'low', label: 'Low' },
    ];
    const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

    function priorityRank(p) {
        return PRIORITY_RANK[p] ?? 1;
    }

    function priorityFlag(p) {
        const f = el('span', `prio prio-${p || 'medium'}`);
        f.title = `${(p || 'medium')[0].toUpperCase()}${(p || 'medium').slice(1)} priority`;
        return f;
    }

    function dueChip(key, time, done) {
        if (!key) return null;
        const chip = el('span', `due-chip ${dueTone(key, done)}`);
        chip.textContent = time ? `${dueLabel(key)} · ${formatTime(time)}` : dueLabel(key);
        chip.title = parseDate(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        return chip;
    }

    // ------------------------------------------------------------ language --

    // Stable per-language colours, roughly matching GitHub's palette.
    const LANG_COLORS = {
        JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572A5', HTML: '#e34c26',
        CSS: '#563d7c', Java: '#b07219', C: '#555555', 'C++': '#f34b7d', 'C#': '#178600',
        Go: '#00ADD8', Rust: '#dea584', Ruby: '#701516', PHP: '#4F5D95', Swift: '#F05138',
        Kotlin: '#A97BFF', Shell: '#89e051', Dart: '#00B4AB', Vue: '#41b883', Svelte: '#ff3e00',
        Jupyter: '#DA5B0B', 'Jupyter Notebook': '#DA5B0B', SCSS: '#c6538c', Dockerfile: '#384d54',
        Makefile: '#427819', Lua: '#000080', R: '#198CE7', MDX: '#fcb32c',
    };

    function langColor(name) {
        if (LANG_COLORS[name]) return LANG_COLORS[name];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
        return `hsl(${hash} 55% 52%)`;
    }

    function langBar(languages, limit = 5) {
        const entries = Object.entries(languages || {}).sort((a, b) => b[1] - a[1]);
        if (!entries.length) return null;
        const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;

        const wrap = el('div');
        const bar = el('div', 'lang-bar');
        entries.forEach(([name, value]) => {
            const seg = el('span', 'lang-seg');
            seg.style.width = `${(value / total) * 100}%`;
            seg.style.background = langColor(name);
            seg.title = `${name} ${((value / total) * 100).toFixed(1)}%`;
            bar.appendChild(seg);
        });
        wrap.appendChild(bar);

        const legend = el('div', 'lang-legend');
        entries.slice(0, limit).forEach(([name, value]) => {
            const item = el('span', 'lang-legend-item');
            const dot = el('span', 'lang-dot');
            dot.style.background = langColor(name);
            item.appendChild(dot);
            item.appendChild(el('span', null, `${name} ${((value / total) * 100).toFixed(0)}%`));
            legend.appendChild(item);
        });
        wrap.appendChild(legend);
        return wrap;
    }

    function progressBar(done, total, large) {
        const wrap = el('div', 'progress-wrap');
        const track = el('div', `progress-track${large ? ' progress-track-lg' : ''}`);
        const fill = el('div', 'progress-fill');
        fill.style.width = `${total ? (done / total) * 100 : 0}%`;
        track.appendChild(fill);
        wrap.appendChild(track);
        wrap.appendChild(el('span', 'progress-label', `${done}/${total}`));
        return wrap;
    }

    // -------------------------------------------------------------- params --

    function param(name) {
        return new URLSearchParams(window.location.search).get(name);
    }

    function hashParams() {
        return new URLSearchParams(window.location.hash.replace(/^#/, ''));
    }

    function pageHref(path) {
        return window.Nav ? window.Nav.href(path) : path;
    }

    function projectHref(id) {
        return pageHref(`pages/project.html?id=${encodeURIComponent(id)}`);
    }

    // Extra tools that belong to a particular project. The portfolio repo's
    // content editor is the first; add more here as projects grow them.
    const PROJECT_TOOLS = {
        'gh:samarthvmurthy/portfolio': [
            { label: 'Edit site content', icon: 'pencil', href: 'pages/portfolio.html', hint: 'Hero, about, featured projects, journey and contact on samarthvmurthy.dev' },
        ],
    };

    function projectTools(id) {
        return PROJECT_TOOLS[id] || [];
    }

    function projectLabel(id) {
        return String(id || '').replace(/^gh:[^/]+\//, '').replace(/^custom:/, '');
    }

    return {
        API_BASE, TIME_ZONE, session, api, el, clear, icon, toast, button, iconButton, link, externalLink,
        checkbox, debounce, uid,
        dateKey, parseDate, addDays, daysBetween, todayKey, startOfWeekKey, dueLabel, dueTone,
        relativeTime, shortDate, timeOfDay, formatTime, greeting,
        PRIORITIES, priorityRank, priorityFlag, dueChip,
        langColor, langBar, progressBar,
        param, hashParams, pageHref, projectHref, projectLabel, projectTools,
    };
})();
