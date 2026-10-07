let peerConnection = null;
let localStream = null;
let currentCallUserId = null;
let currentCallRole = null;
let pendingIceCandidates = [];
let callRingTimer = null;
let callDurationTimer = null;
let callDurationStartedAt = null;
let callSignalsChannel = null;
let callRealtimeGeneration = 0;

const CALL_RING_TIMEOUT = 30000;

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
    const status = document.getElementById("callStatus");

    if (status) {
        status.textContent = text;
    }
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


function startCallRingTimer() {

    clearCallRingTimer();
    const timerGeneration = callRealtimeGeneration;

    callRingTimer =
        setTimeout(
            async () => {

                if (timerGeneration !== callRealtimeGeneration) {
                    return;
                }

                const targetUserId =
                    currentCallUserId;

                const role =
                    currentCallRole;


                if (
                    !targetUserId ||
                    !role
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
                                    null
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

                    if (timerGeneration !== callRealtimeGeneration) {
                        return;
                    }


                    cleanupCall();


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

                    cleanupCall();

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
    role
) {

    peerConnection =
        new RTCPeerConnection(
            rtcConfig
        );


    currentCallUserId =
        targetUserId;

    currentCallRole =
        role;


    // --------------------------------------------------
    // RECEIVE REMOTE AUDIO + VIDEO
    // --------------------------------------------------

    peerConnection.ontrack =
        event => {

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
        async event => {

            if (
                !event.candidate ||
                !currentUser
            ) {
                return;
            }


            try {

                const { error } = await client
                    .from("call_signals")
                    .insert({
                        caller_id:
                            currentUser.id,

                        receiver_id:
                            targetUserId,

                        signal_type:
                            "candidate",

                        signal_data:
                            event.candidate
                    });

                if (error) {
                    console.error("ICE CANDIDATE ERROR:", error);
                }

            } catch (error) {

                console.error(
                    "ICE CANDIDATE ERROR:",
                    error
                );

            }

        };


    // --------------------------------------------------
    // CALL CONNECTION STATE
    // --------------------------------------------------

    const observedConnection = peerConnection;
    const observedGeneration = callRealtimeGeneration;
    observedConnection.onconnectionstatechange =
        () => {

            if (
                !peerConnection ||
                peerConnection !== observedConnection ||
                observedGeneration !== callRealtimeGeneration
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

            }


            if (
                state ===
                "closed"
            ) {

                cleanupCall();

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

    const callGeneration = callRealtimeGeneration;

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

    if (!mayCall) {
        throw new Error(
            currentUser?.id === callUserId && callRealtimeGeneration === callGeneration
                ? "Calls are available only between friends."
                : "The selected user or session changed before the call could start."
        );
    }


    if (
        peerConnection ||
        currentCallUserId
    ) {

        throw new Error(
            "A call is already active."
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

    localStream = acquiredStream;


    // --------------------------------------------------
    // PEER CONNECTION
    // --------------------------------------------------

    createPeerConnection(
        targetUserId,
        "caller"
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

    if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== outgoingConnection) {
        if (peerConnection === outgoingConnection) cleanupCall();
        throw new Error("The call ended before signaling completed.");
    }


    await outgoingConnection
        .setLocalDescription(
            offer
        );

    if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== outgoingConnection) {
        if (peerConnection === outgoingConnection) cleanupCall();
        throw new Error("The call ended before signaling completed.");
    }

    if (!(await isSelectedCallPeerOnline(targetUserId))) {
        if (peerConnection === outgoingConnection) {
            cleanupCall();
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
            cleanupCall();
        }

        throw new Error(
            "Calls are available only to verified friends."
        );
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
                    offer
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
            cleanupCall();
        }


        throw error;

    }

    if (
        callGeneration !== callRealtimeGeneration ||
        !currentUser ||
        peerConnection !== outgoingConnection
    ) {
        throw new Error("The call ended before signaling completed.");
    }

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

    setCallPeerName(selectedUser?.display_name || selectedUser?.username || "Friend");
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
    startCallRingTimer();

    } catch (error) {
        if (peerConnection === outgoingConnection) {
            cleanupCall();
        }
        throw error;
    }

}



// ======================================================
// ACCEPT INCOMING CALL
// ======================================================

// Revalidates the incoming peer before acquiring media and sending the answer signal.
async function acceptIncomingCall(
    callerId,
    offer
) {

    const callGeneration = callRealtimeGeneration;
    const callUserId = currentUser?.id;
    let acceptedConnection = null;

    if (
        !callerId ||
        !offer
    ) {
        return;
    }

    if (
        currentCallUserId !== callerId ||
        currentCallRole !== "receiver" ||
        !(await verifyCallPeerPermissions(
            callerId,
            callUserId,
            callGeneration
        ))
    ) {
        if (currentCallUserId === callerId) {
            cleanupCall();
        }
        if (typeof message === "function") {
            message("This call is unavailable because the friendship or block status changed.");
        }
        return;
    }


    clearCallRingTimer();


    if (peerConnection) {

        cleanupCall();

    }


    currentCallUserId =
        callerId;

    currentCallRole =
        "receiver";


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
            currentCallUserId !== callerId
        ) {
            acquiredStream.getTracks().forEach(track => track.stop());
            return;
        }

        if (!(await verifyCallPeerPermissions(
            callerId,
            callUserId,
            callGeneration
        ))) {
            acquiredStream.getTracks().forEach(track => track.stop());
            if (currentCallUserId === callerId) cleanupCall();
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
            "receiver"
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

        if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== acceptedConnection) {
            if (peerConnection === acceptedConnection) cleanupCall();
            return;
        }

        if (!(await verifyCallPeerPermissions(
            callerId,
            callUserId,
            callGeneration
        ))) {
            if (peerConnection === acceptedConnection) cleanupCall();
            return;
        }

        // --------------------------------------------------
// ADD QUEUED ICE CANDIDATES
// --------------------------------------------------

if (
    pendingIceCandidates.length > 0
) {

    window.TalkSpaceLogger?.debug(
        "PROCESSING QUEUED ICE CANDIDATES:",
        pendingIceCandidates.length
    );


    for (
        const candidate
        of pendingIceCandidates
    ) {

        try {

            await peerConnection
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


    pendingIceCandidates =
        [];

}    


        // --------------------------------------------------
        // CREATE ANSWER
        // --------------------------------------------------

        const answer =
            await acceptedConnection
                .createAnswer();

        if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== acceptedConnection) {
            if (peerConnection === acceptedConnection) cleanupCall();
            return;
        }


        await acceptedConnection
            .setLocalDescription(
                answer
            );

        if (callGeneration !== callRealtimeGeneration || !currentUser || peerConnection !== acceptedConnection) {
            if (peerConnection === acceptedConnection) cleanupCall();
            return;
        }


        // --------------------------------------------------
        // SEND ANSWER
        // --------------------------------------------------

        if (
            currentUser?.id !== callUserId ||
            currentCallUserId !== callerId ||
            peerConnection !== acceptedConnection ||
            !(await verifyCallPeerPermissions(
                callerId,
                callUserId,
                callGeneration
            ))
        ) {
            if (peerConnection === acceptedConnection) cleanupCall();
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
                        answer

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
            peerConnection !== acceptedConnection
        ) {
            return;
        }


        // --------------------------------------------------
        // SHOW ACTIVE CALL
        // --------------------------------------------------

        hideCallPanel(
            "incomingCallPanel"
        );


        showCallPanel(
            "activeCallPanel"
        );

        setCallPeerName(document.getElementById("incomingCallerName")?.textContent || "Friend");
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
            (acceptedConnection && peerConnection !== acceptedConnection)
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

        const failedCallerId =
            currentCallUserId;


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

                        signal_data: {
                            reason:
                                "accept_failed"
                        }

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


        // --------------------------------------------------
        // STOP LOCAL MEDIA
        // --------------------------------------------------

        if (localStream) {

            localStream
                .getTracks()
                .forEach(
                    track => {

                        track.stop();

                    }
                );

            localStream =
                null;

        }


        // --------------------------------------------------
        // CLOSE PEER CONNECTION
        // --------------------------------------------------

        if (peerConnection) {

            try {

                peerConnection.close();

            } catch (closeError) {

                console.error(
                    "PEER CLOSE ERROR:",
                    closeError
                );

            }

            peerConnection =
                null;

        }


        currentCallUserId =
            null;

        currentCallRole =
            null;


        window.pendingCallOffer =
            null;

        pendingIceCandidates = [];

        cleanupCall();


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
    callerId
) {

    const rejectGeneration = callRealtimeGeneration;

    const targetCallerId =
        callerId ||
        currentCallUserId;

    if (
        !targetCallerId ||
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
                    null
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

        if (rejectGeneration === callRealtimeGeneration) {
            cleanupCall();
        }
        return;
    }

    if (rejectGeneration !== callRealtimeGeneration) {
        return;
    }


    // Clean up the incoming call state.
    cleanupCall();


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
async function rejectUnauthorizedIncomingCall(callerId, generation) {
    if (
        !callerId ||
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
                signal_data: { reason: "unavailable" }
            });
        if (error) {
            console.error("UNAUTHORIZED CALL REJECT SIGNAL ERROR:", error);
        }
    } catch (error) {
        console.error("UNAUTHORIZED CALL REJECT SIGNAL ERROR:", error);
    }

    if (
        generation === callRealtimeGeneration &&
        currentCallUserId === callerId &&
        currentCallRole === "receiver"
    ) {
        cleanupCall();
    }
    return true;
}


// ======================================================
// REJECT INCOMING CALL BECAUSE USER IS BUSY
// ======================================================

// Notifies a new caller that this client is busy without disturbing its current call.
async function rejectBusyIncomingCall(
    callerId
) {

    if (
        !callerId ||
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
                    {
                        reason:
                            "busy"
                    }
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
    return;
}

if (callerAllowed !== true) {
    console.warn("Incoming call denied: friendship or block permission was not verified.");
    await rejectUnauthorizedIncomingCall(incomingPeerId, generation);
    return;
}


// Already on another call.


    // Already on another call.
    // Send busy/reject signal to the new caller.
    // DO NOT clean up the current call.

    if (
        peerConnection ||
        currentCallUserId
    ) {

        await rejectBusyIncomingCall(
            signal.caller_id
        );

        return;

    }


    currentCallUserId =
        signal.caller_id;

    currentCallRole =
        "receiver";


    // --------------------------------------------------
    // DETECT VOICE OR VIDEO CALL
    // --------------------------------------------------

    const incomingOffer =
        signal.signal_data;

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


    const callerName =
        await getCallerName(
            signal.caller_id
        );

    if (
        generation !== callRealtimeGeneration ||
        !currentUser ||
        currentCallUserId !== incomingPeerId ||
        currentCallRole !== "receiver"
    ) {
        return;
    }


    const callerElement =
        document.getElementById(
            "incomingCallerName"
        );


    if (callerElement) {

        callerElement.textContent =
            callerName;

    }


    document
        .getElementById(
            "acceptCallBtn"
        )
        ?.setAttribute(
            "data-caller-id",
            signal.caller_id
        );


    document
        .getElementById(
            "rejectCallBtn"
        )
        ?.setAttribute(
            "data-caller-id",
            signal.caller_id
        );


    window.pendingCallOffer =
        signal.signal_data;


    showCallPanel(
        "incomingCallPanel"
    );


    // Start 30-second ringing timer.

    startCallRingTimer();


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
            "caller"
    ) {

        return;

    }


    clearCallRingTimer();


const answeringConnection = peerConnection;
await answeringConnection
    .setRemoteDescription(
        new RTCSessionDescription(
            signal.signal_data
        )
    );

if (
    generation !== callRealtimeGeneration ||
    !currentUser ||
    peerConnection !== answeringConnection
) {
    return;
}


// --------------------------------------------------
// ADD QUEUED ICE CANDIDATES
// --------------------------------------------------

if (
    pendingIceCandidates.length > 0
) {

    window.TalkSpaceLogger?.debug(
        "PROCESSING QUEUED ICE CANDIDATES:",
        pendingIceCandidates.length
    );


    for (
        const candidate
        of pendingIceCandidates
    ) {

        try {

            await peerConnection
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


    pendingIceCandidates =
        [];

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
        !peerConnection
    ) {

        pendingIceCandidates.push(
            signal.signal_data
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
            signal.signal_data
        );

        window.TalkSpaceLogger?.debug(
            "ICE CANDIDATE QUEUED"
        );

        return;

    }


    try {

        await peerConnection
            .addIceCandidate(
                new RTCIceCandidate(
                    signal.signal_data
                )
            );

            if (generation !== callRealtimeGeneration || !currentUser) {
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

    window.TalkSpaceLogger?.debug(
        "REMOTE HANGUP RECEIVED"
    );


    clearCallRingTimer();


    cleanupCall();


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
        signal.signal_data &&
        signal.signal_data.reason ===
            "busy";


    const wasAcceptFailed =
        signal.signal_data &&
        signal.signal_data.reason ===
            "accept_failed";

    const wasUnavailable =
        signal.signal_data &&
        signal.signal_data.reason ===
            "unavailable";


    const rejectedUserId =
        currentCallUserId;


    clearCallRingTimer();


    cleanupCall();


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


    cleanupCall();


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
// GET CALLER NAME
// ======================================================

async function getCallerName(
    userId
) {

    const {
        data,
        error
    } =
        await client
            .from("profiles")
            .select(
                "username, display_name"
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

        return "Someone";

    }


    return (
        data.display_name ||
        data.username ||
        "Someone"
    );

}


// ======================================================
// CLEANUP CALL
// ======================================================

// Fully releases WebRTC, media, timers, pending ICE, UI, and local call state.
function cleanupCall() {

    // --------------------------------------------------
    // STOP RING TIMER
    // --------------------------------------------------

    clearCallRingTimer();
    pendingIceCandidates = [];


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

    currentCallUserId =
        null;

    currentCallRole =
        null;

    window.pendingCallOffer =
        null;


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
    clearCallRingTimer();
    cleanupCall();

    const signalType = peerRole === "receiver" ? "reject" : "hangup";
    try {
        const { error } = await client
            .from("call_signals")
            .insert({
                caller_id: actorId,
                receiver_id: peerId,
                signal_type: signalType,
                signal_data: signalType === "reject"
                    ? { reason: "unavailable" }
                    : null
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


    // --------------------------------------------------
    // SEND HANGUP SIGNAL FIRST
    // --------------------------------------------------

    try {
    if (
        targetUserId &&
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
                        null
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
        cleanupCall();
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

                // Offers establish a new incoming call. Every other call
                // signal must belong to the peer already assigned to this call.
                if (signal.signal_type !== "offer") {
                    const supportedTypes = [
                        "answer",
                        "candidate",
                        "hangup",
                        "reject",
                        "timeout"
                    ];

                    if (
                        !supportedTypes.includes(signal.signal_type) ||
                        !currentCallUserId ||
                        signal.caller_id !== currentCallUserId
                    ) {
                        window.TalkSpaceLogger?.debug("Ignoring unrelated call signal.", {
                            signalType: signal.signal_type
                        });
                        return;
                    }
                }


                await handleCallSignal(
                    signal,
                    generation
                );

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


            if (
                !callerId ||
                !offer
            ) {

                return;

            }


            try {

                await acceptIncomingCall(
                    callerId,
                    offer
                );

            } catch (error) {

                console.error(
                    "ACCEPT CALL ERROR:",
                    error
                );


                cleanupCall();


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


            try {

                await rejectIncomingCall(
                    callerId
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
