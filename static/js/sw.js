const CACHE_NAME = 'iett-pc-v2';
const urlsToCache = [
    './',
    './static/css/style.css',
    './static/js/main.js',
    './static/img/icon.ico',
    './static/img/ibb_logo.png',
    './static/img/iett_logo.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(urlsToCache);
            })
    );
});

self.addEventListener('fetch', event => {
    // Basit cache-first stratejisi (Offline destegi icin)
    // Ancak dinamik API isteklerini cachelememeliyiz (/api/)
    if (event.request.url.includes('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request);
            })
    );
});
