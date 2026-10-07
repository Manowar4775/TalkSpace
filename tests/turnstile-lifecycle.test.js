"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lifecycle = require("../src/turnstile-lifecycle.js");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");

function makeClock() {
    let currentTime = 0;
    let nextId = 0;
    const timers = new Map();

    return {
        now: () => currentTime,
        setTimeout(callback, delay) {
            const id = ++nextId;
            timers.set(id, { callback, dueAt: currentTime + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        get pendingCount() { return timers.size; },
        advance(milliseconds) {
            const target = currentTime + milliseconds;
            while (true) {
                let next = null;
                for (const [id, timer] of timers) {
                    if (timer.dueAt <= target && (!next || timer.dueAt < next.timer.dueAt)) {
                        next = { id, timer };
                    }
                }
                if (!next) break;
                timers.delete(next.id);
                currentTime = next.timer.dueAt;
                next.timer.callback();
            }
            currentTime = target;
        }
    };
}

function makeWaiter(clock, getLibrary) {
    return lifecycle.createWaiter({
        getLibrary,
        setTimeoutFn: clock.setTimeout,
        clearTimeoutFn: clock.clearTimeout,
        now: clock.now
    });
}

test("Turnstile becoming available stops polling and proceeds to widget rendering", async () => {
    const clock = makeClock();
    let library = null;
    let rendered = 0;
    const waiter = makeWaiter(clock, () => library);
    const result = waiter.wait({ onReady: value => { assert.equal(value, library); rendered += 1; } });

    clock.advance(1000);
    assert.equal(waiter.isWaiting, true);
    assert.equal(clock.pendingCount, 1);
    library = { render() {} };
    clock.advance(500);

    assert.equal(await result, true);
    assert.equal(rendered, 1);
    assert.equal(waiter.isWaiting, false);
    assert.equal(clock.pendingCount, 0);
});

test("a missing Turnstile library times out after a finite wait with no timer left", async () => {
    const clock = makeClock();
    let timeoutCount = 0;
    const waiter = makeWaiter(clock, () => null);
    const result = waiter.wait({ onTimeout: () => { timeoutCount += 1; } });

    assert.equal(lifecycle.DEFAULT_INTERVAL_MS, 500);
    assert.equal(lifecycle.DEFAULT_MAX_WAIT_MS, 15000);
    clock.advance(lifecycle.DEFAULT_MAX_WAIT_MS);

    assert.equal(await result, false);
    assert.equal(timeoutCount, 1);
    assert.equal(waiter.isWaiting, false);
    assert.equal(clock.pendingCount, 0);
});

test("repeated render requests share one bounded polling loop", async () => {
    const clock = makeClock();
    let library = null;
    let rendered = 0;
    const waiter = makeWaiter(clock, () => library);
    const options = { onReady: () => { rendered += 1; } };
    const first = waiter.wait(options);
    const second = waiter.wait({ onReady: () => { rendered += 100; } });

    assert.equal(first, second);
    assert.equal(clock.pendingCount, 1);
    library = {};
    clock.advance(500);

    assert.equal(await first, true);
    assert.equal(rendered, 1);
    assert.equal(clock.pendingCount, 0);
});

test("signup and login wait independently", async () => {
    const clock = makeClock();
    let signupLibrary = null;
    let loginLibrary = null;
    let signupRendered = 0;
    let loginRendered = 0;
    const signup = makeWaiter(clock, () => signupLibrary);
    const login = makeWaiter(clock, () => loginLibrary);
    const signupResult = signup.wait({ onReady: () => { signupRendered += 1; } });
    const loginResult = login.wait({ onReady: () => { loginRendered += 1; } });

    signup.cancel();
    signupLibrary = {};
    loginLibrary = {};
    clock.advance(500);

    assert.equal(await signupResult, false);
    assert.equal(await loginResult, true);
    assert.equal(signupRendered, 0);
    assert.equal(loginRendered, 1);
    assert.equal(clock.pendingCount, 0);
    assert.match(appSource, /const signupTurnstileWaiter\s*=\s*window\.TalkSpaceTurnstileLifecycle\.createWaiter/);
    assert.match(appSource, /const loginTurnstileWaiter\s*=\s*window\.TalkSpaceTurnstileLifecycle\.createWaiter/);
});

test("obsolete auth UI requests cancel and cannot render after a section change", async () => {
    const clock = makeClock();
    let library = null;
    let authSectionIsCurrent = true;
    let rendered = 0;
    const waiter = makeWaiter(clock, () => library);
    const result = waiter.wait({
        isCurrent: () => authSectionIsCurrent,
        onReady: () => { rendered += 1; },
        onTimeout: () => assert.fail("obsolete attempt must not report a timeout")
    });

    authSectionIsCurrent = false;
    waiter.cancel();
    library = {};
    clock.advance(lifecycle.DEFAULT_MAX_WAIT_MS);

    assert.equal(await result, false);
    assert.equal(rendered, 0);
    assert.equal(clock.pendingCount, 0);
    assert.match(appSource, /function cancelTurnstileRenderAttempts\(\)[\s\S]*?signupTurnstileWaiter\.cancel\(\)[\s\S]*?loginTurnstileWaiter\.cancel\(\)/);
    assert.match(appSource, /isCurrentTurnstileUi\("signupBox", generation\)/);
    assert.match(appSource, /isCurrentTurnstileUi\("loginBox", generation\)/);
});

test("signup and login retain separate callbacks and token expiry/error clearing", () => {
    assert.match(appSource, /callback:\s*token\s*=>\s*handleSignupTurnstileSuccess\(callbackState,\s*token\)/);
    assert.match(appSource, /callback:\s*token\s*=>\s*handleLoginTurnstileSuccess\(callbackState,\s*token\)/);
    assert.match(appSource, /handleSignupTurnstileExpired\(state\)\s*\{\s*if\s*\(!isCurrentSignupTurnstileCallback\(state\)\)\s*return;[\s\S]*?signupTurnstileToken\s*=\s*""/);
    assert.match(appSource, /handleLoginTurnstileExpired\(state\)\s*\{\s*if\s*\(!isCurrentLoginTurnstileCallback\(state\)\)\s*return;[\s\S]*?loginTurnstileToken\s*=\s*""/);
    assert.match(appSource, /handleSignupTurnstileError\(state,\s*errorCode\)\s*\{\s*if\s*\(!isCurrentSignupTurnstileCallback\(state\)\)\s*return;[\s\S]*?signupTurnstileToken\s*=\s*""/);
    assert.match(appSource, /handleLoginTurnstileError\(state,\s*errorCode\)\s*\{\s*if\s*\(!isCurrentLoginTurnstileCallback\(state\)\)\s*return;[\s\S]*?loginTurnstileToken\s*=\s*""/);
    assert.match(appSource, /state\.viewGeneration\s*===\s*turnstileUiGeneration/);
    assert.match(appSource, /state\s*===\s*signupTurnstileCallbackState/);
    assert.match(appSource, /state\s*===\s*loginTurnstileCallbackState/);
    assert.match(appSource, /Turnstile could not load\. Check your connection/);
});
