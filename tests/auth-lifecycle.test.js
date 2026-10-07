"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");

function extractFunction(source, signature, nextSection) {
    const start = source.indexOf(signature);
    const end = source.indexOf(nextSection, start);
    assert.notEqual(start, -1, `missing function: ${signature}`);
    assert.notEqual(end, -1, `missing section after: ${signature}`);
    return source.slice(start, end).trim();
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeLifecycleHarness({ userId = "user-a", profilePromise } = {}) {
    const shown = [];
    const hidden = [];
    const calls = { setOnline: 0, heartbeat: 0, realtime: 0, callRealtime: 0, load: 0 };
    const elements = new Map();
    for (const id of ["mainScreen"]) {
        elements.set(id, {
            classList: {
                add() {},
                remove() {}
            }
        });
    }
    const context = {
        currentUser: userId ? { id: userId } : null,
        currentProfile: null,
        profileRetryInFlight: false,
        profileRetryLoadGeneration: null,
        profileRetryOperationGeneration: 0,
        clearProfileLoadRetry() {},
        showProfileLoadRetry() {},
        window: { TalkSpaceLogger: { debug() {} } },
        client: {
            auth: {
                async getUser() {
                    return { data: { user: { id: userId } }, error: null };
                }
            },
            from(table) {
                assert.equal(table, "profiles");
                const query = {
                    select() { return this; },
                    eq(column, value) {
                        assert.equal(column, "id");
                        assert.equal(value, userId);
                        return this;
                    },
                    maybeSingle() {
                        return profilePromise || Promise.resolve({
                            data: { id: userId, display_name: "User A" },
                            error: null
                        });
                    }
                };
                return query;
            }
        },
        $: id => elements.get(id) || (elements.set(id, { classList: { add() {}, remove() {} } }), elements.get(id)),
        show(id) { shown.push(id); },
        hide(id) { hidden.push(id); },
        message() {},
        async setOnline() { calls.setOnline += 1; },
        startPresenceHeartbeat() { calls.heartbeat += 1; },
        startRealtime() { calls.realtime += 1; },
        startCallRealtime() { calls.callRealtime += 1; },
        clearMessageSelection() {}
    };

    const lifecycleHelpers = [
        extractFunction(appSource, "function invalidateAuthSessionWork()", "function isCurrentAuthLoad"),
        appSource.match(/function isCurrentAuthLoad\([\s\S]*?\n\}/)?.[0]
    ].join("\n");
    const loadCurrentUser = extractFunction(appSource, "async function loadCurrentUser(", "// SET ONLINE");
    vm.createContext(context);
    vm.runInContext(`let authSessionGeneration = 0; let authUserLoadGeneration = 0; let observedAuthIdentityId = null;\n${lifecycleHelpers}\n${loadCurrentUser}`, context);
    return { context, calls, shown, hidden };
}

async function reachProfileRead() {
    await new Promise(resolve => setImmediate(resolve));
}

test("sign-out invalidation prevents a pending User A profile read restoring private UI", async () => {
    const profile = deferred();
    const state = makeLifecycleHarness({ profilePromise: profile.promise });
    const loading = vm.runInContext("loadCurrentUser()", state.context);
    await reachProfileRead();

    // This is the same invalidator used at the start of signed-out cleanup.
    vm.runInContext("invalidateAuthSessionWork()", state.context);
    profile.resolve({ data: { id: "user-a", display_name: "User A" }, error: null });
    await loading;

    assert.match(appSource, /async function cleanupSignedOutState\(\)\s*\{[\s\S]*?invalidateAuthSessionWork\(\);/);
    assert.equal(state.context.currentProfile, null);
    assert.equal(state.shown.includes("mainScreen"), false);
    assert.equal(state.calls.setOnline, 0);
    assert.equal(state.calls.heartbeat, 0);
    assert.equal(state.calls.realtime, 0);
    assert.equal(state.calls.callRealtime, 0);
});

test("a User A profile read cannot overwrite a newer User B session", async () => {
    const profile = deferred();
    const state = makeLifecycleHarness({ profilePromise: profile.promise });
    const loading = vm.runInContext("loadCurrentUser()", state.context);
    await reachProfileRead();

    state.context.currentUser = { id: "user-b" };
    state.context.currentProfile = { id: "user-b", display_name: "User B" };
    vm.runInContext("invalidateAuthSessionWork()", state.context);
    profile.resolve({ data: { id: "user-a", display_name: "User A" }, error: null });
    await loading;

    assert.equal(state.context.currentUser.id, "user-b");
    assert.equal(
        JSON.stringify(state.context.currentProfile),
        JSON.stringify({ id: "user-b", display_name: "User B" })
    );
    assert.equal(state.shown.includes("mainScreen"), false);
    assert.equal(state.calls.setOnline, 0);
    assert.equal(state.calls.heartbeat, 0);
    assert.equal(state.calls.realtime, 0);
});

test("the current user's profile and authenticated UI load when the session stays current", async () => {
    const state = makeLifecycleHarness();
    await vm.runInContext("loadCurrentUser()", state.context);

    assert.deepEqual(JSON.parse(JSON.stringify(state.context.currentProfile)), {
        id: "user-a",
        display_name: "User A"
    });
    assert.equal(state.shown.includes("mainScreen"), true);
    assert.equal(state.calls.setOnline, 1);
    assert.equal(state.calls.heartbeat, 1);
    assert.equal(state.calls.realtime, 1);
    assert.equal(state.calls.callRealtime, 1);
});

test("startup session restoration does not apply after an auth choice invalidates it", async () => {
    const session = deferred();
    const called = { load: 0, shown: [] };
    const context = {
        window: { TalkSpaceLogger: { debug() {} } },
        client: { auth: { getSession: () => session.promise } },
        loadCurrentUser() { called.load += 1; },
        hide(id) {},
        show(id) { called.shown.push(id); }
    };
    const initializeApp = extractFunction(appSource, "async function initializeApp()", "// START APPLICATION");
    const invalidator = extractFunction(appSource, "function invalidateAuthSessionWork()", "function isCurrentAuthLoad");
    vm.createContext(context);
    vm.runInContext(`let authSessionGeneration = 0;\n${invalidator}\n${initializeApp}`, context);

    const initializing = vm.runInContext("initializeApp()", context);
    vm.runInContext("invalidateAuthSessionWork()", context);
    session.resolve({ data: { session: { user: { id: "user-a" } } }, error: null });
    await initializing;

    assert.equal(called.load, 0);
    assert.deepEqual(called.shown, []);
    assert.match(appSource, /\$\("showSignupBtn"\)[\s\S]*?invalidateAuthSessionWork\(\)/);
    assert.match(appSource, /\$\("showLoginBtn"\)[\s\S]*?invalidateAuthSessionWork\(\)/);
});
