"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");

function sourceBetween(startMarker, endMarker) {
    const start = app.indexOf(startMarker);
    const end = app.indexOf(endMarker, start);
    assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
    assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
    return app.slice(start, end);
}

const previewHelpers = [
    sourceBetween("function ensureFriendPreviewElement(", "function showOfflineFriendPreview("),
    sourceBetween("function showOfflineFriendPreview(", "function isFriendPresenceStateFresh("),
    sourceBetween("function isFriendPresenceStateFresh(", "function expireFriendPresenceState("),
    sourceBetween("function expireFriendPresenceState(", "function expireStaleFriendPresence("),
    sourceBetween("function expireStaleFriendPresence(", "// One local expiry timer"),
    sourceBetween("// One local expiry timer", "document.addEventListener(\"visibilitychange\""),
    sourceBetween("function renderFriendLastMessage(", "async function refreshOnlineFriendPreview("),
    sourceBetween("async function refreshOnlineFriendPreview(", "async function isSelectedCallPeerOnline(")
].join("\n");
const freshnessHelper = sourceBetween(
    "function isPresenceFresh(",
    "// SEARCH USERS"
);
const selectedPresenceRefresh = sourceBetween(
    "async function updateSelectedUserStatus(\n    perf = null,",
    "// ======================================================\n// REALTIME"
);

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeFriend(userId, conversationId) {
    const button = {
        dataset: { userId, conversationId },
        closest() { return friend; }
    };
    const friend = {
        dataset: {},
        isConnected: true,
        preview: null,
        querySelector(selector) {
            if (selector === ".openFriendBtn") return button;
            if (selector === ".lastMessagePreview") return this.preview;
            return null;
        },
        insertBefore(element) { this.preview = element; }
    };
    return friend;
}

function makeHarness({ friends = [] } = {}) {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    let nextTimerId = 1;
    let nextPresenceResult = Promise.resolve({
        data: {
            is_online: true,
            last_seen: new Date(now).toISOString()
        },
        error: null
    });
    const timers = new Map();
    const handlers = new Map();
    const calls = { presenceSelects: 0, lastMessageReads: 0, sorts: 0 };
    const statusClasses = new Set();
    const chatUserStatus = {
        textContent: "Checking status…",
        classList: {
            add(name) { statusClasses.add(name); },
            remove(name) { statusClasses.delete(name); }
        }
    };
    const friendRequestsList = {
        querySelectorAll(selector) {
            const match = selector.match(/data-user-id="([^"]+)"/);
            return match
                ? friends.filter(friend => friend.querySelector(".openFriendBtn").dataset.userId === match[1])
                : friends;
        }
    };
    class ControlledDate extends Date {
        static now() { return now; }
    }

    const context = {
        Date: ControlledDate,
        console: { error() {} },
        document: {
            hidden: false,
            addEventListener(type, handler) { handlers.set(type, handler); },
            createElement() {
                return {
                    className: "",
                    textContent: "",
                    remove() {}
                };
            }
        },
        friends,
        setTimeout(callback, delay) {
            const id = nextTimerId++;
            timers.set(id, { callback, due: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        client: {
            from(table) {
                assert.equal(table, "presence");
                return {
                    select() { return this; },
                    eq(column, value) {
                        assert.equal(column, "user_id");
                        this.userId = value;
                        return this;
                    },
                    maybeSingle() {
                        calls.presenceSelects += 1;
                        return nextPresenceResult;
                    }
                };
            }
        },
        currentUser: { id: "viewer" },
        selectedUser: { id: "friend-a" },
        selectedConversation: { id: "conversation-a" },
        selectedChatGeneration: 4,
        chatMessageLoadGeneration: 0,
        friendPresenceStates: new Map(),
        friendPresenceTrackingIds: new Set(),
        PRESENCE_FRESHNESS_MS: 45000,
        friendPresenceExpiryTimer: null,
        startChatOpenStage() { return null; },
        endChatOpenStage() {},
        isCurrentChatSelection(userId, generation) {
            return Boolean(
                context.currentUser &&
                run("currentUser?.id") &&
                run("selectedUser?.id") === userId &&
                run("selectedChatGeneration") === generation
            );
        },
        showOfflineChatState() {
            context.selectedConversation = null;
        },
        clearMessageSelection() {},
        setCallButtonsDisabled() {},
        formatLastSeen(lastSeen) { return lastSeen ? "Last seen" : "Offline"; },
        getLastMessage() {
            calls.lastMessageReads += 1;
            return nextLastMessageResult;
        },
        sortFriendsList() { calls.sorts += 1; },
        $(id) {
            if (id === "friendRequestsList") return friendRequestsList;
            if (id === "chatUserStatus") return chatUserStatus;
            throw new Error(`Unexpected element: ${id}`);
        }
    };

    let nextLastMessageResult = Promise.resolve({
        body: "Hello",
        created_at: "2026-01-01T00:00:00.000Z"
    });

    vm.createContext(context);
    vm.runInContext([
        "const PRESENCE_FRESHNESS_MS = 45000;",
        "let friendPresenceExpiryTimer = null;",
        "let friendPresenceStates = new Map();",
        "let friendPresenceTrackingIds = new Set();",
        "let currentUser = { id: 'viewer' };",
        "let selectedUser = { id: 'friend-a' };",
        "let selectedConversation = { id: 'conversation-a' };",
        "let selectedChatGeneration = 4;",
        "let chatMessageLoadGeneration = 0;",
        previewHelpers,
        freshnessHelper,
        selectedPresenceRefresh
    ].join("\n"), context);

    function run(code) {
        return vm.runInContext(code, context);
    }

    return {
        context,
        calls,
        friends,
        timers,
        handlers,
        statusClasses,
        chatUserStatus,
        now: () => now,
        setNow(value) { now = value; },
        advance(ms) {
            now += ms;
            while (true) {
                const due = [...timers.entries()].find(([, timer]) => timer.due <= now);
                if (!due) break;
                const [id, timer] = due;
                timers.delete(id);
                timer.callback();
            }
        },
        setPresence(userId, state) {
            run(`friendPresenceStates.set(${JSON.stringify(userId)}, ${JSON.stringify(state)})`);
        },
        setTracked(userId) { run(`friendPresenceTrackingIds.add(${JSON.stringify(userId)})`); },
        presence(userId) {
            return JSON.parse(JSON.stringify(run(`friendPresenceStates.get(${JSON.stringify(userId)}) || null`)));
        },
        schedule() { run("scheduleFriendPresenceExpiry()"); },
        expire() { run("expireStaleFriendPresence()"); },
        async refreshPreview(userId, revision) {
            nextLastMessageResult = this.lastMessageResult || Promise.resolve({
                body: "Hello",
                created_at: new Date(now).toISOString()
            });
            return run(`refreshOnlineFriendPreview(${JSON.stringify(userId)}, ${revision})`);
        },
        setLastMessageResult(promise) { this.lastMessageResult = promise; },
        showOffline(friend) {
            context.testFriend = friend;
            run("showOfflineFriendPreview(testFriend)");
        },
        setPresenceResult(promise) { nextPresenceResult = promise; },
        updateSelectedPresence() {
            return run("updateSelectedUserStatus(null, selectedUser.id, selectedChatGeneration)");
        },
        setFriend(userId, conversationId) {
            const friend = makeFriend(userId, conversationId);
            friends.push(friend);
            return friend;
        },
        setSelectedUser(userId, generation) {
            run(`selectedUser = { id: ${JSON.stringify(userId)} }; selectedChatGeneration = ${generation};`);
        },
        setConversation(id) {
            run(`selectedConversation = ${id === null ? "null" : `{ id: ${JSON.stringify(id)} }`}`);
        },
        logout() { run("currentUser = null"); },
        mapSize() { return run("friendPresenceExpiryTimer !== null"); }
    };
}

test("fresh online friend can display the existing last-message preview", async () => {
    const friend = makeFriend("friend-a", "conversation-a");
    const state = makeHarness({ friends: [friend] });
    state.setTracked("friend-a");
    state.setPresence("friend-a", {
        online: true,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 2
    });

    await state.refreshPreview("friend-a", 2);

    assert.equal(friend.preview.textContent, "Hello");
    assert.equal(state.calls.lastMessageReads, 1);
});

test("presence older than the freshness window is treated as offline", () => {
    const friend = makeFriend("friend-a", "conversation-a");
    const state = makeHarness({ friends: [friend] });
    state.setTracked("friend-a");
    state.setPresence("friend-a", {
        online: true,
        lastSeen: new Date(state.now() - 45001).toISOString(),
        revision: 1
    });

    state.schedule();

    assert.equal(state.presence("friend-a").online, false);
    assert.match(friend.preview.textContent, /friend is offline/);
});

test("a stale non-selected friend's preview is hidden", () => {
    const staleFriend = makeFriend("friend-b", "conversation-b");
    const selectedFriend = makeFriend("friend-a", "conversation-a");
    const state = makeHarness({ friends: [selectedFriend, staleFriend] });
    state.setTracked("friend-a");
    state.setTracked("friend-b");
    state.setPresence("friend-a", {
        online: true,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 1
    });
    state.setPresence("friend-b", {
        online: true,
        lastSeen: new Date(state.now() - 46000).toISOString(),
        revision: 1
    });
    state.setSelectedUser("friend-a", 4);

    state.schedule();

    assert.equal(staleFriend.preview.textContent, "This is private because your friend is offline.");
    assert.equal(state.presence("friend-b").online, false);
    assert.equal(state.presence("friend-a").online, true);
});

test("stale preview expires on the shared timer without selecting that friend", () => {
    const friend = makeFriend("friend-b", "conversation-b");
    const state = makeHarness({ friends: [friend] });
    state.setTracked("friend-b");
    state.setPresence("friend-b", {
        online: true,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 1
    });
    friend.preview = { textContent: "Hello", remove() {} };
    friend.dataset.lastMessageTime = "old-message-time";
    state.setSelectedUser("friend-a", 4);

    state.schedule();
    assert.equal(state.timers.size, 1);
    state.advance(45000);

    assert.equal(friend.preview.textContent, "This is private because your friend is offline.");
    assert.equal(friend.dataset.lastMessageTime, "");
    assert.equal(state.presence("friend-b").online, false);
    assert.equal(state.calls.presenceSelects, 0);
});

test("one friend's stale presence does not change another friend's preview", () => {
    const freshFriend = makeFriend("friend-a", "conversation-a");
    const staleFriend = makeFriend("friend-b", "conversation-b");
    const state = makeHarness({ friends: [freshFriend, staleFriend] });
    state.setTracked("friend-a");
    state.setTracked("friend-b");
    state.setPresence("friend-a", {
        online: true,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 1
    });
    state.setPresence("friend-b", {
        online: true,
        lastSeen: new Date(state.now() - 46000).toISOString(),
        revision: 1
    });
    freshFriend.preview = { textContent: "Fresh preview", remove() {} };
    staleFriend.preview = { textContent: "Stale preview", remove() {} };

    state.schedule();

    assert.equal(freshFriend.preview.textContent, "Fresh preview");
    assert.equal(staleFriend.preview.textContent, "This is private because your friend is offline.");
});

test("a newer online presence refresh can restore the preview", async () => {
    const friend = makeFriend("friend-a", "conversation-a");
    const state = makeHarness({ friends: [friend] });
    state.setTracked("friend-a");
    state.setPresence("friend-a", {
        online: false,
        lastSeen: new Date(state.now() - 50000).toISOString(),
        revision: 2
    });
    state.setPresence("friend-a", {
        online: true,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 3
    });

    await state.refreshPreview("friend-a", 3);

    assert.equal(friend.preview.textContent, "Hello");
    assert.equal(state.presence("friend-a").online, true);
});

test("a stale asynchronous preview refresh cannot restore content after offline state wins", async () => {
    const friend = makeFriend("friend-a", "conversation-a");
    const state = makeHarness({ friends: [friend] });
    state.setTracked("friend-a");
    state.setPresence("friend-a", {
        online: true,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 1
    });
    const pendingMessage = deferred();
    state.setLastMessageResult(pendingMessage.promise);
    const refresh = state.refreshPreview("friend-a", 1);

    state.setPresence("friend-a", {
        online: false,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 2
    });
    state.showOffline(friend);
    pendingMessage.resolve({ body: "Old preview", created_at: "old-time" });
    await refresh;

    assert.equal(friend.preview.textContent, "This is private because your friend is offline.");
    assert.equal(friend.dataset.lastMessageTime, "");
});

test("presence expiry uses one local timeout and does not poll Supabase", () => {
    const first = makeFriend("friend-a", "conversation-a");
    const second = makeFriend("friend-b", "conversation-b");
    const state = makeHarness({ friends: [first, second] });
    for (const userId of ["friend-a", "friend-b"]) {
        state.setTracked(userId);
        state.setPresence(userId, {
            online: true,
            lastSeen: new Date(state.now()).toISOString(),
            revision: 1
        });
    }

    state.schedule();
    state.schedule();

    assert.equal(state.timers.size, 1);
    assert.equal(state.calls.presenceSelects, 0);
});

test("normal selected presence refresh applies a fresh presence result", async () => {
    const state = makeHarness();
    state.setTracked("friend-a");
    await state.updateSelectedPresence();

    assert.equal(state.chatUserStatus.textContent, "Online");
    assert.equal(state.presence("friend-a").online, true);
    assert.equal(state.presence("friend-a").lastSeen, new Date(state.now()).toISOString());
});

test("a Realtime revision change during the selected presence SELECT does not throw", async () => {
    const state = makeHarness();
    const pending = deferred();
    state.setPresenceResult(pending.promise);
    const refresh = state.updateSelectedPresence();
    state.setPresence("friend-a", {
        online: false,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 1
    });

    pending.resolve({
        data: { is_online: true, last_seen: new Date(state.now()).toISOString() },
        error: null
    });

    await assert.doesNotReject(refresh);
    assert.equal(await refresh, false);
});

test("newer Realtime offline state wins over an older online SELECT response", async () => {
    const friend = makeFriend("friend-a", "conversation-a");
    const state = makeHarness({ friends: [friend] });
    state.setTracked("friend-a");
    const pending = deferred();
    state.setPresenceResult(pending.promise);
    const refresh = state.updateSelectedPresence();
    state.setPresence("friend-a", {
        online: false,
        lastSeen: new Date(state.now()).toISOString(),
        revision: 1
    });
    pending.resolve({
        data: { is_online: true, last_seen: new Date(state.now()).toISOString() },
        error: null
    });

    assert.equal(await refresh, false);
    assert.equal(state.presence("friend-a").online, false);
    assert.notEqual(state.chatUserStatus.textContent, "Online");
});

test("selected peer change while presence SELECT is pending ignores the old result", async () => {
    const state = makeHarness();
    const pending = deferred();
    state.setPresenceResult(pending.promise);
    const refresh = state.updateSelectedPresence();
    state.setSelectedUser("friend-b", 5);
    pending.resolve({
        data: { is_online: true, last_seen: new Date(state.now()).toISOString() },
        error: null
    });

    assert.equal(await refresh, null);
    assert.equal(state.chatUserStatus.textContent, "Checking status…");
    assert.equal(state.presence("friend-a"), null);
});

test("logout while presence SELECT is pending ignores the old result", async () => {
    const state = makeHarness();
    const pending = deferred();
    state.setPresenceResult(pending.promise);
    const refresh = state.updateSelectedPresence();
    state.logout();
    pending.resolve({
        data: { is_online: true, last_seen: new Date(state.now()).toISOString() },
        error: null
    });

    assert.equal(await refresh, null);
    assert.equal(state.chatUserStatus.textContent, "Checking status…");
    assert.equal(state.presence("friend-a"), null);
});

test("selected conversation change while presence SELECT is pending ignores the old result", async () => {
    const state = makeHarness();
    const pending = deferred();
    state.setPresenceResult(pending.promise);
    const refresh = state.updateSelectedPresence();
    state.setConversation("conversation-b");
    pending.resolve({
        data: { is_online: true, last_seen: new Date(state.now()).toISOString() },
        error: null
    });

    assert.equal(await refresh, null);
    assert.equal(state.chatUserStatus.textContent, "Checking status…");
    assert.equal(state.presence("friend-a"), null);
});

test("an expired selected presence result remains offline", async () => {
    const state = makeHarness();
    state.setPresenceResult(Promise.resolve({
        data: {
            is_online: true,
            last_seen: new Date(state.now() - 45001).toISOString()
        },
        error: null
    }));

    assert.equal(await state.updateSelectedPresence(), false);
    assert.notEqual(state.chatUserStatus.textContent, "Online");
});

test("presence expiry uses the unchanged 45-second contract and single local expiry wiring", () => {
    assert.match(app, /const PRESENCE_FRESHNESS_MS = 45000/);
    assert.match(app, /setTimeout\(\(\) => \{\s*friendPresenceExpiryTimer = null;\s*scheduleFriendPresenceExpiry\(\)/);
    assert.match(app, /document\.addEventListener\("visibilitychange"/);
    assert.match(app, /friendPresenceStates\.set\(userId, \{[\s\S]*?lastSeen: row\.last_seen/);
});
