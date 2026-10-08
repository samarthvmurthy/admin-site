/**
 * Shared API client + DOM/format helpers, exposed as window.Admin.
 * Namespaced on purpose: portfolio.js declares its own top-level `toast` and
 * `API_BASE`, and two scripts on one page must not collide.
 */
window.Admin = (function () {
    const API_BASE = '/api';

    // ------------------------------------------------------------- network --

    async function api(path, options = {}) {
        const res = await fetch(`${API_BASE}${path}`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers },
            body: options.body != null && typeof options.body !== 'string'
                ? JSON.stringify(options.body)
                : options.body,
        });
        const text = await res.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
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

    function icon(path, size = 15) {
        const span = el('span', 'inline-icon');
        span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
        return span;
    }

    function toast(msg, kind) {
        const t = el('div', `toast${kind ? ' ' + kind : ''}`, msg);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4000);
    }

    function button(label, className, onClick) {
        const b = el('button', className, label);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }

    // Collapse bursts of keystrokes into one save.
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
        return Math.random().toString(36).slice(2, 10);
    }

    // -------------------------------------------------------------- format --

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
        // Deterministic fallback hue so unknown languages stay consistent.
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

    // -------------------------------------------------------------- params --

    function param(name) {
        return new URLSearchParams(window.location.search).get(name);
    }

    function projectHref(id, prefix = '') {
        return `${prefix}pages/project.html?id=${encodeURIComponent(id)}`;
    }

    return {
        API_BASE, api, el, clear, icon, toast, button, debounce, uid, parseDate,
        relativeTime, shortDate, timeOfDay, langColor, langBar, param, projectHref,
    };
})();
