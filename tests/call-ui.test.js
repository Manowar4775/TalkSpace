"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const call = fs.readFileSync(path.join(root, "src/call.js"), "utf8");
const app = fs.readFileSync(path.join(root, "src/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "src/style.css"), "utf8");

test("incoming and active call panels expose clear, accessible call identity and actions", () => {
    assert.match(html, /id="incomingCallPanel"[\s\S]*?role="dialog"[\s\S]*?aria-modal="true"/);
    assert.match(html, /id="incomingCallerName"/);
    assert.match(html, /id="acceptCallBtn"/);
    assert.match(html, /id="rejectCallBtn"/);
    assert.match(html, /id="activeCallPeerName"/);
    assert.match(html, /id="callStatus" aria-live="polite"/);
    assert.match(html, /id="callDuration"/);
    assert.match(html, /id="hangupCallBtn"/);
    assert.match(html, /id="muteCallBtn"[\s\S]*?aria-pressed="false"[\s\S]*?data-muted="false"/);
    assert.match(html, /id="callNotification"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/);
    assert.equal((html.match(/<svg viewBox="0 0 24 24"/g) || []).length, 2);
    assert.doesNotMatch(html, /📞/);
    assert.equal((html.match(/id="incomingCallPanel"/g) || []).length, 1);
    assert.equal((html.match(/id="activeCallPanel"/g) || []).length, 1);
});

test("active peer name and duration follow the current connection and reset through cleanup", () => {
    assert.match(call, /function setCallPeerName\(/);
    assert.match(call, /function startCallDuration\(connection, generation\)/);
    assert.match(call, /generation !== callRealtimeGeneration/);
    assert.match(call, /peerConnection !== connection/);
    assert.match(call, /startCallDuration\(observedConnection, observedGeneration\)/);
    assert.match(call, /function cleanupCall\(\)[\s\S]*?resetCallDuration\(\)/);
});

test("call feedback replaces its prior hide timer and stays positioned above mobile composer controls", () => {
    assert.match(app, /if \(callNotification\.hideTimer\) \{\s*clearTimeout\(callNotification\.hideTimer\)/);
    assert.match(app, /callNotification\.hideTimer = setTimeout/);
    assert.match(css, /#callNotification:not\(\.hidden\)[\s\S]*?position: fixed/);
    assert.match(css, /bottom: calc\(88px \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.callActions button[\s\S]*?min-height: 52px/);
    assert.match(css, /#callNotification:not\(\.hidden\)[\s\S]*?left: 50%[\s\S]*?bottom: calc\(88px \+ env\(safe-area-inset-bottom\)\)/);
});

test("mute state is presented in text and synchronized with the pressed state", () => {
    assert.match(call, /function setMuteButtonPresentation\(button, isMuted\)/);
    assert.match(call, /Microphone muted · Unmute/);
    assert.match(call, /Microphone on · Mute/);
    assert.match(call, /button\.setAttribute\("aria-pressed", String\(isMuted\)\)/);
    assert.match(css, /#muteCallBtn\[data-muted="true"\]/);
});

test("existing call permission and lifecycle protections remain wired", () => {
    assert.match(call, /verifyCallPeerPermissions\(/);
    assert.match(call, /isSelectedCallPeerOnline\(/);
    assert.match(call, /rejectBusyIncomingCall\(/);
    assert.match(call, /generation !== callRealtimeGeneration/);
    assert.match(call, /function cleanupCall\(\)/);
    assert.match(call, /function stopCallRealtime\(/);
});
