let peerConnection = null;
let localStream = null;
let currentCallUserId = null;
let currentCallRole = null;
let currentCallSessionId = null;
let currentCallPhase = null;
let callUiMinimized = false;
let minimizedCallSessionId = null;
let currentCallPeerName = "TalkSpace call";
let currentCallPeerAvatarUrl = "";
let currentCallStatus = "";
let outgoingCallStartToken = null;
let acceptingCallSessionId = null;
let pendingIceCandidates = [];
let pendingIncomingIceCandidates = [];
let pendingIncomingOfferContext = null;
let outgoingIceCandidates = [];
let outgoingIceOfferReady = false;
let outgoingIceWriteQueue = Promise.resolve();
let callRingTimer = null;
let callConnectionTimer = null;
let callDisconnectedTimer = null;
let callDurationTimer = null;
let callDurationStartedAt = null;
let callSignalsChannel = null;
let callRealtimeGeneration = 0;

const CALL_RING_TIMEOUT = 30000;
const CALL_CONNECTION_TIMEOUT = 45000;
const CALL_DISCONNECTED_RECOVERY_TIMEOUT = 15000;

const rtcConfig = {
    iceServers: [
        {
            urls: "stun:stun.l.google.com:19302"
        }
    ]
};


// ======================================================
// UI HELPERS
// ======================================================

function showCallPanel(id) {
    if (
        callUiMinimized &&
        ["incomingCallPanel", "activeCallPanel"].includes(id)
    ) {
        return;
    }

    const panel = document.getElementById(id);

    if (panel) {
        panel.classList.remove("hidden");
    }
}


function hideCallPanel(id) {
    const panel = document.getElementById(id);

    if (panel) {
        panel.classList.add("hidden");
    }
}


function setCallStatus(text) {
    currentCallStatus = text || "";

    const status = document.getElementById("callStatus");

    if (status) {
        status.textContent = text;
    }

    syncMinimizedCallUi();
}

function setMuteButtonPresentation(button, isMuted) {
    if (!button) return;

    button.textContent = isMuted
        ? "Microphone muted · Unmute"
        : "Microphone on · Mute";
    button.setAttribute("aria-pressed", String(isMuted));
    button.dataset.muted = String(isMuted);
}


function setCallPeerName(name) {
    const peerName = document.getElementById("activeCallPeerName");
    if (peerName) {
        peerName.textContent = name || "TalkSpace call";
    }
}


function setCallPeerPresentation(name, avatarUrl = "") {
    currentCallPeerName = name || "TalkSpace call";
    currentCallPeerAvatarUrl = avatarUrl || "";
    setCallPeerName(currentCallPeerName);
    syncMinimizedCallUi();
}


function isMinimizedCallCurrent() {
    return Boolean(
        callUiMinimized &&
        minimizedCallSessionId &&
        currentCallSessionId === minimizedCallSessionId &&
        currentCallUserId
    );
}


function getMinimizedCallStatus() {
    if (currentCallRole === "receiver" && currentCallPhase === "ringing" && !peerConnection) {
        return "Incoming call ringing";
    }

    if (currentCallPhase === "ringing") {
        return "Calling";
    }

    return currentCallStatus || "Call active";
}


function renderMinimizedCallAvatar() {
    const avatar = document.getElementById("minimizedCallAvatar");
    if (!avatar) return;

    if (typeof setProfileAvatar === "function") {
        setProfileAvatar(avatar, {
            display_name: currentCallPeerName,
            avatar_url: currentCallPeerAvatarUrl
        });
        return;
    }

    avatar.textContent = Array.from(String(currentCallPeerName).trim())[0]?.toLocaleUpperCase() || "?";
}


function syncMinimizedCallUi() {
    const bubble = document.getElementById("minimizedCallBubble");
    if (!bubble) return;

    if (!isMinimizedCallCurrent()) {
        bubble.classList.add("hidden");
        return;
    }

    const name = currentCallPeerName || "TalkSpace call";
    const status = getMinimizedCallStatus();
    const nameElement = document.getElementById("minimizedCallPeerName");
    const statusElement = document.getElementById("minimizedCallStatus");
    const duration = document.getElementById("minimizedCallDuration");

    if (nameElement) nameElement.textContent = name;
    if (statusElement) statusElement.textContent = status;
    if (duration) {
        const activeDuration = document.getElementById("callDuration");
        duration.textContent = activeDuration?.textContent || "00:00";
        duration.classList.toggle("hidden", !callDurationStartedAt);
    }

    renderMinimizedCallAvatar();
    bubble.dataset.callState = currentCallPhase || "active";
    bubble.setAttribute("aria-label", `Restore ${status.toLowerCase()} with ${name}`);
    bubble.classList.remove("hidden");
}


function minimizeCallUi() {
    if (!currentCallSessionId || !currentCallUserId) return false;

    callUiMinimized = true;
    minimizedCallSessionId = currentCallSessionId;
    hideCallPanel("incomingCallPanel");
    hideCallPanel("activeCallPanel");
    syncMinimizedCallUi();
    return true;
}


function restoreMinimizedCallUi() {
    if (!isMinimizedCallCurrent()) {
        resetMinimizedCallUi();
        return false;
    }

    const showIncomingCall =
        currentCallRole === "receiver" &&
        currentCallPhase === "ringing" &&
        !peerConnection;

    callUiMinimized = false;
    minimizedCallSessionId = null;
    syncMinimizedCallUi();
    showCallPanel(showIncomingCall ? "incomingCallPanel" : "activeCallPanel");
    return true;
}


function resetMinimizedCallUi() {
    callUiMinimized = false;
    minimizedCallSessionId = null;
    currentCallPeerName = "TalkSpace call";
    currentCallPeerAvatarUrl = "";
    currentCallStatus = "";

    const bubble = document.getElementById("minimizedCallBubble");
    if (bubble) {
        bubble.classList.add("hidden");
        bubble.removeAttribute("data-call-state");
    }
}


function resetCallDuration() {
    if (callDurationTimer) {
        clearInterval(callDurationTimer);
        callDurationTimer = null;
    }
    callDurationStartedAt = null;
    const duration = document.getElementById("callDuration");
    if (duration) {
        duration.textContent = "00:00";
        duration.classList.add("hidden");
    }
}


function startCallDuration(connection, generation) {
    if (callDurationStartedAt || !connection) return;
    callDurationStartedAt = Date.now();
    const duration = document.getElementById("callDuration");
    if (duration) duration.classList.remove("hidden");

    const renderDuration = () => {
        if (
            generation !== callRealtimeGeneration ||
            peerConnection !== connection ||
            !callDurationStartedAt
        ) return;

        const elapsedSeconds = Math.floor((Date.now() - callDurationStartedAt) / 1000);
        const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, "0");
        const seconds = (elapsedSeconds % 60).toString().padStart(2, "0");
        if (duration) duration.textContent = `${minutes}:${seconds}`;
        syncMinimizedCallUi();
    };

    renderDuration();
    callDurationTimer = setInterval(renderDuration, 1000);
}


// ======================================================
// CALL RING TIMER
// ======================================================

function clearCallRingTimer() {

    if (callRingTimer) {

        clearTimeout(
            callRingTimer
        );

        callRingTimer = null;

    }

}

function clearCallConnectionTimer() {
    if (callConnectionTimer) {
        clearTimeout(callConnectionTimer);
        callConnectionTimer = null;
    }
}

function clearCallDisconnectedTimer() {
    if (callDisconnectedTimer) {
        clearTimeout(callDisconnectedTimer);
        callDisconnectedTimer = null;
    }
}

function createCallSessionId() {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function makeCallSignalData(sessionId, payload) {
    return { session_id: sessionId, payload };
}

function readCallSignalData(signal) {
    const data = signal?.signal_data;
    if (
        !data ||
        typeof data !== "object" ||
        typeof data.session_id !== "string" ||
        !data.session_id
    ) {
        return null;
    }

    return { sessionId: data.session_id, payload: data.payload };
}

function isCallSessionCurrent(sessionId, peerUserId = null) {
    return Boolean(
        sessionId &&
        currentCallSessionId === sessionId &&
        (!peerUserId || currentCallUserId === peerUserId)
    );
}

function isOutgoingCallStartCurrent(startToken, peerUserId) {
    return Boolean(
        startToken &&
        outgoingCallStartToken === startToken &&
        startToken.generation === callRealtimeGeneration &&
        currentUser?.id === startToken.userId &&
        isCallSessionCurrent(startToken.sessionId, peerUserId)
    );
}

function startCallConnectionTimer(connection, generation, sessionId) {
    clearCallConnectionTimer();

    if (!connection || connection.connectionState === "connected") {
        return;
    }

    callConnectionTimer = setTimeout(() => {
        callConnectionTimer = null;

        if (
            peerConnection !== connection ||
            generation !== callRealtimeGeneration ||
            !isCallSessionCurrent(sessionId) ||
            connection.connectionState === "connected"
        ) {
            return;
        }

        endCallAfterConnectionFailure(sessionId, "Could not connect. The call ended.");
    }, CALL_CONNECTION_TIMEOUT);
}

function endCallAfterConnectionFailure(sessionId, feedback) {
    if (!isCallSessionCurrent(sessionId)) return false;

    const targetUserId = currentCallUserId;
    const senderUserId = currentUser?.id;
    if (!cleanupCall(sessionId)) return false;

    if (typeof message === "function") message(feedback);
    if (targetUserId && senderUserId) {
        client
            .from("call_signals")
            .insert({
                caller_id: senderUserId,
                receiver_id: targetUserId,
                signal_type: "hangup",
                signal_data: makeCallSignalData(sessionId, null)
            })
            .then(({ error }) => {
                if (error) console.error("CALL CONNECTION FAILURE SIGNAL ERROR:", error);
            })
            .catch(error => console.error("CALL CONNECTION FAILURE SIGNAL ERROR:", error));
    }
    return true;
}

function startCallDisconnectedTimer(connection, generation, sessionId) {
    clearCallDisconnectedTimer();
    callDisconnectedTimer = setTimeout(() => {
        callDisconnectedTimer = null;
        if (
            peerConnection !== connection ||
            generation !== callRealtimeGeneration ||
            !isCallSessionCurrent(sessionId) ||
            connection.connectionState === "connected"
        ) {
            return;
        }

        endCallAfterConnectionFailure(sessionId, "Connection lost. The call ended.");
    }, CALL_DISCONNECTED_RECOVERY_TIMEOUT);
}

function insertOutgoingIceCandidate(candidate, connection, generation, targetUserId, senderUserId, sessionId) {
    outgoingIceWriteQueue = outgoingIceWriteQueue
        .then(async () => {
            if (
                peerConnection !== connection ||
                generation !== callRealtimeGeneration ||
                !isCallSessionCurrent(sessionId, targetUserId) ||
                !currentUser ||
                currentUser.id !== senderUserId
            ) {
                return;
            }

            const { error } = await client
                .from("call_signals")
                .insert({
                    caller_id: senderUserId,
                    receiver_id: targetUserId,
                    signal_type: "candidate",
                    signal_data: makeCallSignalData(sessionId, candidate)
                });

            if (error) throw error;
        })
        .catch(error => console.error("ICE CANDIDATE ERROR:", error));
}

function markOutgoingIceOfferSent(connection, generation, targetUserId, senderUserId, sessionId) {
    if (
        peerConnection !== connection ||
        generation !== callRealtimeGeneration ||
        !isCallSessionCurrent(sessionId, targetUserId) ||
        !currentUser ||
        currentUser.id !== senderUserId
    ) {
        return;
    }

    outgoingIceOfferReady = true;
    const stagedCandidates = outgoingIceCandidates;
    outgoingIceCandidates = [];
    for (const candidate of stagedCandidates) {
        insertOutgoingIceCandidate(candidate, connection, generation, targetUserId, senderUserId, sessionId);
    }
}


function startCallRingTimer(sessionId) {

    clearCallRingTimer();
    const timerGeneration = callRealtimeGeneration;

    callRingTimer =
        setTimeout(
            async () => {

                if (
                    timerGeneration !== callRealtimeGeneration ||
                    !isCallSessionCurrent(sessionId) ||
                    currentCallPhase !== "ringing"
                ) {
                    return;
                }

                const targetUserId =
                    currentCallUserId;

                const role =
                    currentCallRole;


                if (
                    !targetUserId ||
                    !role ||
                    currentCallSessionId !== sessionId
                ) {
                    return;
                }


                // --------------------------------------------------
                // CALLER TIMEOUT
                // --------------------------------------------------

                if (
                    role === "caller"
                ) {

                    try {

                        const { error } = await client
                            .from("call_signals")
                            .insert({
                                caller_id:
                                    currentUser.id,

                                receiver_id:
                                    targetUserId,

                                signal_type:
                                    "timeout",

                                signal_data:
                                    makeCallSignalData(sessionId, null)
                            });

                        if (error) {
                            console.error("CALL TIMEOUT SIGNAL ERROR:", error);
                        }

                    } catch (error) {

                        console.error(
                            "CALL TIMEOUT SIGNAL ERROR:",
                            error
                        );

                    }

                    if (
                        timerGeneration !== callRealtimeGeneration ||
                        !isCallSessionCurrent(sessionId, targetUserId) ||
                        currentCallRole !== role ||
                        currentCallPhase !== "ringing"
                    ) {
                        return;
                    }


                    cleanupCall(sessionId);


                    if (
                        typeof message ===
                        "function"
                    ) {

                        message(
                            "No answer. The call ended."
                        );

                    }

                }


                // --------------------------------------------------
                // RECEIVER TIMEOUT
                // --------------------------------------------------

                else if (
                    role === "receiver"
                ) {

                    cleanupCall(sessionId);

                }

            },
            CALL_RING_TIMEOUT
        );

}


// ======================================================
// CREATE PEER CONNECTION
// ======================================================

// Creates WebRTC transport and wires media/ICE callbacks to the current call generation.
function createPeerConnection(
    targetUserId,
    role,
    sessionId
) {

    peerConnection =
        new RTCPeerConnection(
            rtcConfig
        );


    currentCallUserId =
        targetUserId;

    currentCallRole =
        role;
    currentCallSessionId = sessionId;

    if (role === "caller") {
        outgoingIceCandidates = [];
        outgoingIceOfferReady = false;
        outgoingIceWriteQueue = Promise.resolve();
    }

    const observedConnection = peerConnection;
    const observedGeneration = callRealtimeGeneration;
    const senderUserId = currentUser?.id;


    // --------------------------------------------------
    // RECEIVE REMOTE AUDIO + VIDEO
    // --------------------------------------------------

    peerConnection.ontrack =
        event => {

            if (
                peerConnection !== observedConnection ||
                observedGeneration !== callRealtimeGeneration ||
                !isCallSessionCurrent(sessionId, targetUserId)
            ) {
                return;
            }

            const stream =
                event.streams[0];

            if (!stream) {
                return;
            }


            // ------------------------------------------
            // REMOTE AUDIO
            // ------------------------------------------

            const remoteAudio =
                document.getElementById(
                    "remoteAudio"
                );


            if (remoteAudio) {

                remoteAudio.srcObject =
                    stream;

                remoteAudio
                    .play()
                    .catch(
                        error => {

                            console.warn(
                                "Remote audio autoplay:",
                                error
                            );

                        }
                    );

            }


            // ------------------------------------------
            // REMOTE VIDEO
            // ------------------------------------------

            const remoteVideo =
                document.getElementById(
                    "remoteVideo"
                );


            if (
                remoteVideo &&
                stream.getVideoTracks().length > 0
            ) {

                remoteVideo.srcObject =
                    stream;

                remoteVideo
                    .play()
                    .catch(
                        error => {

                            console.warn(
                                "Remote video autoplay:",
                                error
                            );

                        }
                    );


                const videoArea =
                    document.getElementById(
                        "videoCallArea"
                    );

                if (videoArea) {

                    videoArea.classList.remove(
                        "hidden"
                    );

                }

            }

        };


    // --------------------------------------------------
    // SEND ICE CANDIDATES
    // --------------------------------------------------

    peerConnection.onicecandidate =
        event => {

            if (
                !event.candidate ||
                !currentUser ||
                currentUser.id !== senderUserId ||
                peerConnection !== observedConnection ||
                observedGeneration !== callRealtimeGeneration ||
                !isCallSessionCurrent(sessionId, targetUserId)
            ) {
                return;
            }


            if (role === "caller" && !outgoingIceOfferReady) {
                outgoingIceCandidates.push(event.candidate);
                return;
            }

            insertOutgoingIceCandidate(
                event.candidate,
                observedConnection,
                observedGeneration,
                targetUserId,
                senderUserId,
                sessionId
            );

        };


    // --------------------------------------------------
    // CALL CONNECTION STATE
    // --------------------------------------------------

    observedConnection.onconnectionstatechange =
        () => {

            if (
                !peerConnection ||
                peerConnection !== observedConnection ||
                observedGeneration !== callRealtimeGeneration ||
                !isCallSessionCurrent(sessionId, targetUserId)
            ) {
                return;
            }


            const state =
                peerConnection.connectionState;


            window.TalkSpaceLogger?.debug(
                "WEBRTC CONNECTION STATE:",
                state
            );


            if (
                state ===
                "connected"
            ) {

                clearCallRingTimer();
                clearCallConnectionTimer();
                clearCallDisconnectedTimer();
                currentCallPhase = "connected";

                setCallStatus(
                    "Connected"
                );
                startCallDuration(observedConnection, observedGeneration);

            }


            if (
                state ===
                "disconnected" ||
                state ===
                "failed"
            ) {

                setCallStatus(
                    "Connection lost"
                );

                if (state === "failed") {
                    endCallAfterConnectionFailure(sessionId, "Connection lost. The call ended.");
                    return;
                }

                startCallDisconnectedTimer(
                    observedConnection,
                    observedGeneration,
                    sessionId
                );

            }


            if (
                state ===
                "closed"
            ) {

                cleanupCall(sessionId);

            }

        };


    return peerConnection;

}


// ======================================================
// START OUTGOING CALL
// ======================================================

// Fails closed unless peer identity, block state, friendship, and call generation remain valid.
async function verifyCallPeerPermissions(
    targetUserId,
    authUserId,
    callGeneration,
    selectionGeneration = null
) {
    if (
        !targetUserId ||
        !authUserId ||
        typeof isBlocked !== "function" ||
        typeof getFriendRelationshipState !== "function"
    ) {
        return false;
    }

    const blocked = await isBlocked(targetUserId);
    if (
        blocked !== false ||
        currentUser?.id !== authUserId ||
        callRealtimeGeneration !== callGeneration
    ) {
        return false;
    }

    const relationship = await getFriendRelationshipState(
        targetUserId,
        authUserId
    );

    return Boolean(
        currentUser?.id === authUserId &&
        callRealtimeGeneration === callGeneration &&
        (
            selectionGeneration === null ||
            (
                selectedUser?.id === targetUserId &&
                selectedChatGeneration === selectionGeneration
            )
        ) &&
        relationship?.verified === true &&
        relationship.isFriend === true
    );
}

// Starts voice/video negotiation only after repeated peer permission and availability checks.
async function startVoiceCall(
    targetUserId,
    isVideoCall = false
) {

    if (
        typeof client === "undefined" ||
        typeof currentUser === "undefined" ||
        !currentUser
    ) {
        throw new Error("TalkSpace is not signed in.");
    }

    if (!targetUserId || targetUserId === currentUser.id) {
        throw new Error("Invalid call target.");
    }

    if (
        outgoingCallStartToken ||
        peerConnection ||
        currentCallSessionId ||
        currentCallUserId
    ) {
        throw new Error("A call is already active or starting.");
    }

    const startToken = {
        sessionId: createCallSessionId(),
        generation: callRealtimeGeneration,
        userId: currentUser.id
    };
    outgoingCallStartToken = startToken;
    currentCallSessionId = startToken.sessionId;
    currentCallUserId = targetUserId;
    currentCallRole = "caller";
    currentCallPhase = "preparing";

    try {
        return await startVoiceCallAttempt(targetUserId, isVideoCall, startToken);
    } catch (error) {
        cleanupCall(startToken.sessionId);
        throw error;
    } finally {
        if (outgoingCallStartToken === startToken) {
            outgoingCallStartToken = null;
        }
    }
}

async function startVoiceCallAttempt(
    targetUserId,
    isVideoCall,
    startToken
) {

    const callGeneration = startToken.generation;

    if (
        typeof client ===
            "undefined" ||
        typeof currentUser ===
            "undefined" ||
        !currentUser
    ) {

        throw new Error(
            "TalkSpace is not signed in."
        );

    }


    if (
        !targetUserId ||
        targetUserId ===
            currentUser.id
    ) {

        throw new Error(
            "Invalid call target."
        );

    }

    const callUserId = currentUser.id;
    const selectionGeneration = selectedChatGeneration;
    const mayCall = await verifyCallPeerPermissions(
        targetUserId,
        callUserId,
        callGeneration,
        selectionGeneration
    );

    if (!isOutgoingCallStartCurrent(startToken, targetUserId)) {
        throw new Error("The call ended before it could start.");
    }

    if (!mayCall) {
        throw new Error(
            currentUser?.id === callUserId && callRealtimeGeneration === callGeneration
                ? "Calls are available only between friends."
                : "The selected user or session changed before the call could start."
        );
    }


    if (
        typeof isSelectedCallPeerOnline !== "function" ||
        !(await isSelectedCallPeerOnline(targetUserId))
    ) {
        throw new Error(
            "Calls are unavailable while this user is offline."
        );
    }

    if (!isOutgoingCallStartCurrent(startToken, targetUserId)) {
        throw new Error("The call ended before media could be acquired.");
    }


    // --------------------------------------------------
    // MICROPHONE + CAMERA
    // --------------------------------------------------

    const acquiredStream =
        await navigator.mediaDevices
            .getUserMedia({

                audio: true,

                video:
                    isVideoCall

            });

    if (
        !isOutgoingCallStartCurrent(startToken, targetUserId) ||
        selectedUser?.id !== targetUserId ||
        selectedChatGeneration !== selectionGeneration
    ) {
        acquiredStream.getTracks().forEach(track => track.stop());
        throw new Error("The session ended before the call could start.");
    }

    if (!(await isSelectedCallPeerOnline(targetUserId))) {
        acquiredStream.getTracks().forEach(track => track.stop());
        throw new Error(
            "Calls are unavailable while this user is offline."
        );
    }

    if (!isOutgoingCallStartCurrent(startToken, targetUserId)) {
        acquiredStream.getTracks().forEach(track => track.stop());
        throw new Error("The call ended before media setup completed.");
    }

    if (
        !(await verifyCallPeerPermissions(
            targetUserId,
            callUserId,
            callGeneration,
            selectionGeneration
        ))
    ) {
        acquiredStream.getTracks().forEach(track => track.stop());
        throw new Error(
            "The friendship could not be verified or is no longer active."
        );
    }

    if (!isOutgoingCallStartCurrent(startToken, targetUserId)) {
        acquiredStream.getTracks().forEach(track => track.stop());
        throw new Error("The call ended before signaling could begin.");
    }

    localStream = acquiredStream;


    // --------------------------------------------------
    // PEER CONNECTION
    // --------------------------------------------------

    createPeerConnection(
        targetUserId,
        "caller",
        startToken.sessionId
    );

    const outgoingConnection = peerConnection;


    localStream
        .getTracks()
        .forEach(
            track => {

                peerConnection.addTrack(
                    track,
                    localStream
                );

            }
        );

    try {
    // --------------------------------------------------
    // CREATE OFFER
    // --------------------------------------------------

    const offer =
        await outgoingConnection
            .createOffer();

    if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== outgoingConnection || !isCallSessionCurrent(startToken.sessionId, targetUserId)) {
        if (peerConnection === outgoingConnection) cleanupCall(startToken.sessionId);
        throw new Error("The call ended before signaling completed.");
    }


    await outgoingConnection
        .setLocalDescription(
            offer
        );

    if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== outgoingConnection || !isCallSessionCurrent(startToken.sessionId, targetUserId)) {
        if (peerConnection === outgoingConnection) cleanupCall(startToken.sessionId);
        throw new Error("The call ended before signaling completed.");
    }

    if (!(await isSelectedCallPeerOnline(targetUserId))) {
        if (peerConnection === outgoingConnection) {
            cleanupCall(startToken.sessionId);
        }

        throw new Error(
            "Calls are unavailable while this user is offline."
        );
    }

    if (
        !(await verifyCallPeerPermissions(
            targetUserId,
            callUserId,
            callGeneration,
            selectionGeneration
        ))
    ) {
        if (peerConnection === outgoingConnection) {
            cleanupCall(startToken.sessionId);
        }

        throw new Error(
            "Calls are available only to verified friends."
        );
    }

    if (!isOutgoingCallStartCurrent(startToken, targetUserId)) {
        throw new Error("The call ended before its offer could be sent.");
    }

    // --------------------------------------------------
    // SEND OFFER
    // --------------------------------------------------

    let error;
    try {
        ({ error } = await client
            .from("call_signals")
            .insert({
                caller_id:
                    currentUser.id,

                receiver_id:
                    targetUserId,

                signal_type:
                    "offer",

                signal_data:
                    makeCallSignalData(startToken.sessionId, offer)
            }));
    } catch (signalError) {
        error = signalError;
    }


    if (error) {

        console.error(
            "SEND OFFER ERROR:",
            error
        );


        if (peerConnection === outgoingConnection) {
            cleanupCall(startToken.sessionId);
        }


        throw error;

    }

    if (
        callGeneration !== callRealtimeGeneration ||
        !currentUser ||
        peerConnection !== outgoingConnection ||
        !isCallSessionCurrent(startToken.sessionId, targetUserId)
    ) {
        throw new Error("The call ended before signaling completed.");
    }

    markOutgoingIceOfferSent(
        outgoingConnection,
        callGeneration,
        targetUserId,
        callUserId,
        startToken.sessionId
    );

    if (isVideoCall) {
        const localVideo = document.getElementById("localVideo");
        const videoArea = document.getElementById("videoCallArea");

        if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.play().catch(error => {
            console.warn("Local video autoplay failed:", error);
            });
        }

        if (videoArea) {
            videoArea.classList.remove("hidden");
        }
    }

    setCallPeerPresentation(
        selectedUser?.display_name || selectedUser?.username || "Friend",
        selectedUser?.avatar_url
    );
    const activeCallTitle = document.getElementById("activeCallTitle");
    if (activeCallTitle) activeCallTitle.textContent = isVideoCall ? "Video call" : "Voice call";
    resetCallDuration();

    showCallPanel("activeCallPanel");
    setCallStatus(
        isVideoCall
            ? "Starting video call..."
            : "Calling..."
    );


    // Start 30-second ringing timer
    currentCallPhase = "ringing";
    startCallRingTimer(startToken.sessionId);

    } catch (error) {
        cleanupCall(startToken.sessionId);
        throw error;
    }

}



// ======================================================
// ACCEPT INCOMING CALL
// ======================================================

// Revalidates the incoming peer before acquiring media and sending the answer signal.
async function acceptIncomingCall(
    callerId,
    offer,
    sessionId
) {
    if (
        !sessionId ||
        !isCallSessionCurrent(sessionId, callerId) ||
        acceptingCallSessionId
    ) {
        return;
    }

    acceptingCallSessionId = sessionId;
    try {
        return await acceptIncomingCallAttempt(callerId, offer, sessionId);
    } finally {
        if (acceptingCallSessionId === sessionId) {
            acceptingCallSessionId = null;
        }
    }
}

async function acceptIncomingCallAttempt(
    callerId,
    offer,
    sessionId
) {

    const callGeneration = callRealtimeGeneration;
    const callUserId = currentUser?.id;
    let acceptedConnection = null;

    if (
        !callerId ||
        !offer ||
        !isCallSessionCurrent(sessionId, callerId)
    ) {
        return;
    }

    const initiallyPermitted = await verifyCallPeerPermissions(
        callerId,
        callUserId,
        callGeneration
    );
    if (!isCallSessionCurrent(sessionId, callerId)) return;

    if (
        currentCallRole !== "receiver" ||
        !initiallyPermitted
    ) {
        if (isCallSessionCurrent(sessionId, callerId)) {
            cleanupCall(sessionId);
        }
        if (typeof message === "function") {
            message("This call is unavailable because the friendship or block status changed.");
        }
        return;
    }


    clearCallRingTimer();


    currentCallUserId =
        callerId;

    currentCallRole =
        "receiver";
    currentCallSessionId = sessionId;
    currentCallPhase = "connecting";


    // --------------------------------------------------
    // DETECT VIDEO CALL
    // --------------------------------------------------

    const isVideoCall =
        offer &&
        offer.sdp &&
        offer.sdp.includes(
            "m=video"
        );


    try {

        // --------------------------------------------------
        // MICROPHONE + CAMERA
        // --------------------------------------------------

        const acquiredStream =
            await navigator.mediaDevices
                .getUserMedia({

                    audio: true,

                    video:
                        isVideoCall

                });

        if (
            callGeneration !== callRealtimeGeneration ||
            currentUser?.id !== callUserId ||
            currentCallUserId !== callerId ||
            currentCallSessionId !== sessionId
        ) {
            acquiredStream.getTracks().forEach(track => track.stop());
            return;
        }

        const mediaPermissionValid = await verifyCallPeerPermissions(
            callerId,
            callUserId,
            callGeneration
        );
        if (
            !isCallSessionCurrent(sessionId, callerId) ||
            currentUser?.id !== callUserId
        ) {
            acquiredStream.getTracks().forEach(track => track.stop());
            return;
        }
        if (!mediaPermissionValid) {
            acquiredStream.getTracks().forEach(track => track.stop());
            if (isCallSessionCurrent(sessionId, callerId)) cleanupCall(sessionId);
            return;
        }

        localStream = acquiredStream;


        // --------------------------------------------------
        // SHOW LOCAL VIDEO
        // --------------------------------------------------

        if (isVideoCall) {

            const localVideo =
                document.getElementById(
                    "localVideo"
                );

            const videoArea =
                document.getElementById(
                    "videoCallArea"
                );


            if (localVideo) {

                localVideo.srcObject =
                    localStream;

                localVideo
                    .play()
                    .catch(
                        error => {

                            console.warn(
                                "Local video autoplay:",
                                error
                            );

                        }
                    );

            }


            if (videoArea) {

                videoArea.classList.remove(
                    "hidden"
                );

            }

        }


        // --------------------------------------------------
        // PEER CONNECTION
        // --------------------------------------------------

        createPeerConnection(
            callerId,
            "receiver",
            sessionId
        );

        acceptedConnection = peerConnection;


        localStream
            .getTracks()
            .forEach(
                track => {

                    peerConnection.addTrack(
                        track,
                        localStream
                    );

                }
            );


        // --------------------------------------------------
        // SET OFFER
        // --------------------------------------------------

        await acceptedConnection
            .setRemoteDescription(
                new RTCSessionDescription(
                    offer
                )
            );

        if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== acceptedConnection || !isCallSessionCurrent(sessionId, callerId)) {
            if (peerConnection === acceptedConnection) cleanupCall(sessionId);
            return;
        }

        const remoteDescriptionPermissionValid = await verifyCallPeerPermissions(
            callerId,
            callUserId,
            callGeneration
        );
        if (
            !isCallSessionCurrent(sessionId, callerId) ||
            peerConnection !== acceptedConnection
        ) {
            return;
        }
        if (!remoteDescriptionPermissionValid) {
            if (peerConnection === acceptedConnection) cleanupCall(sessionId);
            return;
        }

        // --------------------------------------------------
// ADD QUEUED ICE CANDIDATES
// --------------------------------------------------

if (
    pendingIceCandidates.length > 0
) {

    const queuedCandidates = pendingIceCandidates;
    pendingIceCandidates = [];

    window.TalkSpaceLogger?.debug(
        "PROCESSING QUEUED ICE CANDIDATES:",
        queuedCandidates.length
    );


    for (
        const candidate
        of queuedCandidates
    ) {

        if (
            peerConnection !== acceptedConnection ||
            !isCallSessionCurrent(sessionId, callerId)
        ) {
            return;
        }

        try {

            await acceptedConnection
                .addIceCandidate(
                    new RTCIceCandidate(
                        candidate
                    )
                );

        } catch (error) {

            console.error(
                "QUEUED ICE CANDIDATE ERROR:",
                error
            );

        }

    }


}    


        // --------------------------------------------------
        // CREATE ANSWER
        // --------------------------------------------------

        const answer =
            await acceptedConnection
                .createAnswer();

        if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== acceptedConnection || !isCallSessionCurrent(sessionId, callerId)) {
            if (peerConnection === acceptedConnection) cleanupCall(sessionId);
            return;
        }


        await acceptedConnection
            .setLocalDescription(
                answer
            );

        if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== acceptedConnection || !isCallSessionCurrent(sessionId, callerId)) {
            if (peerConnection === acceptedConnection) cleanupCall(sessionId);
            return;
        }


        // --------------------------------------------------
        // SEND ANSWER
        // --------------------------------------------------

        const answerPermissionValid = await verifyCallPeerPermissions(
            callerId,
            callUserId,
            callGeneration
        );
        if (
            currentUser?.id !== callUserId ||
            currentCallUserId !== callerId ||
            currentCallSessionId !== sessionId ||
            peerConnection !== acceptedConnection ||
            !answerPermissionValid
        ) {
            if (peerConnection === acceptedConnection) cleanupCall(sessionId);
            return;
        }

        const {
            error
        } =
            await client
                .from("call_signals")
                .insert({

                    caller_id:
                        currentUser.id,

                    receiver_id:
                        callerId,

                    signal_type:
                        "answer",

                    signal_data:
                        makeCallSignalData(sessionId, answer)

                });


        if (error) {

            console.error(
                "SEND ANSWER ERROR:",
                error
            );

            throw error;

        }

        if (
            callGeneration !== callRealtimeGeneration ||
            !currentUser ||
            peerConnection !== acceptedConnection ||
            !isCallSessionCurrent(sessionId, callerId)
        ) {
            return;
        }

        startCallConnectionTimer(acceptedConnection, callGeneration, sessionId);
        currentCallPhase = "connecting";


        // --------------------------------------------------
        // SHOW ACTIVE CALL
        // --------------------------------------------------

        hideCallPanel(
            "incomingCallPanel"
        );


        showCallPanel(
            "activeCallPanel"
        );

        setCallPeerPresentation(
            document.getElementById("incomingCallerName")?.textContent || "Friend"
        );
        const activeCallTitle = document.getElementById("activeCallTitle");
        if (activeCallTitle) activeCallTitle.textContent = isVideoCall ? "Video call" : "Voice call";
        resetCallDuration();


        setCallStatus(
            isVideoCall
                ? "Connecting video..."
                : "Connecting..."
        );


    } catch (error) {

        if (
            callGeneration !== callRealtimeGeneration ||
            (acceptedConnection && peerConnection !== acceptedConnection) ||
            !isCallSessionCurrent(sessionId, callerId)
        ) {
            return;
        }

        console.error(
            "ACCEPT CALL ERROR:",
            error
        );


        // --------------------------------------------------
        // SAVE CALLER ID BEFORE CLEANUP
        // --------------------------------------------------

        const failedCallerId = currentCallUserId;


        // --------------------------------------------------
        // TELL CALLER THAT ACCEPT FAILED
        // --------------------------------------------------

        if (
            failedCallerId &&
            currentUser
        ) {

            try {

                const { error: signalError } = await client
                    .from("call_signals")
                    .insert({

                        caller_id:
                            currentUser.id,

                        receiver_id:
                            failedCallerId,

                        signal_type:
                            "reject",

                        signal_data: makeCallSignalData(
                            sessionId,
                            { reason: "accept_failed" }
                        )

                    });

                if (signalError) {
                    console.error(
                        "ACCEPT FAILURE SIGNAL ERROR:",
                        signalError
                    );
                }

            } catch (signalError) {

                console.error(
                    "ACCEPT FAILURE SIGNAL ERROR:",
                    signalError
                );

            }

        }


        if (!isCallSessionCurrent(sessionId, callerId)) return;
        cleanupCall(sessionId);


        // --------------------------------------------------
        // CLOSE INCOMING CALL PANEL
        // --------------------------------------------------

        hideCallPanel(
            "incomingCallPanel"
        );


        // --------------------------------------------------
        // SHOW ERROR TO B
        // --------------------------------------------------

        if (
            typeof message ===
            "function"
        ) {

            if (
                error &&
                error.name ===
                    "NotAllowedError"
            ) {

                message(
                    isVideoCall
                        ? "Camera or microphone permission was denied."
                        : "Microphone permission was denied."
                );

            } else if (
                error &&
                error.name ===
                    "NotReadableError"
            ) {

                message(
                    isVideoCall
                        ? "Camera or microphone is already being used by another browser or application."
                        : "Microphone is already being used by another browser or application."
                );

            } else {

                message(
                    "Could not accept the call."
                );

            }

        }

    }

}




// ======================================================
// REJECT INCOMING CALL
// ======================================================

// Rejects the current incoming call and releases its ringing state and resources.
async function rejectIncomingCall(
    callerId,
    sessionId = currentCallSessionId
) {

    const rejectGeneration = callRealtimeGeneration;

    const targetCallerId =
        callerId ||
        currentCallUserId;

    if (
        !targetCallerId ||
        !sessionId ||
        !isCallSessionCurrent(sessionId, targetCallerId) ||
        !currentUser
    ) {
        console.error(
            "REJECT CALL: Missing caller ID."
        );

        return;
    }


    clearCallRingTimer();


    let error;
    try {
        ({ error } = await client
            .from("call_signals")
            .insert({
                caller_id:
                    currentUser.id,

                receiver_id:
                    targetCallerId,

                signal_type:
                    "reject",

                signal_data:
                    makeCallSignalData(sessionId, null)
            }));
    } catch (signalError) {
        error = signalError;
    }


    if (error) {

        console.error(
            "REJECT CALL SIGNAL ERROR:",
            error
        );

        if (
            typeof message ===
            "function"
        ) {

            message(
                "Could not reject the call."
            );

        }

        if (rejectGeneration === callRealtimeGeneration && isCallSessionCurrent(sessionId, targetCallerId)) {
            cleanupCall(sessionId);
        }
        return;
    }

    if (rejectGeneration !== callRealtimeGeneration || !isCallSessionCurrent(sessionId, targetCallerId)) {
        return;
    }


    // Clean up the incoming call state.
    cleanupCall(sessionId);


    if (
        typeof message ===
        "function"
    ) {

        message(
            "Call rejected."
        );

    }

}


// Rejects a denied offer without touching an unrelated active call on this device.
async function rejectUnauthorizedIncomingCall(callerId, sessionId, generation) {
    if (
        !callerId ||
        !sessionId ||
        !currentUser ||
        generation !== callRealtimeGeneration
    ) {
        return false;
    }

    try {
        const { error } = await client
            .from("call_signals")
            .insert({
                caller_id: currentUser.id,
                receiver_id: callerId,
                signal_type: "reject",
                signal_data: makeCallSignalData(sessionId, { reason: "unavailable" })
            });
        if (error) {
            console.error("UNAUTHORIZED CALL REJECT SIGNAL ERROR:", error);
        }
    } catch (error) {
        console.error("UNAUTHORIZED CALL REJECT SIGNAL ERROR:", error);
    }

    if (
        generation === callRealtimeGeneration &&
        currentCallSessionId === sessionId &&
        currentCallUserId === callerId &&
        currentCallRole === "receiver"
    ) {
        cleanupCall(sessionId);
    }
    return true;
}


// ======================================================
// REJECT INCOMING CALL BECAUSE USER IS BUSY
// ======================================================

// Notifies a new caller that this client is busy without disturbing its current call.
async function rejectBusyIncomingCall(
    callerId,
    sessionId
) {

    if (
        !callerId ||
        !sessionId ||
        !currentUser
    ) {
        console.error(
            "BUSY CALL REJECT: Missing caller ID."
        );

        return;
    }


    let error;
    try {
        ({ error } = await client
            .from("call_signals")
            .insert({
                caller_id:
                    currentUser.id,

                receiver_id:
                    callerId,

                signal_type:
                    "reject",

                signal_data:
                    makeCallSignalData(sessionId, { reason: "busy" })
            }));
    } catch (signalError) {
        error = signalError;
    }


    if (error) {

        console.error(
            "BUSY CALL REJECT SIGNAL ERROR:",
            error
        );

    }

}



// ======================================================
// HANDLE CALL SIGNAL
// ======================================================

// Processes call signals only for the current authenticated session and expected peer.
async function handleCallSignal(
signal,
generation = callRealtimeGeneration
) {


if (
    !signal ||
    !currentUser ||
    generation !== callRealtimeGeneration
) {
    return;
}

const callSignalData = readCallSignalData(signal);
if (!callSignalData) {
    window.TalkSpaceLogger?.debug("Ignoring call signal without a session ID.");
    return;
}
const { sessionId, payload: signalPayload } = callSignalData;

if (signal.signal_type !== "offer") {
    const matchesActiveCall =
        currentCallSessionId === sessionId &&
        currentCallUserId === signal.caller_id;
    const matchesPendingCall =
        pendingIncomingOfferContext?.sessionId === sessionId &&
        pendingIncomingOfferContext.callerId === signal.caller_id &&
        pendingIncomingOfferContext.receiverId === currentUser.id &&
        pendingIncomingOfferContext.generation === generation;
    if (!matchesActiveCall && !matchesPendingCall) return;
}


window.TalkSpaceLogger?.debug(
    "HANDLE CALL SIGNAL:",
    signal.signal_type
);


// ==================================================
// INCOMING OFFER
// ==================================================

if (
    signal.signal_type ===
    "offer"
) {

   if (
    signal.caller_id ===
    currentUser.id
) {
    return;
}

const incomingUserId = currentUser.id;
const incomingPeerId = signal.caller_id;
if (
    (currentCallSessionId === sessionId && currentCallUserId === incomingPeerId) ||
    pendingIncomingOfferContext?.sessionId === sessionId
) {
    return;
}

const incomingOfferContext =
    !peerConnection && !currentCallSessionId && !currentCallUserId &&
    !outgoingCallStartToken && !pendingIncomingOfferContext
        ? {
            callerId: incomingPeerId,
            receiverId: incomingUserId,
            generation,
            sessionId
        }
        : null;

if (incomingOfferContext) {
    pendingIncomingOfferContext = incomingOfferContext;
    pendingIncomingIceCandidates = [];
}


// --------------------------------------------------
// BLOCKED USER CHECK
// --------------------------------------------------

// Incoming offers require both a verified unblocked state and an active,
// accepted friendship. Missing helpers and query errors fail closed.
const callerAllowed = await verifyCallPeerPermissions(
    incomingPeerId,
    incomingUserId,
    generation
);

if (
    generation !== callRealtimeGeneration ||
    currentUser?.id !== incomingUserId
) {
    if (pendingIncomingOfferContext === incomingOfferContext) {
        pendingIncomingOfferContext = null;
        pendingIncomingIceCandidates = [];
    }
    return;
}

if (incomingOfferContext && pendingIncomingOfferContext !== incomingOfferContext) {
    return;
}

if (callerAllowed !== true) {
    if (pendingIncomingOfferContext === incomingOfferContext) {
        pendingIncomingOfferContext = null;
        pendingIncomingIceCandidates = [];
    }
    console.warn("Incoming call denied: friendship or block permission was not verified.");
    await rejectUnauthorizedIncomingCall(incomingPeerId, sessionId, generation);
    return;
}


// Already on another call.


    // Already on another call.
    // Send busy/reject signal to the new caller.
    // DO NOT clean up the current call.

    if (
        peerConnection ||
        currentCallSessionId ||
        currentCallUserId ||
        outgoingCallStartToken ||
        (pendingIncomingOfferContext && pendingIncomingOfferContext !== incomingOfferContext)
    ) {

        if (pendingIncomingOfferContext === incomingOfferContext) {
            pendingIncomingOfferContext = null;
            pendingIncomingIceCandidates = [];
        }

        await rejectBusyIncomingCall(
            signal.caller_id,
            sessionId
        );

        return;

    }


    currentCallUserId =
        signal.caller_id;

    currentCallRole =
        "receiver";
    currentCallSessionId = sessionId;
    currentCallPhase = "ringing";

    if (
        incomingOfferContext &&
        pendingIncomingOfferContext === incomingOfferContext &&
        incomingOfferContext.sessionId === sessionId
    ) {
        pendingIceCandidates.push(...pendingIncomingIceCandidates);
        pendingIncomingIceCandidates = [];
        pendingIncomingOfferContext = null;
    }


    // --------------------------------------------------
    // DETECT VOICE OR VIDEO CALL
    // --------------------------------------------------

    const incomingOffer =
        signalPayload;

    const isVideoCall =
        incomingOffer &&
        incomingOffer.sdp &&
        incomingOffer.sdp.includes(
            "m=video"
        );


    // Save call type for the rest of the call.

    window.currentCallIsVideo =
        isVideoCall;


    // --------------------------------------------------
    // RESET VIDEO UI FOR VOICE CALL
    // --------------------------------------------------

    const videoArea =
        document.getElementById(
            "videoCallArea"
        );

    const localVideo =
        document.getElementById(
            "localVideo"
        );

    const remoteVideo =
        document.getElementById(
            "remoteVideo"
        );


    if (!isVideoCall) {

        if (videoArea) {

            videoArea.classList.add(
                "hidden"
            );

        }


        if (localVideo) {

            localVideo.srcObject =
                null;

        }


        if (remoteVideo) {

            remoteVideo.srcObject =
                null;

        }

    }


    // --------------------------------------------------
    // UPDATE INCOMING CALL TITLE
    // --------------------------------------------------

    const incomingTitle =
        document.querySelector(
            "#incomingCallPanel h2"
        );


    if (incomingTitle) {

        incomingTitle.textContent =
            isVideoCall
                ? "Incoming Video Call"
                : "Incoming Voice Call";

    }


    const callerProfile =
        await getCallerProfile(
            signal.caller_id
        );

    if (
        generation !== callRealtimeGeneration ||
        !currentUser ||
        currentCallUserId !== incomingPeerId ||
        currentCallRole !== "receiver" ||
        !isCallSessionCurrent(sessionId, incomingPeerId)
    ) {
        return;
    }


    const callerElement =
        document.getElementById(
            "incomingCallerName"
        );


    if (callerElement) {

        callerElement.textContent =
            callerProfile.name;

    }

    setCallPeerPresentation(
        callerProfile.name,
        callerProfile.avatarUrl
    );


    document
        .getElementById(
            "acceptCallBtn"
        )
        ?.setAttribute(
            "data-caller-id",
            signal.caller_id
        );
    document.getElementById("acceptCallBtn")?.setAttribute("data-call-session-id", sessionId);


    document
        .getElementById(
            "rejectCallBtn"
        )
        ?.setAttribute(
            "data-caller-id",
            signal.caller_id
        );
    document.getElementById("rejectCallBtn")?.setAttribute("data-call-session-id", sessionId);


    window.pendingCallOffer =
        incomingOffer;
    window.pendingCallOfferSessionId = sessionId;


    showCallPanel(
        "incomingCallPanel"
    );


    // Start 30-second ringing timer.

    startCallRingTimer(sessionId);


    return;

}


// ==================================================
// ANSWER
// ==================================================

if (
    signal.signal_type ===
    "answer"
) {

    if (
        !peerConnection ||
        currentCallRole !==
            "caller" ||
        !isCallSessionCurrent(sessionId, signal.caller_id)
    ) {

        return;

    }


    clearCallRingTimer();


const answeringConnection = peerConnection;
startCallConnectionTimer(answeringConnection, generation, sessionId);
currentCallPhase = "connecting";
await answeringConnection
    .setRemoteDescription(
        new RTCSessionDescription(
            signalPayload
        )
    );

if (
    generation !== callRealtimeGeneration ||
    !currentUser ||
    peerConnection !== answeringConnection ||
    !isCallSessionCurrent(sessionId, signal.caller_id)
) {
    return;
}

// --------------------------------------------------
// ADD QUEUED ICE CANDIDATES
// --------------------------------------------------

if (pendingIceCandidates.length > 0) {
    const queuedCandidates = pendingIceCandidates;
    pendingIceCandidates = [];

    window.TalkSpaceLogger?.debug(
        "PROCESSING QUEUED ICE CANDIDATES:",
        queuedCandidates.length
    );

    for (const candidate of queuedCandidates) {
        if (
            peerConnection !== answeringConnection ||
            !isCallSessionCurrent(sessionId, signal.caller_id)
        ) {
            return;
        }

        try {
            await answeringConnection.addIceCandidate(
                new RTCIceCandidate(candidate)
            );
        } catch (error) {
            console.error("QUEUED ICE CANDIDATE ERROR:", error);
        }
    }
}


// --------------------------------------------------
// WAIT FOR ACTUAL WEBRTC CONNECTION
// --------------------------------------------------

setCallStatus(
    "Connecting..."
);


    return;

}


// ==================================================
// ICE CANDIDATE
// ==================================================

// ==================================================
// ICE CANDIDATE
// ==================================================

if (
    signal.signal_type ===
    "candidate"
) {

    if (
        !currentCallUserId &&
        pendingIncomingOfferContext &&
        pendingIncomingOfferContext.callerId === signal.caller_id &&
        pendingIncomingOfferContext.receiverId === currentUser.id &&
        pendingIncomingOfferContext.generation === generation &&
        pendingIncomingOfferContext.sessionId === sessionId
    ) {
        pendingIncomingIceCandidates.push(signalPayload);
        window.TalkSpaceLogger?.debug("Early incoming ICE candidate staged.");
        return;
    }

    if (!isCallSessionCurrent(sessionId, signal.caller_id)) return;

    if (
        !peerConnection
    ) {

        pendingIceCandidates.push(
            signalPayload
        );

        return;

    }


    // --------------------------------------------------
    // WAIT FOR REMOTE DESCRIPTION
    // --------------------------------------------------

    if (
        !peerConnection.remoteDescription
    ) {

        pendingIceCandidates.push(
            signalPayload
        );

        window.TalkSpaceLogger?.debug(
            "ICE CANDIDATE QUEUED"
        );

        return;

    }


    try {

        const candidateConnection = peerConnection;
        if (!isCallSessionCurrent(sessionId, signal.caller_id)) return;
        await candidateConnection
            .addIceCandidate(
                new RTCIceCandidate(
                    signalPayload
                )
            );

            if (
                generation !== callRealtimeGeneration ||
                !currentUser ||
                peerConnection !== candidateConnection ||
                !isCallSessionCurrent(sessionId, signal.caller_id)
            ) {
                return;
            }

    } catch (error) {

        console.error(
            "ADD ICE CANDIDATE ERROR:",
            error
        );

    }


    return;

}


// ==================================================
// HANG UP
// ==================================================

if (
    signal.signal_type ===
    "hangup"
) {

    const matchesPendingIncomingCall =
        pendingIncomingOfferContext?.sessionId === sessionId &&
        pendingIncomingOfferContext.callerId === signal.caller_id &&
        pendingIncomingOfferContext.receiverId === currentUser.id;
    if (!isCallSessionCurrent(sessionId, signal.caller_id) && !matchesPendingIncomingCall) {
        return;
    }

    window.TalkSpaceLogger?.debug(
        "REMOTE HANGUP RECEIVED"
    );


    clearCallRingTimer();


    cleanupCall(sessionId);


    if (
        typeof message ===
        "function"
    ) {

        message(
            "The call has ended."
        );

    }


    return;

}


// ==================================================
// REJECT
// ==================================================

if (
    signal.signal_type ===
    "reject"
) {

window.TalkSpaceLogger?.debug("Call rejection signal received.");


    const wasBusy =
        signalPayload &&
        signalPayload.reason ===
            "busy";


    const wasAcceptFailed =
        signalPayload &&
        signalPayload.reason ===
            "accept_failed";

    const wasUnavailable =
        signalPayload &&
        signalPayload.reason ===
            "unavailable";


    const rejectedUserId =
        currentCallUserId;


    clearCallRingTimer();


    cleanupCall(sessionId);


    if (
        typeof message ===
        "function"
    ) {

        if (wasBusy) {

            let busyUserName =
                "The user";


            if (rejectedUserId) {

                busyUserName =
                    await getCallerName(
                        rejectedUserId
                    );

                    if (generation !== callRealtimeGeneration || !currentUser) {
                        return;
                    }

            }


            message(
                busyUserName +
                " is currently on another call."
            );

        } else if (wasAcceptFailed) {

            message(
                "The video call could not be accepted."
            );

        } else if (wasUnavailable) {

            message(
                "The call is unavailable because privacy or friendship requirements were not met."
            );

        } else {

            message(
                "The call was rejected."
            );

        }

    }


    return;

}


// ==================================================
// NO ANSWER / TIMEOUT
// ==================================================

if (
    signal.signal_type ===
    "timeout"
) {

    window.TalkSpaceLogger?.debug(
        "CALL TIMEOUT RECEIVED"
    );


    clearCallRingTimer();


    cleanupCall(sessionId);


    if (
        typeof message ===
        "function"
    ) {

        message(
            "The call was not answered."
        );

    }


    return;

}


}





// ======================================================
// GET CALLER PROFILE
// ======================================================

async function getCallerProfile(
    userId
) {

    const {
        data,
        error
    } =
        await client
            .from("profiles")
            .select(
                "username, display_name, avatar_url"
            )
            .eq(
                "id",
                userId
            )
            .maybeSingle();


    if (
        error ||
        !data
    ) {

        return {
            name: "Someone",
            avatarUrl: ""
        };

    }


    return {
        name: data.display_name || data.username || "Someone",
        avatarUrl: data.avatar_url || ""
    };

}


// ======================================================
// CLEANUP CALL
// ======================================================

// Fully releases WebRTC, media, timers, pending ICE, UI, and local call state.
function cleanupCall(expectedSessionId = null) {

    if (
        expectedSessionId &&
        currentCallSessionId !== expectedSessionId &&
        outgoingCallStartToken?.sessionId !== expectedSessionId &&
        pendingIncomingOfferContext?.sessionId !== expectedSessionId
    ) {
        return false;
    }

    // --------------------------------------------------
    // STOP RING TIMER
    // --------------------------------------------------

    clearCallRingTimer();
    pendingIceCandidates = [];
    pendingIncomingIceCandidates = [];
    pendingIncomingOfferContext = null;
    outgoingIceCandidates = [];
    outgoingIceOfferReady = false;
    outgoingIceWriteQueue = Promise.resolve();
    clearCallConnectionTimer();
    clearCallDisconnectedTimer();


    // --------------------------------------------------
    // SAVE CURRENT PEER CONNECTION
    // --------------------------------------------------

    const connection =
        peerConnection;


    // --------------------------------------------------
    // DETACH WEBRTC EVENT HANDLERS
    // --------------------------------------------------

    if (connection) {

        connection.ontrack = null;
        connection.onicecandidate = null;
        connection.onconnectionstatechange = null;
        connection.oniceconnectionstatechange = null;
        connection.onsignalingstatechange = null;
        connection.onicegatheringstatechange = null;

    }


    // --------------------------------------------------
    // CLOSE PEER CONNECTION
    // --------------------------------------------------

    if (connection) {

        try {

            connection.close();

        } catch (error) {

            console.error(
                "Peer cleanup error:",
                error
            );

        }

    }


    peerConnection =
        null;


    // --------------------------------------------------
    // STOP LOCAL MEDIA
    // --------------------------------------------------

    if (localStream) {

        localStream
            .getTracks()
            .forEach(
                track => {

                    try {

                        track.stop();

                    } catch (error) {

                        console.error(
                            "Track cleanup error:",
                            error
                        );

                    }

                }
            );


        localStream =
            null;

    }


    // --------------------------------------------------
    // CLEAR LOCAL VIDEO
    // --------------------------------------------------

    const localVideo =
        document.getElementById(
            "localVideo"
        );


    if (localVideo) {

        try {

            localVideo.pause();

        } catch (error) {

            console.error(
                "Local video pause error:",
                error
            );

        }


        localVideo.srcObject =
            null;

    }


    // --------------------------------------------------
    // CLEAR REMOTE VIDEO
    // --------------------------------------------------

    const remoteVideo =
        document.getElementById(
            "remoteVideo"
        );


    if (remoteVideo) {

        try {

            remoteVideo.pause();

        } catch (error) {

            console.error(
                "Remote video pause error:",
                error
            );

        }


        remoteVideo.srcObject =
            null;

    }


    // --------------------------------------------------
    // HIDE VIDEO AREA
    // --------------------------------------------------

    const videoArea =
        document.getElementById(
            "videoCallArea"
        );


    if (videoArea) {

        videoArea.classList.add(
            "hidden"
        );

    }


    // --------------------------------------------------
    // CLEAR REMOTE AUDIO
    // --------------------------------------------------

    const remoteAudio =
        document.getElementById(
            "remoteAudio"
        );


    if (remoteAudio) {

        try {

            remoteAudio.pause();

        } catch (error) {

            console.error(
                "Remote audio pause error:",
                error
            );

        }


        remoteAudio.srcObject =
            null;

    }


    // --------------------------------------------------
    // RESET CALL STATE
    // --------------------------------------------------

    resetMinimizedCallUi();

    currentCallUserId =
        null;

    currentCallRole =
        null;

    currentCallSessionId = null;
    currentCallPhase = null;
    if (!expectedSessionId || outgoingCallStartToken?.sessionId === expectedSessionId) {
        outgoingCallStartToken = null;
    }
    if (!expectedSessionId || acceptingCallSessionId === expectedSessionId) {
        acceptingCallSessionId = null;
    }

    window.pendingCallOffer =
        null;
    window.pendingCallOfferSessionId = null;


    // --------------------------------------------------
    // HIDE CALL PANELS
    // --------------------------------------------------

    hideCallPanel(
        "incomingCallPanel"
    );

    hideCallPanel(
        "activeCallPanel"
    );

    resetCallDuration();


    // --------------------------------------------------
    // RESET MUTE BUTTON
    // --------------------------------------------------

    const muteButton =
        document.getElementById(
            "muteCallBtn"
        );


    if (muteButton) {
        setMuteButtonPresentation(muteButton, false);
    }

    return true;

}


// ======================================================
// HANG UP
// ======================================================

// Immediately clears an active call with a peer when verified block state changes.
async function handleBlockedPeerCall(peerId) {
    if (
        !peerId ||
        currentCallUserId !== peerId ||
        !currentUser
    ) {
        return false;
    }

    const peerRole = currentCallRole;
    const actorId = currentUser.id;
    const sessionId = currentCallSessionId;
    clearCallRingTimer();
    if (!sessionId || !cleanupCall(sessionId)) return false;

    const signalType = peerRole === "receiver" ? "reject" : "hangup";
    try {
        const { error } = await client
            .from("call_signals")
            .insert({
                caller_id: actorId,
                receiver_id: peerId,
                signal_type: signalType,
                signal_data: makeCallSignalData(sessionId, signalType === "reject"
                    ? { reason: "unavailable" }
                    : null)
            });
        if (error) {
            console.error("BLOCKED CALL CLEANUP SIGNAL ERROR:", error);
        }
    } catch (error) {
        console.error("BLOCKED CALL CLEANUP SIGNAL ERROR:", error);
    }

    if (typeof message === "function") {
        message("The call ended because this conversation is unavailable.");
    }
    return true;
}


// Sends a best-effort hangup for the active peer, then runs the shared call cleanup.
async function hangUpCall() {

    const targetUserId =
        currentCallUserId;
    const sessionId = currentCallSessionId;


    // --------------------------------------------------
    // SEND HANGUP SIGNAL FIRST
    // --------------------------------------------------

    try {
    if (
        targetUserId &&
        sessionId &&
        currentUser
    ) {

        const {
            error
        } =
            await client
                .from("call_signals")
                .insert({
                    caller_id:
                        currentUser.id,

                    receiver_id:
                        targetUserId,

                    signal_type:
                        "hangup",

                    signal_data:
                        makeCallSignalData(sessionId, null)
                });


        if (error) {

            console.error(
                "HANGUP SIGNAL ERROR:",
                error
            );

        }

    }


    // --------------------------------------------------
    // CLEAN UP LOCAL CALL
    // --------------------------------------------------

    } catch (error) {
        console.error("HANGUP SIGNAL ERROR:", error);
    } finally {
        clearCallRingTimer();
        cleanupCall(sessionId);
    }

}


// Invalidates queued call events and removes the one call-signalling channel.
async function stopCallRealtime() {
    callRealtimeGeneration += 1;

    const channel = callSignalsChannel;
    callSignalsChannel = null;

    if (!channel) {
        return;
    }

    try {
        await client.removeChannel(channel);
    } catch (error) {
        console.error("CALL REALTIME CHANNEL CLEANUP ERROR:", error);
    }
}


// Stops call signalling before ending any ringing/active call during logout.
async function endCallSessionForLogout() {
    // Invalidate queued and in-flight Realtime work before awaiting the
    // hangup signal, so it cannot recreate call state during logout.
    await stopCallRealtime();

    if (currentCallUserId || peerConnection || callRingTimer) {
        await hangUpCall();
    } else {
        cleanupCall();
    }
}


// ======================================================
// MUTE / UNMUTE
// ======================================================

function toggleMute() {

    if (!localStream) {
        return;
    }


    const audioTrack =
        localStream
            .getAudioTracks()[0];


    if (!audioTrack) {
        return;
    }


    audioTrack.enabled =
        !audioTrack.enabled;


    const button =
        document.getElementById(
            "muteCallBtn"
        );


    if (button) {
        setMuteButtonPresentation(button, !audioTrack.enabled);
    }

}


// ======================================================
// REALTIME CALL SIGNALING
// ======================================================

// Installs one authenticated call-signal subscription tied to the current generation.
function startCallRealtime() {

    if (callSignalsChannel) {
        return;
    }

    const generation = callRealtimeGeneration;

    const channel = client
        .channel(
            "talkspace-call-signals"
        )

        .on(
            "postgres_changes",
            {
                event:
                    "INSERT",

                schema:
                    "public",

                table:
                    "call_signals"
            },

            async payload => {

                if (
                    callSignalsChannel !== channel ||
                    generation !== callRealtimeGeneration
                ) {
                    return;
                }

                const signal =
                payload.new;

             window.TalkSpaceLogger?.debug(
               "CALL SIGNAL TYPE:",
             signal.signal_type
            );

                if (
                    !currentUser ||
                    !signal
                ) {

                    return;

                }


                if (
                    signal.receiver_id !==
                    currentUser.id
                ) {

                    return;

                }

                const signalData = readCallSignalData(signal);
                if (!signalData) {
                    window.TalkSpaceLogger?.debug("Ignoring call signal without a session ID.");
                    return;
                }
                const { sessionId } = signalData;

                // Offers establish an incoming call. Candidates may also
                // arrive while that offer's existing permission checks run.
                if (signal.signal_type !== "offer") {
                    const supportedTypes = [
                        "answer",
                        "candidate",
                        "hangup",
                        "reject",
                        "timeout"
                    ];

                    const isActivePeerSignal =
                        currentCallSessionId === sessionId &&
                        currentCallUserId === signal.caller_id;
                    const isEarlyCandidate =
                        signal.signal_type === "candidate" &&
                        pendingIncomingOfferContext &&
                        pendingIncomingOfferContext.sessionId === sessionId &&
                        pendingIncomingOfferContext.callerId === signal.caller_id &&
                        pendingIncomingOfferContext.receiverId === currentUser.id &&
                        pendingIncomingOfferContext.generation === generation;
                    const isPendingCallEnd =
                        ["hangup", "reject", "timeout"].includes(signal.signal_type) &&
                        pendingIncomingOfferContext &&
                        pendingIncomingOfferContext.sessionId === sessionId &&
                        pendingIncomingOfferContext.callerId === signal.caller_id &&
                        pendingIncomingOfferContext.receiverId === currentUser.id &&
                        pendingIncomingOfferContext.generation === generation;

                    if (
                        !supportedTypes.includes(signal.signal_type) ||
                        (!isActivePeerSignal && !isEarlyCandidate && !isPendingCallEnd)
                    ) {
                        window.TalkSpaceLogger?.debug("Ignoring unrelated call signal.", {
                            signalType: signal.signal_type
                        });
                        return;
                    }
                }


                await handleCallSignal(signal, generation);

            }
        )

        .subscribe(
            status => {

                window.TalkSpaceLogger?.debug(
                    "CALL REALTIME STATUS:",
                    status
                );

            }
        );

    callSignalsChannel = channel;

}


// Start global call signaling
startCallRealtime();


// ======================================================
// CALL BUTTON
// ======================================================

const callButton =
    document.getElementById(
        "callBtn"
    );


if (callButton) {

    callButton.addEventListener(
        "click",
        async () => {

            if (
                typeof selectedUser ===
                    "undefined" ||
                !selectedUser
            ) {

                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        "Please select a user first."
                    );

                }


                return;

            }


            const callTargetUserId = selectedUser.id;
            const callUserId = currentUser?.id;
            const callSelectionGeneration =
                typeof selectedChatGeneration === "number"
                    ? selectedChatGeneration
                    : null;
            const blockCheck =
                typeof isBlocked === "function"
                    ? await isBlocked(callTargetUserId)
                    : "unknown";

            if (
                currentUser?.id !== callUserId ||
                selectedUser?.id !== callTargetUserId ||
                (
                    callSelectionGeneration !== null &&
                    selectedChatGeneration !== callSelectionGeneration
                )
            ) {
                return;
            }

            if (blockCheck !== false) {

                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        blockCheck === true
                            ? "Voice calling is unavailable because one of the users is blocked."
                            : "Could not verify block status. Voice calling is unavailable."
                    );

                }


                return;

            }


            try {

                await startVoiceCall(
                    callTargetUserId
                );


                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        "Calling… waiting for the other user to answer."
                    );

                }

            } catch (error) {

                console.error(
                    "VOICE CALL ERROR:",
                    error
                );


                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        "Could not start the voice call: " +
                        error.message
                    );

                }

            }

        }
    );

}

// ======================================================
// VIDEO CALL BUTTON
// ======================================================

const videoCallButton =
    document.getElementById(
        "videoCallBtn"
    );


if (videoCallButton) {

    videoCallButton.addEventListener(
        "click",
        async () => {

            if (
                typeof selectedUser ===
                    "undefined" ||
                !selectedUser
            ) {

                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        "Please select a user first."
                    );

                }

                return;

            }


            const callTargetUserId = selectedUser.id;
            const callUserId = currentUser?.id;
            const callSelectionGeneration =
                typeof selectedChatGeneration === "number"
                    ? selectedChatGeneration
                    : null;
            const blockCheck =
                typeof isBlocked === "function"
                    ? await isBlocked(callTargetUserId)
                    : "unknown";

            if (
                currentUser?.id !== callUserId ||
                selectedUser?.id !== callTargetUserId ||
                (
                    callSelectionGeneration !== null &&
                    selectedChatGeneration !== callSelectionGeneration
                )
            ) {
                return;
            }

            if (blockCheck !== false) {

                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        blockCheck === true
                            ? "Video calling is unavailable because one of the users is blocked."
                            : "Could not verify block status. Video calling is unavailable."
                    );

                }

                return;

            }


            try {

                await startVoiceCall(
                    callTargetUserId,
                    true
                );


                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        "Video calling… waiting for the other user to answer."
                    );

                }

            } catch (error) {

                console.error(
                    "VIDEO CALL ERROR:",
                    error
                );


                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        "Could not start the video call: " +
                        error.message
                    );

                }

            }

        }
    );

}

// ======================================================
// ACCEPT BUTTON
// ======================================================

const acceptCallButton =
    document.getElementById(
        "acceptCallBtn"
    );


if (acceptCallButton) {

    acceptCallButton.addEventListener(
        "click",
        async () => {

            const callerId =
                acceptCallButton
                    .dataset
                    .callerId;


            const offer =
                window.pendingCallOffer;
            const sessionId = window.pendingCallOfferSessionId;


            if (
                !callerId ||
                !offer ||
                !sessionId
            ) {

                return;

            }


            try {

                await acceptIncomingCall(
                    callerId,
                    offer,
                    sessionId
                );

            } catch (error) {

                console.error(
                    "ACCEPT CALL ERROR:",
                    error
                );


                cleanupCall(sessionId);


                if (
                    typeof message ===
                    "function"
                ) {

                    message(
                        "Could not accept the call."
                    );

                }

            }

        }
    );

}


// ======================================================
// REJECT BUTTON
// ======================================================

const rejectCallButton =
    document.getElementById(
        "rejectCallBtn"
    );


if (rejectCallButton) {

    rejectCallButton.addEventListener(
        "click",
        async () => {

            window.TalkSpaceLogger?.debug(
                "REJECT BUTTON CLICKED"
            );


            const callerId =
                rejectCallButton
                    .dataset
                    .callerId ||
                currentCallUserId;
            const sessionId =
                rejectCallButton.dataset.callSessionId ||
                window.pendingCallOfferSessionId;


            try {

                await rejectIncomingCall(
                    callerId,
                    sessionId
                );

            } catch (error) {

                console.error(
                    "REJECT CALL ERROR:",
                    error
                );

            }

        }
    );

}


// ======================================================
// HANG UP BUTTON
// ======================================================

const hangupCallButton =
    document.getElementById(
        "hangupCallBtn"
    );


if (hangupCallButton) {

    hangupCallButton.addEventListener(
        "click",
        async () => {

            await hangUpCall();

        }
    );

}


// ======================================================
// MUTE BUTTON
// ======================================================

const muteCallButton =
    document.getElementById(
        "muteCallBtn"
    );


if (muteCallButton) {

    muteCallButton.addEventListener(
        "click",
        () => {

            toggleMute();

        }
    );

}


const minimizeIncomingCallButton =
    document.getElementById(
        "minimizeIncomingCallBtn"
    );


if (minimizeIncomingCallButton) {

    minimizeIncomingCallButton.addEventListener(
        "click",
        () => {

            minimizeCallUi();

        }
    );

}


const minimizeActiveCallButton =
    document.getElementById(
        "minimizeActiveCallBtn"
    );


if (minimizeActiveCallButton) {

    minimizeActiveCallButton.addEventListener(
        "click",
        () => {

            minimizeCallUi();

        }
    );

}


const minimizedCallBubble =
    document.getElementById(
        "minimizedCallBubble"
    );


if (minimizedCallBubble) {

    minimizedCallBubble.addEventListener(
        "click",
        () => {

            restoreMinimizedCallUi();

        }
    );

}
