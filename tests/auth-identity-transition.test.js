"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const listenerStart = appSource.indexOf("client.auth.onAuthStateChange(");
const listenerEnd = appSource.indexOf("// INITIAL SESSION CHECK", listenerStart);
assert.notEqual(listenerStart, -1, "auth state listener exists");
assert.notEqual(listenerEnd, -1, "initial session section exists");
const listenerSource = appSource.slice(listenerStart, listenerEnd);

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeHarness() {
    const cleanupGate = deferred();
    let cleanupPromise = null;
    let authCallback;
    const events = [];
    let context;
    context = {
        currentUser: { id: "A" },
        currentProfile: { id: "A", display_name: "A profile" },
        selectedUser: { id: "A-friend" },
        selectedConversation: { id: "A-conversation" },
        messages: [{ id: "A-message" }],
        realtimeChannel: { userId: "A" },
        window: { TalkSpaceLogger: { debug() {} } },
        console: { error(...args) { events.push(["error", ...args]); } },
        client: { auth: { onAuthStateChange(callback) { authCallback = callback; } } },
        cleanupCalls: 0,
        removedChannels: [],
        loadedUsers: [],
        cleanupSignedOutState() {
            if (cleanupPromise) return cleanupPromise;
            context.cleanupCalls += 1;
            const oldChannel = context.realtimeChannel;
            context.realtimeChannel = null;
            context.currentUser = null;
            context.currentProfile = null;
            context.selectedUser = null;
            context.selectedConversation = null;
            context.messages = [];
            context.removedChannels.push(oldChannel);
            cleanupPromise = cleanupGate.promise;
            return cleanupPromise;
        },
        async loadCurrentUser() {
            const identity = context.currentUser?.id;
            context.loadedUsers.push(identity);
            context.currentProfile = { id: identity, display_name: `${identity} profile` };
            events.push(["load", identity]);
        }
    };
    vm.createContext(context);
    vm.runInContext(`
        let observedAuthIdentityId = "A";
        let authIdentityTransitionGeneration = 0;
        let authIdentityTransitionPending = false;
        let authIdentityTransitionTargetId = null;
        ${listenerSource}
    `, context);

    return {
        context,
        events,
        emit(event, user) { authCallback(event, user ? { user } : null); },
        finishCleanup() { cleanupGate.resolve(); }
    };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("A to B clears old private state and removes A's authenticated channel before loading B", async () => {
    const state = makeHarness();
    state.emit("SIGNED_IN", { id: "B" });

    assert.equal(state.context.currentUser, null);
    assert.equal(state.context.currentProfile, null);
    assert.equal(state.context.selectedConversation, null);
    assert.deepEqual(state.context.messages, []);
    assert.deepEqual(state.context.removedChannels, [{ userId: "A" }]);
    assert.deepEqual(state.context.loadedUsers, []);

    state.finishCleanup();
    await tick();
    await tick();

    assert.equal(state.context.currentUser.id, "B");
    assert.deepEqual(state.context.loadedUsers, ["B"]);
    assert.deepEqual(state.events, [["load", "B"]]);
});

test("same-user auth events do not run full cleanup", async () => {
    const state = makeHarness();
    state.emit("TOKEN_REFRESHED", { id: "A" });

    assert.equal(state.context.cleanupCalls, 0);
    assert.equal(state.context.currentProfile.id, "A");
    assert.equal(state.context.realtimeChannel.userId, "A");
    assert.equal(state.context.currentUser.id, "A");
});

test("sign-out still clears state and invalidates a pending identity transition", async () => {
    const state = makeHarness();
    state.emit("SIGNED_IN", { id: "B" });
    state.emit("SIGNED_OUT");
    state.finishCleanup();
    await tick();
    await tick();

    assert.equal(state.context.currentUser, null);
    assert.equal(state.context.currentProfile, null);
    assert.deepEqual(state.context.loadedUsers, []);
    assert.equal(state.context.cleanupCalls, 1);
});

test("rapid A to B to A activates only the last identity after shared cleanup", async () => {
    const state = makeHarness();
    state.emit("SIGNED_IN", { id: "B" });
    state.emit("SIGNED_IN", { id: "A" });
    state.finishCleanup();
    await tick();
    await tick();
    await tick();

    assert.deepEqual(state.context.loadedUsers, ["A"]);
    assert.equal(state.context.currentUser.id, "A");
    assert.equal(state.context.currentProfile.id, "A");
    assert.equal(state.context.cleanupCalls, 1);
});

test("existing cleanup clears private chat state and removes the old realtime channel", () => {
    const cleanupStart = appSource.indexOf("async function cleanupSignedOutState()");
    const cleanupEnd = appSource.indexOf("// AUTH STATE CHANGE", cleanupStart);
    const cleanupSource = appSource.slice(cleanupStart, cleanupEnd);
    assert.match(cleanupSource, /const channel\s*=\s*realtimeChannel/);
    assert.match(cleanupSource, /realtimeChannel = null/);
    assert.match(cleanupSource, /currentProfile = null/);
    assert.match(cleanupSource, /selectedConversation = null/);
    assert.match(cleanupSource, /clearMessageSelection\(\)/);
    assert.match(cleanupSource, /client\.removeChannel\(channel\)/);
});

test("stale profile loads and pending chat state remain generation-protected on identity changes", () => {
    assert.match(appSource, /isCurrentAuthLoad\(authGeneration, loadGeneration, data\.user\.id\)/);
    assert.match(appSource, /clearChatOperationGeneration\s*\+=\s*1/);
    assert.match(appSource, /currentUser = null;[\s\S]*?currentProfile = null;[\s\S]*?selectedConversation = null/);
});
