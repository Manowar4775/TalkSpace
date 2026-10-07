"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");

function extractBetween(startMarker, endMarker) {
    const start = appSource.indexOf(startMarker);
    const end = appSource.indexOf(endMarker, start);
    assert.notEqual(start, -1, "missing source marker: " + startMarker);
    assert.notEqual(end, -1, "missing source marker: " + endMarker);
    return appSource.slice(start, end);
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeHarness({ getUser, updateUser, upsert } = {}) {
    const events = [];
    const messages = [];
    const errors = [];
    const loads = [];
    const upsertRows = [];
    let updateCalls = 0;
    const elements = new Map();
    const values = {
        usernameInput: "ari_user",
        displayNameInput: "Ari User",
        passwordInput: "p".repeat(12)
    };

    for (const id of [
        "usernameInput", "displayNameInput", "passwordInput",
        "createAccountBtn", "signupBox", "profileBox"
    ]) {
        const classes = new Set();
        if (id === "createAccountBtn") {
            elements.set(id, {
                disabled: false,
                classList: {
                    add(name) { classes.add(name); },
                    remove(name) { classes.delete(name); },
                    contains(name) { return classes.has(name); }
                },
                addEventListener(type, handler) { events.push({ id, type, handler }); }
            });
        } else if (id === "signupBox" || id === "profileBox") {
            elements.set(id, {
                classList: {
                    add(name) { classes.add(name); },
                    remove(name) { classes.delete(name); },
                    contains(name) { return classes.has(name); }
                }
            });
        } else {
            elements.set(id, {
                value: values[id],
                classList: { contains(name) { return classes.has(name); } }
            });
        }
    }

    const context = {
        window: { TalkSpaceLogger: { debug() {} } },
        console: { error(...args) { errors.push(args); } },
        client: {
            auth: {
                getUser() {
                    events.push({ type: "getUser" });
                    return getUser
                        ? getUser()
                        : Promise.resolve({ data: { user: { id: "user-a" } }, error: null });
                },
                updateUser(options) {
                    updateCalls += 1;
                    // Record only non-secret profile metadata; never retain the password.
                    events.push({ type: "updateUser", metadata: options.data });
                    return updateUser
                        ? updateUser(options)
                        : Promise.resolve({ error: null });
                }
            },
            from(table) {
                assert.equal(table, "profiles");
                return {
                    upsert(row) {
                        upsertRows.push({ ...row });
                        events.push({ type: "upsert" });
                        return upsert
                            ? upsert(row)
                            : Promise.resolve({ error: null });
                    }
                };
            }
        },
        $(id) { return elements.get(id); },
        message(text) { messages.push(text); },
        async loadCurrentUser() {
            loads.push(vm.runInContext("currentUser?.id || observedAuthIdentityId || null", context));
            events.push({ type: "loadCurrentUser" });
        }
    };

    const accountState = extractBetween(
        "let accountSetupGeneration = 0;",
        "function invalidateAuthSessionWork()"
    );
    const handler = extractBetween(
        '$("createAccountBtn").addEventListener(',
        "// LOGIN / SIGN IN"
    );
    vm.createContext(context);
    vm.runInContext([
        "let authSessionGeneration = 5;",
        "let turnstileUiGeneration = 2;",
        "let signupOtpRequestGeneration = 10;",
        "let signupOtpVerificationGeneration = 3;",
        'let currentUser = { id: "user-a" };',
        'let observedAuthIdentityId = "user-a";',
        accountState,
        handler
    ].join("\n"), context);

    return {
        context,
        elements,
        errors,
        events,
        loads,
        messages,
        upsertRows,
        get updateCalls() { return updateCalls; },
        setup() { return events.find(event => event.id === "createAccountBtn").handler(); },
        invalidate() {
            vm.runInContext("invalidateAccountSetupOperation(); authSessionGeneration += 1;", context);
        },
        changeView() {
            vm.runInContext("invalidateAccountSetupOperation(); turnstileUiGeneration += 1;", context);
            elements.get("profileBox").classList.add("hidden");
        },
        changeIdentity(userId) {
            vm.runInContext(
                "currentUser = { id: " + JSON.stringify(userId) +
                " }; observedAuthIdentityId = " + JSON.stringify(userId) +
                "; invalidateAccountSetupOperation(); authSessionGeneration += 1;",
                context
            );
        }
    };
}

async function waitForEvent(state, type) {
    for (let count = 0; count < 20; count += 1) {
        if (state.events.some(event => event.type === type)) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail("timed out waiting for " + type);
}

test("Back while getUser is pending prevents updateUser and later stages", async () => {
    const pending = deferred();
    const state = makeHarness({ getUser: () => pending.promise });
    const operation = state.setup();
    state.changeView();
    pending.resolve({ data: { user: { id: "user-a" } }, error: null });
    await operation;

    assert.equal(state.updateCalls, 0);
    assert.equal(state.upsertRows.length, 0);
    assert.deepEqual(state.loads, []);
});

test("auth-view change after getUser stops before updateUser starts", async () => {
    let state;
    const stateChanged = deferred();
    state = makeHarness({
        getUser() {
            const result = Promise.resolve({ data: { user: { id: "user-a" } }, error: null });
            queueMicrotask(() => {
                state.changeView();
                stateChanged.resolve();
            });
            return result;
        }
    });
    const operation = state.setup();
    await stateChanged.promise;
    await operation;
    assert.equal(state.updateCalls, 0);
    assert.equal(state.upsertRows.length, 0);
});

test("sign-out while getUser is pending stops later account/profile mutations", async () => {
    const pending = deferred();
    const state = makeHarness({ getUser: () => pending.promise });
    const operation = state.setup();
    state.invalidate();
    pending.resolve({ data: { user: { id: "user-a" } }, error: null });
    await operation;
    assert.equal(state.updateCalls, 0);
    assert.equal(state.upsertRows.length, 0);
    assert.deepEqual(state.loads, []);
});

test("a different current identity prevents the old setup data from being used", async () => {
    const pending = deferred();
    const state = makeHarness({ getUser: () => pending.promise });
    const operation = state.setup();
    state.changeIdentity("user-b");
    pending.resolve({ data: { user: { id: "user-a" } }, error: null });
    await operation;
    assert.equal(state.updateCalls, 0);
    assert.equal(state.upsertRows.length, 0);
    assert.deepEqual(state.loads, []);
});

test("a setup made stale as getUser resolves does not submit updateUser", async () => {
    let state;
    const invalidationDone = deferred();
    state = makeHarness({
        getUser() {
            const result = Promise.resolve({ data: { user: { id: "user-a" } }, error: null });
            queueMicrotask(() => {
                state.invalidate();
                invalidationDone.resolve();
            });
            return result;
        }
    });
    const operation = state.setup();
    await invalidationDone.promise;
    await operation;
    assert.equal(state.updateCalls, 0);
    assert.equal(state.upsertRows.length, 0);
});

test("an already-submitted updateUser may finish, but stale setup does not upsert", async () => {
    const update = deferred();
    const state = makeHarness({ updateUser: () => update.promise });
    const operation = state.setup();
    await waitForEvent(state, "updateUser");
    state.invalidate();
    update.resolve({ error: { message: "stale update error" } });
    await operation;
    assert.equal(state.updateCalls, 1);
    assert.equal(state.upsertRows.length, 0);
    assert.deepEqual(state.loads, []);
    assert.doesNotMatch(state.messages.join(" "), /stale update error/);
});

test("an already-submitted profile upsert may finish, but stale setup does not load or route", async () => {
    const profileWrite = deferred();
    const state = makeHarness({ upsert: () => profileWrite.promise });
    const operation = state.setup();
    await waitForEvent(state, "upsert");
    state.invalidate();
    profileWrite.resolve({ error: null });
    await operation;
    assert.equal(state.upsertRows.length, 1);
    assert.deepEqual(state.loads, []);
    assert.doesNotMatch(state.messages.join(" "), /Account created successfully/);
});

test("current setup updates the user, upserts the profile, then loads once", async () => {
    const state = makeHarness();
    await state.setup();
    assert.equal(state.updateCalls, 1);
    assert.deepEqual(state.upsertRows, [{
        id: "user-a",
        username: "ari_user",
        display_name: "Ari User"
    }]);
    assert.deepEqual(
        JSON.parse(JSON.stringify(state.events.find(event => event.type === "updateUser").metadata)),
        { username: "ari_user", display_name: "Ari User" }
    );
    assert.deepEqual(state.loads, ["user-a"]);
    assert.match(state.messages.at(-1), /Account created successfully/);
});

test("current provider failure preserves the error flow and restores Create Account", async () => {
    const state = makeHarness({
        updateUser: async () => ({ error: { message: "provider unavailable" } })
    });
    await state.setup();
    assert.match(state.messages.at(-1), /Could not create account: provider unavailable/);
    assert.equal(state.elements.get("createAccountBtn").disabled, false);
    assert.equal(state.upsertRows.length, 0);
    assert.deepEqual(state.loads, []);
});

test("auth navigation and shared cleanup invalidate account setup", () => {
    const back = extractBetween(
        '$("backToAuthBtn").addEventListener(',
        "// BACK FROM LOGIN"
    );
    const cancelOtp = extractBetween(
        "function cancelSignupOtpFlow(",
        "async function requestSignupOtp("
    );
    const cleanup = extractBetween(
        "async function cleanupSignedOutState()",
        "// AUTH STATE CHANGE"
    );
    const login = extractBetween(
        '$("loginBtn").addEventListener(',
        "// LOGOUT"
    );
    assert.match(cancelOtp, /invalidateAccountSetupOperation\(\)/);
    assert.match(back, /cancelSignupOtpFlow\(\)/);
    assert.match(back, /invalidateAuthSessionWork\(\)/);
    assert.match(cleanup, /cancelSignupOtpFlow\(\)/);
    assert.match(login, /invalidateAccountSetupOperation\(\)/);
});

test("existing identity-switch, OTP, Login, and session-load protections remain wired", () => {
    assert.match(appSource, /await cleanupSignedOutState\(\)[\s\S]*?currentUser = nextUser;[\s\S]*?await loadCurrentUser\(\)/);
    assert.match(appSource, /signupOtpVerificationGeneration === verificationGeneration/);
    assert.match(appSource, /loginOperationGeneration === operationGeneration/);
    assert.match(appSource, /isCurrentAuthLoad\(authGeneration, loadGeneration,/);
});
