(function () {
    function isPortfolioPage() {
        return window.location.pathname.replace(/\/+$/, '').split('/').pop() === 'portfolio.html';
    }

    function applyAutoState() {
        const folder = document.querySelector('.tree-item[data-key="portfolio-editor"]');
        if (folder) folder.classList.toggle('collapsed', !isPortfolioPage());
    }

    function initToggles() {
        document.querySelectorAll('.tree-folder').forEach((row) => {
            row.addEventListener('click', () => {
                row.closest('.tree-item').classList.toggle('collapsed');
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

    applyAutoState();
    initToggles();
    highlightActive();
})();
