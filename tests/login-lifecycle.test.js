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

function makeHarness({ responses = [] } = {}) {
    const requests = [];
    const messages = [];
    const resets = [];
    const loads = [];
    const events = [];
    const elements = new Map();

    for (const id of ["loginBtn", "loginIdentifier", "loginPassword", "loginBox"]) {
        const classes = new Set();
        elements.set(id, {
            value: id === "loginIdentifier" ? "person@example.test" : "password-value",
            disabled: false,
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                contains(name) { return classes.has(name); }
            },
            addEventListener(type, handler) { events.push({ id, type, handler }); }
        });
    }

    const context = {
        currentUser: null,
        observedAuthIdentityId: null,
        window: { TalkSpaceLogger: { debug() {} } },
        console: { error() {} },
        client: {
            auth: {
                signInWithPassword(options) {
                    requests.push(options);
                    return responses.length
                        ? responses.shift()(options)
                        : Promise.resolve({ data: { user: { id: "user-b" } }, error: null });
                }
            }
        },
        $(id) { return elements.get(id); },
        message(text) { messages.push(text); },
        resetLoginTurnstile() {
            resets.push(true);
            vm.runInContext('loginTurnstileToken = ""', context);
        },
        async loadCurrentUser() { loads.push(context.currentUser?.id || null); }
    };

    const loginState = extractBetween(
        "let loginOperationGeneration = 0;",
        "function invalidateAuthSessionWork()"
    );
    const authInvalidator = extractBetween(
        "function invalidateAuthSessionWork()",
        "function isCurrentAuthLoad"
    );
    const loginHandler = extractBetween(
        '$("loginBtn").addEventListener(',
        "// LOGOUT"
    );
    const emailValidator = extractBetween(
        "function normalizeAndValidateEmail(value)",
        "// TURNSTILE CONFIGURATION CHECK"
    );
    vm.createContext(context);
    const setup = [
        "let authSessionGeneration = 4;",
        "let turnstileUiGeneration = 7;",
        'let loginTurnstileToken = "captcha-token";',
        emailValidator,
        loginState,
        authInvalidator,
        loginHandler
    ].join("\n");
    vm.runInContext(setup, context);

    return {
        context,
        elements,
        loads,
        messages,
        requests,
        resets,
        login() { return events.find(event => event.id === "loginBtn").handler(); },
        setEmail(value) { elements.get("loginIdentifier").value = value; },
        invalidateForBack() {
            vm.runInContext("turnstileUiGeneration += 1; invalidateLoginOperation();", context);
            elements.get("loginBox").classList.add("hidden");
        },
        invalidateForSignOut() {
            vm.runInContext("authSessionGeneration += 1; invalidateLoginOperation();", context);
        },
        setIdentity(userId) {
            context.currentUser = { id: userId };
            context.observedAuthIdentityId = userId;
        },
        getCaptchaToken() { return vm.runInContext("loginTurnstileToken", context); },
        getAuthGeneration() { return vm.runInContext("authSessionGeneration", context); },
        getLoginGeneration() { return vm.runInContext("loginOperationGeneration", context); },
        isLoginInFlight() { return vm.runInContext("loginOperationInFlight", context); }
    };
}

test("pending Login followed by Back ignores late success", async () => {
    const pending = deferred();
    const state = makeHarness({ responses: [() => pending.promise] });
    const request = state.login();
    state.invalidateForBack();
    pending.resolve({ data: { user: { id: "user-b" } }, error: null });
    await request;
    assert.deepEqual(state.loads, []);
    assert.equal(state.context.currentUser, null);
    assert.doesNotMatch(state.messages.join(" "), /LOGIN SUCCESS/);
});

test("pending Login followed by Back ignores late failure", async () => {
    const pending = deferred();
    const state = makeHarness({ responses: [() => pending.promise] });
    const request = state.login();
    state.invalidateForBack();
    pending.resolve({ error: { message: "stale provider error" } });
    await request;
    assert.deepEqual(state.loads, []);
    assert.deepEqual(state.resets, []);
    assert.doesNotMatch(state.messages.join(" "), /stale provider error/);
});

test("sign-out invalidation ignores late Login success and failure", async () => {
    for (const result of [
        { data: { user: { id: "user-b" } }, error: null },
        { error: { message: "stale provider error" } }
    ]) {
        const pending = deferred();
        const state = makeHarness({ responses: [() => pending.promise] });
        const request = state.login();
        state.invalidateForSignOut();
        pending.resolve(result);
        await request;
        assert.deepEqual(state.loads, []);
        assert.deepEqual(state.resets, []);
        assert.doesNotMatch(state.messages.join(" "), /stale provider error/);
    }
});

test("Login result for an old identity cannot overwrite a different current identity", async () => {
    const pending = deferred();
    const state = makeHarness({ responses: [() => pending.promise] });
    const request = state.login();
    state.setIdentity("user-c");
    pending.resolve({ data: { user: { id: "user-b" } }, error: null });
    await request;
    assert.equal(state.context.currentUser.id, "user-c");
    assert.deepEqual(state.loads, []);
});

test("a newer Login after leaving the view supersedes the older request", async () => {
    const first = deferred();
    const second = deferred();
    const state = makeHarness({ responses: [() => first.promise, () => second.promise] });
    const oldLogin = state.login();
    state.invalidateForBack();
    state.elements.get("loginBox").classList.remove("hidden");
    const newLogin = state.login();
    first.resolve({ data: { user: { id: "user-old" } }, error: null });
    await oldLogin;
    assert.equal(state.context.currentUser, null);
    assert.deepEqual(state.loads, []);
    state.setIdentity("user-new");
    second.resolve({ data: { user: { id: "user-new" } }, error: null });
    await newLogin;
    assert.deepEqual(state.loads, ["user-new"]);
    assert.equal(state.context.currentUser.id, "user-new");
});

test("current Login accepts its expected auth event and loads the profile once", async () => {
    const pending = deferred();
    const state = makeHarness({ responses: [() => pending.promise] });
    state.setEmail("  person@example.test  ");
    const request = state.login();
    assert.equal(state.requests[0].email, "person@example.test");
    state.setIdentity("user-b");
    pending.resolve({ data: { user: { id: "user-b" } }, error: null });
    await request;
    assert.deepEqual(state.loads, ["user-b"]);
    assert.equal(state.elements.get("loginBtn").disabled, false);
    assert.equal(state.getCaptchaToken(), "");
});

test("invalid Login email is rejected before auth invalidation or provider-pending state", async () => {
    const state = makeHarness();
    state.setEmail("person@@example.test");
    const authGeneration = state.getAuthGeneration();
    const loginGeneration = state.getLoginGeneration();

    await state.login();

    assert.equal(state.requests.length, 0);
    assert.equal(state.getCaptchaToken(), "captcha-token");
    assert.equal(state.getAuthGeneration(), authGeneration);
    assert.equal(state.getLoginGeneration(), loginGeneration);
    assert.equal(state.isLoginInFlight(), false);
    assert.equal(state.elements.get("loginBtn").disabled, false);
    assert.equal(state.resets.length, 0);
    assert.match(state.messages.at(-1), /valid email address/);
});

test("current Login failure shows its error, resets CAPTCHA, and restores controls", async () => {
    const state = makeHarness({
        responses: [async () => ({ error: { message: "Invalid login credentials" } })]
    });
    await state.login();
    assert.match(state.messages.at(-1), /Invalid login credentials/);
    assert.equal(state.resets.length, 1);
    assert.equal(state.elements.get("loginBtn").disabled, false);
    assert.equal(state.getCaptchaToken(), "");
    assert.deepEqual(state.loads, []);
});

test("duplicate clicks do not create overlapping Login requests", async () => {
    const pending = deferred();
    const state = makeHarness({ responses: [() => pending.promise] });
    const first = state.login();
    await state.login();
    assert.equal(state.requests.length, 1);
    pending.resolve({ error: { message: "Invalid login credentials" } });
    await first;
});

test("auth view navigation and signed-out cleanup invalidate Login operations", () => {
    const showSignup = extractBetween(
        '$("showSignupBtn").addEventListener(',
        "// OPEN LOGIN"
    );
    const showLogin = extractBetween(
        '$("showLoginBtn").addEventListener(',
        "// BACK FROM SIGNUP"
    );
    const backFromLogin = extractBetween(
        '$("backToAuthFromLoginBtn").addEventListener(',
        "// SEND / RESEND OTP"
    );
    const cleanup = extractBetween(
        "async function cleanupSignedOutState()",
        "// AUTH STATE CHANGE"
    );
    assert.match(showSignup, /invalidateLoginOperation\(\)/);
    assert.match(showLogin, /invalidateLoginOperation\(\)/);
    assert.match(backFromLogin, /invalidateLoginOperation\(\)/);
    assert.match(cleanup, /invalidateLoginOperation\(\)/);
});
