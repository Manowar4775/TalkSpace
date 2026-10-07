(function (root, factory) {
    const lifecycle = factory();

    if (typeof module === "object" && module.exports) {
        module.exports = lifecycle;
    } else {
        root.FriendRequestLifecycle = lifecycle;
    }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
    "use strict";

    // Resolves relationship state from both directional rows without collapsing request history.
    function classifyRows(rows, authUserId, peerId) {
        const pairRows = Array.isArray(rows)
            ? rows.filter(row => (
                row.sender_id === authUserId && row.receiver_id === peerId
            ) || (
                row.sender_id === peerId && row.receiver_id === authUserId
            ))
            : [];

        return {
            rows: pairRows,
            isFriend: pairRows.some(row => row.status === "accepted"),
            incomingPending: pairRows.find(row =>
                row.status === "pending" &&
                row.sender_id === peerId &&
                row.receiver_id === authUserId
            ) || null,
            outgoingPending: pairRows.find(row =>
                row.status === "pending" &&
                row.sender_id === authUserId &&
                row.receiver_id === peerId
            ) || null,
            incomingRejected: pairRows.find(row =>
                row.status === "rejected" &&
                row.sender_id === peerId &&
                row.receiver_id === authUserId
            ) || null,
            outgoingRejected: pairRows.find(row =>
                row.status === "rejected" &&
                row.sender_id === authUserId &&
                row.receiver_id === peerId
            ) || null
        };
    }

    function pairFilter(authUserId, peerId) {
        return `and(sender_id.eq.${authUserId},receiver_id.eq.${peerId}),and(sender_id.eq.${peerId},receiver_id.eq.${authUserId})`;
    }

    async function readPair(client, authUserId, peerId) {
        try {
            const { data, error } = await client
                .from("friend_requests")
                .select("id, sender_id, receiver_id, status")
                .or(pairFilter(authUserId, peerId));

            if (error || !Array.isArray(data)) {
                return {
                    rows: null,
                    error: error || new Error("Relationship query returned an invalid response.")
                };
            }

            return {
                rows: data.filter(row => (
                    row.sender_id === authUserId && row.receiver_id === peerId
                ) || (
                    row.sender_id === peerId && row.receiver_id === authUserId
                )),
                error: null
            };
        } catch (error) {
            return { rows: null, error };
        }
    }

    function transitionRows(data, action, requestId) {
        if (
            !data ||
            data.ok !== true ||
            data.action !== action ||
            !Array.isArray(data.rows) ||
            data.rows.length === 0
        ) {
            return null;
        }

        const rows = data.rows.map(row => ({
            ...row,
            id: row.request_id
        }));
        const target = rows.find(row => row.id === requestId);
        const expectedStatus = action === "accept"
            ? "accepted"
            : action === "reactivate"
                ? "pending"
                : "rejected";

        return target?.status === expectedStatus ? rows : null;
    }

    async function callTransition(client, requestId, action) {
        return client.rpc("talkspace_friend_request_transition_v1", {
            p_request_id: requestId,
            p_action: action
        });
    }

    // Inserts a new directional request or reactivates this sender's rejected row.
    async function createOrReuseRequest(client, authUserId, peerId, rows) {
        const relationship = classifyRows(rows, authUserId, peerId);

        if (relationship.isFriend) {
            return { ok: false, outcome: "already-friends", relationship };
        }

        if (relationship.outgoingPending || relationship.incomingPending) {
            return { ok: false, outcome: "already-pending", relationship };
        }

        const rejectedRequest = relationship.outgoingRejected;
        const operation = rejectedRequest ? "reactivate" : "insert";

        try {
            if (!rejectedRequest) {
                const { error } = await client
                    .from("friend_requests")
                    .insert({
                        sender_id: authUserId,
                        receiver_id: peerId
                    });

                return error
                    ? { ok: false, outcome: "error", operation, error }
                    : { ok: true, outcome: "inserted", operation };
            }

            const { data, error } = await callTransition(
                client,
                rejectedRequest.id,
                "reactivate"
            );

            if (error) {
                return { ok: false, outcome: "error", operation, error };
            }

            const rows = transitionRows(data, "reactivate", rejectedRequest.id);
            if (rows) {
                return {
                    ok: true,
                    outcome: "reactivated",
                    operation,
                    requestId: rejectedRequest.id,
                    rows
                };
            }

            // An unexpected RPC response is not success. Read the pair again
            // to report whether another actor changed it or it remains rejected/hidden.
            const refreshed = await readPair(client, authUserId, peerId);
            const latestRelationship = refreshed.rows
                ? classifyRows(refreshed.rows, authUserId, peerId)
                : null;
            const status = latestRelationship?.isFriend
                ? "accepted"
                : latestRelationship?.outgoingPending
                    ? "outgoing-pending"
                    : latestRelationship?.incomingPending
                        ? "incoming-pending"
                        : latestRelationship?.outgoingRejected
                            ? "outgoing-rejected"
                            : latestRelationship?.incomingRejected
                                ? "incoming-rejected"
                                : "no-visible-row";

            return {
                ok: false,
                outcome: "zero-rows",
                operation,
                requestId: rejectedRequest.id,
                latestRows: refreshed.rows,
                latestRelationship,
                refreshError: refreshed.error,
                error: new Error(
                    `Reactivation did not return the expected transition; latest visible state: ${status}.`
                )
            };
        } catch (error) {
            return { ok: false, outcome: "error", operation, error };
        }
    }

    // The lifecycle RPC authorizes the pending request transition for the receiver.
    async function decideIncomingRequest(
        client,
        requestId,
        receiverId,
        status
    ) {
        if (!["accepted", "rejected"].includes(status)) {
            return {
                ok: false,
                outcome: "invalid-status",
                error: new Error("Incoming requests can only be accepted or rejected.")
            };
        }

        if (!requestId || !receiverId) {
            return {
                ok: false,
                outcome: "invalid-request",
                error: new Error("A pending request and signed-in receiver are required.")
            };
        }

        const action = status === "accepted" ? "accept" : "reject";

        try {
            const { data, error } = await callTransition(client, requestId, action);

            if (error) {
                return { ok: false, outcome: "error", error };
            }

            const rows = transitionRows(data, action, requestId);
            if (!rows) {
                return {
                    ok: false,
                    outcome: "invalid-response",
                    error: new Error("The friend-request transition returned an unexpected response.")
                };
            }

            const row = rows.find(result => result.id === requestId);
            return {
                ok: true,
                outcome: status,
                requestId,
                peerId: row.sender_id,
                rows
            };
        } catch (error) {
            return { ok: false, outcome: "error", error };
        }
    }

    // Removes an accepted relationship using the selected accepted row as its RPC anchor.
    async function removeAcceptedRelationship(client, authUserId, peerId, requestId) {
        if (!authUserId || !peerId || !requestId) {
            return {
                ok: false,
                outcome: "invalid-request",
                error: new Error("A friend relationship and accepted request row are required.")
            };
        }

        try {
            const { data, error } = await callTransition(client, requestId, "remove");

            if (error) {
                return { ok: false, outcome: "error", error };
            }

            const rows = transitionRows(data, "remove", requestId);
            if (!rows) {
                const refreshed = await readPair(client, authUserId, peerId);
                return {
                    ok: false,
                    outcome: "invalid-response",
                    rows: refreshed.rows,
                    refreshError: refreshed.error,
                    error: new Error("The removal RPC did not return the accepted row transition.")
                };
            }

            return { ok: true, outcome: "removed", rows };
        } catch (error) {
            return { ok: false, outcome: "error", error };
        }
    }

    // Resolves relevant friend-request Realtime events, including partial DELETE payloads.
    function resolveRealtimeEvent(payload, authUserId, knownRows) {
        if (!payload || !authUserId) {
            return null;
        }

        const eventType = payload.eventType;
        const oldRow = payload.old || {};
        let request = payload.new || oldRow;

        if (
            eventType === "DELETE" &&
            (!request.sender_id || !request.receiver_id)
        ) {
            request = knownRows?.get(oldRow.id);
        }

        if (
            !request ||
            (request.sender_id !== authUserId && request.receiver_id !== authUserId)
        ) {
            return null;
        }

        return {
            eventType,
            request,
            peerId: request.sender_id === authUserId
                ? request.receiver_id
                : request.sender_id
        };
    }

    function getRealtimeRefreshPlan({
        event,
        selectedPeerId,
        panelVisible,
        panelView
    }) {
        if (!event) {
            return {
                refreshSelected: false,
                refreshPanel: false,
                preserveSelectedChat: true
            };
        }

        return {
            refreshSelected: event.peerId === selectedPeerId,
            refreshPanel: Boolean(
                panelVisible &&
                (panelView === "friends" || panelView === "requests")
            ),
            panelView,
            preserveSelectedChat: true
        };
    }

    function isCurrentSelection({
        currentUserId,
        expectedUserId,
        selectedPeerId,
        expectedPeerId,
        currentGeneration,
        expectedGeneration
    }) {
        return Boolean(
            currentUserId === expectedUserId &&
            selectedPeerId === expectedPeerId &&
            currentGeneration === expectedGeneration
        );
    }

    return {
        classifyRows,
        readPair,
        createOrReuseRequest,
        decideIncomingRequest,
        removeAcceptedRelationship,
        resolveRealtimeEvent,
        getRealtimeRefreshPlan,
        isCurrentSelection
    };
});
