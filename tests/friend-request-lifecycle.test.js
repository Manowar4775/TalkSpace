"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const lifecycle = require("../src/friend-request-lifecycle.js");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const callSource = fs.readFileSync(path.join(__dirname, "../src/call.js"), "utf8");
const lifecycleSource = fs.readFileSync(path.join(__dirname, "../src/friend-request-lifecycle.js"), "utf8");

function makeRow(id, sender_id, receiver_id, status) {
    return { id, sender_id, receiver_id, status };
}

class MockSupabaseClient {
    constructor(rows = [], options = {}) {
        this.rows = rows.map(row => ({ ...row }));
        this.options = options;
        this.operations = [];
        this.nextId = 1;
    }

    from(table) {
        assert.equal(table, "friend_requests");
        return new MockQuery(this);
    }

    async rpc(name, args) {
        assert.equal(name, "talkspace_friend_request_transition_v1");
        this.operations.push({ action: "rpc", name, args: { ...args } });

        if (this.options.throwNext === "rpc") {
            this.options.throwNext = null;
            throw new Error("mock rpc network failure");
        }
        if (this.options.errorNext === "rpc") {
            this.options.errorNext = null;
            return { data: null, error: { code: "MOCK_ERROR", message: "mock rpc error" } };
        }
        if (this.options.invalidRpcResponse) {
            return { data: this.options.invalidRpcResponse, error: null };
        }

        const { p_request_id: requestId, p_action: action } = args;
        const target = this.rows.find(row => row.id === requestId);
        const actor = this.options.authUserId;
        let changedRows = [];

        if (!target) {
            return { data: null, error: { code: "42501", message: "transition not permitted" } };
        }
        if (action === "accept" || action === "reject") {
            if (target.status !== "pending" || target.receiver_id !== actor) {
                return { data: null, error: { code: "42501", message: "transition not permitted" } };
            }
            target.status = action === "accept" ? "accepted" : "rejected";
            changedRows = [target];
        } else if (action === "reactivate") {
            if (target.status !== "rejected" || target.sender_id !== actor) {
                return { data: null, error: { code: "42501", message: "transition not permitted" } };
            }
            target.status = "pending";
            changedRows = [target];
        } else if (action === "remove") {
            if (
                target.status !== "accepted" ||
                (target.sender_id !== actor && target.receiver_id !== actor)
            ) {
                return { data: null, error: { code: "42501", message: "transition not permitted" } };
            }
            changedRows = this.rows.filter(row =>
                row.status === "accepted" &&
                ((row.sender_id === target.sender_id && row.receiver_id === target.receiver_id) ||
                 (row.sender_id === target.receiver_id && row.receiver_id === target.sender_id))
            );
            changedRows.forEach(row => { row.status = "rejected"; });
        } else {
            throw new Error(`Unsupported RPC action: ${action}`);
        }

        return {
            data: {
                ok: true,
                action,
                rows: changedRows.map(row => ({
                    request_id: row.id,
                    sender_id: row.sender_id,
                    receiver_id: row.receiver_id,
                    status: row.status
                }))
            },
            error: null
        };
    }
}

class MockQuery {
    constructor(client) {
        this.client = client;
        this.action = "select";
        this.filters = [];
        this.pairIds = null;
        this.values = null;
        this.returnRows = false;
    }

    select() {
        this.returnRows = true;
        return this;
    }

    insert(values) {
        this.action = "insert";
        this.values = values;
        return this;
    }

    eq(column, value) {
        this.filters.push([column, value]);
        return this;
    }

    or(expression) {
        const matches = [...expression.matchAll(/sender_id\.eq\.([^,\)]+),receiver_id\.eq\.([^\)]+)/g)];
        this.pairIds = matches.map(match => [match[1], match[2]]);
        return this;
    }

    then(resolve, reject) {
        return this.execute().then(resolve, reject);
    }

    async execute() {
        const action = this.action;
        this.client.operations.push({
            action,
            values: this.values ? { ...this.values } : null,
            filters: [...this.filters]
        });

        if (this.client.options.throwNext === action) {
            this.client.options.throwNext = null;
            throw new Error(`mock ${action} network failure`);
        }
        if (this.client.options.errorNext === action) {
            this.client.options.errorNext = null;
            return { data: null, error: { code: "MOCK_ERROR", message: `mock ${action} error` } };
        }

        if (action === "insert") {
            const { sender_id, receiver_id } = this.values;
            if (this.client.rows.some(row =>
                row.sender_id === sender_id && row.receiver_id === receiver_id
            )) {
                return {
                    data: null,
                    error: {
                        code: "23505",
                        message: "duplicate key value violates unique constraint"
                    }
                };
            }
            const row = makeRow(
                `new-${this.client.nextId++}`,
                sender_id,
                receiver_id,
                this.values.status || "pending"
            );
            this.client.rows.push(row);
            return { data: null, error: null };
        }

        const matches = this.client.rows.filter(row => {
            const equals = this.filters.every(([column, value]) => row[column] === value);
            const pairMatches = !this.pairIds || this.pairIds.some(([sender, receiver]) =>
                row.sender_id === sender && row.receiver_id === receiver
            );
            return equals && pairMatches;
        });

        if (action === "select") {
            if (this.client.options.errorNext === "select") {
                this.client.options.errorNext = null;
                return { data: null, error: { code: "MOCK_ERROR", message: "mock select error" } };
            }
            return { data: matches.map(row => ({ ...row })), error: null };
        }

        throw new Error(`Unsupported mock action: ${action}`);
    }
}

function queryRelationshipRows(client, senderId, receiverId) {
    return lifecycle.readPair(client, senderId, receiverId);
}

test("no relationship inserts one pending row in the requested direction", async () => {
    const client = new MockSupabaseClient();
    const result = await lifecycle.createOrReuseRequest(client, "A", "D", []);

    assert.equal(result.outcome, "inserted");
    assert.equal(client.rows.length, 1);
    assert.deepEqual(client.rows[0], makeRow("new-1", "A", "D", "pending"));
    assert.deepEqual(client.operations.map(operation => operation.action), ["insert"]);
});

test("rejected outgoing row is reactivated in place without an insert", async () => {
    const original = makeRow("ad-1", "A", "D", "rejected");
    const client = new MockSupabaseClient([original], { authUserId: "A" });
    const result = await lifecycle.createOrReuseRequest(client, "A", "D", [original]);

    assert.equal(result.outcome, "reactivated");
    assert.equal(result.requestId, "ad-1");
    assert.deepEqual(client.rows, [makeRow("ad-1", "A", "D", "pending")]);
    assert.deepEqual(client.operations.map(operation => operation.action), ["rpc"]);
    assert.deepEqual(client.operations[0].args, {
        p_request_id: "ad-1",
        p_action: "reactivate"
    });
});

test("rejected reverse-direction row is not mutated; request uses current direction", async () => {
    const reverse = makeRow("da-1", "D", "A", "rejected");
    const client = new MockSupabaseClient([reverse]);
    const result = await lifecycle.createOrReuseRequest(client, "A", "D", [reverse]);

    assert.equal(result.outcome, "inserted");
    assert.deepEqual(client.rows, [
        makeRow("da-1", "D", "A", "rejected"),
        makeRow("new-1", "A", "D", "pending")
    ]);
    assert.deepEqual(client.operations.map(operation => operation.action), ["insert"]);
});

test("when both directions have rejected history, only the current sender direction is reactivated", async () => {
    const outgoing = makeRow("ad-1", "A", "D", "rejected");
    const incoming = makeRow("da-1", "D", "A", "rejected");
    const client = new MockSupabaseClient([outgoing, incoming], { authUserId: "A" });
    const result = await lifecycle.createOrReuseRequest(
        client,
        "A",
        "D",
        [outgoing, incoming]
    );

    assert.equal(result.outcome, "reactivated");
    assert.deepEqual(client.rows, [
        makeRow("ad-1", "A", "D", "pending"),
        makeRow("da-1", "D", "A", "rejected")
    ]);
    assert.equal(client.rows.length, 2);
});

test("outgoing pending prevents duplicate writes", async () => {
    const pending = makeRow("ad-1", "A", "D", "pending");
    const client = new MockSupabaseClient([pending]);
    const result = await lifecycle.createOrReuseRequest(client, "A", "D", [pending]);

    assert.equal(result.outcome, "already-pending");
    assert.equal(client.operations.length, 0);
    assert.equal(client.rows.length, 1);
});

test("incoming pending is recognized; accept and reject use the lifecycle RPC", async () => {
    const incoming = makeRow("da-1", "D", "A", "pending");
    const client = new MockSupabaseClient([incoming], { authUserId: "A" });
    const relationship = lifecycle.classifyRows([incoming], "A", "D");
    assert.equal(relationship.incomingPending.id, "da-1");

    const duplicate = await lifecycle.createOrReuseRequest(client, "A", "D", [incoming]);
    assert.equal(duplicate.outcome, "already-pending");
    assert.equal(client.operations.length, 0);

    const accepted = await lifecycle.decideIncomingRequest(client, "da-1", "A", "accepted");
    assert.equal(accepted.outcome, "accepted");
    assert.equal(client.rows[0].status, "accepted");

    client.rows[0].status = "pending";
    const rejected = await lifecycle.decideIncomingRequest(client, "da-1", "A", "rejected");
    assert.equal(rejected.outcome, "rejected");
    assert.equal(client.rows[0].status, "rejected");

    const wrongActorClient = new MockSupabaseClient([incoming], { authUserId: "D" });
    const wrongReceiver = await lifecycle.decideIncomingRequest(
        wrongActorClient,
        "da-1",
        "D",
        "accepted"
    );
    assert.equal(wrongReceiver.outcome, "error");
    assert.equal(wrongActorClient.rows[0].status, "pending");
    assert.deepEqual(client.operations.slice(0, 2).map(operation => operation.args), [
        { p_request_id: "da-1", p_action: "accept" },
        { p_request_id: "da-1", p_action: "reject" }
    ]);
});

test("accepted relationship in either direction is active and removal deactivates it", async () => {
    for (const accepted of [
        makeRow("ab-1", "A", "B", "accepted"),
        makeRow("ba-1", "B", "A", "accepted")
    ]) {
        const state = lifecycle.classifyRows([accepted], "A", "B");
        assert.equal(state.isFriend, true);
        const client = new MockSupabaseClient([accepted], { authUserId: "A" });
        const noRequest = await lifecycle.createOrReuseRequest(client, "A", "B", [accepted]);
        assert.equal(noRequest.outcome, "already-friends");
        assert.equal(client.operations.length, 0);

        const removed = await lifecycle.removeAcceptedRelationship(client, "A", "B", accepted.id);
        assert.equal(removed.outcome, "removed");
        assert.equal(client.rows[0].status, "rejected");
        assert.deepEqual(client.operations[0].args, {
            p_request_id: accepted.id,
            p_action: "remove"
        });
        assert.equal(lifecycle.classifyRows(client.rows, "A", "B").isFriend, false);
    }
});

test("accept, reject, remove, and reactivate use exact RPC action payloads without direct lifecycle UPDATE", async () => {
    const incoming = makeRow("ba-1", "B", "A", "pending");
    const acceptClient = new MockSupabaseClient([incoming], { authUserId: "A" });
    const accepted = await lifecycle.decideIncomingRequest(acceptClient, "ba-1", "A", "accepted");
    assert.equal(accepted.ok, true);
    assert.deepEqual(acceptClient.operations[0].args, {
        p_request_id: "ba-1",
        p_action: "accept"
    });

    const rejectClient = new MockSupabaseClient([incoming], { authUserId: "A" });
    const rejected = await lifecycle.decideIncomingRequest(rejectClient, "ba-1", "A", "rejected");
    assert.equal(rejected.ok, true);
    assert.deepEqual(rejectClient.operations[0].args, {
        p_request_id: "ba-1",
        p_action: "reject"
    });

    assert.match(lifecycleSource, /client\.rpc\("talkspace_friend_request_transition_v1",\s*\{\s*p_request_id:\s*requestId,\s*p_action:\s*action/s);
    assert.doesNotMatch(lifecycleSource, /\.from\(["']friend_requests["']\)\s*\.update\(/);
    assert.match(appSource, /acceptedRows\[0\]\.id/);
    assert.equal((appSource.match(/getFriendRelationshipState\(decision\.peerId, authUserId\)/g) || []).length, 2);
});

test("accept, reject, and remove RPC errors are surfaced without local success", async () => {
    const incoming = makeRow("ba-1", "B", "A", "pending");
    for (const status of ["accepted", "rejected"]) {
        const client = new MockSupabaseClient([incoming], {
            authUserId: "A",
            errorNext: "rpc"
        });
        const result = await lifecycle.decideIncomingRequest(client, "ba-1", "A", status);
        assert.equal(result.ok, false);
        assert.equal(result.error.code, "MOCK_ERROR");
        assert.equal(client.rows[0].status, "pending");
    }

    const accepted = makeRow("ab-1", "A", "B", "accepted");
    const removeClient = new MockSupabaseClient([accepted], {
        authUserId: "A",
        errorNext: "rpc"
    });
    const removeResult = await lifecycle.removeAcceptedRelationship(
        removeClient,
        "A",
        "B",
        "ab-1"
    );
    assert.equal(removeResult.ok, false);
    assert.equal(removeResult.error.code, "MOCK_ERROR");
    assert.equal(removeClient.rows[0].status, "accepted");
});

test("removed friendship can be requested again by reusing the rejected directed row", async () => {
    const removed = makeRow("ab-1", "A", "B", "rejected");
    const client = new MockSupabaseClient([removed], { authUserId: "A" });
    const result = await lifecycle.createOrReuseRequest(client, "A", "B", [removed]);

    assert.equal(result.outcome, "reactivated");
    assert.equal(client.rows.length, 1);
    assert.equal(client.rows[0].status, "pending");
});

test("unexpected reactivate RPC response refreshes relationship and never reports success or inserts", async () => {
    const rejected = makeRow("ad-1", "A", "D", "rejected");
    const client = new MockSupabaseClient([rejected], {
        authUserId: "A",
        invalidRpcResponse: { ok: true, action: "reactivate", rows: [] }
    });
    const result = await lifecycle.createOrReuseRequest(client, "A", "D", [rejected]);

    assert.equal(result.ok, false);
    assert.equal(result.outcome, "zero-rows");
    assert.equal(result.latestRelationship.outgoingRejected.id, "ad-1");
    assert.equal(client.rows.length, 1);
    assert.deepEqual(client.operations.map(operation => operation.action), ["rpc", "select"]);
});

test("unexpected reactivate RPC response with a rejected row reports unresolved state", async () => {
    const rejected = makeRow("ad-1", "A", "D", "rejected");
    const client = new MockSupabaseClient([rejected], {
        authUserId: "A",
        invalidRpcResponse: { ok: false, action: "reactivate", rows: [] }
    });
    const result = await lifecycle.createOrReuseRequest(client, "A", "D", [rejected]);

    assert.equal(result.ok, false);
    assert.equal(result.outcome, "zero-rows");
    assert.equal(result.latestRelationship.outgoingRejected.id, "ad-1");
    assert.match(result.error.message, /outgoing-rejected/);
    assert.equal(client.rows.length, 1);
    assert.deepEqual(client.operations.map(operation => operation.action), ["rpc", "select"]);
});

test("unexpected reactivate RPC response preserves fresh-read errors", async () => {
    const rejected = makeRow("ad-1", "A", "D", "rejected");
    const client = new MockSupabaseClient([rejected], {
        authUserId: "A",
        invalidRpcResponse: { ok: true, action: "reactivate", rows: [] },
        errorNext: "select"
    });
    const result = await lifecycle.createOrReuseRequest(client, "A", "D", [rejected]);

    assert.equal(result.ok, false);
    assert.equal(result.outcome, "zero-rows");
    assert.equal(result.latestRows, null);
    assert.equal(result.refreshError.code, "MOCK_ERROR");
    assert.equal(client.rows.length, 1);
});

test("query, RPC, insert, and thrown network errors are returned without false success", async () => {
    const queryClient = new MockSupabaseClient([], { errorNext: "select" });
    const queryResult = await queryRelationshipRows(queryClient, "A", "D");
    assert.equal(queryResult.rows, null);
    assert.equal(queryResult.error.code, "MOCK_ERROR");

    const rejected = makeRow("ad-1", "A", "D", "rejected");
    const rpcClient = new MockSupabaseClient([rejected], {
        authUserId: "A",
        errorNext: "rpc"
    });
    const rpcResult = await lifecycle.createOrReuseRequest(rpcClient, "A", "D", [rejected]);
    assert.equal(rpcResult.ok, false);
    assert.equal(rpcResult.error.code, "MOCK_ERROR");
    assert.equal(rpcClient.rows[0].status, "rejected");

    const insertClient = new MockSupabaseClient([], { errorNext: "insert" });
    const insertResult = await lifecycle.createOrReuseRequest(insertClient, "A", "D", []);
    assert.equal(insertResult.ok, false);
    assert.equal(insertResult.error.code, "MOCK_ERROR");

    const thrownClient = new MockSupabaseClient([], { throwNext: "insert" });
    const thrownResult = await lifecycle.createOrReuseRequest(thrownClient, "A", "D", []);
    assert.equal(thrownResult.ok, false);
    assert.match(thrownResult.error.message, /network failure/);

    const thrownRpcClient = new MockSupabaseClient([rejected], {
        authUserId: "A",
        throwNext: "rpc"
    });
    const thrownRpcResult = await lifecycle.createOrReuseRequest(
        thrownRpcClient,
        "A",
        "D",
        [rejected]
    );
    assert.equal(thrownRpcResult.ok, false);
    assert.match(thrownRpcResult.error.message, /network failure/);
});

test("stale session or peer selection invalidates pending UI work", () => {
    const original = {
        currentUserId: "A",
        expectedUserId: "A",
        selectedPeerId: "B",
        expectedPeerId: "B",
        currentGeneration: 12,
        expectedGeneration: 12
    };
    assert.equal(lifecycle.isCurrentSelection(original), true);
    assert.equal(lifecycle.isCurrentSelection({ ...original, selectedPeerId: "C" }), false);
    assert.equal(lifecycle.isCurrentSelection({ ...original, currentUserId: "X" }), false);
    assert.equal(lifecycle.isCurrentSelection({ ...original, currentGeneration: 13 }), false);
});

test("Realtime filters unrelated rows and plans selected-user/panel refresh without changing selection", () => {
    const knownRows = new Map([["ab-1", makeRow("ab-1", "A", "B", "pending")]]);
    const unrelated = lifecycle.resolveRealtimeEvent({
        eventType: "INSERT",
        new: makeRow("cd-1", "C", "D", "pending")
    }, "A", knownRows);
    assert.equal(unrelated, null);

    const event = lifecycle.resolveRealtimeEvent({
        eventType: "UPDATE",
        old: makeRow("ab-1", "A", "B", "rejected"),
        new: makeRow("ab-1", "A", "B", "pending")
    }, "A", knownRows);
    assert.equal(event.peerId, "B");
    assert.equal(event.eventType, "UPDATE");

    const plan = lifecycle.getRealtimeRefreshPlan({
        event,
        selectedPeerId: "B",
        panelVisible: true,
        panelView: "requests"
    });
    assert.equal(plan.refreshSelected, true);
    assert.equal(plan.refreshPanel, true);
    assert.equal(plan.preserveSelectedChat, true);

    const partialDelete = lifecycle.resolveRealtimeEvent({
        eventType: "DELETE",
        old: { id: "ab-1" }
    }, "A", knownRows);
    assert.equal(partialDelete.peerId, "B");

    const hiddenPanelPlan = lifecycle.getRealtimeRefreshPlan({
        event,
        selectedPeerId: "C",
        panelVisible: false,
        panelView: "requests"
    });
    assert.equal(hiddenPanelPlan.refreshSelected, false);
    assert.equal(hiddenPanelPlan.refreshPanel, false);
    assert.equal(hiddenPanelPlan.preserveSelectedChat, true);

    assert.equal((appSource.match(/table:\s*"friend_requests"/g) || []).length, 1);
    assert.match(appSource, /FriendRequestLifecycle\.resolveRealtimeEvent\(/);
    assert.match(appSource, /FriendRequestLifecycle\.getRealtimeRefreshPlan\(/);
    const realtimeStart = appSource.indexOf("// FRIEND REQUEST CHANGES");
    const realtimeEnd = appSource.indexOf("// MESSAGE CHANGES", realtimeStart);
    const realtimeHandler = appSource.slice(realtimeStart, realtimeEnd);
    assert.doesNotMatch(realtimeHandler, /\.from\("friend_requests"\)\s*\.(?:insert|update|delete)\(/);
    assert.equal((realtimeHandler.match(/\.on\(/g) || []).length, 1);
});

test("production friend handlers use lifecycle operations exactly once", () => {
    assert.equal((appSource.match(/async function getFriendRelationshipState\(/g) || []).length, 1);
    assert.equal((appSource.match(/friendRequestButton\.addEventListener\(/g) || []).length, 1);
    assert.equal((appSource.match(/FriendRequestLifecycle\.createOrReuseRequest\(/g) || []).length, 1);
    assert.equal((appSource.match(/FriendRequestLifecycle\.decideIncomingRequest\(/g) || []).length, 2);
    assert.equal((appSource.match(/FriendRequestLifecycle\.removeAcceptedRelationship\(/g) || []).length, 1);
});

test("call permission regression: outgoing/incoming paths fail closed and recheck at signaling points", () => {
    const helperStart = callSource.indexOf("async function verifyCallPeerPermissions(");
    const helperEnd = callSource.indexOf("async function startVoiceCall(", helperStart);
    const helper = callSource.slice(helperStart, helperEnd);
    assert.notEqual(helperStart, -1);
    assert.match(helper, /blocked !== false/);
    assert.match(helper, /relationship\?\.verified === true/);
    assert.match(helper, /relationship\.isFriend === true/);

    const outgoingStart = callSource.indexOf("async function startVoiceCall(");
    const outgoingEnd = callSource.indexOf("async function acceptIncomingCall(", outgoingStart);
    const outgoing = callSource.slice(outgoingStart, outgoingEnd);
    assert.equal((outgoing.match(/verifyCallPeerPermissions\(/g) || []).length, 3);
    assert.ok(outgoing.indexOf("verifyCallPeerPermissions(") < outgoing.indexOf("getUserMedia("));
    assert.ok(outgoing.lastIndexOf("verifyCallPeerPermissions(") < outgoing.indexOf('.from("call_signals")'));
    assert.equal((outgoing.match(/await startVoiceCall\(/g) || []).length, 0);

    const incomingStart = callSource.indexOf("async function handleCallSignal(");
    const incomingEnd = callSource.indexOf("// ==================================================\n// ANSWER", incomingStart);
    const incomingOffer = callSource.slice(incomingStart, incomingEnd);
    assert.match(incomingOffer, /const callerAllowed = await verifyCallPeerPermissions/);
    assert.match(incomingOffer, /if \(callerAllowed !== true\)/);

    const acceptStart = callSource.indexOf("async function acceptIncomingCall(");
    const acceptEnd = callSource.indexOf("async function handleCallSignal(", acceptStart);
    const accept = callSource.slice(acceptStart, acceptEnd);
    assert.equal((accept.match(/verifyCallPeerPermissions\(/g) || []).length, 4);
    assert.ok(accept.indexOf("verifyCallPeerPermissions(") < accept.indexOf("getUserMedia("));
    assert.ok(accept.lastIndexOf("verifyCallPeerPermissions(") < accept.indexOf('.from("call_signals")'));

    assert.equal((callSource.match(/await startVoiceCall\(/g) || []).length, 2);
});
