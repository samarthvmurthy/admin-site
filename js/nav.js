/**
 * Renders the sidebar from one config so nav markup isn't duplicated across
 * pages, then wires the folder toggles, active highlighting and mobile drawer.
 *
 * Each page only needs:  <aside class="sidebar" id="sidebar"></aside>
 *                        <div class="sidebar-overlay" id="sidebar-overlay"></div>
 */
(function () {
    const ICONS = {
        home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
        folder: '<path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z"/>',
        file: '<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v4h4"/>',
        grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
        calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
        pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
        logout: '<path d="M9 21H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
        brand: '<path d="M8 4 3 12l5 8M16 4l5 8-5 8"/>',
        chevron: '<path d="M6 4l4 4-4 4"/>',
    };

    // Pages live either at the root or one level down in /pages, so links are
    // written root-relative here and prefixed at render time.
    const inPages = /\/pages\//.test(window.location.pathname);
    const PREFIX = inPages ? '../' : '';

    const NAV = [
        { label: 'Dashboard', href: 'index.html', icon: 'home' },
        { label: 'Projects', href: 'index.html#panel-projects', icon: 'grid' },
        { label: 'Calendar', href: 'pages/calendar.html', icon: 'calendar' },
        {
            label: 'Portfolio Editor',
            key: 'portfolio-editor',
            icon: 'folder',
            children: [
                { label: 'Overview', href: 'pages/portfolio.html' },
                { label: 'Site & Hero', href: 'pages/portfolio.html#panel-site' },
                { label: 'About', href: 'pages/portfolio.html#panel-about' },
                { label: 'Projects', href: 'pages/portfolio.html#panel-projects' },
                { label: 'Journey', href: 'pages/portfolio.html#panel-journey' },
                { label: 'Contact', href: 'pages/portfolio.html#panel-contact' },
            ],
        },
    ];

    function svg(name, size) {
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    }

    function leafMarkup(item) {
        return `
            <li class="tree-item">
                <a href="${PREFIX}${item.href}" class="tree-row">
                    <span class="tree-toggle spacer">&#9656;</span>
                    <span class="tree-icon">${svg(item.icon || 'file', 15)}</span>
                    <span class="tree-label">${item.label}</span>
                </a>
            </li>`;
    }

    function folderMarkup(item) {
        return `
            <li class="tree-item" data-key="${item.key}">
                <div class="tree-row tree-folder">
                    <span class="tree-toggle"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.chevron}</svg></span>
                    <span class="tree-icon">${svg(item.icon || 'folder', 15)}</span>
                    <span class="tree-label">${item.label}</span>
                </div>
                <ul class="tree-children">${item.children.map(leafMarkup).join('')}</ul>
            </li>`;
    }

    function render() {
        const sidebar = document.getElementById('sidebar');
        if (!sidebar || sidebar.dataset.rendered) return;
        sidebar.dataset.rendered = '1';
        sidebar.innerHTML = `
            <div class="brand">
                <span class="symbol"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS.brand}</svg></span>
                Admin
            </div>
            <div class="sidebar-scroll">
                <div class="nav-section-label">Explorer</div>
                <ul class="tree">
                    ${NAV.map((i) => (i.children ? folderMarkup(i) : leafMarkup(i))).join('')}
                </ul>
            </div>
            <a href="/cdn-cgi/access/logout" class="logout">${svg('logout', 15)} Log out</a>`;
    }

    function currentFile() {
        return window.location.pathname.replace(/\/+$/, '').split('/').pop() || 'index.html';
    }

    function applyAutoState() {
        // Only expand a folder when you're actually on one of its pages.
        document.querySelectorAll('.tree-item[data-key]').forEach((folder) => {
            const onChildPage = Array.from(folder.querySelectorAll('.tree-row[href]')).some((row) => {
                const url = new URL(row.getAttribute('href'), window.location.href);
                return (url.pathname.replace(/\/+$/, '').split('/').pop() || 'index.html') === currentFile();
            });
            folder.classList.toggle('collapsed', !onChildPage);
        });
    }

    function initToggles() {
        document.querySelectorAll('.tree-folder').forEach((row) => {
            row.addEventListener('click', () => row.closest('.tree-item').classList.toggle('collapsed'));
        });
    }

    function highlightActive() {
        const current = currentFile();
        const hash = window.location.hash;
        let bestMatch = null;

        document.querySelectorAll('.tree-row[href]').forEach((row) => {
            row.classList.remove('active');
            const url = new URL(row.getAttribute('href'), window.location.href);
            const rowFile = url.pathname.replace(/\/+$/, '').split('/').pop() || 'index.html';
            if (rowFile !== current) return;
            // Prefer an exact hash match, then a hashless row, then anything.
            if (hash && url.hash === hash) bestMatch = row;
            else if (!hash && !url.hash && !bestMatch) bestMatch = row;
            else if (!bestMatch) bestMatch = row;
        });

        if (bestMatch) bestMatch.classList.add('active');
    }

    function initMobileDrawer() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebar-overlay');
        const toggle = document.getElementById('menu-toggle');
        if (!sidebar || !overlay || !toggle) return;

        const close = () => { sidebar.classList.remove('open'); overlay.classList.remove('visible'); };
        const open = () => { sidebar.classList.add('open'); overlay.classList.add('visible'); };

        toggle.addEventListener('click', () => (sidebar.classList.contains('open') ? close() : open()));
        overlay.addEventListener('click', close);
        document.querySelectorAll('.tree-row[href]').forEach((row) => row.addEventListener('click', close));
        window.addEventListener('hashchange', close);
    }

    render();
    applyAutoState();
    initToggles();
    highlightActive();
    initMobileDrawer();
    window.addEventListener('hashchange', highlightActive);
})();
