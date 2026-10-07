"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

function extractFunction(signature, nextMarker) {
    const start = appSource.indexOf(signature);
    const end = appSource.indexOf(nextMarker, start);
    assert.notEqual(start, -1, `missing source: ${signature}`);
    assert.notEqual(end, -1, `missing source after: ${signature}`);
    return appSource.slice(start, end).trim();
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeHarness(profileResults = []) {
    const elements = new Map();
    const listeners = new Map();
    const shown = [];
    const hidden = [];
    const messages = [];
    const calls = { getUser: 0, profileRead: 0, setOnline: 0, heartbeat: 0, realtime: 0, callRealtime: 0 };

    for (const id of ["retryProfileLoadBtn", "authMessage", "mainScreen", "authScreen", "authChoice", "signupBox", "loginBox", "otpBox", "profileBox"]) {
        const classes = new Set(id === "mainScreen" || id === "signupBox" || id === "loginBox" || id === "otpBox" || id === "profileBox" ? ["hidden"] : []);
        elements.set(id, {
            disabled: false,
            textContent: id === "retryProfileLoadBtn" ? "Retry" : "",
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                contains(name) { return classes.has(name); }
            },
            addEventListener(type, listener) { listeners.set(`${id}:${type}`, listener); }
        });
    }

    const context = {
        currentUser: { id: "user-a" },
        currentProfile: null,
        window: { TalkSpaceLogger: { debug() {} } },
        console: { error() {} },
        client: {
            auth: {
                async getUser() {
                    calls.getUser += 1;
                    return { data: { user: { id: "user-a" } }, error: null };
                }
            },
            from(table) {
                assert.equal(table, "profiles");
                return {
                    select() { return this; },
                    eq(column, value) {
                        assert.equal(column, "id");
                        assert.equal(value, "user-a");
                        return this;
                    },
                    maybeSingle() {
                        calls.profileRead += 1;
                        return profileResults.shift() || Promise.resolve({
                            data: { id: "user-a", display_name: "User A" },
                            error: null
                        });
                    }
                };
            }
        },
        $(id) { return elements.get(id); },
        show(id) { shown.push(id); elements.get(id)?.classList.remove("hidden"); },
        hide(id) { hidden.push(id); elements.get(id)?.classList.add("hidden"); },
        message(text) { messages.push(text); elements.get("authMessage").textContent = text; },
        async setOnline() { calls.setOnline += 1; },
        startPresenceHeartbeat() { calls.heartbeat += 1; },
        startRealtime() { calls.realtime += 1; },
        startCallRealtime() { calls.callRealtime += 1; },
        clearMessageSelection() {},
        setCallButtonsDisabled() {}
    };

    const invalidator = extractFunction("function invalidateAuthSessionWork()", "function isCurrentAuthLoad");
    const currentLoadCheck = extractFunction("function isCurrentAuthLoad(", "let selectedUser");
    const retryHelpers = extractFunction("function showProfileLoadRetry()", '$("retryProfileLoadBtn").addEventListener');
    const loader = extractFunction("async function loadCurrentUser(", "// SET ONLINE");
    const registration = '$("retryProfileLoadBtn").addEventListener("click", retryProfileLoad);';

    vm.createContext(context);
    vm.runInContext(`let authSessionGeneration = 1; let authUserLoadGeneration = 0; let profileRetryInFlight = false; let profileRetryOperationGeneration = 0; let profileRetryLoadGeneration = null;\n${invalidator}\n${currentLoadCheck}\n${retryHelpers}\n${loader}\n${registration}`, context);

    return { context, elements, listeners, shown, hidden, messages, calls };
}

test("profile read failure shows the existing error and an accessible Retry control", async () => {
    const state = makeHarness([Promise.resolve({ data: null, error: { message: "temporary read failure" } })]);
    await state.context.loadCurrentUser();

    const retry = state.elements.get("retryProfileLoadBtn");
    assert.equal(retry.classList.contains("hidden"), false);
    assert.equal(retry.disabled, false);
    assert.equal(retry.textContent, "Retry");
    assert.match(state.messages.at(-1), /Could not load your profile/);
    assert.match(indexSource, /id="retryProfileLoadBtn"[\s\S]*?aria-label="Retry loading your profile"/);
});

test("Retry click invokes the existing loadCurrentUser path and a successful retry restores normal routing", async () => {
    const state = makeHarness([
        Promise.resolve({ data: null, error: { message: "temporary failure" } }),
        Promise.resolve({ data: { id: "user-a", display_name: "User A" }, error: null })
    ]);
    await state.context.loadCurrentUser();

    await state.listeners.get("retryProfileLoadBtn:click")();
    assert.equal(state.calls.getUser, 2);
    assert.equal(state.calls.profileRead, 2);
    assert.equal(state.calls.setOnline, 1);
    assert.equal(state.elements.get("mainScreen").classList.contains("hidden"), false);
    assert.equal(state.elements.get("retryProfileLoadBtn").classList.contains("hidden"), true);
    assert.equal(state.elements.get("authMessage").textContent, "");
});

test("Retry is disabled while pending and repeated clicks do not overlap profile loads", async () => {
    const pending = deferred();
    const state = makeHarness([
        Promise.resolve({ data: null, error: { message: "temporary failure" } }),
        pending.promise
    ]);
    await state.context.loadCurrentUser();

    const click = state.listeners.get("retryProfileLoadBtn:click");
    const firstRetry = click();
    assert.equal(state.elements.get("retryProfileLoadBtn").disabled, true);
    assert.equal(state.elements.get("retryProfileLoadBtn").textContent, "Retrying...");
    await click();
    assert.equal(state.calls.getUser, 2);
    assert.equal(state.calls.profileRead, 2);

    pending.resolve({ data: null, error: { message: "still unavailable" } });
    await firstRetry;
    assert.equal(state.elements.get("retryProfileLoadBtn").disabled, false);
    assert.equal(state.elements.get("retryProfileLoadBtn").textContent, "Retry");
    assert.equal(state.elements.get("retryProfileLoadBtn").classList.contains("hidden"), false);
});

test("a retry can be attempted again after another profile read failure", async () => {
    const state = makeHarness([
        Promise.resolve({ data: null, error: { message: "first failure" } }),
        Promise.resolve({ data: null, error: { message: "second failure" } })
    ]);
    await state.context.loadCurrentUser();
    await state.listeners.get("retryProfileLoadBtn:click")();

    assert.equal(state.calls.profileRead, 2);
    assert.equal(state.elements.get("retryProfileLoadBtn").classList.contains("hidden"), false);
    assert.equal(state.elements.get("retryProfileLoadBtn").disabled, false);
    assert.match(state.messages.at(-1), /Could not load your profile/);
});

test("session invalidation during retry prevents stale profile state or UI from being restored", async () => {
    const pending = deferred();
    const state = makeHarness([
        Promise.resolve({ data: null, error: { message: "temporary failure" } }),
        pending.promise
    ]);
    await state.context.loadCurrentUser();

    const retry = state.listeners.get("retryProfileLoadBtn:click")();
    vm.runInContext("invalidateAuthSessionWork(); currentUser = null; clearProfileLoadRetry()", state.context);
    pending.resolve({ data: { id: "user-a", display_name: "Stale User" }, error: null });
    await retry;

    assert.equal(state.context.currentProfile, null);
    assert.equal(state.elements.get("mainScreen").classList.contains("hidden"), true);
    assert.equal(state.elements.get("retryProfileLoadBtn").classList.contains("hidden"), true);
    assert.equal(state.calls.setOnline, 0);
});

test("successful initial profile loading remains unchanged and does not expose Retry", async () => {
    const state = makeHarness();
    await state.context.loadCurrentUser();

    assert.equal(state.context.currentProfile.display_name, "User A");
    assert.equal(state.elements.get("mainScreen").classList.contains("hidden"), false);
    assert.equal(state.elements.get("retryProfileLoadBtn").classList.contains("hidden"), true);
    assert.equal(state.calls.setOnline, 1);
});
