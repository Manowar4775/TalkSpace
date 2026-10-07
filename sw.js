// TalkSpace's authenticated features require a live network connection. The
// worker therefore bypasses browser/CacheStorage caches for app requests and
// only remains to retire caches created by older TalkSpace releases.
const LEGACY_CACHE_PREFIX = "talkspace-";

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(cacheNames => Promise.all(
            cacheNames
                .filter(cacheName => cacheName.startsWith(LEGACY_CACHE_PREFIX))
                .map(cacheName => caches.delete(cacheName))
        ))
    );
});

self.addEventListener("fetch", event => {
    const request = event.request;

    if (request.method !== "GET") return;

    const requestUrl = new URL(request.url);
    if (requestUrl.origin !== self.location.origin) return;

    // Do not read from or write to CacheStorage, and bypass the browser's HTTP
    // cache so an app deployment is not masked by an older local asset copy.
    event.respondWith(fetch(request, { cache: "no-store" }));
});
