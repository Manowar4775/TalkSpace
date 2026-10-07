"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const page = read("privacy.html");
const styles = read("src/style.css");
const app = read("src/app.js");
const call = read("src/call.js");
const index = read("index.html");
const settings = read("setting.html");
const settingsScript = read("src/settings.js");

function sourceBetween(source, start, end) {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt + start.length);
    assert.notEqual(startAt, -1, `missing source marker: ${start}`);
    assert.notEqual(endAt, -1, `missing source marker: ${end}`);
    return source.slice(startAt, endAt);
}

test("privacy page describes implemented behavior without presenting fake controls", () => {
    for (const phrase of [
        "accepted friends",
        "If either person has blocked the other",
        "cannot verify friendship or block status",
        "chat history and last-message preview are hidden",
        "message composer is unavailable",
        "online visibility",
        "profile-field visibility",
        "profile bio"
    ]) {
        assert.ok(page.toLowerCase().includes(phrase.toLowerCase()), `missing: ${phrase}`);
    }
    assert.doesNotMatch(page, /<(?:form|input|textarea|select|button)\b/i);
    assert.match(page, /href="\.\/index\.html"/);
    assert.match(page, /href="\.\/setting\.html"/);
    assert.match(page, /href="\.\/src\/style\.css"/);
    assert.doesNotMatch(page, /(?:supabase-js|config\.js|settings\.js)/i);
});

test("privacy page uses responsive shared styling and routes back through app startup", () => {
    assert.match(page, /class="card privacy-card"/);
    assert.match(styles, /\.privacy-card\s*\{[\s\S]*?width:\s*min\(780px,\s*calc\(100% - 32px\)\)/);
    assert.match(styles, /\.privacy-navigation\s*\{[\s\S]*?flex-wrap:\s*wrap/);
    assert.match(index, /<script src="\.\/src\/app\.js"><\/script>/);
    assert.equal((app.match(/^initializeApp\(\);$/gm) || []).length, 1);
    assert.match(settings, /href="\.\/privacy\.html"/);
    assert.match(settings, /href|id="backBtn"/);
    assert.match(settingsScript, /window\.location\.href\s*=\s*"index\.html"/);
});

test("friend-only chat, bilateral blocking, and fail-closed checks remain in place", () => {
    const openUser = sourceBetween(app, "async function openUser(", "// CHECK BLOCK");
    assert.ok(openUser.indexOf("presenceOnline !== true") < openUser.indexOf("const blockState = await getBlockState"));
    assert.ok(openUser.indexOf("if (blockState.unknown)") < openUser.indexOf("if (!friendship.isFriend)"));
    assert.match(openUser, /if \(!friendship\.isFriend\)/);
    assert.match(openUser, /chatUserStatus"\)\.textContent !== "Online"[\s\S]*?showOfflineChatState\(\)/);

    const blockState = sourceBetween(app, "async function getBlockState(", "function updateBlockControls(");
    assert.match(blockState, /blockedByMe === BLOCK_CHECK_UNKNOWN/);
    assert.match(blockState, /blockedMe === BLOCK_CHECK_UNKNOWN/);

    const sendMessage = sourceBetween(app, "async function sendMessage()", "// UPDATE SELECTED USER STATUS");
    assert.match(sendMessage, /await isBlocked\(recipientId\)/);
    assert.match(sendMessage, /blocked === BLOCK_CHECK_UNKNOWN/);
    assert.match(sendMessage, /await getFriendRelationshipState\(/);
    assert.match(sendMessage, /friendship\.isFriend/);

    const verifyCall = sourceBetween(call, "async function verifyCallPeerPermissions(", "// Starts voice/video negotiation");
    assert.match(verifyCall, /blocked !== false/);
    assert.match(verifyCall, /relationship\?\.verified === true/);
    assert.match(verifyCall, /relationship\.isFriend === true/);
});

test("offline history and previews are hidden, and Realtime invalidates stale offline UI", () => {
    const offlineChat = sourceBetween(app, "function showOfflineChatState()", "function setCallButtonsDisabled(");
    assert.match(offlineChat, /selectedConversation = null/);
    assert.match(offlineChat, /messageInput"\)\.disabled = true/);
    assert.match(offlineChat, /sendMessageBtn"\)\.disabled = true/);
    assert.match(offlineChat, /setCallButtonsDisabled\(true\)/);
    assert.match(offlineChat, /chatMessageLoadGeneration \+= 1/);

    const offlinePreview = sourceBetween(app, "function showOfflineFriendPreview(", "function renderFriendLastMessage(");
    assert.match(offlinePreview, /dataset\.lastMessageTime = ""/);
    assert.match(offlinePreview, /This is private because your friend is offline/);

    const friendPreviewLoad = sourceBetween(app, "const shouldLoadLastMessage = Boolean(", "const friendDiv = document.createElement(\"div\")");
    assert.match(friendPreviewLoad, /conversation &&[\s\S]*?isFriendOnline[\s\S]*?getLastMessage/);
    assert.match(friendPreviewLoad, /finalPresenceState[\s\S]*?lastMessage = null/);

    const presenceRealtime = sourceBetween(app, "table: \"presence\"", "// PERIODIC PRESENCE CHECK");
    assert.match(presenceRealtime, /showOfflineChatState\(\)/);
    assert.match(presenceRealtime, /isCurrentChatSelection\(/);
});

test("privacy page accurately notes the Settings bio limitation and supported display name", () => {
    assert.match(page, /Manage your supported profile display name in Settings/);
    assert.match(page, /profile bio[\s\S]*?does not support saving or enforcing them/);
    assert.match(settings, /Bio is not stored by the current TalkSpace profile database/);
    assert.match(settingsScript, /\.update\(\{ display_name: displayName \}\)/);
});
