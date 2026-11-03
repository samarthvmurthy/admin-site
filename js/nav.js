/**
 * Sidebar + shared chrome.
 *
 * The sidebar has three parts:
 *   - a header naming the current module (with a way back to the dashboard)
 *   - page-specific sections, which each page fills via Nav.setSections()
 *   - a footer dock that jumps between modules, plus theme and logout
 *
 * Each page needs <body data-module="…">, an <aside id="sidebar">, a
 * <div id="sidebar-overlay"> and a .topbar with #menu-toggle.
 */
(function () {
    const ICONS = {
        home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
        plan: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
        upnext: '<path d="M13 3 5 14h6l-1 7 8-11h-6l1-7Z"/>',
        projects: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
        calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
        jobs: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 13h18"/>',
        habits: '<path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.6 1.2 2.5 2 2.5-.5-3 0-5.5 1-8Z"/>',
        pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        logout: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
        brand: '<path d="M8 4 3 12l5 8M16 4l5 8-5 8"/>',
        sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
        moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
        monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
        download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
        upload: '<path d="M12 20V9"/><path d="m7 14 5-5 5 5"/><path d="M5 4h14"/>',
        plus: '<path d="M12 5v14M5 12h14"/>',
        list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
        alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
        clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
        sunrise: '<path d="M12 3v5M4.9 9.9l1.4 1.4M19.1 9.9l-1.4 1.4M2 18h20M7 18a5 5 0 0 1 10 0"/>',
        inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6Z"/>',
        check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
        map: '<path d="M9 4 3 6.5v13L9 17l6 3 6-2.5v-13L15 7 9 4Z"/><path d="M9 4v13M15 7v13"/>',
        github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
        layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
        agenda: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
        refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3.5M20 20v-4h-4"/>',
        external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
        trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
        flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
        target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
        chevronLeft: '<path d="m15 18-6-6 6-6"/>',
        chevronRight: '<path d="m9 18 6-6-6-6"/>',
        menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
        x: '<path d="M6 6l12 12M18 6 6 18"/>',
    };

    const MODULES = [
        { key: 'dashboard', label: 'Dashboard', href: 'index.html', icon: 'home' },
        { key: 'plan', label: 'Plan', href: 'pages/plan.html', icon: 'plan' },
        { key: 'upnext', label: 'Up next', href: 'pages/upnext.html', icon: 'upnext' },
        { key: 'projects', label: 'Projects', href: 'pages/projects.html', icon: 'projects' },
        { key: 'calendar', label: 'Calendar', href: 'pages/calendar.html', icon: 'calendar' },
        { key: 'jobs', label: 'Jobs', href: 'pages/jobs.html', icon: 'jobs' },
    ];

    // Pages live at the root or one level down in /pages; links are written
    // root-relative and prefixed at render time.
    const PREFIX = /\/pages\//.test(window.location.pathname) ? '../' : '';
    const moduleKey = document.body.dataset.module || 'dashboard';
    const current = MODULES.find((m) => m.key === moduleKey) || MODULES[0];

    function svg(name, size = 16) {
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
    }

    function href(path) {
        if (!path || /^(#|https?:|\/)/.test(path)) return path;
        return PREFIX + path;
    }

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ------------------------------------------------------------- sidebar --

    function renderShell() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar) return;
        const back = current.key === 'dashboard' ? '' : `
            <a class="sb-back" href="${href('index.html')}">${svg('chevronLeft', 14)} Dashboard</a>`;

        sidebar.innerHTML = `
            <a class="sb-brand" href="${href('index.html')}">
                <span class="sb-symbol">${svg('brand', 14)}</span>
                <span>Control Panel</span>
            </a>
            <div class="sb-scroll">
                ${back}
                <div class="sb-title">${svg(current.icon, 16)}<span>${esc(current.label)}</span></div>
                <div id="sb-sections"></div>
            </div>
            <div class="sb-foot">
                <nav class="sb-dock" aria-label="Modules">
                    ${MODULES.map((m) => `
                        <a href="${href(m.href)}" class="sb-dock-item${m.key === current.key ? ' active' : ''}" title="${esc(m.label)}" aria-label="${esc(m.label)}">${svg(m.icon, 17)}</a>`).join('')}
                </nav>
                <div class="sb-foot-row">
                    <div class="theme-switch" role="radiogroup" aria-label="Theme">
                        ${[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'monitor', 'System']].map(([v, i, l]) => `
                            <button type="button" role="radio" data-theme-value="${v}" title="${l}" aria-label="${l} theme">${svg(i, 14)}</button>`).join('')}
                    </div>
                    <a href="/cdn-cgi/access/logout" class="sb-logout" title="Log out">${svg('logout', 15)}<span>Log out</span></a>
                </div>
            </div>`;

        sidebar.querySelectorAll('[data-theme-value]').forEach((btn) => {
            btn.addEventListener('click', () => window.Theme.set(btn.dataset.themeValue));
        });
        syncThemeControls();
    }

    function itemNode(item) {
        const tag = item.href ? 'a' : 'button';
        const node = document.createElement(tag);
        node.className = `sb-item${item.active ? ' active' : ''}${item.tone ? ' tone-' + item.tone : ''}`;
        if (item.href) node.href = href(item.href);
        else node.type = 'button';
        if (item.title) node.title = item.title;

        let lead = '';
        if (item.dot) lead = `<span class="sb-dot${item.dotOff ? ' off' : ''}" style="--dot:${esc(item.dot)}"></span>`;
        else if (item.icon) lead = `<span class="sb-item-icon">${svg(item.icon, 15)}</span>`;

        node.innerHTML = `${lead}<span class="sb-item-label">${esc(item.label)}</span>${
            item.count != null && item.count !== '' ? `<span class="sb-count${item.countTone ? ' ' + item.countTone : ''}">${esc(item.count)}</span>` : ''}`;

        node.addEventListener('click', (e) => {
            if (item.onClick) { e.preventDefault(); item.onClick(e); }
            closeDrawer();
        });
        return node;
    }

    /**
     * sections: [{ label?, items: [{ label, href?, onClick?, icon?, dot?,
     *   dotOff?, count?, countTone?, active?, tone?, title? }], action?: { label, onClick } }]
     */
    function setSections(sections) {
        const host = document.getElementById('sb-sections');
        if (!host) return;
        host.innerHTML = '';
        (sections || []).forEach((section) => {
            const wrap = document.createElement('div');
            wrap.className = 'sb-section';
            if (section.label || section.action) {
                const head = document.createElement('div');
                head.className = 'sb-section-head';
                head.innerHTML = `<span>${esc(section.label || '')}</span>`;
                if (section.action) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'sb-section-action';
                    btn.title = section.action.label;
                    btn.setAttribute('aria-label', section.action.label);
                    btn.innerHTML = svg(section.action.icon || 'plus', 14);
                    btn.addEventListener('click', () => { section.action.onClick(); closeDrawer(); });
                    head.appendChild(btn);
                }
                wrap.appendChild(head);
            }
            (section.items || []).forEach((item) => wrap.appendChild(itemNode(item)));
            if (section.empty && !(section.items || []).length) {
                const p = document.createElement('div');
                p.className = 'sb-empty';
                p.textContent = section.empty;
                wrap.appendChild(p);
            }
            host.appendChild(wrap);
        });
    }

    // --------------------------------------------------------------- theme --

    function syncThemeControls() {
        const pref = window.Theme ? window.Theme.get() : 'system';
        document.querySelectorAll('[data-theme-value]').forEach((btn) => {
            const on = btn.dataset.themeValue === pref;
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-checked', String(on));
        });
        const quick = document.getElementById('theme-quick');
        if (quick && window.Theme) {
            const dark = window.Theme.resolved() === 'dark';
            quick.innerHTML = svg(dark ? 'sun' : 'moon', 16);
            quick.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
            quick.setAttribute('aria-label', quick.title);
        }
    }

    // A one-tap light/dark toggle in every page's top bar.
    function injectQuickToggle() {
        const topbar = document.querySelector('.topbar');
        if (!topbar) return;
        let actions = topbar.querySelector('.topbar-actions');
        if (!actions) {
            actions = document.createElement('div');
            actions.className = 'topbar-actions';
            topbar.appendChild(actions);
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'theme-quick';
        btn.className = 'icon-btn';
        btn.addEventListener('click', () => window.Theme.set(window.Theme.resolved() === 'dark' ? 'light' : 'dark'));
        actions.appendChild(btn);
        syncThemeControls();
    }

    // -------------------------------------------------------------- drawer --

    function closeDrawer() {
        document.getElementById('sidebar')?.classList.remove('open');
        document.getElementById('sidebar-overlay')?.classList.remove('visible');
    }

    function initDrawer() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const toggle = document.getElementById('menu-toggle');
        if (!sidebar || !overlay || !toggle) return;
        toggle.innerHTML = svg('menu', 18);
        toggle.addEventListener('click', () => {
            const open = !sidebar.classList.contains('open');
            sidebar.classList.toggle('open', open);
            overlay.classList.toggle('visible', open);
        });
        overlay.addEventListener('click', closeDrawer);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
    }

    renderShell();
    injectQuickToggle();
    initDrawer();
    window.addEventListener('themechange', syncThemeControls);

    window.Nav = { ICONS, MODULES, svg, href, setSections, closeDrawer, module: current.key };
})();
