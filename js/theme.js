/**
 * Light / dark / system theme. Loaded synchronously in <head> so the right
 * palette is applied before first paint (no flash of the wrong theme).
 */
(function () {
    const KEY = 'cp:theme';
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    function get() {
        try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
    }

    function resolve(pref) {
        return pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
    }

    function apply(pref) {
        const root = document.documentElement;
        root.dataset.theme = resolve(pref);
        root.dataset.themePref = pref;
    }

    function set(pref) {
        try { localStorage.setItem(KEY, pref); } catch { /* private mode: still apply */ }
        apply(pref);
        window.dispatchEvent(new CustomEvent('themechange', { detail: { pref, theme: resolve(pref) } }));
    }

    apply(get());
    media.addEventListener('change', () => { if (get() === 'system') set('system'); });

    window.Theme = { get, set, resolved: () => resolve(get()) };
})();
