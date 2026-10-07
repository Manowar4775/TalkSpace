"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const workerSource = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "index.html"), "utf8");

function loadWorker(options = {}) {
    const handlers = new Map();
    const cacheNames = options.cacheNames || [];
    const deletedCaches = [];
    const fetchCalls = [];
    const self = {
        location: { origin: "https://talkspace.example" },
        addEventListener(type, callback) { handlers.set(type, callback); }
    };
    const caches = {
        keys: async () => cacheNames,
        delete: async name => { deletedCaches.push(name); return true; }
    };
    const fetch = async (...args) => {
        fetchCalls.push(args);
        return { ok: true, source: "network" };
    };
    vm.runInNewContext(workerSource, { self, caches, fetch, URL });
    return { handlers, deletedCaches, fetchCalls };
}

test("activation deletes obsolete TalkSpace caches and leaves unrelated caches intact", async () => {
    const worker = loadWorker({ cacheNames: ["talkspace-v2", "talkspace-old-shell", "other-app"] });
    let activation;
    worker.handlers.get("activate")({ waitUntil(promise) { activation = promise; } });
    await activation;
    assert.deepEqual(worker.deletedCaches, ["talkspace-v2", "talkspace-old-shell"]);
});

test("same-origin GET resources are fetched from network without cache", async () => {
    const worker = loadWorker();
    let response;
    worker.handlers.get("fetch")({
        request: { method: "GET", url: "https://talkspace.example/src/app.js", destination: "script" },
        respondWith(promise) { response = promise; }
    });
    const result = await response;
    assert.equal(result.source, "network");
    assert.equal(worker.fetchCalls.length, 1);
    assert.equal(worker.fetchCalls[0][1].cache, "no-store");
});

test("non-GET and cross-origin requests are not intercepted", () => {
    const worker = loadWorker();
    for (const request of [
        { method: "POST", url: "https://talkspace.example/api" },
        { method: "GET", url: "https://cdn.example/library.js" }
    ]) {
        let intercepted = false;
        worker.handlers.get("fetch")({ request, respondWith() { intercepted = true; } });
        assert.equal(intercepted, false);
    }
});

test("app registers one update-aware worker in production and retires it on localhost", () => {
    assert.equal((indexSource.match(/serviceWorker\s*\.\s*register\s*\(/g) || []).length, 1);
    assert.match(indexSource, /updateViaCache:\s*"none"/);
    assert.match(indexSource, /await registration\.update\(\)/);
    assert.match(indexSource, /isLocalDevelopment/);
    assert.match(indexSource, /registration\.unregister\(\)/);
    assert.match(indexSource, /cacheName\.startsWith\("talkspace-"\)/);

    const maintenanceScript = indexSource.match(
        /<!--[\s\S]*?SERVICE WORKER[\s\S]*?-->\s*<script>([\s\S]*?)<\/script>/
    );
    assert.ok(maintenanceScript, "service-worker maintenance script exists");
    assert.doesNotThrow(() => new vm.Script(maintenanceScript[1]));
});

test("manifest is valid and its icon resources exist", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "TalkSpace");
    assert.equal(manifest.short_name, "TalkSpace");
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.start_url);
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
    for (const icon of manifest.icons) {
        assert.ok(fs.existsSync(path.join(root, icon.src.replace(/^\.\//, ""))), `${icon.src} exists`);
    }
});
