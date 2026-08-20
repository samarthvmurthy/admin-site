(function () {
    const STORAGE_KEY = 'admin_tree_state';

    function loadState() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveState(state) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function applyExpandedState() {
        const state = loadState();
        document.querySelectorAll('.tree-item[data-key]').forEach((item) => {
            const key = item.dataset.key;
            const expanded = key in state ? state[key] : true;
            item.classList.toggle('collapsed', !expanded);
        });
    }

    function initToggles() {
        document.querySelectorAll('.tree-folder').forEach((row) => {
            row.addEventListener('click', () => {
                const item = row.closest('.tree-item');
                const key = item.dataset.key;
                const collapsed = item.classList.toggle('collapsed');
                if (key) {
                    const state = loadState();
                    state[key] = !collapsed;
                    saveState(state);
                }
            });
        });
    }

    function highlightActive() {
        const current = window.location.pathname.replace(/\/+$/, '').split('/').pop() || 'index.html';
        const hash = window.location.hash;
        let bestMatch = null;

        document.querySelectorAll('.tree-row[href]').forEach((row) => {
            row.classList.remove('active');
            const url = new URL(row.getAttribute('href'), window.location.href);
            const rowFile = url.pathname.replace(/\/+$/, '').split('/').pop() || 'index.html';
            if (rowFile !== current) return;
            if (hash && url.hash === hash) {
                bestMatch = row;
            } else if (!hash && !url.hash && !bestMatch) {
                bestMatch = row;
            } else if (!bestMatch) {
                bestMatch = row;
            }
        });

        if (bestMatch) bestMatch.classList.add('active');
    }

    document.querySelectorAll('.tree-row[href]').forEach((row) => {
        row.addEventListener('click', () => {
            document.querySelectorAll('.tree-row').forEach((r) => r.classList.remove('active'));
            row.classList.add('active');
        });
    });

    window.addEventListener('hashchange', highlightActive);

    applyExpandedState();
    initToggles();
    highlightActive();
})();
