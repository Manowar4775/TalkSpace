"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "call.js"), "utf8");

function makeHarness({ getUserMedia } = {}) {
    const rows = [];
    const messages = [];
    const timers = new Map();
    const elements = new Map();
    let nextTimerId = 1;
    let nextSessionId = 1;
    let mediaRequest = getUserMedia || (async () => makeStream());
    const peerConnections = [];

    function element(id) {
        if (!elements.has(id)) {
            elements.set(id, {
                id,
                dataset: {},
                textContent: "",
                classList: {
                    values: new Set(["hidden"]),
                    add(value) { this.values.add(value); },
                    remove(value) { this.values.delete(value); },
                    toggle(value, force) {
                        if (force === undefined ? !this.values.has(value) : force) this.values.add(value);
                        else this.values.delete(value);
                    },
                    contains(value) { return this.values.has(value); }
                },
                addEventListener() {},
                setAttribute(name, value) { this[name] = value; },
                removeAttribute(name) { delete this[name]; },
                play() { return Promise.resolve(); },
                pause() {},
                style: {},
                srcObject: null
            });
        }
        return elements.get(id);
    }

    class FakePeerConnection {
        constructor() {
            this.connectionState = "new";
            this.remoteDescription = null;
            this.localDescription = null;
            this.addedCandidates = [];
            peerConnections.push(this);
        }
        addTrack() {}
        createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0\nm=audio 9 RTP/AVP 0\nm=video 9 UDP/TLS/RTP/SAVPF 96" }); }
        createAnswer() { return Promise.resolve({ type: "answer", sdp: "v=0\nm=audio 9 RTP/AVP 0" }); }
        setLocalDescription(description) { this.localDescription = description; return Promise.resolve(); }
        setRemoteDescription(description) { this.remoteDescription = description; return Promise.resolve(); }
        addIceCandidate(candidate) { this.addedCandidates.push(candidate); return Promise.resolve(); }
        close() { this.connectionState = "closed"; }
    }

    const context = {
        console: { debug() {}, warn() {}, error() {} },
        Date,
        Math,
        Promise,
        setTimeout(callback, delay) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay, cleared: false });
            return id;
        },
        clearTimeout(id) {
            const timer = timers.get(id);
            if (timer) timer.cleared = true;
        },
        setInterval(callback, delay) {
            const id = nextTimerId++;
            timers.set(id, { callback, delay, cleared: false, interval: true });
            return id;
        },
        clearInterval(id) {
            const timer = timers.get(id);
            if (timer) timer.cleared = true;
        },
        document: {
            getElementById: element,
            querySelector: element,
            addEventListener() {}
        },
        window: { TalkSpaceLogger: { debug() {} } },
        navigator: { mediaDevices: { getUserMedia: (...args) => mediaRequest(...args) } },
        crypto: { randomUUID: () => `call-${nextSessionId++}` },
        RTCPeerConnection: FakePeerConnection,
        RTCSessionDescription: class RTCSessionDescription { constructor(value) { Object.assign(this, value); } },
        RTCIceCandidate: class RTCIceCandidate { constructor(value) { Object.assign(this, value); } },
        currentUser: { id: "local-user" },
        selectedUser: { id: "peer-user", username: "Peer" },
        selectedChatGeneration: 1,
        isBlocked: async () => false,
        getCallerName: async () => "Peer",
        getFriendRelationshipState: async () => ({ verified: true, isFriend: true }),
        isSelectedCallPeerOnline: async () => true,
        message: value => messages.push(value),
        client: {
            from() {
                return {
                    insert(row) {
                        rows.push(row);
                        return Promise.resolve({ error: null });
                    },
                    select() { return this; },
                    eq() { return this; },
                    maybeSingle() { return Promise.resolve({ data: { display_name: "Peer" }, error: null }); }
                };
            },
            channel() {
                return {
                    on() { return this; },
                    subscribe() { return this; }
                };
            },
            removeChannel() { return Promise.resolve(); }
        }
    };

    vm.createContext(context);
    vm.runInContext(`${source}\n;globalThis.__callTest = {
        startVoiceCall,
        acceptIncomingCall,
        rejectIncomingCall,
        handleCallSignal,
        cleanupCall,
        startCallConnectionTimer,
        minimizeCallUi,
        restoreMinimizedCallUi,
        hangUpCall,
        toggleMute,
        getState: () => ({
            peerConnection,
            currentCallUserId,
            currentCallSessionId,
            currentCallPhase,
            callUiMinimized,
            minimizedCallSessionId,
            outgoingCallStartToken,
            acceptingCallSessionId
        })
    };`, context);

    return {
        api: context.__callTest,
        context,
        rows,
        messages,
        timers,
        peerConnections,
        element,
        setMediaRequest(value) { mediaRequest = value; },
        async start(peerId = "peer-user", isVideo = true) {
            context.selectedUser.id = peerId;
            await context.__callTest.startVoiceCall(peerId, isVideo);
            return context.__callTest.getState();
        },
        timerWithDelay(delay) {
            return [...timers.values()].find(timer => timer.delay === delay && !timer.cleared);
        }
    };
}

function makeStream() {
    const track = { enabled: true, stop() {} };
    return {
        getTracks: () => [track],
        getAudioTracks: () => [track],
        getVideoTracks: () => [track]
    };
}

test("two rapid outgoing starts create one connection and one offer", async () => {
    let releaseMedia;
    let mediaRequested;
    const requested = new Promise(resolve => { mediaRequested = resolve; });
    const harness = makeHarness({
        getUserMedia: () => {
            mediaRequested();
            return new Promise(resolve => { releaseMedia = resolve; });
        }
    });

    const firstStart = harness.api.startVoiceCall("peer-user", true);
    await requested;
    await assert.rejects(
        harness.api.startVoiceCall("peer-user", false),
        /already active or starting/
    );

    releaseMedia(makeStream());
    await firstStart;

    assert.equal(harness.peerConnections.length, 1);
    assert.equal(harness.rows.filter(row => row.signal_type === "offer").length, 1);
    assert.equal(harness.api.getState().peerConnection, harness.peerConnections[0]);
    assert.ok(harness.rows.find(row => row.signal_type === "offer").signal_data.session_id);
});

test("failed connection cleans the call and permits another call to the same peer", async () => {
    const harness = makeHarness();
    const first = await harness.start();
    const firstConnection = first.peerConnection;
    firstConnection.connectionState = "failed";
    firstConnection.onconnectionstatechange();

    assert.equal(harness.api.getState().currentCallSessionId, null);
    assert.equal(harness.api.getState().peerConnection, null);
    assert.ok(harness.messages.includes("Connection lost. The call ended."));

    const second = await harness.start();
    assert.equal(harness.peerConnections.length, 2);
    assert.notEqual(second.currentCallSessionId, first.currentCallSessionId);
});

test("disconnected call recovers when it reconnects and cleans up when it does not", async () => {
    const recovered = makeHarness();
    const call = await recovered.start();
    const connection = call.peerConnection;
    connection.connectionState = "disconnected";
    connection.onconnectionstatechange();
    assert.equal(recovered.api.getState().currentCallSessionId, call.currentCallSessionId);

    connection.connectionState = "connected";
    connection.onconnectionstatechange();
    const recoveryTimer = [...recovered.timers.values()].find(timer => timer.delay === 15000);
    assert.equal(recoveryTimer.cleared, true);
    assert.equal(recovered.api.getState().currentCallSessionId, call.currentCallSessionId);

    const dropped = makeHarness();
    const droppedCall = await dropped.start();
    droppedCall.peerConnection.connectionState = "disconnected";
    droppedCall.peerConnection.onconnectionstatechange();
    const pendingRecovery = dropped.timerWithDelay(15000);
    assert.ok(pendingRecovery);
    pendingRecovery.callback();
    assert.equal(dropped.api.getState().currentCallSessionId, null);
    assert.equal(dropped.api.getState().peerConnection, null);
});

test("late terminal signals from call A cannot clean up call B with the same peer", async () => {
    const harness = makeHarness();
    const first = await harness.start();
    const firstSessionId = first.currentCallSessionId;
    harness.api.cleanupCall(firstSessionId);
    const second = await harness.start();
    const secondConnection = second.peerConnection;

    for (const signal_type of ["hangup", "reject", "timeout"]) {
        await harness.api.handleCallSignal({
            caller_id: "peer-user",
            receiver_id: "local-user",
            signal_type,
            signal_data: { session_id: firstSessionId, payload: { reason: "busy" } }
        });
        assert.equal(harness.api.getState().currentCallSessionId, second.currentCallSessionId);
        assert.equal(harness.api.getState().peerConnection, secondConnection);
    }

    await harness.api.handleCallSignal({
        caller_id: "peer-user",
        receiver_id: "local-user",
        signal_type: "hangup",
        signal_data: null
    });
    assert.equal(harness.api.getState().peerConnection, secondConnection);
});

test("a timer callback from call A cannot clean up a replacement call B", async () => {
    const harness = makeHarness();
    const first = await harness.start();
    const firstSessionId = first.currentCallSessionId;
    harness.api.startCallConnectionTimer(first.peerConnection, 0, firstSessionId);
    const oldTimer = harness.timerWithDelay(45000);

    harness.api.cleanupCall(firstSessionId);
    const second = await harness.start();
    oldTimer.callback();

    assert.equal(harness.api.getState().currentCallSessionId, second.currentCallSessionId);
    assert.equal(harness.api.getState().peerConnection, second.peerConnection);
});

test("voice and video share session-correlated offer signaling", async () => {
    for (const isVideo of [false, true]) {
        const harness = makeHarness();
        const call = await harness.start("peer-user", isVideo);
        const offer = harness.rows.find(row => row.signal_type === "offer");
        assert.equal(offer.signal_data.session_id, call.currentCallSessionId);
        assert.equal(offer.signal_data.payload.type, "offer");
        harness.api.cleanupCall(call.currentCallSessionId);
    }
});

test("incoming offer, early ICE, and answer keep the same session identifier", async () => {
    const harness = makeHarness();
    const sessionId = "remote-call-session";
    const offer = {
        type: "offer",
        sdp: "v=0\nm=audio 9 RTP/AVP 0\nm=video 9 UDP/TLS/RTP/SAVPF 96"
    };

    const incomingOffer = harness.api.handleCallSignal({
        caller_id: "peer-user",
        receiver_id: "local-user",
        signal_type: "offer",
        signal_data: { session_id: sessionId, payload: offer }
    });
    await harness.api.handleCallSignal({
        caller_id: "peer-user",
        receiver_id: "local-user",
        signal_type: "candidate",
        signal_data: {
            session_id: sessionId,
            payload: { candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host" }
        }
    });
    await incomingOffer;

    await harness.api.acceptIncomingCall("peer-user", offer, sessionId);
    const answer = harness.rows.find(row => row.signal_type === "answer");

    assert.equal(harness.api.getState().currentCallSessionId, sessionId);
    assert.equal(answer.signal_data.session_id, sessionId);
    assert.equal(answer.signal_data.payload.type, "answer");
    assert.equal(harness.peerConnections[0].addedCandidates.length, 1);
});

test("minimizing an incoming call preserves its session, current chat, and existing answer flow", async () => {
    const harness = makeHarness();
    const sessionId = "incoming-minimized-session";
    const offer = { type: "offer", sdp: "v=0\nm=audio 9 RTP/AVP 0" };
    const selectedChatBefore = harness.context.selectedUser.id;

    await harness.api.handleCallSignal({
        caller_id: "peer-user",
        receiver_id: "local-user",
        signal_type: "offer",
        signal_data: { session_id: sessionId, payload: offer }
    });

    assert.equal(harness.api.minimizeCallUi(), true);
    assert.equal(harness.api.getState().currentCallSessionId, sessionId);
    assert.equal(harness.api.getState().callUiMinimized, true);
    assert.equal(harness.context.selectedUser.id, selectedChatBefore);
    assert.equal(harness.rows.filter(row => row.signal_type === "reject").length, 0);
    assert.equal(harness.element("minimizedCallBubble").classList.contains("hidden"), false);

    assert.equal(harness.api.restoreMinimizedCallUi(), true);
    assert.equal(harness.api.getState().callUiMinimized, false);
    assert.equal(harness.element("incomingCallPanel").classList.contains("hidden"), false);

    await harness.api.acceptIncomingCall("peer-user", offer, sessionId);
    assert.equal(harness.rows.find(row => row.signal_type === "answer").signal_data.session_id, sessionId);
});

test("minimized active calls restore controls and disappear through existing cleanup paths", async () => {
    const harness = makeHarness();
    const call = await harness.start();
    const sessionId = call.currentCallSessionId;

    assert.equal(harness.api.minimizeCallUi(), true);
    assert.equal(harness.api.getState().peerConnection, call.peerConnection);
    assert.equal(harness.api.getState().currentCallSessionId, sessionId);
    assert.equal(harness.element("minimizedCallBubble").classList.contains("hidden"), false);

    assert.equal(harness.api.restoreMinimizedCallUi(), true);
    harness.api.toggleMute();
    assert.equal(harness.element("muteCallBtn")["aria-pressed"], "true");

    await harness.api.handleCallSignal({
        caller_id: "peer-user",
        receiver_id: "local-user",
        signal_type: "hangup",
        signal_data: { session_id: sessionId, payload: null }
    });
    assert.equal(harness.api.getState().currentCallSessionId, null);
    assert.equal(harness.api.getState().callUiMinimized, false);
    assert.equal(harness.element("minimizedCallBubble").classList.contains("hidden"), true);
});

test("minimized incoming calls clear their indicator through the existing reject path", async () => {
    const harness = makeHarness();
    const sessionId = "incoming-rejected-session";

    await harness.api.handleCallSignal({
        caller_id: "peer-user",
        receiver_id: "local-user",
        signal_type: "offer",
        signal_data: {
            session_id: sessionId,
            payload: { type: "offer", sdp: "v=0\nm=audio 9 RTP/AVP 0" }
        }
    });
    harness.api.minimizeCallUi();

    await harness.api.rejectIncomingCall("peer-user", sessionId);
    assert.equal(harness.api.getState().currentCallSessionId, null);
    assert.equal(harness.element("minimizedCallBubble").classList.contains("hidden"), true);
    assert.equal(harness.rows.filter(row => row.signal_type === "reject").length, 1);
});

test("minimized calls clear their indicator after connection failure and local hangup", async () => {
    const failed = makeHarness();
    const failedCall = await failed.start();
    failed.api.minimizeCallUi();
    failedCall.peerConnection.connectionState = "failed";
    failedCall.peerConnection.onconnectionstatechange();
    assert.equal(failed.api.getState().currentCallSessionId, null);
    assert.equal(failed.element("minimizedCallBubble").classList.contains("hidden"), true);

    const ended = makeHarness();
    await ended.start();
    ended.api.minimizeCallUi();
    await ended.api.hangUpCall();
    assert.equal(ended.api.getState().currentCallSessionId, null);
    assert.equal(ended.element("minimizedCallBubble").classList.contains("hidden"), true);
    assert.equal(ended.rows.filter(row => row.signal_type === "hangup").length, 1);
});
