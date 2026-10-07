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

function makeHarness() {
    const messages = [];
    const errors = [];
    const renders = [];
    const removed = [];
    const resets = [];
    const authOperations = { otp: 0, login: 0 };
    let nextWidgetId = 1;
    const elementMap = new Map();

    for (const id of [
        "authScreen", "signupBox", "loginBox",
        "turnstileWidget", "loginTurnstileWidget"
    ]) {
        const classes = new Set();
        if (id === "loginBox") classes.add("hidden");
        elementMap.set(id, {
            innerHTML: "",
            classList: {
                add(name) { classes.add(name); },
                remove(name) { classes.delete(name); },
                contains(name) { return classes.has(name); }
            }
        });
    }

    const turnstile = {
        render(selector, options) {
            const id = nextWidgetId++;
            renders.push({ id, selector, options });
            return id;
        },
        remove(id) { removed.push(id); },
        reset(id) { resets.push(id); }
    };
    const context = {
        window: {
            SUPABASE_CONFIG: { turnstileSiteKey: "site-key" },
            TalkSpaceLogger: { debug() {} },
            turnstile
        },
        client: {
            auth: {
                signInWithOtp() { authOperations.otp += 1; },
                signInWithPassword() { authOperations.login += 1; }
            }
        },
        turnstile,
        console: { error(...args) { errors.push(args); } },
        message(text) { messages.push(text); },
        $(id) { return elementMap.get(id); },
        clearTimeout() {},
        signupTurnstileWaiter: { cancel() {}, wait() {} },
        loginTurnstileWaiter: { cancel() {}, wait() {} },
        signupTurnstileRenderDelay: null,
        loginTurnstileRenderDelay: null
    };

    const siteKeyCheck = extractBetween(
        "function hasTurnstileSiteKey()",
        "// TURNSTILE - SIGNUP SUCCESS"
    );
    const callbacksAndRenderers = extractBetween(
        "function isCurrentSignupTurnstileCallback(state)",
        "// SIGNUP OTP REQUEST / RESEND LIFECYCLE"
    );
    const removers = extractBetween(
        "function removeSignupTurnstile()",
        "// INITIAL AUTH CHOICE"
    );
    vm.createContext(context);
    vm.runInContext([
        'let signupTurnstileToken = "";',
        "let signupTurnstileWidgetId = null;",
        "let signupTurnstileCallbackGeneration = 0;",
        "let signupTurnstileCallbackState = null;",
        'let loginTurnstileToken = "";',
        "let loginTurnstileWidgetId = null;",
        "let loginTurnstileCallbackGeneration = 0;",
        "let loginTurnstileCallbackState = null;",
        "let turnstileUiGeneration = 1;",
        siteKeyCheck,
        callbacksAndRenderers,
        removers
    ].join("\n"), context);

    return {
        context,
        errors,
        messages,
        renders,
        removed,
        resets,
        authOperations,
        elementMap,
        renderSignup(generation = 1) {
            vm.runInContext("renderSignupTurnstile(" + generation + ")", context);
            return renders.filter(item => item.selector === "#turnstileWidget").at(-1);
        },
        renderLogin(generation = 1) {
            vm.runInContext("renderLoginTurnstile(" + generation + ")", context);
            return renders.filter(item => item.selector === "#loginTurnstileWidget").at(-1);
        },
        token(name) { return vm.runInContext(name + "TurnstileToken", context); },
        changeView(from, to) {
            elementMap.get(from + "Box").classList.add("hidden");
            elementMap.get(to + "Box").classList.remove("hidden");
            vm.runInContext("turnstileUiGeneration += 1", context);
            return vm.runInContext("turnstileUiGeneration", context);
        },
        signOut() {
            elementMap.get("authScreen").classList.add("hidden");
            vm.runInContext("removeSignupTurnstile(); removeLoginTurnstile();", context);
        },
        resetSignup() { vm.runInContext("resetSignupTurnstile()", context); }
    };
}

test("current signup callback stores the token for the active widget", () => {
    const state = makeHarness();
    const widget = state.renderSignup();
    widget.options.callback("signup-current");
    assert.equal(state.token("signup"), "signup-current");
});

test("current login callback stores the token for the active widget", () => {
    const state = makeHarness();
    state.changeView("signup", "login");
    const widget = state.renderLogin(2);
    widget.options.callback("login-current");
    assert.equal(state.token("login"), "login-current");
});

test("an old signup success callback cannot overwrite a replacement widget token", () => {
    const state = makeHarness();
    const oldWidget = state.renderSignup();
    const currentWidget = state.renderSignup();
    currentWidget.options.callback("signup-new");
    oldWidget.options.callback("signup-old");
    assert.equal(state.token("signup"), "signup-new");
    assert.deepEqual(state.authOperations, { otp: 0, login: 0 });
});

test("an old login success callback cannot overwrite a replacement widget token", () => {
    const state = makeHarness();
    state.changeView("signup", "login");
    const oldWidget = state.renderLogin(2);
    const currentWidget = state.renderLogin(2);
    currentWidget.options.callback("login-new");
    oldWidget.options.callback("login-old");
    assert.equal(state.token("login"), "login-new");
});

test("old signup expiry cannot clear a newer token or reset its widget", () => {
    const state = makeHarness();
    const oldWidget = state.renderSignup();
    const currentWidget = state.renderSignup();
    currentWidget.options.callback("signup-new");
    oldWidget.options["expired-callback"]();
    assert.equal(state.token("signup"), "signup-new");
    assert.deepEqual(state.resets, []);
    assert.deepEqual(state.messages, []);
});

test("old login expiry cannot clear a newer token or reset its widget", () => {
    const state = makeHarness();
    state.changeView("signup", "login");
    const oldWidget = state.renderLogin(2);
    const currentWidget = state.renderLogin(2);
    currentWidget.options.callback("login-new");
    oldWidget.options["expired-callback"]();
    assert.equal(state.token("login"), "login-new");
    assert.deepEqual(state.resets, []);
    assert.deepEqual(state.messages, []);
});

test("old signup error cannot change the current widget state", () => {
    const state = makeHarness();
    const oldWidget = state.renderSignup();
    const currentWidget = state.renderSignup();
    currentWidget.options.callback("signup-new");
    oldWidget.options["error-callback"]("old-error");
    assert.equal(state.token("signup"), "signup-new");
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.resets, []);
});

test("old login error cannot change the current widget state", () => {
    const state = makeHarness();
    state.changeView("signup", "login");
    const oldWidget = state.renderLogin(2);
    const currentWidget = state.renderLogin(2);
    currentWidget.options.callback("login-new");
    oldWidget.options["error-callback"]("old-error");
    assert.equal(state.token("login"), "login-new");
    assert.deepEqual(state.errors, []);
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.resets, []);
});

test("signup callback after switching to Login cannot affect either view", () => {
    const state = makeHarness();
    const oldSignup = state.renderSignup();
    const loginGeneration = state.changeView("signup", "login");
    const currentLogin = state.renderLogin(loginGeneration);
    oldSignup.options.callback("stale-signup");
    assert.equal(state.token("signup"), "");
    assert.equal(state.token("login"), "");
    currentLogin.options.callback("login-current");
    oldSignup.options["expired-callback"]();
    assert.equal(state.token("login"), "login-current");
    assert.deepEqual(state.messages, []);
});

test("login callback after switching to Signup cannot affect either view", () => {
    const state = makeHarness();
    const loginGeneration = state.changeView("signup", "login");
    const oldLogin = state.renderLogin(loginGeneration);
    const signupGeneration = state.changeView("login", "signup");
    const currentSignup = state.renderSignup(signupGeneration);
    oldLogin.options.callback("stale-login");
    oldLogin.options["error-callback"]("old-error");
    assert.equal(state.token("login"), "");
    assert.equal(state.token("signup"), "");
    currentSignup.options.callback("signup-current");
    assert.equal(state.token("signup"), "signup-current");
    assert.deepEqual(state.messages, []);
});

test("old callbacks after sign-out cannot repopulate removed widget tokens", () => {
    const state = makeHarness();
    const oldSignup = state.renderSignup();
    const generation = state.changeView("signup", "login");
    const oldLogin = state.renderLogin(generation);
    state.signOut();
    oldSignup.options.callback("stale-signup");
    oldLogin.options.callback("stale-login");
    oldSignup.options["expired-callback"]();
    oldLogin.options["error-callback"]("old-error");
    assert.equal(state.token("signup"), "");
    assert.equal(state.token("login"), "");
    assert.deepEqual(state.messages, []);
    assert.deepEqual(state.errors, []);
});

test("only the latest same-view render accepts callbacks", () => {
    const state = makeHarness();
    const first = state.renderSignup();
    const second = state.renderSignup();
    const third = state.renderSignup();
    first.options.callback("first");
    second.options.callback("second");
    third.options.callback("third");
    assert.equal(state.token("signup"), "third");
    assert.deepEqual(state.removed, [first.id, second.id]);
});

test("the current widget can be reset, while stale callback state cannot reset its replacement", () => {
    const state = makeHarness();
    const oldWidget = state.renderSignup();
    state.resetSignup();
    assert.deepEqual(state.resets, [oldWidget.id]);
    const currentWidget = state.renderSignup();
    oldWidget.options["expired-callback"]();
    assert.deepEqual(state.resets, [oldWidget.id]);
    assert.equal(state.token("signup"), "");
    currentWidget.options.callback("signup-current");
    assert.equal(state.token("signup"), "signup-current");
});

test("current expiry and error callbacks retain their existing feedback", () => {
    const state = makeHarness();
    const signup = state.renderSignup();
    signup.options.callback("signup-token");
    signup.options["expired-callback"]();
    assert.equal(state.token("signup"), "");
    assert.match(state.messages.at(-1), /CAPTCHA expired/);

    const generation = state.changeView("signup", "login");
    const login = state.renderLogin(generation);
    login.options.callback("login-token");
    login.options["error-callback"]("current-error");
    assert.equal(state.token("login"), "");
    assert.match(state.messages.at(-1), /Login CAPTCHA could not be verified/);
    assert.equal(state.errors.length, 1);
});

test("bounded Turnstile waiting remains in the existing lifecycle helper", () => {
    assert.equal(require("../src/turnstile-lifecycle.js").DEFAULT_MAX_WAIT_MS, 15000);
    assert.match(appSource, /signupTurnstileWaiter\.wait\(/);
    assert.match(appSource, /loginTurnstileWaiter\.wait\(/);
});
