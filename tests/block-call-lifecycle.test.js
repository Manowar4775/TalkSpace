"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const app = read("src/app.js");
const call = read("src/call.js");

function sourceBetween(source, start, end) {
    const startAt = source.indexOf(start);
    const endAt = source.indexOf(end, startAt + start.length);
    assert.notEqual(startAt, -1, `missing source marker: ${start}`);
    assert.notEqual(endAt, -1, `missing source marker: ${end}`);
    return source.slice(startAt, endAt);
}

test("verified block Realtime events recheck the selected pair and replace private chat UI", () => {
    const handler = sourceBetween(
        app,
        "async function handleBlockStatusBroadcast(",
        "// Provides call/message guards"
    );
    assert.match(handler, /blocker_id/);
    assert.match(handler, /target_user_id/);
    assert.match(handler, /\["blocked", "unblocked"\]\.includes\(action\)/);
    assert.match(handler, /channel === realtimeChannel/);
    assert.match(handler, /await getBlockState\(selectedPeerId\)/);
    assert.match(handler, /await refreshSelectedUserBlockState\(verifiedBlockState, selectedPeerId\)/);

    const blockedUi = sourceBetween(app, "function showBlockedChatState(", "function showFriendshipRequiredState(");
    assert.match(blockedUi, /This conversation is unavailable because this user blocked you/);
    assert.match(blockedUi, /messageInput"\)\.disabled = true/);
    assert.match(blockedUi, /sendMessageBtn"\)\.disabled = true/);
    assert.match(blockedUi, /setCallButtonsDisabled\(true\)/);
    assert.match(blockedUi, /selectedConversation = null/);
});

test("block and unblock broadcast carries both participants for peer-side revalidation", () => {
    const broadcast = sourceBetween(app, "async function broadcastBlockStatus(", "$(\"blockBtn\").addEventListener(");
    assert.match(broadcast, /blocker_id: currentUser\.id/);
    assert.match(broadcast, /target_user_id: targetUserId/);
    assert.match(broadcast, /event: "block-status"/);

    const subscription = sourceBetween(app, 'realtimeChannel.on(\n        "broadcast",\n        { event: "block-status" }', "// FRIEND REQUEST CHANGES");
    assert.match(subscription, /handleBlockStatusBroadcast\(/);
});

test("denied incoming offers are rejected promptly without clearing an unrelated call", () => {
    const deniedOffer = sourceBetween(call, "if (callerAllowed !== true)", "// Already on another call.");
    assert.match(deniedOffer, /await rejectUnauthorizedIncomingCall\(incomingPeerId, sessionId, generation\)/);

    const rejection = sourceBetween(call, "async function rejectUnauthorizedIncomingCall(", "// ======================================================\n// REJECT INCOMING CALL BECAUSE USER IS BUSY");
    assert.match(rejection, /signal_type: "reject"/);
    assert.match(rejection, /reason: "unavailable"/);
    assert.match(rejection, /currentCallUserId === callerId/);
    assert.match(rejection, /currentCallRole === "receiver"/);
    assert.match(rejection, /cleanupCall\(sessionId\)/);
});

test("block detection immediately cleans matching active calls and notifies the peer", () => {
    const handler = sourceBetween(call, "async function handleBlockedPeerCall(", "// Sends a best-effort hangup");
    assert.match(handler, /currentCallUserId !== peerId/);
    assert.match(handler, /cleanupCall\(sessionId\)/);
    assert.match(handler, /signalType = peerRole === "receiver" \? "reject" : "hangup"/);

    const rejection = sourceBetween(call, 'if (\n    signal.signal_type ===\n    "reject"\n)', "// NO ANSWER / TIMEOUT");
    assert.match(rejection, /wasUnavailable/);
    assert.match(rejection, /privacy or friendship requirements were not met/);
    assert.match(rejection, /cleanupCall\(sessionId\)/);
});

test("message and call permission guards continue to fail closed", () => {
    const isBlocked = sourceBetween(app, "async function isBlocked(", "// CHECK IF SELECTED USER HAS BLOCKED ME");
    assert.match(isBlocked, /blockState\.unknown/);
    assert.match(isBlocked, /return blockState\.blockedByMe \|\| blockState\.blockedMe/);

    const verify = sourceBetween(call, "async function verifyCallPeerPermissions(", "// Starts voice/video negotiation");
    assert.match(verify, /blocked !== false/);
    assert.match(verify, /relationship\?\.verified === true/);
    assert.match(verify, /relationship\.isFriend === true/);
});
