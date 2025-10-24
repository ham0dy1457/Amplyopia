document.addEventListener('DOMContentLoaded', () => {
    const yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    // Mobile landing option handlers
    const routes = {
        'opt-lazy-eye': () => window.location.href = 'https://color-vision-game2.netlify.app/',
        'opt-vision-test': () => { window.location.href = 'vision-test.html'; },
        'opt-guidelines': () => { window.location.href = 'guidelines.html'; },
        'opt-report': () => alert('Report selected')
    };
    Object.keys(routes).forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', routes[id]);
    });

    // Back button on secondary pages
    const backBtn = document.getElementById('back-btn');
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            if (window.history.length > 1) {
                window.history.back();
            } else {
                window.location.href = 'index.html';
            }
        });
    }

    // Remove old demo form behavior if form isn't present
});


