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
    assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
    return appSource.slice(start, end);
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeHarness({ otpVisible = false, response, verifyResponse, emitIdentityOnVerify = false } = {}) {
    let now = 1_000_000;
    let nextTimerId = 1;
    const intervals = new Map();
    const events = [];
    const messages = [];
    const requests = [];
    const resetCalls = [];
    const elements = new Map();

    for (const id of ["signupEmail", "otpInput", "authMessage", "sendOtpBtn", "resendOtpBtn", "verifyOtpBtn", "otpBox", "signupBox", "profileBox"]) {
        const classes = new Set();
        if (id === "otpBox" && !otpVisible) classes.add("hidden");
        if (id === "profileBox") classes.add("hidden");
        elements.set(id, {
            value: id === "signupEmail" ? "person@example.test" : "",
            textContent: "",
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
        Date: { now: () => now },
        setInterval(callback) {
            const id = nextTimerId++;
            intervals.set(id, callback);
            return id;
        },
        clearInterval(id) { intervals.delete(id); },
        window: { TalkSpaceLogger: { debug() {} } },
        console: { error() {} },
        client: {
            auth: {
                signInWithOtp(options) {
                    requests.push(options);
                    return response ? response(options) : Promise.resolve({ error: null });
                },
                verifyOtp(options) {
                    requests.push({ verify: options });
                    if (emitIdentityOnVerify) {
                        context.currentUser = { id: "verified-user" };
                        vm.runInContext('observedAuthIdentityId = "verified-user"', context);
                    }
                    return verifyResponse
                        ? verifyResponse(options)
                        : Promise.resolve({ data: { user: { id: "verified-user" } }, error: null });
                }
            }
        },
        $: id => elements.get(id),
        show(id) { elements.get(id).classList.remove("hidden"); },
        hide(id) { elements.get(id).classList.add("hidden"); },
        message(text) { messages.push(text); elements.get("authMessage").textContent = text; },
        invalidateAccountSetupOperation() {},
        resetSignupTurnstile() {
            resetCalls.push(true);
            vm.runInContext('signupTurnstileToken = ""', context);
        }
    };

    const lifecycle = extractBetween(
        "// SIGNUP OTP REQUEST / RESEND LIFECYCLE",
        "// REMOVE SIGNUP TURNSTILE"
    );
    const emailValidator = extractBetween(
        "function normalizeAndValidateEmail(value)",
        "// TURNSTILE CONFIGURATION CHECK"
    );
    const verifyHandler = extractBetween(
        '$("verifyOtpBtn").addEventListener(',
        "// CREATE ACCOUNT"
    );
    vm.createContext(context);
    vm.runInContext(`let authSessionGeneration = 4; let turnstileUiGeneration = 7; let signupTurnstileToken = ""; let currentUser = null; let observedAuthIdentityId = null;\n${emailValidator}\n${lifecycle}\n${verifyHandler}`, context);

    return {
        context,
        elements,
        events,
        messages,
        requests,
        resetCalls,
        intervals,
        setToken(value) { vm.runInContext(`signupTurnstileToken = ${JSON.stringify(value)}`, context); },
        getToken() { return vm.runInContext("signupTurnstileToken", context); },
        getCooldownUntil() { return vm.runInContext("signupOtpCooldownUntil", context); },
        getRequestGeneration() { return vm.runInContext("signupOtpRequestGeneration", context); },
        setNow(value) { now = value; },
        tickIntervals() { for (const callback of intervals.values()) callback(); },
        verify() { return events.find(event => event.id === "verifyOtpBtn").handler(); },
        setOtpVisible(visible) {
            const box = elements.get("otpBox");
            if (visible) box.classList.remove("hidden");
            else box.classList.add("hidden");
        },
        backFromSignup() {
            vm.runInContext(`cancelSignupOtpFlow(); turnstileUiGeneration += 1;`, context);
            elements.get("signupBox").classList.add("hidden");
            elements.get("otpBox").classList.add("hidden");
        },
        invalidateSession() {
            vm.runInContext(`authSessionGeneration += 1; cancelSignupOtpFlow();`, context);
        },
        switchIdentity(userId) {
            context.currentUser = { id: userId };
            vm.runInContext(`observedAuthIdentityId = ${JSON.stringify(userId)};`, context);
        },
        startNewOtp() {
            vm.runInContext(`signupOtpCooldownUntil = 0;`, context);
            return vm.runInContext(`requestSignupOtp({ resend: true })`, context);
        },
        getVerificationGeneration() { return vm.runInContext("signupOtpVerificationGeneration", context); }
    };
}

test("initial signup OTP uses the existing provider path and opens OTP entry without auto-verifying", async () => {
    const state = makeHarness();
    state.elements.get("signupEmail").value = "  person@example.test  ";
    state.setToken("captcha-first");
    await vm.runInContext("requestSignupOtp()", state.context);

    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].email, "person@example.test");
    assert.equal(state.requests[0].options.shouldCreateUser, true);
    assert.equal(state.requests[0].options.captchaToken, "captcha-first");
    assert.equal(state.getToken(), "");
    assert.equal(state.resetCalls.length, 1);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), false);
    assert.equal(state.elements.get("sendOtpBtn").classList.contains("hidden"), true);
    assert.match(state.messages.at(-1), /OTP sent/);
    assert.equal(state.requests.some(request => request.verify), false);
});

test("invalid signup email makes no request and preserves CAPTCHA, cooldown, and OTP panel state", async () => {
    const state = makeHarness();
    state.elements.get("signupEmail").value = "person@@example.test";
    state.setToken("still-valid-captcha");
    const requestGeneration = state.getRequestGeneration();

    await vm.runInContext("requestSignupOtp()", state.context);

    assert.equal(state.requests.length, 0);
    assert.equal(state.getToken(), "still-valid-captcha");
    assert.equal(state.getCooldownUntil(), 0);
    assert.equal(state.intervals.size, 0);
    assert.equal(state.getRequestGeneration(), requestGeneration);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), true);
    assert.match(state.messages.at(-1), /valid email address/);
});

test("resend uses the signup email and a fresh Turnstile token while preserving OTP entry", async () => {
    const state = makeHarness({ otpVisible: true });
    state.elements.get("signupEmail").value = "  person@example.test  ";
    state.elements.get("otpInput").value = "12345678";
    state.setToken("captcha-fresh");
    await vm.runInContext("requestSignupOtp({ resend: true })", state.context);

    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].email, "person@example.test");
    assert.equal(state.requests[0].options.captchaToken, "captcha-fresh");
    assert.equal(state.getToken(), "");
    assert.equal(state.resetCalls.length, 1);
    assert.equal(state.elements.get("otpInput").value, "12345678");
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), false);
    assert.match(state.messages.at(-1), /new OTP was sent/);
});

test("invalid resend email makes no request or cooldown change and keeps OTP entry", async () => {
    const state = makeHarness({ otpVisible: true });
    state.elements.get("signupEmail").value = "person@.example.test";
    state.setToken("still-valid-captcha");
    state.elements.get("otpInput").value = "12345678";

    await vm.runInContext("requestSignupOtp({ resend: true })", state.context);

    assert.equal(state.requests.length, 0);
    assert.equal(state.getToken(), "still-valid-captcha");
    assert.equal(state.getCooldownUntil(), 0);
    assert.equal(state.intervals.size, 0);
    assert.equal(state.resetCalls.length, 0);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), false);
    assert.equal(state.elements.get("otpInput").value, "12345678");
    assert.match(state.messages.at(-1), /valid email address/);
});

test("resend cooldown disables with a countdown, expires automatically, and requires fresh CAPTCHA", async () => {
    const state = makeHarness();
    state.setToken("first-captcha");
    await vm.runInContext("requestSignupOtp()", state.context);
    const resend = state.elements.get("resendOtpBtn");
    assert.equal(resend.disabled, true);
    assert.match(resend.textContent, /30s/);

    state.setToken("captcha-too-early");
    await vm.runInContext("requestSignupOtp({ resend: true })", state.context);
    assert.equal(state.requests.length, 1);
    assert.equal(state.getToken(), "captcha-too-early");

    state.setNow(1_030_000);
    state.tickIntervals();
    assert.equal(resend.disabled, false);
    assert.equal(resend.textContent, "Resend OTP");

    state.setToken("captcha-after-cooldown");
    await vm.runInContext("requestSignupOtp({ resend: true })", state.context);
    assert.equal(state.requests.length, 2);
    assert.equal(state.requests[1].options.captchaToken, "captcha-after-cooldown");
    assert.equal(resend.disabled, true);
});

test("duplicate simultaneous send/resend requests share one in-flight provider request", async () => {
    const pending = deferred();
    const state = makeHarness({ response: () => pending.promise });
    state.setToken("single-use");

    const first = vm.runInContext("requestSignupOtp()", state.context);
    await vm.runInContext("requestSignupOtp()", state.context);
    assert.equal(state.requests.length, 1);
    assert.equal(state.elements.get("sendOtpBtn").disabled, true);
    assert.equal(state.elements.get("resendOtpBtn").disabled, true);

    pending.resolve({ error: null });
    await first;
    assert.equal(state.elements.get("sendOtpBtn").disabled, false);
});

test("resend failure keeps OTP entry, clears CAPTCHA, and enables retry after cooldown policy", async () => {
    const state = makeHarness({
        otpVisible: true,
        response: async () => ({ error: { message: "provider unavailable" } })
    });
    state.elements.get("otpInput").value = "87654321";
    state.setToken("used-captcha");
    await vm.runInContext("requestSignupOtp({ resend: true })", state.context);

    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), false);
    assert.equal(state.elements.get("otpInput").value, "87654321");
    assert.equal(state.getToken(), "");
    assert.equal(state.elements.get("resendOtpBtn").disabled, false);
    assert.match(state.messages.at(-1), /provider unavailable/);
});

test("an obsolete resend result cannot update a later auth view", async () => {
    const pending = deferred();
    const state = makeHarness({ otpVisible: true, response: () => pending.promise });
    state.setToken("captcha");
    const request = vm.runInContext("requestSignupOtp({ resend: true })", state.context);
    const messageCount = state.messages.length;

    vm.runInContext("cancelSignupOtpFlow(); turnstileUiGeneration += 1;", state.context);
    state.elements.get("signupBox").classList.add("hidden");
    pending.resolve({ error: null });
    await request;

    assert.equal(state.messages.length, messageCount);
    assert.equal(state.resetCalls.length, 0);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), false);
    assert.equal(state.intervals.size, 0);
});

test("OTP verification rejects non-digits before verifyOtp and accepts an eight-digit code", async () => {
    const state = makeHarness();
    state.setOtpVisible(true);
    state.elements.get("otpInput").value = "1234abcd";
    vm.runInContext("$(\"verifyOtpBtn\").addEventListener = (type, handler) => { globalThis.verifyHandler = handler; };", state.context);
    vm.runInContext(verifyHandlerSource(), state.context);
    await state.context.verifyHandler();
    assert.equal(state.requests.length, 0);
    assert.match(state.messages.at(-1), /only digits/);

    state.elements.get("otpInput").value = "12345678";
    await state.context.verifyHandler();
    assert.equal(state.requests.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(state.requests[0].verify)), {
        email: "person@example.test",
        token: "12345678",
        type: "email"
    });
});

test("pending verification followed by Back ignores a late success", async () => {
    const pending = deferred();
    const state = makeHarness({ otpVisible: true, verifyResponse: () => pending.promise });
    state.elements.get("otpInput").value = "12345678";
    const verification = state.verify();
    const priorMessages = state.messages.length;

    state.backFromSignup();
    pending.resolve({ data: { user: { id: "verified-user" } }, error: null });
    await verification;

    assert.equal(state.messages.length, priorMessages);
    assert.equal(state.elements.get("profileBox").classList.contains("hidden"), true);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), true);
    assert.equal(state.elements.get("verifyOtpBtn").disabled, false);
});

test("pending verification followed by Back ignores a late failure", async () => {
    const pending = deferred();
    const state = makeHarness({ otpVisible: true, verifyResponse: () => pending.promise });
    state.elements.get("otpInput").value = "12345678";
    const verification = state.verify();
    const priorMessages = state.messages.length;

    state.backFromSignup();
    pending.resolve({ error: { message: "expired code" } });
    await verification;

    assert.equal(state.messages.length, priorMessages);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), true);
    assert.doesNotMatch(state.messages.join(" "), /expired code/);
});

test("pending verification cannot update Login after switching auth views", async () => {
    const pending = deferred();
    const state = makeHarness({ otpVisible: true, verifyResponse: () => pending.promise });
    state.elements.get("otpInput").value = "12345678";
    const verification = state.verify();
    const priorMessages = state.messages.length;

    state.backFromSignup();
    state.elements.get("loginBox")?.classList.remove("hidden");
    pending.resolve({ error: { message: "wrong code" } });
    await verification;

    assert.equal(state.messages.length, priorMessages);
    assert.equal(state.elements.get("profileBox").classList.contains("hidden"), true);
});

test("sign-out/session invalidation ignores a pending verification result", async () => {
    const pending = deferred();
    const state = makeHarness({ otpVisible: true, verifyResponse: () => pending.promise });
    state.elements.get("otpInput").value = "12345678";
    const verification = state.verify();
    const priorMessages = state.messages.length;

    state.invalidateSession();
    pending.resolve({ data: { user: { id: "verified-user" } }, error: null });
    await verification;

    assert.equal(state.messages.length, priorMessages);
    assert.equal(state.elements.get("profileBox").classList.contains("hidden"), true);
    assert.equal(state.elements.get("verifyOtpBtn").disabled, false);
});

test("a different authenticated identity invalidates the pending verification", async () => {
    const pending = deferred();
    const state = makeHarness({ otpVisible: true, verifyResponse: () => pending.promise });
    state.elements.get("otpInput").value = "12345678";
    const verification = state.verify();
    const priorMessages = state.messages.length;

    state.switchIdentity("another-user");
    pending.resolve({ data: { user: { id: "verified-user" } }, error: null });
    await verification;

    assert.equal(state.messages.length, priorMessages);
    assert.equal(state.elements.get("profileBox").classList.contains("hidden"), true);
});

test("a newer OTP request supersedes and ignores an older verification", async () => {
    const pending = deferred();
    const state = makeHarness({ otpVisible: true, verifyResponse: () => pending.promise });
    state.elements.get("otpInput").value = "12345678";
    state.setToken("fresh-resend-captcha");
    const verification = state.verify();
    const oldGeneration = state.getVerificationGeneration();

    await state.startNewOtp();
    assert.ok(state.getVerificationGeneration() > oldGeneration);
    const priorMessages = state.messages.length;
    pending.resolve({ data: { user: { id: "verified-user" } }, error: null });
    await verification;

    assert.equal(state.messages.length, priorMessages);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), false);
    assert.equal(state.elements.get("profileBox").classList.contains("hidden"), true);
});

test("current successful verification opens the existing profile setup flow", async () => {
    const state = makeHarness({ otpVisible: true, emitIdentityOnVerify: true });
    state.elements.get("otpInput").value = "12345678";

    await state.verify();

    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), true);
    assert.equal(state.elements.get("profileBox").classList.contains("hidden"), false);
    assert.match(state.messages.at(-1), /Email verified successfully/);
    assert.equal(state.elements.get("verifyOtpBtn").disabled, false);
});

test("current failed verification shows its error and restores Verify", async () => {
    const state = makeHarness({
        otpVisible: true,
        verifyResponse: async () => ({ error: { message: "expired code" } })
    });
    state.elements.get("otpInput").value = "12345678";

    await state.verify();

    assert.match(state.messages.at(-1), /OTP verification failed: expired code/);
    assert.equal(state.elements.get("otpBox").classList.contains("hidden"), false);
    assert.equal(state.elements.get("verifyOtpBtn").disabled, false);
});

test("Back, auth-view switches, sign-out cleanup, and identity cleanup invalidate verification", () => {
    const backHandler = extractBetween(
        '$("backToAuthBtn").addEventListener(',
        "// BACK FROM LOGIN"
    );
    const loginSwitch = extractBetween(
        '$("showLoginBtn").addEventListener(',
        "// BACK FROM SIGNUP"
    );
    const cleanup = extractBetween(
        "async function cleanupSignedOutState()",
        "// AUTH STATE CHANGE"
    );
    const identityListener = extractBetween(
        "client.auth.onAuthStateChange(",
        "// INITIAL SESSION CHECK"
    );

    assert.match(backHandler, /cancelSignupOtpFlow\(\)/);
    assert.match(loginSwitch, /cancelSignupOtpFlow\(\)/);
    assert.match(cleanup, /cancelSignupOtpFlow\(\)/);
    assert.match(identityListener, /await cleanupSignedOutState\(\)/);
});

function verifyHandlerSource() {
    return extractBetween(
        '$("verifyOtpBtn").addEventListener(',
        "// CREATE ACCOUNT"
    );
}

test("markup and wiring provide one dedicated resend handler and reject malformed OTPs before provider verification", () => {
    const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
    assert.match(html, /id="resendOtpBtn"/);
    assert.equal((appSource.match(/\$\("resendOtpBtn"\)\.addEventListener\(/g) || []).length, 1);
    assert.match(appSource, /if \(!\/\^\[0-9\]\{8\}\$\/\.test\(token\)\)[\s\S]*?OTP must contain only digits[\s\S]*?return;[\s\S]*?verifyOtp/);
    assert.doesNotMatch(appSource, /console\.(?:log|debug)\([^\n]*\btoken\b/i);
});
