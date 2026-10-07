"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("src/app.js");
const css = read("src/style.css");
const index = read("index.html");
const settings = read("setting.html");
const privacy = read("privacy.html");
const call = read("src/call.js");

function sourceBetween(source, start, end) {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt + start.length);
    assert.notEqual(startAt, -1, `missing source marker: ${start}`);
    assert.notEqual(endAt, -1, `missing source marker: ${end}`);
    return source.slice(startAt, endAt);
}

test("mobile chat navigation has one back handler and reuses the existing friend loader", () => {
    assert.match(index, /id="mobileBackToFriendsBtn"[\s\S]*?aria-label="Back to friends"/);
    assert.equal((app.match(/\$\("mobileBackToFriendsBtn"\)\.addEventListener\(/g) || []).length, 1);

    const openUser = sourceBetween(app, "async function openUser(", "// CHECK BLOCK");
    assert.match(openUser, /mainScreen"\)\.classList\.add\("mobile-chat-active"\)/);
    assert.match(openUser, /const selectionGeneration =\s*\+\+selectedChatGeneration/);

    const back = sourceBetween(app, "function returnToFriendsFromMobileChat()", "// ESCAPE HTML");
    for (const check of [
        /selectedChatGeneration \+= 1/,
        /chatMessageLoadGeneration \+= 1/,
        /friendOpenIntentGeneration \+= 1/,
        /clearMessageSelection\(\)/,
        /selectedUser = null/,
        /selectedConversation = null/,
        /messageInput"\)\.value = ""/,
        /sendTypingStatus\(typingContext, false\)/,
        /\$\("friendsBtn"\)\.click\(\)/
    ]) assert.match(back, check);
    assert.doesNotMatch(back, /sendMessage\(|openConversation\(|\.from\("messages"\)\.insert/);
});

test("dedicated navigation uses one current-view mechanism and preserves async invalidation", () => {
    const navigation = sourceBetween(app, "function navigateToView(", "function closeAccountPopover(");
    assert.match(navigation, /mainScreen\.dataset\.currentView = view/);
    assert.match(navigation, /findPeoplePanel/);
    assert.match(navigation, /friendRequestsPanel/);
    assert.match(navigation, /settingsPanel/);
    assert.match(navigation, /privacyPanel/);
    assert.match(navigation, /classList\.remove\("mobile-chat-active"\)/);

    for (const id of ["friendsBtn", "requestsBtn", "blockedBtn", "profileBtn"]) {
        assert.equal((app.match(new RegExp(`\\$\\("${id}"\\)\\.addEventListener\\(`, "g")) || []).length, 1);
    }
    assert.match(app, /friendOpenIntentGeneration \+= 1/);
    assert.match(app, /selectedChatGeneration \+= 1/);
    assert.match(app, /function cleanupSignedOutState\(\)[\s\S]*?classList\.remove\("mobile-chat-active"\)/);
    assert.match(app, /async function loadCurrentUser\(\)[\s\S]*?classList\.remove\("mobile-chat-active"\)/);

    assert.match(app, /\$\("closeFriendRequestsBtn"\)\.addEventListener\([\s\S]*?navigateToView\("home"\)/);
    assert.match(app, /\$\("findPeopleBackBtn"\)\.addEventListener\("click", returnFromDedicatedView\)/);
    assert.match(app, /chatReturnView = currentView/);
    assert.match(app, /if \(chatReturnView === "friends"\)[\s\S]*?\$\("friendsBtn"\)\.click\(\)/);
});

test("relationship navigation paints its shell before loading and batches profile reads", () => {
    assert.match(app, /function waitForViewPaint\(\)\s*\{\s*return new Promise\(resolve => requestAnimationFrame\(resolve\)\)/);

    const friends = sourceBetween(app, '$("friendsBtn").addEventListener(', 'document.addEventListener("click", async (event) => {');
    const requests = sourceBetween(app, '$("requestsBtn").addEventListener(', '$("closeFriendRequestsBtn").addEventListener(');
    const blocked = sourceBetween(app, '$("blockedBtn").addEventListener(', 'document.addEventListener(\n    "click",\n    async event =>');

    for (const handler of [friends, requests, blocked]) {
        assert.ok(handler.indexOf('list.innerHTML =') < handler.indexOf('await waitForViewPaint()'));
        assert.ok(handler.indexOf('await waitForViewPaint()') < handler.indexOf('.from('));
        assert.match(handler, /\.in\("id",/);
    }
    assert.match(friends, /Promise\.all\(\[[\s\S]*?from\("conversations"\)[\s\S]*?from\("presence"\)/);
    assert.match(friends, /Promise\.all\(\[[\s\S]*?getUnreadCount\([\s\S]*?getLastMessage\(/);
    assert.ok(friends.indexOf("const presenceRevision") < friends.indexOf("const [conversationResult, presenceResult] = await Promise.all"));
    assert.match(friends, /latestPresenceState\.revision !== presenceRevision/);
    assert.match(friends, /Math\.min\(4, friendships\.length\)/);
    assert.match(requests, /friendPanelView !== "requests"/);
    assert.match(blocked, /friendPanelView !== "blocked"/);
});

test("Home shortcuts reuse navigation handlers and the relationship label stays a heading", () => {
    assert.match(index, /<h3 id="relationshipsTitle">Relationships<\/h3>/);
    assert.doesNotMatch(index, /<button[^>]*id="relationshipsTitle"/);
    for (const view of ["findPeople", "friends", "requests", "blocked"]) {
        assert.match(index, new RegExp(`data-home-nav="${view}"`));
    }
    assert.match(app, /const buttonByView = \{[\s\S]*?findPeople: "findPeopleBtn"[\s\S]*?blocked: "blockedBtn"[\s\S]*?\$\(buttonByView\[shortcut\.dataset\.homeNav\]\)\?\.click\(\)/);
    assert.match(app, /function showListFeedback\(list, title, detail = "", actionLabel = "", actionView = ""\)/);
});

test("responsive layout supports a scrollable list, full-height chat, and reachable account pages", () => {
    const mobileStyles = css.slice(css.indexOf("@media (max-width: 700px)"));
    assert.match(mobileStyles, /\.layout\s*\{[\s\S]*?flex-direction:\s*column/);
    assert.match(mobileStyles, /#mainScreen\.mobile-chat-active \.sidebar\s*\{[\s\S]*?display:\s*none/);
    assert.match(mobileStyles, /#mainScreen\.mobile-chat-active #chatPanel:not\(\.hidden\)\s*\{[\s\S]*?display:\s*flex/);
    assert.match(mobileStyles, /#messages\s*\{[\s\S]*?overflow-y:\s*auto/);
    assert.match(mobileStyles, /\.messageContextMenu\s*\{[\s\S]*?max-width:\s*calc\(100vw - 16px\)/);
    assert.match(mobileStyles, /\.messageBox input\s*\{[\s\S]*?min-height:\s*44px/);
    assert.match(mobileStyles, /\.chatHeader\s*\{[\s\S]*?display:\s*grid/);
    assert.match(mobileStyles, /#mainScreen\.mobile-chat-active \.messageBox\s*\{[\s\S]*?env\(safe-area-inset-bottom\)/);
    assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.friend-request-item\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.blocked-user-item \.unblockUserBtn\s*\{[\s\S]*?width:\s*100%/);
    assert.match(index, /id="settingsBtn"[^>]*>Settings/);
    assert.match(index, /id="privacyBtn"[^>]*>Privacy &amp; Safety/);
    assert.match(index, /id="logoutBtn" class="dashboardLogout"/);
    assert.match(index, /id="findPeoplePanel"/);
    assert.match(index, /id="settingsPanel"/);
    assert.match(index, /id="privacyPanel"/);
    assert.match(index, /aria-haspopup="true"[\s\S]*?aria-controls="accountPopover"[\s\S]*?aria-expanded="false"/);
    assert.match(app, /event\.key === "Escape"[\s\S]*?closeAccountPopover\(\)/);
    assert.match(app, /event\.target\.closest\("#accountMenu"\)/);
    assert.match(settings, /href="\.\/privacy\.html"/);
    assert.match(privacy, /href="\.\/setting\.html"/);
    assert.match(privacy, /href="\.\/index\.html"/);

    const contextMenu = sourceBetween(app, "// SHOW MENU", "// CLOSE MESSAGE CONTEXT MENU");
    assert.match(contextMenu, /getBoundingClientRect\(\)/);
    assert.match(contextMenu, /window\.innerWidth - menuRect\.width/);
    assert.match(contextMenu, /window\.innerHeight - menuRect\.height/);
});

test("Home logout is a separate danger corner action and the friend request action stays in the chat header", () => {
    assert.match(index, /<button id="logoutBtn" class="dashboardLogout"/);
    assert.ok(index.indexOf('id="logoutBtn"') > index.indexOf("</main>"));
    assert.match(index, /id="friendRequestBtn"[\s\S]*?aria-label="Send Friend Request"[\s\S]*?title="Send Friend Request"/);
    assert.match(index, /class="friendRequestIcon"[\s\S]*?class="friendRequestPlus"/);
    assert.match(css, /#mainScreen\[data-current-view="home"\] > \.dashboardLogout\s*\{[\s\S]*?display:\s*inline-flex/);
    assert.match(css, /\.dashboardLogout\s*\{[\s\S]*?position:\s*fixed[\s\S]*?right:\s*24px[\s\S]*?bottom:[\s\S]*?var\(--color-danger-surface\)/);

    const actionState = sourceBetween(app, "function setFriendActionState(", "function getFriendRelationshipState(");
    assert.match(actionState, /friendRequestBlockAllowed/);
    assert.match(actionState, /\["unavailable", "unknown", "blocked"\]/);
    assert.match(actionState, /action === "remove"/);
    assert.match(actionState, /relationship\.isFriend/);
    assert.match(actionState, /relationship\.incomingPending/);
    assert.match(actionState, /relationship\.outgoingPending/);
    assert.match(actionState, /"Send Friend Request"/);

    const requestHandler = sourceBetween(app, "friendRequestButton.addEventListener(", "// BLOCK USER");
    assert.match(requestHandler, /await getBlockState\(userId\)/);
    assert.match(requestHandler, /blockState\.blockedByMe \|\| blockState\.blockedMe/);
    assert.match(requestHandler, /FriendRequestLifecycle\.createOrReuseRequest\(/);
});

test("mobile call overlay fits the viewport without changing WebRTC behavior", () => {
    const mobileStyles = css.slice(css.indexOf("@media (max-width: 700px)"));
    assert.match(mobileStyles, /\.callPanel\s*\{[\s\S]*?overflow-y:\s*auto/);
    assert.match(mobileStyles, /\.callPanelContent\s*\{[\s\S]*?max-height:\s*calc\(100dvh - 24px\)/);
    assert.match(mobileStyles, /\.videoCallArea\s*\{[\s\S]*?48dvh/);
    assert.match(call, /async function verifyCallPeerPermissions\(/);
    assert.match(call, /async function startVoiceCall\(/);
    assert.doesNotMatch(call, /RTCPeerConnection\s*=\s*\(/);
});

test("mobile transitions preserve existing privacy gates and async guards", () => {
    const openUser = sourceBetween(app, "async function openUser(", "// CHECK BLOCK");
    assert.match(openUser, /presenceOnline !== true/);
    assert.match(openUser, /blockState\.unknown/);
    assert.match(openUser, /blockState\.blockedByMe \|\| blockState\.blockedMe/);
    assert.match(openUser, /friendship\.isFriend/);
    assert.match(openUser, /isCurrentChatSelection\(user\.id, selectionGeneration\)/);

    const sendMessage = sourceBetween(app, "async function sendMessage()", "// UPDATE SELECTED USER STATUS");
    assert.match(sendMessage, /await isBlocked\(recipientId\)/);
    assert.match(sendMessage, /await getFriendRelationshipState\(/);
    assert.match(sendMessage, /selectedChatGeneration === selectionGeneration/);

    const offlineState = sourceBetween(app, "function showOfflineChatState()", "function setCallButtonsDisabled(");
    assert.match(offlineState, /messageInput"\)\.disabled = true/);
    assert.match(offlineState, /setCallButtonsDisabled\(true\)/);
});
