// ======================================================
// TALKSPACE
// Main Application
// ======================================================


// ======================================================
// SUPABASE CLIENT
// ======================================================

const client = window.supabase.createClient(
    window.SUPABASE_CONFIG.url,
    window.SUPABASE_CONFIG.anonKey
);


// ======================================================
// APPLICATION STATE
// ======================================================

let currentUser = null;

let currentProfile = null;

// Invalidates asynchronous profile/session restoration when auth intent or
// identity changes. A separate load counter makes only the newest restore win.
let authSessionGeneration = 0;
let authUserLoadGeneration = 0;
let profileRetryInFlight = false;
let profileRetryOperationGeneration = 0;
let profileRetryLoadGeneration = null;
let observedAuthIdentityId = null;
let authIdentityTransitionGeneration = 0;
let authIdentityTransitionPending = false;
let authIdentityTransitionTargetId = null;
let loginOperationGeneration = 0;
let loginOperationInFlight = false;
let accountSetupGeneration = 0;
let accountSetupInFlight = false;

function invalidateLoginOperation() {
    loginOperationGeneration += 1;
    loginOperationInFlight = false;

    const loginButton = $("loginBtn");
    if (loginButton) {
        loginButton.disabled = false;
    }
}

function invalidateAccountSetupOperation() {
    accountSetupGeneration += 1;
    accountSetupInFlight = false;

    const createAccountButton = $("createAccountBtn");
    if (createAccountButton) {
        createAccountButton.disabled = false;
    }
}

function invalidateAuthSessionWork() {
    authSessionGeneration += 1;
}

function isCurrentAuthLoad(generation, loadGeneration, userId) {
    return authSessionGeneration === generation &&
        authUserLoadGeneration === loadGeneration &&
        currentUser?.id === userId;
}

let selectedUser = null;

let selectedConversation = null;

let realtimeChannel = null;

let signedOutCleanupPromise = null;

let selectedChatGeneration = 0;
let chatMessageLoadGeneration = 0;
let clearChatOperationGeneration = 0;
const friendPresenceStates = new Map();
const friendPresenceTrackingIds = new Set();
const PRESENCE_FRESHNESS_MS = 45000;
let friendPresenceExpiryTimer = null;
let friendListLoadGeneration = 0;
let friendOpenIntentGeneration = 0;
let friendRequestListLoadGeneration = 0;
let friendPanelView = null;
let friendRequestBlockAllowed = false;
let currentView = "home";
let chatReturnView = "friends";
let accountReturnView = "home";
let dedicatedViewReturnTo = "home";
let settingsViewController = null;
let friendActionStateGeneration = 0;
let friendshipUnavailablePeerId = null;
const friendRequestRelationshipRows = new Map();
let publicProfileLoadGeneration = 0;
let publicProfileReturnView = "home";

// PERFORMANCE AUDIT ONLY: Temporary chat-open timing helpers. Remove after
// collecting the baseline; these helpers do not await or change app flow.
let chatOpenPerformanceId = 0;

function startChatOpenPerformance(source) {
    if (!window.TalkSpaceLogger?.enabled) {
        return null;
    }

    return {
        id: ++chatOpenPerformanceId,
        source,
        startedAt: performance.now(),
        stages: [],
        milestones: {},
        totals: {}
    };
}

function startChatOpenStage(perf, name, category) {
    if (!perf) {
        return null;
    }

    return {
        name,
        category,
        startedAt: performance.now()
    };
}

function endChatOpenStage(perf, stage) {
    if (!perf || !stage) {
        return;
    }

    const endedAt = performance.now();
    perf.stages.push({
        name: stage.name,
        category: stage.category,
        startMs: stage.startedAt - perf.startedAt,
        endMs: endedAt - perf.startedAt,
        durationMs: endedAt - stage.startedAt
    });
}

// PERFORMANCE AUDIT ONLY: Time independent Supabase requests individually
// while allowing their existing caller to await them concurrently.
function measureChatOpenRequest(perf, name, request) {
    const stage = startChatOpenStage(
        perf,
        name,
        "Supabase/network wait"
    );

    return Promise.resolve(request).then(
        result => {
            endChatOpenStage(perf, stage);
            return result;
        },
        error => {
            endChatOpenStage(perf, stage);
            throw error;
        }
    );
}

function markChatOpenMilestone(perf, name) {
    if (perf && perf.milestones[name] === undefined) {
        perf.milestones[name] = performance.now();
    }
}

function scheduleChatOpenPaintMilestone(perf, name) {
    if (!perf) {
        return;
    }

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            markChatOpenMilestone(perf, name);
        });
    });
}

function addChatOpenTotal(perf, name, duration, count = 1) {
    if (!perf) {
        return;
    }

    const total = perf.totals[name] || { count: 0, durationMs: 0 };
    total.count += count;
    total.durationMs += duration;
    perf.totals[name] = total;
}

function isCurrentChatSelection(userId, generation) {
    return Boolean(
        currentUser &&
        selectedUser?.id === userId &&
        selectedChatGeneration === generation
    );
}

function setConversationMessageState(state, heading, description = "") {
    const messages = $("messages");
    messages.dataset.state = state;
    messages.setAttribute("aria-busy", state === "loading" ? "true" : "false");
    messages.innerHTML = `
        <div class="conversationState" role="status">
            <strong>${escapeHtml(heading)}</strong>
            ${description ? `<span>${escapeHtml(description)}</span>` : ""}
        </div>
    `;
}

function showOfflineChatState() {
    chatMessageLoadGeneration += 1;
    clearMessageSelection();
    selectedConversation = null;
    $("messages").innerHTML =
        '<div class="emptyState"><p>This private chat is hidden while the other user is offline.</p></div>';
    $("messages").dataset.state = "offline";
    $("messages").setAttribute("aria-busy", "false");
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    setCallButtonsDisabled(true);
    $("typingIndicator").classList.add("hidden");
}

function setCallButtonsDisabled(disabled) {
    const callButton = $("callBtn");
    const videoCallButton = $("videoCallBtn");

    if (callButton) {
        callButton.disabled = disabled;
    }

    if (videoCallButton) {
        videoCallButton.disabled = disabled;
    }
}

function ensureFriendPreviewElement(friendDiv) {
    let preview = friendDiv.querySelector(".lastMessagePreview");

    if (!preview) {
        preview = document.createElement("p");
        preview.className = "lastMessagePreview";
        const button = friendDiv.querySelector(".openFriendBtn");
        friendDiv.insertBefore(preview, button);
    }

    return preview;
}

function showOfflineFriendPreview(friendDiv) {
    friendDiv.dataset.lastMessageTime = "";
    setFriendPresencePresentation(friendDiv, false);
    ensureFriendPreviewElement(friendDiv).textContent =
        "This is private because your friend is offline.";
}

function showUnavailableFriendPreview(friendDiv) {
    friendDiv.dataset.lastMessageTime = "";
    setFriendPresencePresentation(friendDiv, "unavailable");
    ensureFriendPreviewElement(friendDiv).textContent =
        "This is private while your friend's status is unavailable.";
}

function setFriendPresencePresentation(friendDiv, online) {
    const status = friendDiv.querySelector(".friendPresence");
    const label = status?.querySelector(".presenceLabel");
    if (!status || !label) return;

    const state = online === true
        ? "online"
        : online === "unavailable"
            ? "unavailable"
            : "offline";
    status.dataset.state = state;
    label.textContent = state === "online"
        ? "Online"
        : state === "unavailable"
            ? "Unavailable"
            : "Offline";
    sortFriendsList();
}


function isFriendPresenceStateFresh(state, now = Date.now()) {
    return Boolean(
        state?.online &&
        isPresenceFresh({
            is_online: true,
            last_seen: state.lastSeen
        }, now)
    );
}


function expireFriendPresenceState(userId, expectedRevision = null, now = Date.now()) {
    const state = friendPresenceStates.get(userId);
    if (
        !state?.online ||
        (expectedRevision !== null && state.revision !== expectedRevision) ||
        isFriendPresenceStateFresh(state, now)
    ) {
        return false;
    }

    const offlineState = {
        ...state,
        online: false,
        revision: state.revision + 1
    };
    friendPresenceStates.set(userId, offlineState);

    const friendRows = $("friendRequestsList");
    friendRows?.querySelectorAll(`.friend-item[data-user-id="${userId}"]`)
        .forEach(showOfflineFriendPreview);

    if (
        selectedUser?.id === userId &&
        $("chatUserStatus").textContent === "Online"
    ) {
        showOfflineChatState();
        $("chatUserStatus").textContent = formatLastSeen(state.lastSeen);
        $("chatUserStatus").classList.add("lastSeenStatus");
    }

    return true;
}


function expireStaleFriendPresence(now = Date.now()) {
    for (const userId of friendPresenceTrackingIds) {
        expireFriendPresenceState(userId, null, now);
    }
}


// One local expiry timer covers every tracked friend without polling Supabase.
function scheduleFriendPresenceExpiry() {
    if (friendPresenceExpiryTimer !== null) {
        clearTimeout(friendPresenceExpiryTimer);
        friendPresenceExpiryTimer = null;
    }

    const now = Date.now();
    expireStaleFriendPresence(now);

    let nextExpiry = Infinity;
    for (const userId of friendPresenceTrackingIds) {
        const state = friendPresenceStates.get(userId);
        if (!state?.online) continue;

        const lastSeen = new Date(state.lastSeen || "").getTime();
        const expiresAt = Number.isFinite(lastSeen)
            ? lastSeen + PRESENCE_FRESHNESS_MS
            : now;
        nextExpiry = Math.min(nextExpiry, expiresAt);
    }

    if (Number.isFinite(nextExpiry)) {
        friendPresenceExpiryTimer = setTimeout(() => {
            friendPresenceExpiryTimer = null;
            scheduleFriendPresenceExpiry();
        }, Math.max(0, nextExpiry - Date.now()));
    }
}


document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        scheduleFriendPresenceExpiry();
    }
});


function renderFriendLastMessage(friendDiv, lastMessage) {
    setFriendPresencePresentation(friendDiv, true);
    if (!lastMessage) {
        friendDiv.querySelector(".lastMessagePreview")?.remove();
        friendDiv.dataset.lastMessageTime = "";
        return;
    }

    const preview = ensureFriendPreviewElement(friendDiv);
    preview.textContent = lastMessage.deleted_at
        ? "This message was deleted"
        : lastMessage.body;
    friendDiv.dataset.lastMessageTime = lastMessage.created_at;
}

async function refreshOnlineFriendPreview(userId, revision) {
    const list = $("friendRequestsList");
    if (!list) {
        return;
    }

    const friendDivs = list.querySelectorAll(
        `.friend-item[data-user-id="${userId}"]`
    );

    for (const friendDiv of friendDivs) {
        const button = friendDiv.querySelector(".openFriendBtn");
        const conversationId = button?.dataset.conversationId;
        const lastMessage = conversationId
            ? await getLastMessage(conversationId)
            : null;
        const presenceState = friendPresenceStates.get(userId);

        if (
            !isFriendPresenceStateFresh(presenceState) ||
            presenceState.revision !== revision ||
            !friendDiv.isConnected
        ) {
            if (presenceState?.online) {
                scheduleFriendPresenceExpiry();
            }
            return;
        }

        renderFriendLastMessage(friendDiv, lastMessage);
    }

    sortFriendsList();
}

async function isSelectedCallPeerOnline(targetUserId) {
    if (
        !currentUser ||
        !selectedUser ||
        selectedUser.id !== targetUserId
    ) {
        return false;
    }

    const userId = currentUser.id;
    const selectionGeneration = selectedChatGeneration;
    const online = await updateSelectedUserStatus(
        null,
        targetUserId,
        selectionGeneration
    );

    const stillSelected = Boolean(
        currentUser?.id === userId &&
        isCurrentChatSelection(targetUserId, selectionGeneration)
    );

    if (!stillSelected || online !== true) {
        if (stillSelected) {
            showOfflineChatState();
        }

        return false;
    }

    return true;
}

setCallButtonsDisabled(true);

function reportChatOpenPerformance(perf) {
    if (!perf || perf.reported) {
        return;
    }

    perf.reported = true;
    markChatOpenMilestone(perf, "report generated");

    const milestoneRows = Object.entries(perf.milestones).map(
        ([name, endedAt]) => ({
            milestone: name,
            startMs: 0,
            endMs: endedAt - perf.startedAt,
            durationMs: endedAt - perf.startedAt
        })
    );
    const elapsed = name =>
        perf.milestones[name] === undefined
            ? "not reached"
            : (perf.milestones[name] - perf.startedAt).toFixed(1) + " ms";
    const headerVisibleMilestone =
        perf.milestones["friend panel dismissed / header unoccluded"] === undefined
            ? "chat header paint opportunity"
            : "friend panel dismissed / header unoccluded";

    console.groupCollapsed(
        `[TalkSpace Performance] Chat open #${perf.id} — ${perf.source}`
    );
    window.TalkSpaceLogger?.debug("Summary:", {
        "Chat open total": elapsed("chat open flow complete"),
        "Header ready": elapsed("chat header ready"),
        "Header visible": elapsed(headerVisibleMilestone),
        "Friend panel dismissed": elapsed("friend panel dismissed / header unoccluded"),
        "Composer usable": elapsed("composer usable"),
        "Messages rendered": elapsed("messages rendered / DOM ready"),
        "Messages paint opportunity": elapsed("messages paint opportunity"),
        "Chat visually ready": elapsed("chat visually ready paint opportunity"),
        "Unread clear complete": elapsed("unread clear complete")
    });
    console.table(milestoneRows);
    console.table(perf.stages);
    window.TalkSpaceLogger?.debug("Aggregates:", perf.totals);
    console.groupEnd();
}

// ======================================================
// MESSAGE MULTI-SELECT
// ======================================================

let selectedMessages = new Set();

let messageSelectionMode = false;
let messageSelectionUserId = null;

// ======================================================
// SELECT / UNSELECT MESSAGE
// ======================================================

function toggleMessageSelection(
    messageElement
) {

    if (!messageElement) {
        return;
    }

    const messageId =
        messageElement.dataset.messageId;

    if (!messageId) {
        return;
    }

    if (
        selectedMessages.has(
            messageId
        )
    ) {

        selectedMessages.delete(
            messageId
        );

        messageElement.classList.remove(
            "messageSelected"
        );

    } else {

        if (selectedMessages.size === 0) {
            messageSelectionUserId = selectedUser?.id || null;
        }

        selectedMessages.add(
            messageId
        );

        messageElement.classList.add(
            "messageSelected"
        );

    }

    messageSelectionMode =
        selectedMessages.size > 0;
        
    updateMessageSelectionBar();

}

// ======================================================
// UPDATE MESSAGE SELECTION BAR
// ======================================================

function updateMessageSelectionBar() {

    const bar =
        $("messageSelectionBar");

    const count =
        $("selectedMessageCount");

    if (
        !bar ||
        !count
    ) {
        return;
    }

    const selectedCount =
        selectedMessages.size;

    if (
        selectedCount === 0
    ) {

        messageSelectionMode =
            false;
        messageSelectionUserId = null;

        count.textContent =
            "0 selected";

        bar.classList.add(
            "hidden"
        );

        return;

    }

    messageSelectionMode =
        true;

    count.textContent =
        `${selectedCount} selected`;

    bar.classList.remove(
        "hidden"
    );

}


function clearMessageSelection() {

    selectedMessages.clear();
    messageSelectionMode = false;
    messageSelectionUserId = null;

    document
        .querySelectorAll(".messageSelected")
        .forEach(messageElement => {
            messageElement.classList.remove("messageSelected");
        });

    updateMessageSelectionBar();
}
// ======================================================
// CANCEL MESSAGE SELECTION
// ======================================================

document.addEventListener(
    "click",
    event => {

        if (
            event.target.id !==
            "cancelMessageSelection"
        ) {
            return;
        }

        clearMessageSelection();

    }
);

// ======================================================
// COPY SELECTED MESSAGES
// ======================================================

document.addEventListener(
    "click",
    async event => {

        if (
            event.target.id !==
            "copySelectedMessages"
        ) {
            return;
        }

        if (
            selectedMessages.size === 0
        ) {
            return;
        }

        const messages = [];

        selectedMessages.forEach(
            messageId => {

                const messageElement =
                    document.querySelector(
                        `.message[data-message-id="${messageId}"]`
                    );

                if (!messageElement) {
                    return;
                }

                const content =
                    messageElement.querySelector(
                        ".messageContent"
                    );

                if (!content) {
                    return;
                }

                const text =
                    (content.dataset.messageBody ?? content.textContent).trim();

                if (text) {
                    messages.push(text);
                }

            }
        );

        if (
            messages.length === 0
        ) {
            return;
        }

        try {

            await navigator.clipboard.writeText(
                messages.join("\n")
            );

            message(
                `${messages.length} messages copied.`
            );

            clearMessageSelection();

        } catch (error) {

            console.error(
                "COPY SELECTED MESSAGES ERROR:",
                error
            );

            message(
                "Could not copy the selected messages."
            );

        }

    }
);

// ======================================================
// DELETE SELECTED MESSAGES FOR ME
// ======================================================

document.addEventListener(
    "click",
    async event => {

        if (
            event.target.id !==
            "deleteSelectedMessages"
        ) {
            return;
        }

        if (
            selectedMessages.size === 0
        ) {
            return;
        }

        const messageIds = [
            ...selectedMessages
        ];

        const confirmed =
            confirm(
                `Delete ${messageIds.length} selected messages for you?`
            );

        if (!confirmed) {
            return;
        }

        try {

            const rows =
                messageIds.map(
                    messageId => ({
                        message_id:
                            messageId,

                        user_id:
                            currentUser.id
                    })
                );

            const { error } =
                await client
                    .from(
                        "message_deleted_for"
                    )
                    .insert(rows);

            if (error) {
                throw error;
            }

            message(
                `${messageIds.length} messages deleted for you.`
            );

            clearMessageSelection();

            await loadMessages();

        } catch (error) {

            console.error(
                "DELETE SELECTED MESSAGES ERROR:",
                error
            );

            message(
                "Could not delete the selected messages."
            );

        }

    }
);



let typingTimeout = null;

let pendingTypingContext = null;

let isTyping = false;

let isSendingMessage = false;

let searchTimer = null;

let presenceHeartbeat = null;


// ======================================================
// TURNSTILE STATE
// ======================================================

// Signup CAPTCHA
let signupTurnstileToken = "";
let signupTurnstileWidgetId = null;
let signupTurnstileRenderDelay = null;
let signupTurnstileCallbackGeneration = 0;
let signupTurnstileCallbackState = null;
const signupTurnstileWaiter =
    window.TalkSpaceTurnstileLifecycle.createWaiter({
        getLibrary: () => window.turnstile
    });


// Login CAPTCHA
let loginTurnstileToken = "";
let loginTurnstileWidgetId = null;
let loginTurnstileRenderDelay = null;
let loginTurnstileCallbackGeneration = 0;
let loginTurnstileCallbackState = null;
const loginTurnstileWaiter =
    window.TalkSpaceTurnstileLifecycle.createWaiter({
        getLibrary: () => window.turnstile
    });

let turnstileUiGeneration = 0;


// ======================================================
// ELEMENT HELPER
// ======================================================

function $(id) {

    return document.getElementById(id);

}


// ======================================================
// AUTH MESSAGE
// ======================================================
function message(text) {

    const box = $("authMessage");

    if (box) {

        box.textContent = text;

    }


    const callNotification =
        $("callNotification");

    if (callNotification) {

        if (callNotification.hideTimer) {
            clearTimeout(callNotification.hideTimer);
        }

        callNotification.textContent =
            text;

        callNotification.classList.remove(
            "hidden"
        );

        callNotification.hideTimer = setTimeout(
            () => {

                callNotification.classList.add(
                    "hidden"
                );
                callNotification.hideTimer = null;

            },
            4000
        );

    }

}

function showProfileLoadRetry() {

    const button = $("retryProfileLoadBtn");
    if (!button) {
        return;
    }

    button.disabled = profileRetryInFlight;
    button.textContent = profileRetryInFlight ? "Retrying..." : "Retry";
    show("retryProfileLoadBtn");

}

function clearProfileLoadRetry({ clearMessage = false } = {}) {

    const wasVisible =
        !$("retryProfileLoadBtn").classList.contains("hidden");

    profileRetryOperationGeneration += 1;
    profileRetryInFlight = false;
    profileRetryLoadGeneration = null;

    const button = $("retryProfileLoadBtn");
    if (button) {
        button.disabled = false;
        button.textContent = "Retry";
    }

    hide("retryProfileLoadBtn");

    if (clearMessage && wasVisible) {
        $("authMessage").textContent = "";
    }

}

async function retryProfileLoad() {

    if (profileRetryInFlight || !currentUser?.id) {
        return;
    }

    const userId = currentUser.id;
    const authGeneration = authSessionGeneration;
    const loadGeneration = authUserLoadGeneration + 1;
    const retryGeneration = ++profileRetryOperationGeneration;
    const button = $("retryProfileLoadBtn");

    profileRetryInFlight = true;
    profileRetryLoadGeneration = loadGeneration;
    button.disabled = true;
    button.textContent = "Retrying...";

    try {
        await loadCurrentUser();
    } catch (error) {
        if (
            retryGeneration !== profileRetryOperationGeneration ||
            authSessionGeneration !== authGeneration ||
            authUserLoadGeneration !== loadGeneration ||
            currentUser?.id !== userId
        ) {
            return;
        }

        console.error("PROFILE LOAD RETRY ERROR:", error);
        message("Could not load your profile.");
        showProfileLoadRetry();
    } finally {
        if (
            retryGeneration === profileRetryOperationGeneration &&
            authSessionGeneration === authGeneration &&
            authUserLoadGeneration === loadGeneration &&
            currentUser?.id === userId
        ) {
            profileRetryInFlight = false;
            profileRetryLoadGeneration = null;
            if (!button.classList.contains("hidden")) {
                button.disabled = false;
                button.textContent = "Retry";
            }
        }
    }

}

$("retryProfileLoadBtn").addEventListener("click", retryProfileLoad);


// ======================================================
// SHOW
// ======================================================

function show(id) {

    const element = $(id);

    if (element) {

        element.classList.remove("hidden");

    }

}


// ======================================================
// HIDE
// ======================================================

function hide(id) {

    const element = $(id);

    if (element) {

        element.classList.add("hidden");

    }

}

// Give the browser one paint opportunity after a destination shell is shown,
// before starting its first network request.
function waitForViewPaint() {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

// Switches the SPA's visible view and keeps sidebar state in sync.
function navigateToView(view) {
    const mainScreen = $("mainScreen");
    const panelByView = {
        findPeople: "findPeoplePanel",
        friends: "friendRequestsPanel",
        requests: "friendRequestsPanel",
        blocked: "friendRequestsPanel",
        profile: "profilePanel",
        publicProfile: "publicProfilePanel",
        settings: "settingsPanel",
        privacy: "privacyPanel"
    };
    if (view !== "publicProfile") publicProfileLoadGeneration += 1;
    currentView = view;
    mainScreen.dataset.currentView = view;
    mainScreen.classList.remove("mobile-chat-active");
    ["findPeoplePanel", "profilePanel", "publicProfilePanel", "friendRequestsPanel", "settingsPanel", "privacyPanel", "chatPanel"]
        .forEach(id => hide(id));
    if (panelByView[view]) show(panelByView[view]);
    const viewPanel = panelByView[view] ? $(panelByView[view]) : null;
    if (viewPanel) viewPanel.scrollTop = 0;
    viewPanel?.querySelector(".findPeopleContent, .profile-card, .publicProfileContent, .settingsPanelContent, .privacyPanelContent")?.scrollTo(0, 0);
    ["friendRequestsList", "userResults", "settingsPanel", "privacyPanel", "profilePanel", "publicProfilePanel"]
        .forEach(id => {
            const element = $(id);
            if (element) element.scrollTop = 0;
        });
    if (view === "home") show("emptyChat");
    else hide("emptyChat");

    if (["friends", "requests", "blocked"].includes(view)) setFriendPanelView(view);
    else {
        friendListLoadGeneration += 1;
        friendRequestListLoadGeneration += 1;
        setFriendPanelView(null);
    }
    syncSidebarNavigationState({
        home: "homeBtn",
        findPeople: "findPeopleBtn",
        friends: "friendsBtn",
        requests: "requestsBtn",
        blocked: "blockedBtn",
        publicProfile: publicProfileReturnView === "friends" ? "friendsBtn"
            : publicProfileReturnView === "findPeople" ? "findPeopleBtn" : null
    }[view] || null);
}

function closeAccountPopover() {
    const button = $("accountBtn");
    const popover = $("accountPopover");
    if (!button || !popover) return;
    button.setAttribute("aria-expanded", "false");
    popover.classList.add("hidden");
}

function setAccountIdentity(profile, user) {
    const identity = profile?.display_name || profile?.username || user?.email || "?";
    const avatar = $("accountAvatar");
    if (avatar) avatar.textContent = (Array.from(String(identity).trim())[0] || "?").toLocaleUpperCase();
    $("accountBtn")?.setAttribute("aria-label", `Account: ${identity}`);
}

function returnFromDedicatedView() {
    navigateToView(dedicatedViewReturnTo || "home");
}

if (window.TalkSpaceSettings?.initialize) {
    settingsViewController = window.TalkSpaceSettings.initialize(
        client,
        () => returnFromDedicatedView(),
        displayName => {
            currentProfile = { ...currentProfile, display_name: displayName };
            setAccountIdentity(currentProfile, currentUser);
            $("profileDisplayName").textContent = displayName || "-";
        },
        async () => {
            await cleanupSignedOutState();
        }
    );
}

$("accountBtn").addEventListener("click", event => {
    event.stopPropagation();
    accountReturnView = currentView === "chat" ? chatReturnView : currentView;
    const button = $("accountBtn");
    const popover = $("accountPopover");
    const opening = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(opening));
    popover.classList.toggle("hidden", !opening);
});

document.addEventListener("click", event => {
    if (!event.target.closest("#accountMenu")) closeAccountPopover();
});

document.addEventListener("keydown", event => {
    if (event.key === "Escape" && $("accountBtn")?.getAttribute("aria-expanded") === "true") {
        closeAccountPopover();
        $("accountBtn").focus();
    }
});

$("homeBtn").addEventListener("click", () => navigateToView("home"));
$("findPeopleBtn").addEventListener("click", () => {
    dedicatedViewReturnTo = "home";
    navigateToView("findPeople");
    $("searchInput").focus();
});

document.addEventListener("click", event => {
    const shortcut = event.target.closest("[data-home-nav]");
    if (!shortcut) return;

    const buttonByView = {
        findPeople: "findPeopleBtn",
        friends: "friendsBtn",
        requests: "requestsBtn",
        blocked: "blockedBtn"
    };
    $(buttonByView[shortcut.dataset.homeNav])?.click();
});

$("findPeopleBackBtn").addEventListener("click", returnFromDedicatedView);
$("settingsBtn").addEventListener("click", () => {
    closeAccountPopover();
    dedicatedViewReturnTo = accountReturnView;
    navigateToView("settings");
    if (currentUser && settingsViewController) void settingsViewController.setUser(currentUser);
});
$("privacyBtn").addEventListener("click", () => {
    closeAccountPopover();
    dedicatedViewReturnTo = accountReturnView;
    navigateToView("privacy");
});
$("privacyBackBtn").addEventListener("click", returnFromDedicatedView);

function setFriendPanelView(view) {
    friendPanelView = view;
    const panel = $("friendRequestsPanel");
    const heading = $("friendRequestsHeading");
    const backButton = $("closeFriendRequestsBtn");
    const labels = {
        friends: "Friends",
        requests: "Friend Requests",
        blocked: "Blocked Users"
    };
    const label = labels[view] || "People";

    panel?.classList.toggle("is-friends-view", view === "friends");
    if (heading) {
        heading.textContent = label;
    }
    if (backButton) {
        backButton.textContent = "← Back";
        backButton.setAttribute("aria-label", `Back from ${label}`);
    }
}

function showListFeedback(list, title, detail = "", actionLabel = "", actionView = "") {
    if (!list) return;

    const feedback = document.createElement("div");
    feedback.className = "listFeedback";
    feedback.setAttribute("role", "status");

    const heading = document.createElement("strong");
    heading.textContent = title;
    feedback.appendChild(heading);

    if (detail) {
        const description = document.createElement("span");
        description.textContent = detail;
        feedback.appendChild(description);
    }

    if (actionLabel && actionView) {
        const action = document.createElement("button");
        action.className = "emptyStateAction";
        action.type = "button";
        action.dataset.homeNav = actionView;
        action.textContent = actionLabel;
        feedback.appendChild(action);
    }

    list.replaceChildren(feedback);
}

// Keep one current item in the sidebar without changing panel behavior.
function syncSidebarNavigationState(activeButtonId = null) {
    ["homeBtn", "findPeopleBtn", "friendsBtn", "requestsBtn", "blockedBtn"].forEach(buttonId => {
        const button = $(buttonId);
        const isActive = buttonId === activeButtonId;
        button.classList.toggle("is-active", isActive);
        if (isActive) {
            button.setAttribute("aria-current", "page");
        } else {
            button.removeAttribute("aria-current");
        }
    });
}

function setProfileAvatar(element, profile) {
    if (!element) return;
    const identity = String(profile?.display_name || profile?.username || "?").trim();
    const initial = Array.from(identity)[0]?.toLocaleUpperCase() || "?";
    element.textContent = initial;

    const rawUrl = String(profile?.avatar_url || "").trim();
    if (!rawUrl) return;

    try {
        const avatarUrl = new URL(rawUrl, window.location.origin);
        const isSecureUrl = avatarUrl.protocol === "https:";
        const isSameOriginHttp = avatarUrl.protocol === "http:" && avatarUrl.origin === window.location.origin;
        if (!isSecureUrl && !isSameOriginHttp) return;

        const image = document.createElement("img");
        image.alt = "";
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => {
            element.textContent = initial;
        }, { once: true });
        image.src = avatarUrl.href;
        element.replaceChildren(image);
    } catch {
        element.textContent = initial;
    }
}

function isCurrentPublicProfileLoad(userId, authUserId, generation) {
    return publicProfileLoadGeneration === generation &&
        currentUser?.id === authUserId &&
        currentView === "publicProfile" &&
        Boolean(userId);
}

async function openPublicProfile(user, returnView = currentView) {
    const authUserId = currentUser?.id;
    if (!authUserId || !user?.id || user.id === authUserId) return;

    const allowedReturnViews = ["findPeople", "friends"];
    publicProfileReturnView = allowedReturnViews.includes(returnView) ? returnView : "home";
    const generation = ++publicProfileLoadGeneration;
    navigateToView("publicProfile");

    const details = $("publicProfileDetails");
    const messageElement = $("publicProfileMessage");
    details.classList.add("hidden");
    $("publicProfileAvatar").replaceChildren();
    $("publicProfilePresence").classList.add("hidden");
    messageElement.textContent = "Loading profile…";

    const blockState = await getBlockState(user.id);
    if (!isCurrentPublicProfileLoad(user.id, authUserId, generation)) return;
    if (blockState.unknown) {
        messageElement.textContent = "Could not verify privacy status, so this profile is unavailable.";
        return;
    }
    if (blockState.blockedByMe || blockState.blockedMe) {
        messageElement.textContent = "This profile is unavailable.";
        return;
    }

    const [{ data: profile, error: profileError }, relationship] = await Promise.all([
        client
            .from("profiles")
            .select("id, username, display_name, avatar_url")
            .eq("id", user.id)
            .maybeSingle(),
        getFriendRelationshipState(user.id, authUserId)
    ]);
    if (!isCurrentPublicProfileLoad(user.id, authUserId, generation)) return;
    if (profileError || !profile) {
        messageElement.textContent = "This profile is unavailable.";
        return;
    }

    let presenceLabel = "";
    if (relationship.verified && relationship.isFriend) {
        const { data: presence, error: presenceError } = await client
            .from("presence")
            .select("is_online, last_seen")
            .eq("user_id", user.id)
            .maybeSingle();
        if (!isCurrentPublicProfileLoad(user.id, authUserId, generation)) return;
        presenceLabel = presenceError
            ? "Presence unavailable"
            : isPresenceFresh(presence) ? "Online" : "Offline";
    }

    const latestBlockState = await getBlockState(user.id);
    if (!isCurrentPublicProfileLoad(user.id, authUserId, generation)) return;
    if (latestBlockState.unknown || latestBlockState.blockedByMe || latestBlockState.blockedMe) {
        messageElement.textContent = latestBlockState.unknown
            ? "Could not verify privacy status, so this profile is unavailable."
            : "This profile is unavailable.";
        return;
    }

    const relationshipLabel = !relationship.verified
        ? "Relationship status unavailable"
        : relationship.isFriend
            ? "Friend"
            : relationship.incomingPending
                ? "Friend request received"
                : relationship.outgoingPending
                    ? "Friend request sent"
                    : "Not friends";

    $("publicProfileDisplayName").textContent = profile.display_name || profile.username || "TalkSpace user";
    $("publicProfileUsername").textContent = profile.username ? `@${profile.username}` : "";
    $("publicProfileRelationship").textContent = relationshipLabel;
    setProfileAvatar($("publicProfileAvatar"), profile);
    const presenceElement = $("publicProfilePresence");
    presenceElement.textContent = presenceLabel;
    presenceElement.classList.toggle("hidden", !presenceLabel);
    messageElement.textContent = "";
    details.classList.remove("hidden");
}

function returnFromPublicProfile() {
    if (publicProfileReturnView === "friends") {
        $("friendsBtn").click();
    } else if (publicProfileReturnView === "findPeople") {
        navigateToView("findPeople");
    } else {
        navigateToView("home");
    }
}

$("publicProfileBackBtn").addEventListener("click", returnFromPublicProfile);

// Invalidates hidden-chat work and returns to the existing Friends loader.
function returnToFriendsFromMobileChat() {
    const mainScreen = $("mainScreen");
    if (!mainScreen.classList.contains("mobile-chat-active")) {
        return;
    }

    const typingContext = pendingTypingContext;
    if (typingTimeout) {
        clearTimeout(typingTimeout);
        typingTimeout = null;
    }
    pendingTypingContext = null;
    isTyping = false;
    $("typingIndicator").classList.add("hidden");

    selectedChatGeneration += 1;
    chatMessageLoadGeneration += 1;
    friendOpenIntentGeneration += 1;
    clearMessageSelection();
    selectedUser = null;
    selectedConversation = null;

    $("messages").innerHTML = "";
    $("messageInput").value = "";
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    setCallButtonsDisabled(true);
    $("chatUserName").textContent = "";
    $("chatUserStatus").textContent = "";
    hide("chatPanel");
    hide("profilePanel");
    hide("publicProfilePanel");
    show("emptyChat");
    mainScreen.classList.remove("mobile-chat-active");
    currentView = chatReturnView;
    mainScreen.dataset.currentView = currentView;

    if (typingContext) {
        const stopTypingRequest = sendTypingStatus(typingContext, false);
        stopTypingRequest?.catch(error => {
            console.error("Could not stop typing during mobile navigation:", error);
        });
    }

    if (chatReturnView === "friends") {
        $("friendsBtn").click();
    } else {
        navigateToView(chatReturnView);
    }
}


// ======================================================
// ESCAPE HTML
// ======================================================

function escapeHtml(value) {

    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}


// Normalizes common email input and rejects clearly malformed addresses.
function normalizeAndValidateEmail(value) {
    if (typeof value !== "string") {
        return null;
    }

    const email = value.trim();
    if (
        !email ||
        email.length > 254 ||
        /[\s\u0000-\u001f\u007f]/.test(email)
    ) {
        return null;
    }

    const atIndex = email.indexOf("@");
    if (atIndex <= 0 || atIndex !== email.lastIndexOf("@")) {
        return null;
    }

    const localPart = email.slice(0, atIndex);
    const domain = email.slice(atIndex + 1);
    const localPartPattern = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
    const domainLabelPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
    const domainLabels = domain.split(".");

    if (
        !localPart ||
        localPart.length > 64 ||
        !localPartPattern.test(localPart) ||
        domain.length > 253 ||
        domainLabels.length < 2 ||
        domainLabels.some(label =>
            !label || label.length > 63 || !domainLabelPattern.test(label)
        )
    ) {
        return null;
    }

    return email;
}


// ======================================================
// TURNSTILE CONFIGURATION CHECK
// ======================================================

function hasTurnstileSiteKey() {

    return Boolean(
        window.SUPABASE_CONFIG &&
        window.SUPABASE_CONFIG.turnstileSiteKey &&
        String(
            window.SUPABASE_CONFIG.turnstileSiteKey
        ).trim()
    );

}


// ======================================================
// TURNSTILE - SIGNUP SUCCESS
// ======================================================

function isCurrentSignupTurnstileCallback(state) {
    return Boolean(
        state &&
        state === signupTurnstileCallbackState &&
        state.generation === signupTurnstileCallbackGeneration &&
        state.viewGeneration === turnstileUiGeneration &&
        isCurrentTurnstileUi("signupBox", state.viewGeneration) &&
        (state.widgetId === null || state.widgetId === signupTurnstileWidgetId)
    );
}


function isCurrentLoginTurnstileCallback(state) {
    return Boolean(
        state &&
        state === loginTurnstileCallbackState &&
        state.generation === loginTurnstileCallbackGeneration &&
        state.viewGeneration === turnstileUiGeneration &&
        isCurrentTurnstileUi("loginBox", state.viewGeneration) &&
        (state.widgetId === null || state.widgetId === loginTurnstileWidgetId)
    );
}


function handleSignupTurnstileSuccess(state, token) {
    if (!isCurrentSignupTurnstileCallback(state)) return;

    window.TalkSpaceLogger?.debug(
        "SIGNUP TURNSTILE SUCCESS"
    );

    signupTurnstileToken =
        token || "";

}


window.onSignupTurnstileSuccess = function(token) {
    handleSignupTurnstileSuccess(signupTurnstileCallbackState, token);
};


// ======================================================
// TURNSTILE - LOGIN SUCCESS
// ======================================================

function handleLoginTurnstileSuccess(state, token) {
    if (!isCurrentLoginTurnstileCallback(state)) return;

    window.TalkSpaceLogger?.debug(
        "LOGIN TURNSTILE SUCCESS"
    );

    loginTurnstileToken =
        token || "";

}


window.onLoginTurnstileSuccess = function(token) {
    handleLoginTurnstileSuccess(loginTurnstileCallbackState, token);
};


// ======================================================
// TURNSTILE - SIGNUP EXPIRED
// ======================================================

function handleSignupTurnstileExpired(state) {
    if (!isCurrentSignupTurnstileCallback(state)) return;

    window.TalkSpaceLogger?.debug(
        "SIGNUP TURNSTILE EXPIRED"
    );

    signupTurnstileToken = "";

    message(
        "CAPTCHA expired. Please complete it again."
    );

}


window.onSignupTurnstileExpired = function() {
    handleSignupTurnstileExpired(signupTurnstileCallbackState);
};


// ======================================================
// TURNSTILE - LOGIN EXPIRED
// ======================================================

function handleLoginTurnstileExpired(state) {
    if (!isCurrentLoginTurnstileCallback(state)) return;

    window.TalkSpaceLogger?.debug(
        "LOGIN TURNSTILE EXPIRED"
    );

    loginTurnstileToken = "";

    message(
        "CAPTCHA expired. Please complete it again."
    );

}


window.onLoginTurnstileExpired = function() {
    handleLoginTurnstileExpired(loginTurnstileCallbackState);
};


// ======================================================
// TURNSTILE - SIGNUP ERROR
// ======================================================

function handleSignupTurnstileError(state, errorCode) {
    if (!isCurrentSignupTurnstileCallback(state)) return;

    console.error(
        "SIGNUP TURNSTILE ERROR:",
        errorCode
    );

    signupTurnstileToken = "";

    message(
        "Signup CAPTCHA could not be verified. Please try again."
    );

}


window.onSignupTurnstileError = function(errorCode) {
    handleSignupTurnstileError(signupTurnstileCallbackState, errorCode);
};


// ======================================================
// TURNSTILE - LOGIN ERROR
// ======================================================

function handleLoginTurnstileError(state, errorCode) {
    if (!isCurrentLoginTurnstileCallback(state)) return;

    console.error(
        "LOGIN TURNSTILE ERROR:",
        errorCode
    );

    loginTurnstileToken = "";

    message(
        "Login CAPTCHA could not be verified. Please try again."
    );

}


window.onLoginTurnstileError = function(errorCode) {
    handleLoginTurnstileError(loginTurnstileCallbackState, errorCode);
};


// ======================================================
// RENDER SIGNUP TURNSTILE
// ======================================================

function isCurrentTurnstileUi(boxId, generation) {
    const box = $(boxId);
    const authScreen = $("authScreen");
    return generation === turnstileUiGeneration &&
        Boolean(box) &&
        !box.classList.contains("hidden") &&
        Boolean(authScreen) &&
        !authScreen.classList.contains("hidden");
}


function cancelTurnstileRenderAttempts() {
    turnstileUiGeneration += 1;

    if (signupTurnstileRenderDelay !== null) {
        clearTimeout(signupTurnstileRenderDelay);
        signupTurnstileRenderDelay = null;
    }

    if (loginTurnstileRenderDelay !== null) {
        clearTimeout(loginTurnstileRenderDelay);
        loginTurnstileRenderDelay = null;
    }

    signupTurnstileWaiter.cancel();
    loginTurnstileWaiter.cancel();

    return turnstileUiGeneration;
}


function renderSignupTurnstile(generation = turnstileUiGeneration) {

    if (!isCurrentTurnstileUi("signupBox", generation)) return;

    if (!hasTurnstileSiteKey()) {

        console.error(
            "TURNSTILE SITEKEY IS MISSING IN src/config.js"
        );

        message(
            "Turnstile Sitekey is missing. Please configure src/config.js."
        );

        return;

    }


    const renderWidget = turnstile => {
        if (!isCurrentTurnstileUi("signupBox", generation)) return;

        const container = $("turnstileWidget");
        if (!container) {
            console.error("Signup Turnstile container not found.");
            return;
        }

        const previousWidgetId = signupTurnstileWidgetId;
        const callbackState = {
            generation: ++signupTurnstileCallbackGeneration,
            viewGeneration: generation,
            widgetId: null
        };
        signupTurnstileCallbackState = callbackState;
        signupTurnstileWidgetId = null;

        if (previousWidgetId !== null) {
            try {
                turnstile.remove(previousWidgetId);
            } catch (error) {
                console.error("Previous signup Turnstile widget could not be removed:", error);
            }
        }

        container.innerHTML = "";
        signupTurnstileToken = "";

        const widgetId = turnstile.render(
            "#turnstileWidget",
            {
                sitekey: window.SUPABASE_CONFIG.turnstileSiteKey,
                action: "signup",
                theme: "auto",
                callback: token => handleSignupTurnstileSuccess(callbackState, token),
                "expired-callback": () => handleSignupTurnstileExpired(callbackState),
                "error-callback": errorCode =>
                    handleSignupTurnstileError(callbackState, errorCode)
            }
        );

        if (signupTurnstileCallbackState === callbackState) {
            callbackState.widgetId = widgetId;
            signupTurnstileWidgetId = widgetId;
        }

        window.TalkSpaceLogger?.debug(
            "SIGNUP TURNSTILE WIDGET RENDERED:",
            widgetId
        );
    };

    if (window.turnstile) {
        signupTurnstileWaiter.cancel();
        renderWidget(window.turnstile);
        return;
    }

    window.TalkSpaceLogger?.debug(
        "Turnstile library is not ready yet."
    );

    signupTurnstileWaiter.wait({
        isCurrent: () => isCurrentTurnstileUi("signupBox", generation),
        onReady: renderWidget,
        onTimeout: () => message(
            "Turnstile could not load. Check your connection, then go back and reopen this screen to try again."
        )
    });

}


// ======================================================
// RENDER LOGIN TURNSTILE
// ======================================================

function renderLoginTurnstile(generation = turnstileUiGeneration) {

    if (!isCurrentTurnstileUi("loginBox", generation)) return;

    if (!hasTurnstileSiteKey()) {

        console.error(
            "TURNSTILE SITEKEY IS MISSING IN src/config.js"
        );

        message(
            "Turnstile Sitekey is missing. Please configure src/config.js."
        );

        return;

    }


    const renderWidget = turnstile => {
        if (!isCurrentTurnstileUi("loginBox", generation)) return;

        const container = $("loginTurnstileWidget");
        if (!container) {
            console.error("Login Turnstile container not found.");
            return;
        }

        const previousWidgetId = loginTurnstileWidgetId;
        const callbackState = {
            generation: ++loginTurnstileCallbackGeneration,
            viewGeneration: generation,
            widgetId: null
        };
        loginTurnstileCallbackState = callbackState;
        loginTurnstileWidgetId = null;

        if (previousWidgetId !== null) {
            try {
                turnstile.remove(previousWidgetId);
            } catch (error) {
                console.error("Previous login Turnstile widget could not be removed:", error);
            }
        }

        container.innerHTML = "";
        loginTurnstileToken = "";

        const widgetId = turnstile.render(
            "#loginTurnstileWidget",
            {
                sitekey: window.SUPABASE_CONFIG.turnstileSiteKey,
                action: "login",
                theme: "auto",
                callback: token => handleLoginTurnstileSuccess(callbackState, token),
                "expired-callback": () => handleLoginTurnstileExpired(callbackState),
                "error-callback": errorCode =>
                    handleLoginTurnstileError(callbackState, errorCode)
            }
        );

        if (loginTurnstileCallbackState === callbackState) {
            callbackState.widgetId = widgetId;
            loginTurnstileWidgetId = widgetId;
        }

        window.TalkSpaceLogger?.debug(
            "LOGIN TURNSTILE WIDGET RENDERED:",
            widgetId
        );
    };

    if (window.turnstile) {
        loginTurnstileWaiter.cancel();
        renderWidget(window.turnstile);
        return;
    }

    window.TalkSpaceLogger?.debug(
        "Turnstile library is not ready yet."
    );

    loginTurnstileWaiter.wait({
        isCurrent: () => isCurrentTurnstileUi("loginBox", generation),
        onReady: renderWidget,
        onTimeout: () => message(
            "Turnstile could not load. Check your connection, then go back and reopen this screen to try again."
        )
    });

}


// ======================================================
// RESET SIGNUP CAPTCHA
// ======================================================

function resetSignupTurnstile() {

    const callbackState = signupTurnstileCallbackState;
    if (
        callbackState &&
        !isCurrentSignupTurnstileCallback(callbackState)
    ) {
        return;
    }

    signupTurnstileToken = "";

    const widgetId = callbackState?.widgetId ?? signupTurnstileWidgetId;

    if (
        widgetId !== null &&
        window.turnstile
    ) {

        try {

            window.turnstile.reset(
                widgetId
            );

        } catch (error) {

            console.error("Signup Turnstile reset failed:", error);

        }

    }

}


// ======================================================
// RESET LOGIN CAPTCHA
// ======================================================

function resetLoginTurnstile() {

    const callbackState = loginTurnstileCallbackState;
    if (
        callbackState &&
        !isCurrentLoginTurnstileCallback(callbackState)
    ) {
        return;
    }

    loginTurnstileToken = "";

    const widgetId = callbackState?.widgetId ?? loginTurnstileWidgetId;

    if (
        widgetId !== null &&
        window.turnstile
    ) {

        try {

            window.turnstile.reset(
                widgetId
            );

        } catch (error) {

            console.error("Login Turnstile reset failed:", error);

        }

    }

}


// ======================================================
// SIGNUP OTP REQUEST / RESEND LIFECYCLE
// ======================================================

// A short client-side delay prevents accidental repeated email requests.
// Supabase remains authoritative for its own rate limits.
const SIGNUP_OTP_RESEND_COOLDOWN_MS = 30_000;
let signupOtpRequestGeneration = 0;
let signupOtpRequestInFlight = false;
let signupOtpCooldownUntil = 0;
let signupOtpCooldownTimer = null;
let signupOtpVerificationGeneration = 0;
let signupOtpVerificationInFlight = false;

function invalidateSignupOtpVerification() {

    signupOtpVerificationGeneration += 1;

    if (signupOtpVerificationInFlight) {
        signupOtpVerificationInFlight = false;
        const verifyButton = $("verifyOtpBtn");
        if (verifyButton) {
            verifyButton.disabled = false;
        }
    }

}

function updateSignupOtpResendCooldown() {

    const button = $("resendOtpBtn");
    if (!button) {
        return;
    }

    const remainingSeconds = Math.ceil(
        Math.max(0, signupOtpCooldownUntil - Date.now()) / 1000
    );

    if (remainingSeconds > 0) {
        button.disabled = true;
        button.textContent = `Resend OTP (${remainingSeconds}s)`;
        return;
    }

    if (signupOtpCooldownTimer !== null) {
        clearInterval(signupOtpCooldownTimer);
        signupOtpCooldownTimer = null;
    }

    signupOtpCooldownUntil = 0;
    button.disabled = signupOtpRequestInFlight;
    button.textContent = signupOtpRequestInFlight ? "Sending..." : "Resend OTP";

}

function startSignupOtpResendCooldown() {

    if (signupOtpCooldownTimer !== null) {
        clearInterval(signupOtpCooldownTimer);
    }

    signupOtpCooldownUntil = Date.now() + SIGNUP_OTP_RESEND_COOLDOWN_MS;
    updateSignupOtpResendCooldown();
    signupOtpCooldownTimer = setInterval(updateSignupOtpResendCooldown, 1000);

}

function cancelSignupOtpFlow({ restoreSendButton = true } = {}) {

    invalidateAccountSetupOperation();
    signupOtpRequestGeneration += 1;
    signupOtpRequestInFlight = false;
    invalidateSignupOtpVerification();

    if (signupOtpCooldownTimer !== null) {
        clearInterval(signupOtpCooldownTimer);
        signupOtpCooldownTimer = null;
    }

    signupOtpCooldownUntil = 0;

    const sendButton = $("sendOtpBtn");
    if (sendButton) {
        sendButton.disabled = false;
        if (restoreSendButton) {
            show("sendOtpBtn");
        }
    }

    const resendButton = $("resendOtpBtn");
    if (resendButton) {
        resendButton.disabled = false;
        resendButton.textContent = "Resend OTP";
    }

}

async function requestSignupOtp({ resend = false } = {}) {

    if (signupOtpRequestInFlight) {
        return;
    }

    const email = normalizeAndValidateEmail($("signupEmail").value);
    if (!email) {
        message("Enter a valid email address.");
        return;
    }

    if (resend && Date.now() < signupOtpCooldownUntil) {
        updateSignupOtpResendCooldown();
        return;
    }

    if (!signupTurnstileToken) {
        message("Please complete the CAPTCHA first.");
        return;
    }

    if (resend && $("otpBox").classList.contains("hidden")) {
        return;
    }

    // A newly issued OTP supersedes any verification of the previous code.
    invalidateAccountSetupOperation();
    invalidateSignupOtpVerification();
    const requestGeneration = ++signupOtpRequestGeneration;
    const authGeneration = authSessionGeneration;
    const viewGeneration = turnstileUiGeneration;
    const captchaToken = signupTurnstileToken;
    signupTurnstileToken = "";
    signupOtpRequestInFlight = true;

    const sendButton = $("sendOtpBtn");
    const resendButton = $("resendOtpBtn");
    sendButton.disabled = true;
    resendButton.disabled = true;
    if (resend) {
        resendButton.textContent = "Sending...";
    }

    const isCurrentRequest = () =>
        signupOtpRequestGeneration === requestGeneration &&
        authSessionGeneration === authGeneration &&
        turnstileUiGeneration === viewGeneration &&
        !$("signupBox").classList.contains("hidden") &&
        $("signupEmail").value.trim() === email &&
        (!resend || !$("otpBox").classList.contains("hidden"));

    const isCurrentSignupView = () =>
        authSessionGeneration === authGeneration &&
        turnstileUiGeneration === viewGeneration &&
        !$("signupBox").classList.contains("hidden") &&
        (!resend || !$("otpBox").classList.contains("hidden"));

    message(resend ? "Sending a new OTP..." : "Sending OTP...");

    try {

        const { error } = await client.auth.signInWithOtp({
            email,
            options: {
                shouldCreateUser: true,
                captchaToken
            }
        });

        if (!isCurrentRequest()) {
            if (isCurrentSignupView()) {
                resetSignupTurnstile();
            }
            return;
        }

        if (error) {
            console.error("OTP REQUEST ERROR:", error);
            message("OTP could not be sent: " + error.message);
            resetSignupTurnstile();
            return;
        }

        window.TalkSpaceLogger?.debug("OTP REQUEST SUCCESSFUL");
        resetSignupTurnstile();
        startSignupOtpResendCooldown();

        if (resend) {
            message("A new OTP was sent. Check your email.");
        } else {
            message("OTP sent. Check your email.");
            show("otpBox");
            hide("sendOtpBtn");
        }

    } catch (error) {

        if (!isCurrentRequest()) {
            if (isCurrentSignupView()) {
                resetSignupTurnstile();
            }
            return;
        }

        console.error(resend ? "RESEND OTP ERROR:" : "SEND OTP ERROR:", error);
        message(resend
            ? "A new OTP could not be sent. Please try again."
            : "Something went wrong while sending OTP.");
        resetSignupTurnstile();

    } finally {

        if (signupOtpRequestGeneration === requestGeneration) {
            signupOtpRequestInFlight = false;
            if (isCurrentSignupView()) {
                sendButton.disabled = false;
                updateSignupOtpResendCooldown();
            }
        }

    }

}


// ======================================================
// REMOVE SIGNUP TURNSTILE
// ======================================================

function removeSignupTurnstile() {

    signupTurnstileWaiter.cancel();
    if (signupTurnstileRenderDelay !== null) {
        clearTimeout(signupTurnstileRenderDelay);
        signupTurnstileRenderDelay = null;
    }

    signupTurnstileCallbackGeneration += 1;
    signupTurnstileCallbackState = null;
    signupTurnstileToken = "";
    const widgetId = signupTurnstileWidgetId;
    signupTurnstileWidgetId = null;


    if (
        widgetId !== null &&
        window.turnstile
    ) {

        try {

            window.turnstile.remove(
                widgetId
            );

        } catch (error) {

            console.error("Signup Turnstile removal failed:", error);

        }

    }


    const container =
        $("turnstileWidget");


    if (container) {

        container.innerHTML = "";

    }

}


// ======================================================
// REMOVE LOGIN TURNSTILE
// ======================================================

function removeLoginTurnstile() {

    loginTurnstileWaiter.cancel();
    if (loginTurnstileRenderDelay !== null) {
        clearTimeout(loginTurnstileRenderDelay);
        loginTurnstileRenderDelay = null;
    }

    loginTurnstileCallbackGeneration += 1;
    loginTurnstileCallbackState = null;
    loginTurnstileToken = "";
    const widgetId = loginTurnstileWidgetId;
    loginTurnstileWidgetId = null;


    if (
        widgetId !== null &&
        window.turnstile
    ) {

        try {

            window.turnstile.remove(
                widgetId
            );

        } catch (error) {

            console.error("Login Turnstile removal failed:", error);

        }

    }


    const container =
        $("loginTurnstileWidget");


    if (container) {

        container.innerHTML = "";

    }

}


// ======================================================
// INITIAL AUTH CHOICE
// ======================================================

$("showSignupBtn").addEventListener(
    "click",
    () => {

        // A deliberate auth choice takes precedence over a pending startup
        // session restore.
        const generation = cancelTurnstileRenderAttempts();
        invalidateLoginOperation();
        cancelSignupOtpFlow();
        clearProfileLoadRetry();
        invalidateAuthSessionWork();

        hide("authChoice");

        hide("loginBox");

        show("signupBox");

        message("");


        signupTurnstileRenderDelay = setTimeout(
            () => {
                signupTurnstileRenderDelay = null;
                renderSignupTurnstile(generation);
            },
            200
        );

    }
);


// ======================================================
// OPEN LOGIN
// ======================================================

$("showLoginBtn").addEventListener(
    "click",
    () => {

        const generation = cancelTurnstileRenderAttempts();
        invalidateLoginOperation();
        cancelSignupOtpFlow();
        clearProfileLoadRetry();
        invalidateAuthSessionWork();

        hide("authChoice");

        hide("signupBox");

        show("loginBox");

        message("");


        loginTurnstileRenderDelay = setTimeout(
            () => {
                loginTurnstileRenderDelay = null;
                renderLoginTurnstile(generation);
            },
            200
        );

    }
);


// ======================================================
// BACK FROM SIGNUP
// ======================================================

$("backToAuthBtn").addEventListener(
    "click",
    () => {

        cancelTurnstileRenderAttempts();
        invalidateLoginOperation();
        cancelSignupOtpFlow();
        invalidateAuthSessionWork();
        removeSignupTurnstile();

        hide("signupBox");

        hide("loginBox");

        show("authChoice");


        $("signupEmail").value = "";

        $("otpInput").value = "";

        $("usernameInput").value = "";

        $("displayNameInput").value = "";

        $("passwordInput").value = "";


        hide("otpBox");

        hide("profileBox");


        message("");

    }
);


// ======================================================
// BACK FROM LOGIN
// ======================================================

$("backToAuthFromLoginBtn").addEventListener(
    "click",
    () => {

        cancelTurnstileRenderAttempts();
        invalidateLoginOperation();
        cancelSignupOtpFlow();
        removeLoginTurnstile();

        hide("signupBox");

        hide("loginBox");

        show("authChoice");


        $("loginIdentifier").value = "";

        $("loginPassword").value = "";


        message("");

    }
);


// ======================================================
// SEND / RESEND OTP
// ======================================================

// Both actions share one request path and consume a fresh Turnstile token.
$("sendOtpBtn").addEventListener(
    "click",
    () => requestSignupOtp()
);

$("resendOtpBtn").addEventListener(
    "click",
    () => requestSignupOtp({ resend: true })
);


// ======================================================
// VERIFY OTP
// ======================================================

// Verifies the signup OTP before allowing account profile/password completion.
$("verifyOtpBtn").addEventListener(
    "click",
    async () => {

        if (signupOtpVerificationInFlight) {
            return;
        }

        const email =
            $("signupEmail")
                .value
                .trim();


        const token =
            $("otpInput")
                .value
                .trim();


        window.TalkSpaceLogger?.debug(
            "VERIFY OTP BUTTON CLICKED"
        );


        if (!email) {

            message(
                "Email is missing."
            );

            return;

        }


        if (!token) {

            message(
                "Enter the OTP."
            );

            return;

        }


        if (token.length !== 8) {

            message(
                "Please enter the complete 8-digit OTP."
            );

            return;

        }


        if (!/^[0-9]{8}$/.test(token)) {

            message(
                "OTP must contain only digits."
            );

            return;

        }


        $("verifyOtpBtn").disabled = true;
        invalidateAccountSetupOperation();
        signupOtpVerificationInFlight = true;

        const verificationGeneration = ++signupOtpVerificationGeneration;
        const authGeneration = authSessionGeneration;
        const viewGeneration = turnstileUiGeneration;
        const otpRequestGeneration = signupOtpRequestGeneration;
        const startingIdentityId = currentUser?.id || observedAuthIdentityId || null;

        const isCurrentVerification = (resultUserId = null) => {
            const viewIsCurrent =
                signupOtpVerificationGeneration === verificationGeneration &&
                signupOtpVerificationInFlight &&
                authSessionGeneration === authGeneration &&
                turnstileUiGeneration === viewGeneration &&
                signupOtpRequestGeneration === otpRequestGeneration &&
                !$("signupBox").classList.contains("hidden") &&
                !$("otpBox").classList.contains("hidden");

            if (!viewIsCurrent) {
                return false;
            }

            const currentIdentityId = currentUser?.id || observedAuthIdentityId || null;
            return currentIdentityId === startingIdentityId || Boolean(
                resultUserId && currentIdentityId === resultUserId
            );
        };


        try {

            const result =
                await client.auth.verifyOtp({

                    email:
                        email,

                    token:
                        token,

                    type:
                        "email"

                });

            const resultUserId =
                result?.data?.user?.id ||
                result?.data?.session?.user?.id ||
                null;

            if (!isCurrentVerification(resultUserId)) {
                return;
            }

            const { error } = result || {};

            if (error) {

                console.error(
                    "OTP VERIFICATION ERROR:",
                    error
                );

                message(
                    "OTP verification failed: " +
                    error.message
                );

                return;

            }


            window.TalkSpaceLogger?.debug(
                "OTP VERIFICATION SUCCESS"
            );


            message(
                "Email verified successfully."
            );


            hide("otpBox");

            show("profileBox");


        } catch (error) {

            if (!isCurrentVerification()) {
                return;
            }

            console.error(
                "VERIFY OTP ERROR:",
                error
            );

            message(
                "OTP verification failed."
            );

        } finally {

            if (signupOtpVerificationGeneration === verificationGeneration) {
                signupOtpVerificationInFlight = false;
                $("verifyOtpBtn").disabled = false;
            }

        }

    }
);


// ======================================================
// CREATE ACCOUNT
// ======================================================

$("createAccountBtn").addEventListener(
    "click",
    async () => {

        if (accountSetupInFlight) {
            return;
        }

        const username =
            $("usernameInput")
                .value
                .trim()
                .toLowerCase();


        const displayName =
            $("displayNameInput")
                .value
                .trim();


        const password =
            $("passwordInput")
                .value;


        if (!username) {

            message(
                "Please enter a username."
            );

            return;

        }


        if (username.length < 3) {

            message(
                "Username must contain at least 3 characters."
            );

            return;

        }


        if (!/^[a-z0-9_]+$/.test(username)) {

            message(
                "Username can only use lowercase letters, numbers and underscore."
            );

            return;

        }


        if (!displayName) {

            message(
                "Please enter your display name."
            );

            return;

        }


        if (password.length < 12) {

            message(
                "Password must contain at least 12 characters."
            );

            return;

        }


        $("createAccountBtn").disabled = true;
        accountSetupInFlight = true;

        const operationGeneration = ++accountSetupGeneration;
        const authGeneration = authSessionGeneration;
        const viewGeneration = turnstileUiGeneration;
        const otpRequestGeneration = signupOtpRequestGeneration;
        const otpVerificationGeneration = signupOtpVerificationGeneration;
        const startingIdentityId = currentUser?.id || observedAuthIdentityId || null;
        let setupUserId = startingIdentityId;

        const isCurrentAccountSetup = (resolvedUserId = setupUserId) => {
            if (
                accountSetupGeneration !== operationGeneration ||
                !accountSetupInFlight ||
                authSessionGeneration !== authGeneration ||
                turnstileUiGeneration !== viewGeneration ||
                signupOtpRequestGeneration !== otpRequestGeneration ||
                signupOtpVerificationGeneration !== otpVerificationGeneration ||
                $("signupBox").classList.contains("hidden") ||
                $("profileBox").classList.contains("hidden")
            ) {
                return false;
            }

            const currentIdentityId = currentUser?.id || observedAuthIdentityId || null;
            if (
                (startingIdentityId && resolvedUserId && startingIdentityId !== resolvedUserId) ||
                (setupUserId && resolvedUserId && setupUserId !== resolvedUserId) ||
                (currentIdentityId && resolvedUserId && currentIdentityId !== resolvedUserId)
            ) {
                return false;
            }

            return true;
        };


        message(
            "Creating your account..."
        );


        try {

            if (!isCurrentAccountSetup()) {
                return;
            }

            const {
                data: userData,
                error: userError
            } =
                await client.auth.getUser();

            const resolvedUserId = userData?.user?.id || null;
            if (!isCurrentAccountSetup(resolvedUserId)) {
                return;
            }


            if (userError) {

                console.error(
                    "GET USER ERROR:",
                    userError
                );

                message(
                    "Your verification session has expired. Please verify your email again."
                );

                return;

            }


            const user =
                userData.user;


            if (!user) {

                message(
                    "No authenticated user found. Please verify your email again."
                );

                return;

            }

            if (
                (startingIdentityId && startingIdentityId !== user.id) ||
                ((currentUser?.id || observedAuthIdentityId) &&
                    (currentUser?.id || observedAuthIdentityId) !== user.id)
            ) {
                return;
            }

            setupUserId = user.id;
            if (!isCurrentAccountSetup(user.id)) {
                return;
            }


            const {
                error: updateError
            } =
                await client.auth.updateUser({

                    password:
                        password,

                    data: {

                        username:
                            username,

                        display_name:
                            displayName

                    }

                });

            if (!isCurrentAccountSetup(user.id)) {
                return;
            }


            if (updateError) {

                console.error(
                    "AUTH UPDATE ERROR:",
                    updateError
                );

                message(
                    "Could not create account: " +
                    updateError.message
                );

                return;

            }

            if (!isCurrentAccountSetup(user.id)) {
                return;
            }


            const {
                error: profileError
            } =
                await client
                    .from("profiles")
                    .upsert({

                        id:
                            user.id,

                        username:
                            username,

                        display_name:
                            displayName

                    });

            if (!isCurrentAccountSetup(user.id)) {
                return;
            }


            if (profileError) {

                console.error(
                    "PROFILE CREATION ERROR:",
                    profileError
                );

                message(
                    "Profile creation failed: " +
                    profileError.message
                );

                return;

            }


            window.TalkSpaceLogger?.debug(
                "PROFILE CREATED SUCCESSFULLY"
            );


            message(
                "Account created successfully!"
            );

            if (!isCurrentAccountSetup(user.id)) {
                return;
            }

            await loadCurrentUser();

            if (!isCurrentAccountSetup(user.id)) {
                return;
            }


        } catch (error) {

            if (!isCurrentAccountSetup()) {
                return;
            }

            console.error(
                "CREATE ACCOUNT ERROR:",
                error
            );

            message(
                "Something went wrong while creating your account."
            );

        } finally {

            if (accountSetupGeneration === operationGeneration) {
                accountSetupInFlight = false;
                $("createAccountBtn").disabled = false;
            }

        }

    }
);


// ======================================================
// LOGIN / SIGN IN
// ======================================================

// Authenticates with the validated email/password and current login CAPTCHA token.
$("loginBtn").addEventListener(
    "click",
    async () => {

        if (loginOperationInFlight) {
            return;
        }

        const emailInput = $("loginIdentifier").value;
        const email = normalizeAndValidateEmail(emailInput);


        const password =
            $("loginPassword")
                .value;


        if (!emailInput.trim()) {

            message(
                "Enter email and password."
            );

            return;

        }


        if (!email) {

            message(
                "Enter a valid email address."
            );

            return;

        }


        if (!email) {

            message(
                "Enter a valid email address."
            );

            return;

        }


        invalidateAccountSetupOperation();

        // Invalidate startup or prior-user loads for a syntactically valid attempt.
        invalidateAuthSessionWork();


        if (!password) {

            message(
                "Enter email and password."
            );

            return;

        }


        if (!loginTurnstileToken) {

            message(
                "Please complete the CAPTCHA first."
            );

            return;

        }


        
        $("loginBtn").disabled = true;
        loginOperationInFlight = true;

        const operationGeneration = ++loginOperationGeneration;
        const authGeneration = authSessionGeneration;
        const viewGeneration = turnstileUiGeneration;
        const startingIdentityId = currentUser?.id || observedAuthIdentityId || null;
        const captchaToken = loginTurnstileToken;

        const isCurrentLogin = resultUserId => {
            const loginViewIsCurrent =
                loginOperationGeneration === operationGeneration &&
                loginOperationInFlight &&
                authSessionGeneration === authGeneration &&
                turnstileUiGeneration === viewGeneration &&
                !$("loginBox").classList.contains("hidden");

            if (!loginViewIsCurrent) {
                return false;
            }

            const currentIdentityId = currentUser?.id || observedAuthIdentityId || null;
            return currentIdentityId === startingIdentityId || Boolean(
                resultUserId && currentIdentityId === resultUserId
            );
        };


        message(
            "Logging in..."
        );


        try {

            const result =
                await client.auth.signInWithPassword({

                    email:
                        email,

                    password:
                        password,

                    options: {

                        captchaToken

                    }

                });

            const authData = result?.data;
            const resultUserId =
                authData?.user?.id ||
                authData?.session?.user?.id ||
                null;

            if (!isCurrentLogin(resultUserId)) {
                return;
            }

            const { error } = result || {};

            if (error) {

                console.error(
                    "LOGIN ERROR:",
                    error
                );

                message(
                    error.message
                );


                resetLoginTurnstile();

                return;

            }


            window.TalkSpaceLogger?.debug(
                "LOGIN SUCCESS"
            );


            // Token has been consumed.
            loginTurnstileToken = "";


            if (authData?.user) {
                currentUser = authData.user;
            }

            await loadCurrentUser();


        } catch (error) {

            if (!isCurrentLogin(null)) {
                return;
            }

            console.error(
                "LOGIN ERROR:",
                error
            );

            message(
                "Login failed."
            );


            resetLoginTurnstile();

        } finally {

            if (loginOperationGeneration === operationGeneration) {
                loginOperationInFlight = false;
                $("loginBtn").disabled = false;
            }

        }

    }
);


// ======================================================
// LOGOUT
// ======================================================

// Locks the authenticated UI and clears user-scoped state when a session ends.
async function cleanupSignedOutState() {

    if (signedOutCleanupPromise) {
        return signedOutCleanupPromise;
    }

    invalidateLoginOperation();
    invalidateAuthSessionWork();
    cancelSignupOtpFlow();
    clearProfileLoadRetry();

    // Start call cleanup before clearing currentUser so an active call can
    // make its best-effort hangup attempt while its local state is available.
    const callCleanup =
        typeof endCallSessionForLogout === "function"
            ? endCallSessionForLogout()
            : Promise.resolve();

    const channel =
        realtimeChannel;

    clearChatOperationGeneration += 1;
    realtimeChannel = null;

    currentUser = null;
    currentProfile = null;
    if (typeof settingsViewController !== "undefined" && settingsViewController) {
        void settingsViewController.setUser(null);
    }
    closeAccountPopover();
    currentView = "home";
    dedicatedViewReturnTo = "home";
    publicProfileReturnView = "home";
    publicProfileLoadGeneration += 1;
    chatReturnView = "friends";
    $("mainScreen").dataset.currentView = "home";
    $("mainScreen").classList.remove("mobile-chat-active");
    selectedUser = null;
    selectedConversation = null;

    clearMessageSelection();
    friendPresenceStates.clear();
    friendPresenceTrackingIds.clear();
    if (friendPresenceExpiryTimer !== null) {
        clearTimeout(friendPresenceExpiryTimer);
        friendPresenceExpiryTimer = null;
    }
    friendListLoadGeneration += 1;
    friendRequestListLoadGeneration += 1;
    friendPanelView = null;
    friendRequestBlockAllowed = false;
    friendActionStateGeneration += 1;
    friendshipUnavailablePeerId = null;
    friendRequestRelationshipRows.clear();
    friendOpenIntentGeneration += 1;
    setCallButtonsDisabled(true);

    if (typingTimeout) {
        clearTimeout(typingTimeout);
        typingTimeout = null;
    }

    pendingTypingContext = null;
    isTyping = false;

    if (searchTimer) {
        clearTimeout(searchTimer);
        searchTimer = null;
    }

    if (presenceHeartbeat) {
        clearInterval(presenceHeartbeat);
        presenceHeartbeat = null;
    }

    if (startRealtime.presenceCheckInterval) {
        clearInterval(startRealtime.presenceCheckInterval);
        startRealtime.presenceCheckInterval = null;
    }

    lastMessageTime = "";

    hide("mainScreen");
    show("authScreen");
    show("authChoice");
    hide("signupBox");
    hide("loginBox");
    hide("otpBox");
    hide("profileBox");

    hide("profilePanel");
    hide("publicProfilePanel");
    hide("friendRequestsPanel");
    hide("findPeoplePanel");
    hide("settingsPanel");
    hide("privacyPanel");
    hide("chatPanel");
    show("emptyChat");

    $("messages").innerHTML = "";
    $("friendRequestsList").innerHTML =
        "<p>No friend requests yet.</p>";
    $("userResults").innerHTML = "";
    $("searchInput").value = "";
    $("messageInput").value = "";
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    setCallButtonsDisabled(true);
    $("chatUserName").textContent = "";
    $("chatUserStatus").textContent = "";
    $("blockedUserIndicator").classList.add("hidden");
    $("typingIndicator").classList.add("hidden");
    $("profileUsername").textContent = "-";
    $("profileDisplayName").textContent = "-";
    $("profileEmail").textContent = "-";
    $("profileStatus").textContent = "-";
    $("publicProfileMessage").textContent = "";
    $("publicProfileDetails").classList.add("hidden");
    $("publicProfileAvatar").replaceChildren();
    $("publicProfileDisplayName").textContent = "";
    $("publicProfileUsername").textContent = "";
    $("publicProfileRelationship").textContent = "";
    $("publicProfilePresence").textContent = "";

    removeSignupTurnstile();
    removeLoginTurnstile();

    $("signupEmail").value = "";
    $("otpInput").value = "";
    $("usernameInput").value = "";
    $("displayNameInput").value = "";
    $("passwordInput").value = "";
    $("loginIdentifier").value = "";
    $("loginPassword").value = "";

    signedOutCleanupPromise = (async () => {

        const cleanupTasks = [callCleanup];

        if (channel) {
            cleanupTasks.push(
                client.removeChannel(channel).catch(error => {
                    console.error(
                        "Realtime channel removal failed:",
                        error
                    );
                })
            );
        }

        await Promise.allSettled(cleanupTasks);

    })();

    try {
        await signedOutCleanupPromise;
    } finally {
        signedOutCleanupPromise = null;
    }

}

$("logoutBtn").addEventListener(
    "click",
    async () => {

        try {

            if (typeof endCallSessionForLogout === "function") {
                await endCallSessionForLogout();
            }
            
        } catch (error) {

            console.error("Call cleanup before logout failed:", error);

        }


        let signOutError = null;

        try {
            const result =
                await client.auth.signOut();

            signOutError = result.error;
        } catch (error) {
            signOutError = error;
        }

        if (signOutError) {
            console.error(
                "SIGN OUT ERROR:",
                signOutError
            );

            message(
                "Could not log out. Please try again."
            );

            if (currentUser) {
                try {
                    await setOnline();
                    startCallRealtime();
                } catch (error) {
                    console.error(
                        "Could not restore online status:",
                        error
                    );
                }
            }

            return;
        }

        await cleanupSignedOutState();


        message(
            "You have been logged out."
        );

    }
);


// ======================================================
// LOAD CURRENT USER
// ======================================================

// Restores the Supabase session and loads the profile before exposing private UI.
async function loadCurrentUser() {

    const authGeneration = authSessionGeneration;
    const loadGeneration = ++authUserLoadGeneration;
    const requestedUserId = currentUser?.id || null;

    if (
        profileRetryInFlight &&
        profileRetryLoadGeneration !== loadGeneration
    ) {
        profileRetryOperationGeneration += 1;
        profileRetryInFlight = false;
        profileRetryLoadGeneration = null;
        const retryButton = $("retryProfileLoadBtn");
        retryButton.disabled = false;
        retryButton.textContent = "Retry";
    }

    window.TalkSpaceLogger?.debug(
        "Loading current user..."
    );


    const {
        data,
        error
    } =
        await client.auth.getUser();

    if (
        authSessionGeneration !== authGeneration ||
        authUserLoadGeneration !== loadGeneration
    ) {
        return;
    }


    if (
        error ||
        !data ||
        !data.user
    ) {

        clearProfileLoadRetry({ clearMessage: true });

        window.TalkSpaceLogger?.debug(
            "No active session."
        );

        currentUser = null;

        currentProfile = null;


        hide("mainScreen");

        show("authScreen");

        show("authChoice");

        hide("signupBox");

        hide("loginBox");


        return;

    }

    if (
        requestedUserId &&
        data.user.id !== requestedUserId
    ) {
        return;
    }


    currentUser =
        data.user;

    observedAuthIdentityId = data.user.id;


    window.TalkSpaceLogger?.debug("Authenticated user found.");


    const {
        data: profile,
        error: profileError
    } =
        await client
            .from("profiles")
            .select("*")
            .eq(
                "id",
                currentUser.id
            )
            .maybeSingle();

    if (!isCurrentAuthLoad(authGeneration, loadGeneration, data.user.id)) {
        return;
    }


    if (profileError) {

        console.error(
            "PROFILE LOAD ERROR:",
            profileError
        );

        message(
            "Could not load your profile."
        );

        showProfileLoadRetry();

        return;

    }


    if (!profile) {

        clearProfileLoadRetry({ clearMessage: true });

        window.TalkSpaceLogger?.debug(
            "User verified but profile is not completed yet."
        );


        hide("mainScreen");

        show("authScreen");

        hide("authChoice");

        show("signupBox");

        hide("otpBox");

        show("profileBox");


        return;

    }


    currentProfile =
        profile;
    if (typeof setAccountIdentity === "function") setAccountIdentity(currentProfile, currentUser);

    clearProfileLoadRetry({ clearMessage: true });


    window.TalkSpaceLogger?.debug(
        "Complete TalkSpace profile found."
    );


    hide("authScreen");

    show("mainScreen");


    await setOnline();

    if (!isCurrentAuthLoad(authGeneration, loadGeneration, data.user.id)) {
        return;
    }

    if (typeof navigateToView === "function") navigateToView("home");

    if (typeof startCallRealtime === "function") {
        startCallRealtime();
    }

    startPresenceHeartbeat();

    startRealtime();


    clearMessageSelection();
    selectedUser = null;

    selectedConversation = null;

    $("mainScreen").classList.remove("mobile-chat-active");


    hide("chatPanel");

    show("emptyChat");

}


// ======================================================
// SET ONLINE
// ======================================================

// Marks the signed-in user online and starts authenticated presence/Realtime work.
async function setOnline() {

    if (!currentUser) {

        return;

    }


    const {
        error
    } =
        await client
            .from("presence")
            .upsert({

                user_id:
                    currentUser.id,

                is_online:
                    true,

                last_seen:
                    new Date().toISOString()

            });


    if (error) {

        console.error(
            "SET ONLINE ERROR:",
            error
        );

    }


    if ($("onlineStatus")) {

        $("onlineStatus").textContent =
            "Online";

    }

}

// ======================================================
// PRESENCE HEARTBEAT
// ======================================================

function startPresenceHeartbeat() {

    if (presenceHeartbeat) {

        clearInterval(
            presenceHeartbeat
        );

    }


    presenceHeartbeat =
        setInterval(
            async () => {

                if (!currentUser) {

                    return;

                }


                await setOnline();

            },
            20000
        );

}


function isPresenceFresh(presence, now = Date.now()) {
    if (!presence?.is_online || !presence.last_seen) return false;
    const lastSeen = new Date(presence.last_seen).getTime();
    return Number.isFinite(lastSeen) && now - lastSeen < PRESENCE_FRESHNESS_MS;
}


// ======================================================
// SEARCH USERS
// ======================================================

$("searchInput").addEventListener(
    "input",
    () => {

        clearTimeout(searchTimer);


        const value =
            $("searchInput")
                .value
                .trim();


        if (!value) {

            showListFeedback(
                $("userResults"),
                "Find someone on TalkSpace",
                "Search by username to see matching people."
            );

            return;

        }


        searchTimer =
            setTimeout(
                () => {

                    searchUsers(value);

                },
                300
            );

    }
);


// ======================================================
// SEARCH USERS FUNCTION
// ======================================================

// Searches profiles while keeping results scoped to the current query/session.
async function searchUsers(value) {

    if (!currentUser) {

        return;

    }

    const results = $("userResults");
    showListFeedback(results, "Searching…", "Looking for matching usernames.");


    const {
        data,
        error
    } =
        await client
            .from("profiles")
            .select(
                "id, username, display_name, avatar_url"
            )
            .ilike(
                "username",
                `%${value}%`
            )
            .neq(
                "id",
                currentUser.id
            )
            .limit(20);


    if (error) {

        console.error(
            "SEARCH ERROR:",
            error
        );

        showListFeedback(results, "Search unavailable", "Please try again in a moment.");

        return;

    }

    results.innerHTML =
        "";


    if (
        !data ||
        data.length === 0
    ) {

        showListFeedback(results, "No people found", "Try another username.");

        return;

    }


    data.forEach(
        user => {

            const result = document.createElement("div");
            const identity = user.display_name || user.username;
            result.className = "userResult";
            result.innerHTML = `
                <button class="userProfileTrigger" type="button" aria-label="View profile of ${escapeHtml(identity)}">
                    <span class="profileAvatar profileAvatarSmall" aria-hidden="true"></span>
                    <span class="userResultIdentity">
                        <strong>${escapeHtml(identity)}</strong>
                        <span class="personUsername">@${escapeHtml(user.username)}</span>
                    </span>
                    <span class="userProfileAction" aria-hidden="true">Profile</span>
                </button>
                <button class="userResultOpenChat" type="button" aria-label="Open chat with ${escapeHtml(identity)}">Open Chat</button>
            `;
            setProfileAvatar(result.querySelector(".profileAvatar"), user);
            result.querySelector(".userProfileTrigger").addEventListener("click", () => {
                void openPublicProfile(user, "findPeople");
            });
            result.querySelector(".userResultOpenChat").addEventListener("click", () => {
                const perf = startChatOpenPerformance("search result");
                void openUser(user, perf);
            });

            results.appendChild(result);

        }
    );

}


// ======================================================
// OPEN USER
// ======================================================

// Opens a peer only after presence, block, and friendship checks allow private chat.
// PERFORMANCE AUDIT ONLY
async function openUser(
    user,
    perf = startChatOpenPerformance("direct openUser")
) {

    const selectionGeneration =
        ++selectedChatGeneration;
    chatMessageLoadGeneration += 1;
    if (currentView !== "chat") chatReturnView = currentView;
    currentView = "chat";
    $("mainScreen").dataset.currentView = "chat";

    try {
        clearMessageSelection();
        selectedUser = user;
        friendRequestBlockAllowed = false;
        setFriendActionState("checking", "Checking relationship…", true);
        syncSidebarNavigationState();
        friendshipUnavailablePeerId = null;
        ["findPeoplePanel", "profilePanel", "publicProfilePanel", "friendRequestsPanel", "settingsPanel", "privacyPanel"]
            .forEach(id => hide(id));
        $("mainScreen").classList.add("mobile-chat-active");
        const chatBackLabel = chatReturnView === "friends"
            ? "Friends"
            : chatReturnView === "findPeople" ? "Find People" : "Home";
        $("mobileBackToFriendsBtn").textContent = `← ${chatBackLabel}`;
        $("mobileBackToFriendsBtn").setAttribute("aria-label", `Back to ${chatBackLabel.toLowerCase()}`);
        const friendRelationshipPromise = refreshSelectedFriendActionState(
            user.id,
            selectionGeneration
        );

        // Reset the previous conversation before checking the new user's state.
        selectedConversation = null;
        setConversationMessageState("loading", "Checking chat availability…");
        $("messageInput").disabled = true;
        $("sendMessageBtn").disabled = true;
        setCallButtonsDisabled(true);
        updateBlockControls({ unknown: true });

        $("chatUserName").textContent =
            user.display_name || user.username;
        $("chatUserStatus").textContent = "Checking status…";

        show("chatPanel");
        hide("emptyChat");

        markChatOpenMilestone(perf, "chat header ready");
        scheduleChatOpenPaintMilestone(perf, "chat header paint opportunity");

        let stage = startChatOpenStage(
            perf,
            "Presence/status lookup",
            "Supabase/network wait + status update"
        );
        const presenceOnline = await updateSelectedUserStatus(
            perf,
            user.id,
            selectionGeneration
        );
        endChatOpenStage(perf, stage);

        if (!isCurrentChatSelection(user.id, selectionGeneration)) {
            return;
        }

        if (presenceOnline !== true) {
            stage = startChatOpenStage(
                perf,
                "Offline user block-state check",
                "Supabase/network wait (two checks in parallel)"
            );
            const offlineBlockState = await getBlockState(user.id, perf);
            endChatOpenStage(perf, stage);

            if (!isCurrentChatSelection(user.id, selectionGeneration)) {
                return;
            }

            if (offlineBlockState.unknown) {
                friendRequestBlockAllowed = false;
                setFriendActionState("unknown", "Block status unavailable", true);
                updateBlockControls({ unknown: true });
                message("Could not verify block status. Please try again.");
            } else {
                updateBlockControls(offlineBlockState);
                if (offlineBlockState.blockedByMe || offlineBlockState.blockedMe) {
                    friendRequestBlockAllowed = false;
                    setFriendActionState("blocked", "Friend requests unavailable", true);
                } else {
                    friendRequestBlockAllowed = true;
                    const friendship = await friendRelationshipPromise;
                    if (!isCurrentChatSelection(user.id, selectionGeneration)) return;
                    setFriendActionStateFromRelationship(friendship);
                }
            }

            showOfflineChatState();
            markChatOpenMilestone(perf, "offline-chat state rendered");
            return;
        }

        stage = startChatOpenStage(
            perf,
            "Initial block-state check",
            "Supabase/network wait (two checks in parallel)"
        );
        const blockState = await getBlockState(user.id, perf);
        endChatOpenStage(perf, stage);

        if (!isCurrentChatSelection(user.id, selectionGeneration)) {
            return;
        }

        if (blockState.unknown) {
            friendRequestBlockAllowed = false;
            setFriendActionState("unknown", "Block status unavailable", true);
            showBlockStateUnknown();
            message("Could not verify block status. Please try again.");
            return;
        }

        updateBlockControls(blockState);
        if (blockState.blockedByMe || blockState.blockedMe) {
            friendRequestBlockAllowed = false;
            setFriendActionState("blocked", "Friend requests unavailable", true);
            showBlockedChatState(blockState.blockedMe);
            markChatOpenMilestone(perf, "blocked-chat state rendered");
            return;
        }

        friendRequestBlockAllowed = true;
        setCallButtonsDisabled(false);

        const friendship = await friendRelationshipPromise;
        if (!isCurrentChatSelection(user.id, selectionGeneration)) {
            return;
        }

        if (!friendship?.verified) {
            friendRequestBlockAllowed = false;
            setFriendActionState("unknown", "Relationship unavailable", true);
            showFriendRelationshipUnknownState(user.id, selectionGeneration);
            return;
        }

        setFriendActionStateFromRelationship(friendship);

        if (!friendship.isFriend) {
            showFriendshipRequiredState(user.id, selectionGeneration);
            markChatOpenMilestone(perf, "friendship-required state rendered");
            return;
        }

        stage = startChatOpenStage(
            perf,
            "Conversation open/create flow",
            "Supabase/network wait + application checks"
        );
        const opened = await openConversation(
            perf,
            blockState,
            user.id,
            selectionGeneration
        );
        endChatOpenStage(perf, stage);

        if (
            !opened ||
            !isCurrentChatSelection(user.id, selectionGeneration) ||
            $("chatUserStatus").textContent !== "Online"
        ) {
            if (
                !opened &&
                isCurrentChatSelection(user.id, selectionGeneration) &&
                $("messages").dataset.state === "loading"
            ) {
                setConversationMessageState(
                    "error",
                    "Could not open this conversation",
                    "Please try again."
                );
            }
            if (
                isCurrentChatSelection(user.id, selectionGeneration) &&
                $("chatUserStatus").textContent !== "Online"
            ) {
                showOfflineChatState();
                markChatOpenMilestone(perf, "offline-chat state rendered");
            }

            return;
        }

        $("messageInput").disabled = false;
        $("sendMessageBtn").disabled = false;
        setCallButtonsDisabled(false);
        markChatOpenMilestone(perf, "composer usable");

        setConversationMessageState("loading", "Loading conversation…");

        await loadOpenedConversationAndClearUnread(
            perf,
            blockState,
            user.id,
            selectionGeneration
        );

    } finally {
        markChatOpenMilestone(perf, "chat open flow complete");
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                markChatOpenMilestone(perf, "chat visually ready paint opportunity");
                reportChatOpenPerformance(perf);
            });
        });
    }
}


// ======================================================
// CHECK BLOCK
// ======================================================

const BLOCK_CHECK_UNKNOWN = "unknown";

// PERFORMANCE AUDIT ONLY
// Returns verified own-block state or UNKNOWN so failed checks cannot fail open.
async function hasBlockedUser(userId, perf = null) {

    if (!currentUser || !userId) {
        return BLOCK_CHECK_UNKNOWN;
    }

    const authUserId = currentUser.id;
    const stage = startChatOpenStage(
        perf,
        "blocked_users own-block SELECT",
        "Supabase/network wait"
    );
    try {
        const { data, error } = await client
            .from("blocked_users")
            .select("id")
            .eq("blocker_id", authUserId)
            .eq("blocked_id", userId)
            .limit(1);

        if (error) {
            console.error("OWN BLOCK CHECK ERROR:", error);
            return BLOCK_CHECK_UNKNOWN;
        }

        if (!Array.isArray(data) || currentUser?.id !== authUserId) {
            return BLOCK_CHECK_UNKNOWN;
        }

        return data.length > 0;
    } catch (error) {
        console.error("OWN BLOCK CHECK ERROR:", error);
        return BLOCK_CHECK_UNKNOWN;
    } finally {
        endChatOpenStage(perf, stage);
    }
}


// PERFORMANCE AUDIT ONLY
// Combines both block directions into one fail-closed result for chat/call guards.
async function getBlockState(userId, perf = null) {

    const [blockedByMe, blockedMe] = await Promise.all([
        hasBlockedUser(userId, perf),
        hasBlockedMe(userId, perf)
    ]);

    if (
        blockedByMe === BLOCK_CHECK_UNKNOWN ||
        blockedMe === BLOCK_CHECK_UNKNOWN
    ) {
        return {
            blockedByMe: BLOCK_CHECK_UNKNOWN,
            blockedMe: BLOCK_CHECK_UNKNOWN,
            unknown: true
        };
    }

    return { blockedByMe, blockedMe, unknown: false };
}


function updateBlockControls(blockState) {

    const blockButton = $("blockBtn");
    if (blockButton) {
        const unknown = blockState?.unknown === true;
        blockButton.disabled = unknown;
        blockButton.textContent = unknown
            ? "Block status unavailable"
            : blockState.blockedByMe
                ? "Unblock User"
                : "Block User";
    }

    const indicator = $("blockedUserIndicator");
    if (indicator) {
        indicator.classList.toggle(
            "hidden",
            blockState?.unknown === true || !blockState.blockedMe
        );
    }
}


function showBlockStateUnknown() {
    chatMessageLoadGeneration += 1;
    clearMessageSelection();
    selectedConversation = null;
    $("messages").innerHTML =
        '<div class="emptyState"><p>Block status could not be verified. Please try again.</p></div>';
    $("messages").dataset.state = "unavailable";
    $("messages").setAttribute("aria-busy", "false");
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    setCallButtonsDisabled(true);
    $("typingIndicator").classList.add("hidden");
    updateBlockControls({ unknown: true });
}


// Replaces prior chat contents and disables actions when either block direction exists.
function showBlockedChatState(blockedMe) {

    clearMessageSelection();

    selectedConversation = null;
    $("messages").innerHTML = blockedMe
        ? '<div class="emptyState"><p>This conversation is unavailable because this user blocked you.</p></div>'
        : '<div class="emptyState"><p>This conversation is unavailable because you blocked this user.</p></div>';
    $("messages").dataset.state = "unavailable";
    $("messages").setAttribute("aria-busy", "false");
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    setCallButtonsDisabled(true);
    $("typingIndicator").classList.add("hidden");
}


function showFriendshipRequiredState(userId, selectionGeneration) {
    if (!isCurrentChatSelection(userId, selectionGeneration)) {
        return;
    }

    friendshipUnavailablePeerId = userId;
    chatMessageLoadGeneration += 1;
    clearMessageSelection();
    selectedConversation = null;
    $("messages").innerHTML =
        '<div class="emptyState"><p>You must be friends to chat.</p></div>';
    $("messages").dataset.state = "unavailable";
    $("messages").setAttribute("aria-busy", "false");
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    $("typingIndicator").classList.add("hidden");
}


function showFriendRelationshipUnknownState(userId, selectionGeneration) {
    if (!isCurrentChatSelection(userId, selectionGeneration)) {
        return;
    }

    chatMessageLoadGeneration += 1;
    clearMessageSelection();
    selectedConversation = null;
    $("messages").innerHTML =
        '<div class="emptyState"><p>Friend status could not be verified. Please try again.</p></div>';
    $("messages").dataset.state = "unavailable";
    $("messages").setAttribute("aria-busy", "false");
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    $("typingIndicator").classList.add("hidden");
}


// Rechecks block and presence state after block Realtime events without stale UI writes.
async function refreshSelectedUserBlockState(
    knownBlockState = null,
    knownUserId = null
) {

    if (!currentUser || !selectedUser) {
        return;
    }

    const userId = selectedUser.id;
    const authUserId = currentUser.id;
    const selectionGeneration = selectedChatGeneration;

    friendRequestBlockAllowed = false;
    setFriendActionState("checking", "Checking block status…", true);
    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    setCallButtonsDisabled(true);
    updateBlockControls({ unknown: true });

    const blockState =
        knownUserId === userId &&
        knownBlockState &&
        knownBlockState.unknown === false &&
        typeof knownBlockState.blockedByMe === "boolean" &&
        typeof knownBlockState.blockedMe === "boolean"
            ? knownBlockState
            : await getBlockState(userId);

    if (
        currentUser?.id !== authUserId ||
        !isCurrentChatSelection(userId, selectionGeneration)
    ) {
        return;
    }

    if (blockState.unknown) {
        friendRequestBlockAllowed = false;
        setFriendActionState("unknown", "Block status unavailable", true);
        showBlockStateUnknown();
        message("Could not verify block status. Please try again.");
        return;
    }

    updateBlockControls(blockState);

    if (blockState.blockedByMe || blockState.blockedMe) {
        friendRequestBlockAllowed = false;
        setFriendActionState("blocked", "Friend requests unavailable", true);
        if (typeof handleBlockedPeerCall === "function") {
            void handleBlockedPeerCall(userId);
        }
        showBlockedChatState(blockState.blockedMe);
        return;
    }

    friendRequestBlockAllowed = true;
    void refreshSelectedFriendActionState(userId, selectionGeneration);

    const presenceOnline = await updateSelectedUserStatus(
        null,
        userId,
        selectionGeneration
    );

    if (!isCurrentChatSelection(userId, selectionGeneration)) {
        return;
    }

    if (presenceOnline !== true) {
        showOfflineChatState();
        return;
    }

    $("messageInput").disabled = true;
    $("sendMessageBtn").disabled = true;
    selectedConversation = null;

    const opened = await openConversation(
        null,
        null,
        null,
        selectionGeneration
    );
    if (
        opened &&
        isCurrentChatSelection(userId, selectionGeneration) &&
        $("chatUserStatus").textContent === "Online"
    ) {
        $("messageInput").disabled = false;
        $("sendMessageBtn").disabled = false;
        setCallButtonsDisabled(false);
        await loadOpenedConversationAndClearUnread(
            null,
            null,
            null,
            selectionGeneration
        );
    }
}


// Revalidates a block-status broadcast before allowing it to refresh selected UI.
async function handleBlockStatusBroadcast(payload, channel) {
    const event = payload?.payload;
    const eventUserId = currentUser?.id;
    const selectedPeerId = selectedUser?.id;
    const blockerId = event?.blocker_id;
    const blockedId = event?.target_user_id;
    const action = event?.action;
    const matchesSelectedPair = Boolean(
        eventUserId &&
        selectedPeerId &&
        blockerId &&
        blockedId &&
        blockerId !== blockedId &&
        [blockerId, blockedId].includes(eventUserId) &&
        [blockerId, blockedId].includes(selectedPeerId) &&
        ["blocked", "unblocked"].includes(action) &&
        channel === realtimeChannel
    );

    window.TalkSpaceLogger?.debug("Block-status broadcast received.", {
        action,
        matchesSelectedPeer: matchesSelectedPair
    });

    if (!matchesSelectedPair) {
        return false;
    }

    const selectionGeneration = selectedChatGeneration;
    const verifiedBlockState = await getBlockState(selectedPeerId);
    if (
        currentUser?.id !== eventUserId ||
        selectedUser?.id !== selectedPeerId ||
        !isCurrentChatSelection(selectedPeerId, selectionGeneration) ||
        realtimeChannel !== channel
    ) {
        return false;
    }

    window.TalkSpaceLogger?.debug("Refreshing selected chat after block-status broadcast.", {
        action
    });
    await refreshSelectedUserBlockState(verifiedBlockState, selectedPeerId);
    return true;
}


// Provides call/message guards with a verified blocked, unblocked, or unknown result.
async function isBlocked(userId) {

    if (!currentUser || !userId) {
        return BLOCK_CHECK_UNKNOWN;
    }

    const authUserId = currentUser.id;
    const blockState = await getBlockState(userId);
    if (currentUser?.id !== authUserId || blockState.unknown) {
        return BLOCK_CHECK_UNKNOWN;
    }

    return blockState.blockedByMe || blockState.blockedMe;
}

// ======================================================
// CHECK IF SELECTED USER HAS BLOCKED ME
// ======================================================
// PERFORMANCE AUDIT ONLY
// Uses the existing RPC to detect the selected peer's block of the current user.
async function hasBlockedMe(
    userId,
    perf = null
) {

    if (
        !currentUser ||
        !userId
    ) {

        return BLOCK_CHECK_UNKNOWN;

    }

    const authUserId = currentUser.id;

    const stage = startChatOpenStage(
        perf,
        "has_user_blocked_me RPC",
        "Supabase/network wait"
    );
    try {
        const { data, error } = await client
            .rpc(
                "has_user_blocked_me",
                {
                    target_user_id:
                        userId
                }
            );

        if (error) {
            console.error(
                "BLOCKED-ME RPC ERROR:",
                error
            );
            return BLOCK_CHECK_UNKNOWN;
        }

        if (typeof data !== "boolean" || currentUser?.id !== authUserId) {
            return BLOCK_CHECK_UNKNOWN;
        }

        return data;
    } catch (error) {
        console.error(
            "BLOCKED-ME RPC ERROR:",
            error
        );
        return BLOCK_CHECK_UNKNOWN;
    } finally {
        endChatOpenStage(perf, stage);
    }

}

// ======================================================
// SEND FRIEND REQUEST
// ======================================================

const friendRequestButton = $("friendRequestBtn");

function setFriendActionState(action, label, disabled = false) {
    if (!friendRequestButton) {
        return;
    }

    friendRequestButton.dataset.action = action;
    const labelElement = friendRequestButton.querySelector(".friendRequestButtonLabel");
    if (labelElement) labelElement.textContent = label;
    friendRequestButton.setAttribute("aria-label", label);
    friendRequestButton.title = label;
    friendRequestButton.disabled = disabled;
    const unavailable = ["unavailable", "unknown", "blocked"].includes(action);
    friendRequestButton.classList.toggle("hidden", !friendRequestBlockAllowed || unavailable);

    const managementActions = $("chatManagementActions");
    const toolbar = $("callBtn")?.parentElement;
    if (action === "remove" && managementActions) {
        managementActions.prepend(friendRequestButton);
    } else if (toolbar) {
        toolbar.insertBefore(friendRequestButton, $("callBtn"));
    }
}

function setFriendActionStateFromRelationship(relationship) {
    if (!friendRequestBlockAllowed) return;
    if (!relationship?.verified) {
        setFriendActionState("unknown", "Relationship unavailable", true);
    } else if (relationship.isFriend) {
        setFriendActionState("remove", "Remove Friend");
    } else if (relationship.incomingPending) {
        setFriendActionState("pending-incoming", "Request Received", true);
    } else if (relationship.outgoingPending) {
        setFriendActionState("pending-outgoing", "Friend Request Sent", true);
    } else {
        setFriendActionState("send", "Send Friend Request");
    }
}


// Classifies both directional request rows and marks the result unverified on errors.
async function getFriendRelationshipState(userId, authUserId = currentUser?.id) {
    if (!authUserId || !userId || authUserId === userId) {
        return {
            verified: false,
            error: new Error("A valid signed-in user and friend are required.")
        };
    }

    try {
        const { data, error } = await client
            .from("friend_requests")
            .select("id, sender_id, receiver_id, status")
            .or(
                `and(sender_id.eq.${authUserId},receiver_id.eq.${userId}),and(sender_id.eq.${userId},receiver_id.eq.${authUserId})`
            );

        if (
            currentUser?.id !== authUserId ||
            error ||
            !Array.isArray(data)
        ) {
            if (error) {
                console.error("FRIEND RELATIONSHIP CHECK ERROR:", error);
            }
            return {
                verified: false,
                error: error || new Error("The relationship response was invalid.")
            };
        }

        const rows = data.filter(row =>
            (
                row.sender_id === authUserId &&
                row.receiver_id === userId
            ) || (
                row.sender_id === userId &&
                row.receiver_id === authUserId
            )
        );

        rows.forEach(row => {
            friendRequestRelationshipRows.set(row.id, row);
        });

        const relationship = FriendRequestLifecycle.classifyRows(
            rows,
            authUserId,
            userId
        );

        return {
            verified: true,
            ...relationship
        };
    } catch (error) {
        console.error("FRIEND RELATIONSHIP CHECK ERROR:", error);
        return { verified: false, error };
    }
}

function describeFriendRequestError(error, fallback) {
    const detail = error?.message || error?.details || error?.hint;
    const code = error?.code ? ` (${error.code})` : "";
    return detail ? `${fallback}: ${detail}${code}` : fallback;
}


// Refreshes request/action controls only while the same peer and UI generation remain selected.
async function refreshSelectedFriendActionState(
    userId = selectedUser?.id,
    selectionGeneration = selectedChatGeneration
) {
    const authUserId = currentUser?.id;
    const actionGeneration = ++friendActionStateGeneration;

    if (!authUserId || !userId || userId === authUserId) {
        setFriendActionState("unavailable", "Friend action unavailable", true);
        return { verified: false };
    }

    setFriendActionState("checking", "Checking relationship…", true);
    const relationship = await getFriendRelationshipState(userId, authUserId);

    if (
        currentUser?.id !== authUserId ||
        !isCurrentChatSelection(userId, selectionGeneration)
    ) {
        return null;
    }

    if (friendActionStateGeneration !== actionGeneration) {
        return relationship;
    }

    if (!relationship.verified) {
        setFriendActionState("unknown", "Relationship unavailable", true);
        return relationship;
    }

    setFriendActionStateFromRelationship(relationship);

    return relationship;
}

// Applies the selected friend action only after refreshing and validating its relationship state.
if (friendRequestButton) {

    friendRequestButton.addEventListener(
        "click",
        async () => {

            if (!currentUser || !selectedUser) {
                message("Please select a user first.");
                return;
            }

            if (friendRequestButton.disabled) {
                return;
            }

            const authUserId = currentUser.id;
            const userId = selectedUser.id;
            const selectionGeneration = selectedChatGeneration;
            const requestedAction = friendRequestButton.dataset.action;
            const selectionIsCurrent = () => FriendRequestLifecycle.isCurrentSelection({
                currentUserId: currentUser?.id,
                expectedUserId: authUserId,
                selectedPeerId: selectedUser?.id,
                expectedPeerId: userId,
                currentGeneration: selectedChatGeneration,
                expectedGeneration: selectionGeneration
            });

            // Optional friend-request diagnostics are gated by talkspaceDebug.
            window.TalkSpaceLogger?.debug("Friend request action requested.", {
                action: requestedAction
            });

            if (userId === authUserId) {
                return;
            }

            setFriendActionState("checking", "Checking relationship…", true);

            const relationship = await getFriendRelationshipState(
                userId,
                authUserId
            );

            const blockState = await getBlockState(userId);

            window.TalkSpaceLogger?.debug("Friend request relationship checked.", {
                verified: relationship?.verified === true,
                statuses: Array.isArray(relationship?.rows)
                    ? relationship.rows.map(row => row.status)
                    : [],
                error: relationship?.error
                    ? {
                        code: relationship.error.code
                    }
                    : null
            });

            if (!selectionIsCurrent()) {
                return;
            }

            if (blockState.unknown || blockState.blockedByMe || blockState.blockedMe) {
                friendRequestBlockAllowed = false;
                setFriendActionState(
                    blockState.unknown ? "unknown" : "blocked",
                    blockState.unknown ? "Block status unavailable" : "Friend requests unavailable",
                    true
                );
                message(blockState.unknown
                    ? "Could not verify block status. Please try again."
                    : "Friend requests are unavailable for this user.");
                return;
            }

            friendRequestBlockAllowed = true;

            if (!relationship.verified) {
                setFriendActionState(
                    "unknown",
                    "Relationship unavailable",
                    true
                );

                message(
                    describeFriendRequestError(
                        relationship?.error,
                        "Could not check friend request"
                    )
                );

                return;
            }

            if (requestedAction === "remove") {
                const acceptedRows = relationship.rows.filter(
                    request => request.status === "accepted"
                );

                if (!acceptedRows.length) {
                    await refreshSelectedFriendActionState(
                        userId,
                        selectionGeneration
                    );
                    if (selectionIsCurrent()) {
                        message("This user is no longer your friend.");
                    }
                    return;
                }

                if (!window.confirm("Remove this friend?")) {
                    await refreshSelectedFriendActionState(
                        userId,
                        selectionGeneration
                    );
                    return;
                }

                if (!selectionIsCurrent()) {
                    return;
                }

                setFriendActionState("removing", "Removing Friend…", true);
                const removeResult = await FriendRequestLifecycle.removeAcceptedRelationship(
                    client,
                    authUserId,
                    userId,
                    acceptedRows[0].id
                );

                if (!selectionIsCurrent()) {
                    return;
                }

                if (
                    !removeResult.ok
                ) {
                    await refreshSelectedFriendActionState(
                        userId,
                        selectionGeneration
                    );
                    if (!selectionIsCurrent()) {
                        return;
                    }
                    console.error("REMOVE FRIEND ERROR:", removeResult.error);
                    message(
                        describeFriendRequestError(
                            removeResult.error,
                            "Could not remove friend"
                        )
                    );
                    return;
                }

                removeResult.rows.forEach(row => {
                    friendRequestRelationshipRows.delete(row.id);
                });

                showFriendshipRequiredState(
                    userId,
                    selectionGeneration
                );
                setFriendActionState("send", "Send Friend Request");

                await refreshSelectedFriendActionState(
                    userId,
                    selectionGeneration
                );

                if (selectionIsCurrent()) {
                    message("Friend removed.");
                }

                return;
            }

            if (relationship.isFriend) {
                await refreshSelectedFriendActionState(
                    userId,
                    selectionGeneration
                );
                if (selectionIsCurrent()) {
                    message("You are already friends.");
                }
                return;
            }

            if (
                relationship.incomingPending ||
                relationship.outgoingPending
            ) {
                await refreshSelectedFriendActionState(
                    userId,
                    selectionGeneration
                );
                if (selectionIsCurrent()) {
                    message("A friend request already exists.");
                }
                return;
            }

            setFriendActionState("sending", "Sending Request…", true);

            const rejectedRequest = relationship.outgoingRejected;
            const requestOperation = rejectedRequest ? "reactivate" : "insert";

            window.TalkSpaceLogger?.debug("Friend request write started.", {
                operation: requestOperation
            });

            const writeResult = await FriendRequestLifecycle.createOrReuseRequest(
                client,
                authUserId,
                userId,
                relationship.rows
            );

            window.TalkSpaceLogger?.debug("Friend request write completed.", {
                operation: requestOperation,
                outcome: writeResult.outcome,
                succeeded: writeResult.ok,
                latestStatuses: writeResult.latestRows?.map(row => row.status) || null,
                refresh_error: writeResult.refreshError
                    ? {
                        code: writeResult.refreshError.code
                    }
                    : null,
                error: writeResult.error
                    ? {
                        code: writeResult.error.code
                    }
                    : null
            });

            if (!selectionIsCurrent()) {
                return;
            }

            if (!writeResult.ok) {

                if (writeResult.latestRows) {
                    writeResult.latestRows.forEach(row => {
                        friendRequestRelationshipRows.set(row.id, row);
                    });
                }

                await refreshSelectedFriendActionState(
                    userId,
                    selectionGeneration
                );
                if (!selectionIsCurrent()) {
                    return;
                }

                console.error(
                    "FRIEND REQUEST WRITE ERROR:",
                    writeResult.error
                );

                if (writeResult.outcome === "already-pending") {
                    message("A friend request already exists.");
                    return;
                }

                if (writeResult.outcome === "already-friends") {
                    message("You are already friends.");
                    return;
                }

                if (writeResult.outcome === "zero-rows") {
                    const latest = writeResult.latestRelationship;

                    if (latest?.outgoingPending) {
                        message("This friend request is already pending.");
                        return;
                    }

                    if (latest?.incomingPending) {
                        message("This user has already sent you a friend request.");
                        return;
                    }

                    if (latest?.isFriend) {
                        message("You are already friends.");
                        return;
                    }

                    message(
                        describeFriendRequestError(
                            writeResult.refreshError || writeResult.error,
                            "The request row changed before it could be reactivated"
                        )
                    );
                    return;
                }

                message(
                    describeFriendRequestError(
                        writeResult.error,
                        "Could not send friend request"
                    )
                );

                return;
            }

            if (writeResult.requestId) {
                friendRequestRelationshipRows.set(writeResult.requestId, {
                    ...rejectedRequest,
                    status: "pending"
                });
            }

            setFriendActionState(
                "pending-outgoing",
                "Request Sent",
                true
            );

            await refreshSelectedFriendActionState(
                userId,
                selectionGeneration
            );

            if (!selectionIsCurrent()) {
                return;
            }

            message(
                "Friend request sent."
            );

            window.TalkSpaceLogger?.debug(
                "FRIEND REQUEST SENT SUCCESSFULLY"
            );
        }
    );

}


// ======================================================
// BLOCK USER
// ======================================================

// Notify the other signed-in session to recheck privacy state after a block change.
async function broadcastBlockStatus(targetUserId, action) {
    if (
        !currentUser?.id ||
        !targetUserId ||
        !["blocked", "unblocked"].includes(action) ||
        !realtimeChannel
    ) {
        return false;
    }

    try {
        const { error } = await realtimeChannel.send({
            type: "broadcast",
            event: "block-status",
            payload: {
                blocker_id: currentUser.id,
                target_user_id: targetUserId,
                action
            }
        });
        if (error) {
            console.error("BLOCK STATUS BROADCAST ERROR:", error);
            return false;
        }
        return true;
    } catch (error) {
        console.error("BLOCK STATUS BROADCAST ERROR:", error);
        return false;
    }
}


$("blockBtn").addEventListener(
    "click",
    async () => {

        if (
            !currentUser ||
            !selectedUser
        ) {
            return;
        }

        const authUserId = currentUser.id;
        const userId = selectedUser.id;
        const selectionGeneration = selectedChatGeneration;
        const blockedByMe =
            await hasBlockedUser(userId);

        if (
            currentUser?.id !== authUserId ||
            !isCurrentChatSelection(userId, selectionGeneration)
        ) {
            return;
        }

        if (blockedByMe === BLOCK_CHECK_UNKNOWN) {
            updateBlockControls({ unknown: true });
            message("Could not verify block status. Please try again.");
            return;
        }


        // ------------------------------------------
        // UNBLOCK USER
        // ------------------------------------------

        if (blockedByMe === true) {

            const {
                error
            } =
            await client
                .from("blocked_users")
                .delete()
                .eq(
                    "blocker_id",
                    authUserId
                )
                .eq(
                    "blocked_id",
                    userId
                );

            if (currentUser?.id !== authUserId) {
                return;
            }

            if (error) {

                console.error(
                    "UNBLOCK ERROR:",
                    error
                );

                message(
                    "Could not unblock user."
                );

                return;
            }

            await broadcastBlockStatus(userId, "unblocked");

            if (!isCurrentChatSelection(userId, selectionGeneration)) {
                return;
            }

            await refreshSelectedUserBlockState();

            message(
                "User unblocked."
            );

            return;
        }


        // ------------------------------------------
        // BLOCK USER
        // ------------------------------------------

        const {
            error
        } =
        await client
            .from("blocked_users")
            .insert({

                blocker_id:
                    authUserId,

                blocked_id:
                    userId

            });

        if (currentUser?.id !== authUserId) {
            return;
        }

        if (error) {

            console.error(
                "BLOCK ERROR:",
                error
            );

            message(
                "Could not block user."
            );

            return;
        }

        await broadcastBlockStatus(userId, "blocked");

        if (!isCurrentChatSelection(userId, selectionGeneration)) {
            return;
        }

        await refreshSelectedUserBlockState();


        message(
            "User blocked."
        );

    }
);


// ======================================================
// OPEN / CREATE CONVERSATION
// ======================================================

// Finds or creates the peer conversation only after the caller's privacy checks pass.
// PERFORMANCE AUDIT ONLY
async function openConversation(
    perf = null,
    knownBlockState = null,
    knownUserId = null,
    selectionGeneration = selectedChatGeneration
) {
    const totalStage = startChatOpenStage(
        perf,
        "openConversation total",
        "Total stage duration"
    );

    try {
    if (
        !currentUser ||
        !selectedUser ||
        !isCurrentChatSelection(selectedUser.id, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    if (
        messageSelectionUserId &&
        messageSelectionUserId !== selectedUser.id
    ) {
        clearMessageSelection();
    }

    const userA = currentUser.id;
    const userB = selectedUser.id;

    // Never leave the previous conversation attached while checking access.
    selectedConversation = null;

    let stage;
    let blockState;

    if (
        knownBlockState &&
        knownUserId === userB
    ) {
        stage = startChatOpenStage(
            perf,
            "Reuse openUser block state",
            "JavaScript/local state"
        );
        blockState = knownBlockState;
        endChatOpenStage(perf, stage);
    } else {
        stage = startChatOpenStage(
            perf,
            "Conversation block-state recheck",
            "Supabase/network wait (two checks in parallel)"
        );
        blockState = await getBlockState(userB, perf);
        endChatOpenStage(perf, stage);
    }
    if (
        !isCurrentChatSelection(userB, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    if (blockState.unknown) {
        showBlockStateUnknown();
        message("Could not verify block status. Please try again.");
        return false;
    }

    updateBlockControls(blockState);
    if (blockState.blockedByMe || blockState.blockedMe) {
        showBlockedChatState(blockState.blockedMe);
        return false;
    }

    stage = startChatOpenStage(
        perf,
        "Conversation lookup SELECT",
        "Supabase/network wait"
    );
    const { data, error } = await client
        .from("conversations")
        .select("*")
        .or(
            `and(user_one.eq.${userA},user_two.eq.${userB}),and(user_one.eq.${userB},user_two.eq.${userA})`
        )
        .limit(1);
    endChatOpenStage(perf, stage);

    if (error) {
        console.error("CONVERSATION SEARCH ERROR:", error);
        return false;
    }

    if (
        !isCurrentChatSelection(userB, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    const friendship = await getFriendRelationshipState(userB, userA);
    if (
        !isCurrentChatSelection(userB, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    if (!friendship.verified) {
        showFriendRelationshipUnknownState(userB, selectionGeneration);
        return false;
    }

    if (!friendship.isFriend) {
        showFriendshipRequiredState(userB, selectionGeneration);
        return false;
    }

    if (data && data.length > 0) {
        selectedConversation = data[0];
        return true;
    }

    // The selected user may have blocked either side while the conversation
    // lookup was in flight. Recheck before creating a new conversation.
    stage = startChatOpenStage(
        perf,
        "Pre-create block-state recheck",
        "Supabase/network wait (two checks in parallel)"
    );
    const latestBlockState = await getBlockState(userB, perf);
    endChatOpenStage(perf, stage);
    if (
        !isCurrentChatSelection(userB, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    if (latestBlockState.unknown) {
        showBlockStateUnknown();
        message("Could not verify block status. Please try again.");
        return false;
    }

    updateBlockControls(latestBlockState);
    if (latestBlockState.blockedByMe || latestBlockState.blockedMe) {
        showBlockedChatState(latestBlockState.blockedMe);
        return false;
    }

    const latestFriendship = await getFriendRelationshipState(userB, userA);
    if (
        !isCurrentChatSelection(userB, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    if (!latestFriendship.verified) {
        showFriendRelationshipUnknownState(userB, selectionGeneration);
        return false;
    }

    if (!latestFriendship.isFriend) {
        showFriendshipRequiredState(userB, selectionGeneration);
        return false;
    }

    stage = startChatOpenStage(
        perf,
        "Conversation creation INSERT",
        "Supabase/network wait"
    );
    const { data: newConversation, error: createError } = await client
        .from("conversations")
        .insert({
            user_one: userA,
            user_two: userB
        })
        .select()
        .single();
    endChatOpenStage(perf, stage);

    if (createError) {
        console.error("CREATE CONVERSATION ERROR:", createError);
        return false;
    }

    if (
        !isCurrentChatSelection(userB, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    selectedConversation = newConversation;
    return true;
    } finally {
        endChatOpenStage(perf, totalStage);
    }
}

// ======================================================
// MARK MESSAGE AS DELIVERED
// ======================================================

// Writes delivery state for eligible incoming messages before seen-state processing.
// PERFORMANCE AUDIT ONLY
async function markMessagesAsDelivered(
messages,
perf = null,
knownBlockState = null,
knownUserId = null
) {

const deliveryStage = startChatOpenStage(
    perf,
    "markMessagesAsDelivered total",
    "Total stage duration"
);

try {


if (
    !currentUser ||
    !messages ||
    !messages.length
) {
    return;
}


// ------------------------------------------
// ONLY CHECK MESSAGES FROM OTHER USERS
// ------------------------------------------

const incomingMessages =
    messages.filter(
        msg =>
            msg.sender_id !==
            currentUser.id
    );
addChatOpenTotal(
    perf,
    "incoming messages checked for delivery",
    0,
    incomingMessages.length
);


if (
    !incomingMessages.length
) {
    return;
}


// ------------------------------------------
// REMOVE MESSAGES FROM BLOCKED USERS
// ------------------------------------------

const messagesToDeliver = [];
const knownPeerMatchesConversation =
    knownBlockState &&
    knownUserId &&
    selectedUser?.id === knownUserId &&
    selectedConversation &&
    [selectedConversation.user_one, selectedConversation.user_two].includes(knownUserId) &&
    [selectedConversation.user_one, selectedConversation.user_two].includes(currentUser.id) &&
    incomingMessages.every(msg => msg.sender_id === knownUserId) &&
    typeof knownBlockState.blockedByMe === "boolean" &&
    typeof knownBlockState.blockedMe === "boolean";

if (knownPeerMatchesConversation) {
    addChatOpenTotal(
        perf,
        "isBlocked() checks during delivery (count and total ms)",
        0,
        0
    );
    addChatOpenTotal(
        perf,
        "incoming messages using known conversation block state",
        0,
        incomingMessages.length
    );
}


for (
    const msg
    of incomingMessages
) {

    let blocked;

    if (knownPeerMatchesConversation) {
        blocked =
            knownBlockState.blockedByMe ||
            knownBlockState.blockedMe;
    } else {
        const blockCheckStartedAt =
            perf ? performance.now() : null;
        blocked =
            await isBlocked(
                msg.sender_id
            );
        if (perf) {
        addChatOpenTotal(
            perf,
            "isBlocked() checks during delivery (count and total ms)",
            performance.now() - blockCheckStartedAt
        );
        }
    }


    if (blocked === false) {

        messagesToDeliver.push(
            msg
        );

    } else if (blocked === BLOCK_CHECK_UNKNOWN) {
        console.error(
            "Skipping delivery update because block status could not be verified."
        );

    }

}


if (
    !messagesToDeliver.length
) {
    return;
}


const messageIds =
    messagesToDeliver.map(
        msg => msg.id
    );


// ------------------------------------------
// GET EXISTING STATUS IN ONE REQUEST
// ------------------------------------------

const statusReadStage = startChatOpenStage(
    perf,
    "Delivery message_status SELECT",
    "Supabase/network wait"
);
const {
    data: existingStatuses,
    error: statusError
} =
    await client
        .from("message_status")
        .select(
            "message_id, delivered_at"
        )
        .in(
            "message_id",
            messageIds
        );
endChatOpenStage(perf, statusReadStage);
addChatOpenTotal(
    perf,
    "message_status reads during delivery (count and total ms)",
    statusReadStage ? performance.now() - statusReadStage.startedAt : 0
);


if (statusError) {

    console.error(
        "DELIVERY STATUS READ ERROR:",
        statusError
    );

    return;

}


const deliveredMap =
    {};


(
    existingStatuses || []
).forEach(
    status => {

        deliveredMap[
            status.message_id
        ] = status;

    }
);


// ------------------------------------------
// ONLY MARK UNDELIVERED MESSAGES
// ------------------------------------------

const messagesToUpdate =
    messagesToDeliver.filter(
        msg => {

            const status =
                deliveredMap[
                    msg.id
                ];

            return !(
                status &&
                status.delivered_at
            );

        }
    );


if (
    !messagesToUpdate.length
) {
    return;
}


const deliveredAt =
    new Date().toISOString();


const rows =
    messagesToUpdate.map(
        msg => ({

            message_id:
                msg.id,

            delivered_at:
                deliveredAt

        })
    );
addChatOpenTotal(
    perf,
    "message_status rows upserted for delivery",
    0,
    rows.length
);


const statusWriteStage = startChatOpenStage(
    perf,
    "Delivery message_status UPSERT",
    "Supabase/network wait"
);
const {
    error
} =
    await client
        .from("message_status")
        .upsert(
            rows,
            {
                onConflict:
                    "message_id"
            }
        );
endChatOpenStage(perf, statusWriteStage);
addChatOpenTotal(
    perf,
    "message_status writes during delivery (count and total ms)",
    statusWriteStage ? performance.now() - statusWriteStage.startedAt : 0
);


if (error) {

    console.error(
        "MARK DELIVERED ERROR:",
        error
    );

}

} finally {
    endChatOpenStage(perf, deliveryStage);
}

}


// ======================================================
// MARK MESSAGE AS SEEN
// ======================================================

// Marks eligible messages seen and preserves the database trigger's unread decrement flow.
// PERFORMANCE AUDIT ONLY
async function markMessagesAsSeen(
    messages,
    perf = null
) {

    const seenStage = startChatOpenStage(
        perf,
        "markMessagesAsSeen total",
        "Total stage duration"
    );

    try {

    if (
        !currentUser ||
        !messages ||
        !messages.length
    ) {
        return true;
    }


    const messagesToSee =
        messages.filter(
            msg =>
                msg.sender_id !==
                currentUser.id
        );


    if (
        !messagesToSee.length
    ) {
        return true;
    }


    const messageIds =
        messagesToSee.map(
            msg => msg.id
        );


    // ------------------------------------------
    // GET EXISTING STATUS IN ONE REQUEST
    // ------------------------------------------

    const statusReadStage = startChatOpenStage(
        perf,
        "Seen message_status SELECT",
        "Supabase/network wait"
    );
    const {
        data: existingStatuses,
        error: statusError
    } =
        await client
            .from("message_status")
            .select(
                "message_id, delivered_at, seen_at"
            )
            .in(
                "message_id",
                messageIds
            );
    endChatOpenStage(perf, statusReadStage);
    addChatOpenTotal(
        perf,
        "message_status reads during seen handling (count and total ms)",
        statusReadStage ? performance.now() - statusReadStage.startedAt : 0
    );


    if (statusError) {

        console.error(
            "SEEN STATUS READ ERROR:",
            statusError
        );

        return false;

    }


    const statusMap =
        {};

    (
        existingStatuses || []
    ).forEach(
        status => {

            statusMap[
                status.message_id
            ] = status;

        }
    );


    // ------------------------------------------
    // ONLY MARK UNSEEN MESSAGES
    // ------------------------------------------

    const messagesToUpdate =
        messagesToSee.filter(
            msg => {

                const status =
                    statusMap[
                        msg.id
                    ];

                return !(
                    status &&
                    status.seen_at
                );

            }
        );


    if (
        !messagesToUpdate.length
    ) {
        return true;
    }


    const now =
        new Date().toISOString();


    const rows =
        messagesToUpdate.map(
            msg => {

                const status =
                    statusMap[
                        msg.id
                    ];

                return {

                    message_id:
                        msg.id,

                    delivered_at:
                        status?.delivered_at ||
                        now,

                    seen_at:
                        now

                };

            }
        );
    addChatOpenTotal(
        perf,
        "message_status rows upserted for seen",
        0,
        rows.length
    );


    const statusWriteStage = startChatOpenStage(
        perf,
        "Seen message_status UPSERT",
        "Supabase/network wait"
    );
    const {
        error
    } =
        await client
            .from("message_status")
            .upsert(
                rows,
                {
                    onConflict:
                        "message_id"
                }
            );
    endChatOpenStage(perf, statusWriteStage);
    addChatOpenTotal(
        perf,
        "message_status writes during seen handling (count and total ms)",
        statusWriteStage ? performance.now() - statusWriteStage.startedAt : 0
    );


    if (error) {

        console.error(
            "MARK SEEN ERROR:",
            error
        );

        return false;

    }

    return true;

    } finally {
        endChatOpenStage(perf, seenStage);
    }

}

// Soft-deletes a message for everyone after validating its sender and current chat context.
async function deleteMessageForEveryone(
    messageId
) {

    if (
        !currentUser ||
        !messageId
    ) {

        return;

    }

    const {
        error
    } =
        await client
            .from("messages")
            .update({
                deleted_at:
                    new Date()
                        .toISOString()
            })
            .eq(
                "id",
                messageId
            )
            .eq(
                "sender_id",
                currentUser.id
            );

    if (error) {

        console.error(
            "DELETE MESSAGE ERROR:",
            error
        );

        message(
            "Could not delete the message."
        );

        return;

    }

    await loadMessages();

}

// Hides selected messages for this user while guarding against stale chat selections.
async function deleteMessageForMe(
    messageId
) {

    if (
        !currentUser ||
        !messageId
    ) {

        return;

    }

    const {
        error
    } =
        await client
            .from("message_deleted_for")
            .insert({
                message_id:
                    messageId,

                user_id:
                    currentUser.id
            });

    if (error) {

        console.error(
            "DELETE MESSAGE FOR ME ERROR:",
            error
        );

        message(
            "Could not delete the message."
        );

        return;

    }

    await loadMessages();

}


document.addEventListener(
    "click",
    async event => {

        if (
            !event.target.classList.contains(
                "deleteMessageBtn"
            )
        ) {

            return;

        }

        const messageId =
            event.target.dataset.messageId;

        if (!messageId) {

            return;

        }

        const confirmed =
            confirm(
                "Delete this message for everyone?"
            );

        if (!confirmed) {

            return;

        }

        await deleteMessageForEveryone(
            messageId
        );

    }
);
document.addEventListener(
    "click",
    async event => {

        if (
            !event.target.classList.contains(
                "deleteMessageForMeBtn"
            )
        ) {

            return;

        }


        const messageId =
            event.target.dataset.messageId;


        if (!messageId) {

            return;

        }


        const confirmed =
            confirm(
                "Delete this message for you?"
            );


        if (!confirmed) {

            return;

        }


        await deleteMessageForMe(
            messageId
        );

    }
);


// Clears the selected user's unread row through the existing trigger-compatible UI flow.
// PERFORMANCE AUDIT ONLY
async function clearUnreadCount(
    conversationId,
    perf = null
) {

    if (
        !currentUser ||
        !conversationId
    ) {

        return;

    }


    const stage = startChatOpenStage(
        perf,
        "conversation_unread clear UPSERT",
        "Supabase/network wait"
    );
    const {
        error
    } =
        await client
            .from("conversation_unread")
            .upsert(
                {
                    conversation_id:
                        conversationId,

                    user_id:
                        currentUser.id,

                    unread_count:
                        0,

                    updated_at:
                        new Date()
                            .toISOString()
                },
                {
                    onConflict:
                        "conversation_id,user_id"
                }
            );
    endChatOpenStage(perf, stage);
    markChatOpenMilestone(perf, "unread clear complete");


    if (error) {

        console.error(
            "CLEAR UNREAD COUNT ERROR:",
            error
        );

    }

}

// Broadcasts typing state to the captured conversation peer, including its delayed stop event.
function sendTypingStatus(
    context = null,
    isTypingNow = true
) {
    const typingContext = context || (
        currentUser &&
        selectedConversation &&
        selectedUser &&
        realtimeChannel
            ? {
                userId: currentUser.id,
                conversationId: selectedConversation.id,
                channel: realtimeChannel
            }
            : null
    );

    if (!typingContext?.userId || !typingContext?.conversationId || !typingContext?.channel) {
        return;
    }

    return typingContext.channel.send({
        type: "broadcast",
        event: "typing",
        payload: {
            conversation_id:
                typingContext.conversationId,

            user_id:
                typingContext.userId,

            typing: isTypingNow
        }
    });

}

function showTypingIndicator(
    isTypingNow
) {

    const indicator =
        $("typingIndicator");

    if (!indicator) {
        return;
    }

    if (
        isTypingNow
    ) {

        indicator.textContent =
            "Typing...";

        indicator.classList.remove(
            "hidden"
        );

    } else {

        indicator.classList.add(
            "hidden"
        );

    }

}

function formatLastSeen(
    lastSeen
) {

    if (!lastSeen) {

        return "Offline";

    }

    const date =
        new Date(lastSeen);

    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return "Offline";

    }

    const now =
        new Date();

    const difference =
        now.getTime() -
        date.getTime();

    const seconds =
        Math.floor(
            difference / 1000
        );

    if (
        seconds < 60
    ) {

        return "Last seen just now";

    }

    const minutes =
        Math.floor(
            seconds / 60
        );

    if (
        minutes < 60
    ) {

        return (
            "Last seen " +
            minutes +
            (
                minutes === 1
                    ? " minute ago"
                    : " minutes ago"
            )
        );

    }

    const hours =
        Math.floor(
            minutes / 60
        );

    if (
        hours < 24
    ) {

        return (
            "Last seen " +
            hours +
            (
                hours === 1
                    ? " hour ago"
                    : " hours ago"
            )
        );

    }

    const days =
        Math.floor(
            hours / 24
        );

    if (
        days < 7
    ) {

        return (
            "Last seen " +
            days +
            (
                days === 1
                    ? " day ago"
                    : " days ago"
            )
        );

    }

    return (
        "Last seen " +
        date.toLocaleDateString(
            [],
            {
                day: "numeric",
                month: "short"
            }
        )
    );

}

// Reads a peer's online/last-seen state used by chat privacy and call availability.
async function getUserPresence(
    userId
) {

    if (!userId) {

        return null;

    }

    const {
        data,
        error
    } =
        await client
            .from("presence")
            .select(
                "is_online, last_seen"
            )
            .eq(
                "user_id",
                userId
            )
            .maybeSingle();

    if (error) {

        console.error(
            "GET USER PRESENCE ERROR:",
            error
        );

        return null;

    }

    return data || null;

}


// Loads the current user's unread badge value without performing client-side increments.
async function getUnreadCount(
    conversationId
) {

    if (
        !currentUser ||
        !conversationId
    ) {

        return 0;

    }


    const {
        data,
        error
    } =
        await client
            .from("conversation_unread")
            .select(
                "unread_count"
            )
            .eq(
                "conversation_id",
                conversationId
            )
            .eq(
                "user_id",
                currentUser.id
            )
            .maybeSingle();


    if (error) {

        console.error(
            "GET UNREAD COUNT ERROR:",
            error
        );

        return 0;

    }


    return data?.unread_count || 0;

}


async function getLastMessage(
    conversationId
) {

    if (
        !conversationId ||
        !currentUser
    ) {

        return null;

    }


    // ------------------------------------------
    // LOAD MESSAGES
    // ------------------------------------------

    const {
        data: messages,
        error
    } =
        await client
            .from("messages")
            .select(
                "id, body, sender_id, created_at, deleted_at"
            )
            .eq(
                "conversation_id",
                conversationId
            )
            .order(
                "created_at",
                {
                    ascending: false
                }
            );


    if (error) {

        console.error(
            "GET LAST MESSAGE ERROR:",
            error
        );

        return null;

    }


    const allMessages =
        messages || [];


    if (
        allMessages.length === 0
    ) {

        return null;

    }


    // ------------------------------------------
    // LOAD THIS USER'S "DELETED FOR ME" RECORDS
    // ------------------------------------------

    const {
        data: deletedForMe,
        error: deletedForMeError
    } =
        await client
            .from("message_deleted_for")
            .select(
                "message_id"
            )
            .eq(
                "user_id",
                currentUser.id
            );


    if (deletedForMeError) {

        console.error(
            "GET DELETED-FOR-ME ERROR:",
            deletedForMeError
        );

    }


    const deletedMessageIds =
        new Set(
            (deletedForMe || []).map(
                item =>
                    item.message_id
            )
        );


    // ------------------------------------------
    // FIND LATEST MESSAGE VISIBLE TO THIS USER
    // ------------------------------------------

    const lastVisibleMessage =
        allMessages.find(
            msg => {

                // Deleted for me
                if (
                    deletedMessageIds.has(
                        msg.id
                    )
                ) {

                    return false;

                }

                return true;

            }
        );


    if (
        !lastVisibleMessage
    ) {

        return null;

    }


    return lastVisibleMessage;

}


function sortFriendsList() {

    const list =
        $("friendRequestsList");

    if (!list) {
        return;
    }

    const friendItems =
        Array.from(
            list.querySelectorAll(
                ".friend-item"
            )
        );

    list.querySelectorAll(".friendGroupHeading").forEach(heading => {
        heading.remove();
    });

    if (friendItems.length === 0) {
        return;
    }

    const presenceGroup = friend => {
        const state = friend.querySelector(".friendPresence")?.dataset.state;
        return state === "online"
            ? "online"
            : state === "unavailable"
                ? "unavailable"
                : "offline";
    };
    const groupOrder = {
        online: 0,
        offline: 1,
        unavailable: 2
    };

    friendItems.sort(
        (a, b) => {

            const groupDifference =
                groupOrder[presenceGroup(a)] - groupOrder[presenceGroup(b)];

            if (groupDifference !== 0) {
                return groupDifference;
            }

            const timeA =
                a.dataset.lastMessageTime
                    ? new Date(
                        a.dataset.lastMessageTime
                    ).getTime()
                    : 0;

            const timeB =
                b.dataset.lastMessageTime
                    ? new Date(
                        b.dataset.lastMessageTime
                    ).getTime()
                    : 0;

            return timeB - timeA;

        }
    );

    let previousGroup = null;
    friendItems.forEach(friend => {
        const group = presenceGroup(friend);
        if (group !== previousGroup) {
            const heading = document.createElement("h3");
            heading.className = "friendGroupHeading";
            heading.textContent = group === "online"
                ? "Online"
                : group === "unavailable"
                    ? "Unavailable"
                    : "Offline";
            list.appendChild(heading);
            previousGroup = group;
        }

        list.appendChild(friend);
    });

}



// ======================================================
// LOAD MESSAGES
// ======================================================

// Loads only privacy-eligible chat history, processes ticks, and rejects stale results.
// PERFORMANCE AUDIT ONLY
async function loadMessages(
    perf = null,
    knownBlockState = null,
    knownUserId = null,
    onSeenSucceeded = null
) {

    const totalStage = startChatOpenStage(
        perf,
        "loadMessages total",
        "Total stage duration"
    );

    let unreadClearPromise = null;

    try {

    const userId = currentUser?.id;
    const peerId = selectedUser?.id;
    const conversationId = selectedConversation?.id;
    const selectionGeneration = selectedChatGeneration;
    const loadGeneration = chatMessageLoadGeneration;
    const isCurrentLoad = () => Boolean(
        currentUser?.id === userId &&
        isCurrentChatSelection(peerId, selectionGeneration) &&
        selectedConversation?.id === conversationId &&
        chatMessageLoadGeneration === loadGeneration &&
        $("chatUserStatus").textContent === "Online"
    );

    if (!userId || !peerId || !conversationId || !isCurrentLoad()) {

        return false;

    }

    setConversationMessageState("loading", "Loading conversation…");


    // ------------------------------------------
    // LOAD MESSAGES
    // ------------------------------------------

    const messagesRequest = measureChatOpenRequest(
        perf,
        "Conversation messages SELECT",
        client
            .from("messages")
            .select("*")
            .eq(
                "conversation_id",
                conversationId
            )
            .order(
                "created_at",
                {
                    ascending: true
                }
            )
    );

    const deletedQueryRequest = measureChatOpenRequest(
        perf,
        "message_deleted_for SELECT",
        client
            .from("message_deleted_for")
            .select(
                "message_id"
            )
            .eq(
                "user_id",
                userId
            )
    );

    const [
        messagesResult,
        deletedResult
    ] = await Promise.all([
        messagesRequest,
        deletedQueryRequest
    ]);

    if (!isCurrentLoad()) {
        return false;
    }

    const {
        data,
        error
    } = messagesResult;
    const {
        data: deletedForMe,
        error: deletedForMeError
    } = deletedResult;


    if (error) {

        console.error(
            "LOAD MESSAGES ERROR:",
            error
        );

        setConversationMessageState(
            "error",
            "Could not load messages",
            "Please try again."
        );

        return false;

    }


    let messages =
        data || [];
    addChatOpenTotal(
        perf,
        "messages fetched",
        0,
        messages.length
    );


    // ------------------------------------------
    // LOAD "DELETED FOR ME" MESSAGES
    // ------------------------------------------

    addChatOpenTotal(
        perf,
        "message_deleted_for rows fetched",
        0,
        (deletedForMe || []).length
    );


    if (deletedForMeError) {

        console.error(
            "LOAD DELETED-FOR-ME ERROR:",
            deletedForMeError
        );

    }


    const deletedMessageIds =
        new Set(
            (deletedForMe || []).map(
                item =>
                    item.message_id
            )
        );


    // ------------------------------------------
    // REMOVE ONLY THIS USER'S DELETED MESSAGES
    // ------------------------------------------

    const filterStage = startChatOpenStage(
        perf,
        "Deleted-for-me filtering",
        "JavaScript processing"
    );
    messages =
        messages.filter(
            msg =>
                !deletedMessageIds.has(
                    msg.id
                )
        );
    endChatOpenStage(perf, filterStage);


    // ------------------------------------------
    // DELIVERY / SEEN
    // ------------------------------------------

    await markMessagesAsDelivered(
        messages,
        perf,
        knownBlockState,
        knownUserId
    );

    if (!isCurrentLoad()) {
        return false;
    }


    const seenUpdateSucceeded = await markMessagesAsSeen(
        messages,
        perf
    );

    if (!isCurrentLoad()) {
        return false;
    }


    // Start the caller's existing unread clear only after seen processing
    // succeeded and this captured chat is still current. Do not await it here:
    // the final status SELECT can run while the clear request is in flight.
    if (
        seenUpdateSucceeded &&
        typeof onSeenSucceeded === "function"
    ) {
        unreadClearPromise = onSeenSucceeded();
    }


    // ------------------------------------------
    // LOAD LATEST MESSAGE STATUS
    // ------------------------------------------

    let messageStatuses =
        [];

    const ownMessageIds =
        messages
            .filter(
                msg =>
                    msg.sender_id === userId &&
                    !msg.deleted_at
            )
            .map(
                msg =>
                    msg.id
            );

    if (ownMessageIds.length) {


        const statusReadStage = startChatOpenStage(
            perf,
            "Final message_status SELECT for ticks",
            "Supabase/network wait"
        );
        const {
            data: statusData,
            error: statusError
        } =
            await client
                .from("message_status")
                .select(
                    "message_id, delivered_at, seen_at"
                )
                .in(
                    "message_id",
                    ownMessageIds
                );
        endChatOpenStage(perf, statusReadStage);
        addChatOpenTotal(
            perf,
            "final message_status reads (count and total ms)",
            statusReadStage ? performance.now() - statusReadStage.startedAt : 0
        );

        if (!isCurrentLoad()) {
            return false;
        }


        if (statusError) {

            console.error(
                "LOAD MESSAGE STATUS ERROR:",
                statusError
            );

        } else {

            messageStatuses =
                statusData || [];
            addChatOpenTotal(
                perf,
                "message_status rows loaded for ticks",
                0,
                messageStatuses.length
            );

        }

    }


    // ------------------------------------------
    // RENDER
    // ------------------------------------------

    if (!isCurrentLoad()) {
        return false;
    }

    renderMessages(
        messages,
        messageStatuses,
        false,
        perf
    );

    return seenUpdateSucceeded;

    } finally {
        try {
            if (unreadClearPromise) {
                await unreadClearPromise;
            }
        } finally {
            endChatOpenStage(perf, totalStage);
        }
    }

}


// Loads an opened conversation and clears unread only after current-chat seen handling succeeds.
// PERFORMANCE AUDIT ONLY
async function loadOpenedConversationAndClearUnread(
    perf = null,
    knownBlockState = null,
    knownUserId = null,
    selectionGeneration = selectedChatGeneration
) {
    const totalStage = startChatOpenStage(
        perf,
        "loadOpenedConversationAndClearUnread total",
        "Total stage duration"
    );

    try {
    const conversationId = selectedConversation?.id;
    const userId = currentUser?.id;
    const peerId = selectedUser?.id;
    const loadGeneration = chatMessageLoadGeneration;

    if (
        !conversationId ||
        !userId ||
        !peerId ||
        !isCurrentChatSelection(peerId, selectionGeneration) ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    // loadMessages starts this existing unread clear after successful seen
    // processing and while the captured conversation is still selected.
    const messagesLoadedAndSeen = await loadMessages(
        perf,
        knownBlockState,
        knownUserId,
        () => {
            if (
                currentUser?.id !== userId ||
                !isCurrentChatSelection(peerId, selectionGeneration) ||
                !selectedConversation ||
                selectedConversation.id !== conversationId ||
                chatMessageLoadGeneration !== loadGeneration ||
                $("chatUserStatus").textContent !== "Online"
            ) {
                return null;
            }

            return clearUnreadCount(conversationId, perf);
        }
    );

    if (
        !messagesLoadedAndSeen ||
        currentUser?.id !== userId ||
        !isCurrentChatSelection(peerId, selectionGeneration) ||
        !selectedConversation ||
        selectedConversation.id !== conversationId ||
        chatMessageLoadGeneration !== loadGeneration ||
        $("chatUserStatus").textContent !== "Online"
    ) {
        return false;
    }

    return true;
    } finally {
        endChatOpenStage(perf, totalStage);
    }
}


// ======================================================
// RENDER MESSAGES
// ======================================================

// Builds message DOM and applies per-message delivery/seen ticks from loaded status rows.
// PERFORMANCE AUDIT ONLY
function renderMessages(
    messages,
    messageStatuses = [],
    append = false,
    perf = null
) {

    const renderStage = startChatOpenStage(
        perf,
        "Message DOM rendering",
        "JavaScript + DOM rendering"
    );

     const box =
    $("messages");

if (!append) {

    box.innerHTML =
        "";
    box.dataset.state = "ready";
    box.setAttribute("aria-busy", "false");

} else if (messages.length) {

    box.querySelector(".conversationState")?.remove();

}

if (!append && messages.length === 0) {
    box.dataset.state = "empty";
    box.innerHTML = `
        <div class="conversationState conversationEmptyState">
            <strong>No messages yet</strong>
            <span>Start the conversation.</span>
        </div>
    `;
}

    const statusMap =
        {};

    messageStatuses.forEach(
        status => {

            statusMap[
                status.message_id
            ] = status;

        }
    );

    messages.forEach(
        msg => {

            const div =
                document.createElement(
                    "div"
                );

            const own =
                msg.sender_id ===
                currentUser.id;

            // ------------------------------------------
            // MESSAGE TYPE
            // ------------------------------------------

            div.className =
                own
                    ? "message own"
                    : "message";

            div.dataset.messageId =
                msg.id;

            div.dataset.senderId =
                msg.sender_id;

            div.dataset.deleted =
                msg.deleted_at
                    ? "true"
                    : "false";

            const messageTime =
                new Date(
                    msg.created_at
                ).toLocaleTimeString(
                    [],
                    {
                        hour: "2-digit",
                        minute: "2-digit"
                    }
                );

            // ------------------------------------------
            // DELETED MESSAGE
            // ------------------------------------------

            if (msg.deleted_at) {

                div.innerHTML = `
                    <div class="messageContent deletedMessage">
                        This message was deleted
                    </div>

                    <div class="messageTime">
                        ${messageTime}
                    </div>
                `;

                box.appendChild(
                    div
                );

                return;

            }

            // ------------------------------------------
            // MESSAGE STATUS
            // ------------------------------------------

            let statusIcon =
                "";

            if (own) {

                const status =
                    statusMap[
                        msg.id
                    ];

                if (
                    status &&
                    status.seen_at
                ) {

                    statusIcon =
                        "✓✓";

                } else if (
                    status &&
                    status.delivered_at
                ) {

                    statusIcon =
                        "✓";

                } else {

                    statusIcon =
                        "";

                }

            }

            // ------------------------------------------
            // NORMAL MESSAGE
            // ------------------------------------------

            div.innerHTML = `
              <div class="messageContent">
               ${escapeHtml(
                    msg.body
                )}

                ${
                    msg.edited_at
                  ? `<span class="editedLabel">edited</span>`
                    : ""
                }
              </div>

                <div class="messageTime">
                    ${messageTime}

                   ${
    own
        ? `<span class="messageStatus" id="message-status-${msg.id}">${statusIcon}</span>`
        : ""
}
                </div>
            `;

            const messageContent =
                div.querySelector(".messageContent");

            if (messageContent) {
                messageContent.dataset.messageBody =
                    String(msg.body ?? "");
            }

            box.appendChild(
                div
            );

        }
    );

    if (messages.length) {
        box.dataset.state = "ready";
        box.setAttribute("aria-busy", "false");
    }

    box.scrollTop =
        box.scrollHeight;

    endChatOpenStage(perf, renderStage);
    markChatOpenMilestone(perf, "messages rendered / DOM ready");
    scheduleChatOpenPaintMilestone(
        perf,
        "messages paint opportunity"
    );

}


// ======================================================
// SEND MESSAGE
// ======================================================

$("sendMessageBtn").addEventListener(
    "click",
    sendMessage
);


$("messageInput").addEventListener(
    "input",
    () => {

        if (
            !currentUser ||
            !selectedConversation ||
            !selectedUser
        ) {

            return;

        }

        const typingContext = {
            userId: currentUser.id,
            conversationId: selectedConversation.id,
            selectionGeneration: selectedChatGeneration,
            channel: realtimeChannel
        };

        if (
            pendingTypingContext &&
            (
                pendingTypingContext.userId !== typingContext.userId ||
                pendingTypingContext.conversationId !== typingContext.conversationId ||
                pendingTypingContext.selectionGeneration !== typingContext.selectionGeneration ||
                pendingTypingContext.channel !== typingContext.channel
            )
        ) {
            clearTimeout(typingTimeout);
            typingTimeout = null;
            sendTypingStatus(pendingTypingContext, false);
            pendingTypingContext = null;
        } else {
            clearTimeout(typingTimeout);
        }

        sendTypingStatus(typingContext, true);
        pendingTypingContext = typingContext;

        isTyping = true;

        typingTimeout =
            setTimeout(
                () => {

                    if (pendingTypingContext === typingContext) {
                        pendingTypingContext = null;
                        typingTimeout = null;
                        isTyping = false;
                    }

                    sendTypingStatus(typingContext, false);

                },
                2000
            );

    }
);


$("messageInput").addEventListener(
    "keydown",
    event => {

        if (
            event.key === "Enter"
        ) {

            sendMessage();

        }

    }
);


// Sends a captured chat submission once and aborts if user/chat/block context changes.
async function sendMessage() {

    if (isSendingMessage) {
        return;
    }

    isSendingMessage = true;

    try {

        const userId =
            currentUser?.id;

        const conversationId =
            selectedConversation?.id;

        const recipientId =
            selectedUser?.id;

        const selectionGeneration =
            selectedChatGeneration;

        const input =
            $("messageInput");

        const originalInputValue =
            input?.value ?? "";

        const content =
            originalInputValue.trim();

        if (
            !userId ||
            !conversationId ||
            !recipientId ||
            !input ||
            !content
        ) {
            return;
        }

        const isStillInCapturedChat = () =>
            currentUser?.id === userId &&
            selectedConversation?.id === conversationId &&
            selectedUser?.id === recipientId &&
            selectedChatGeneration === selectionGeneration &&
            $("chatUserStatus").textContent === "Online";

        const blocked =
            await isBlocked(recipientId);

        if (!isStillInCapturedChat()) {
            return;
        }

        if (blocked === BLOCK_CHECK_UNKNOWN) {
            message("Could not verify block status. Message was not sent.");
            return;
        }

        if (blocked === true) {

            message(
                "Messaging is unavailable because one of the users is blocked."
            );

            return;

        }

        const friendship = await getFriendRelationshipState(
            recipientId,
            userId
        );

        if (!isStillInCapturedChat()) {
            return;
        }

        if (!friendship.verified) {
            showFriendRelationshipUnknownState(
                recipientId,
                selectionGeneration
            );
            message("Could not verify friendship. Message was not sent.");
            return;
        }

        if (!friendship.isFriend) {
            showFriendshipRequiredState(
                recipientId,
                selectionGeneration
            );
            message("You must be friends to send messages.");
            return;
        }

        const {
            error
        } =
            await client
                .from("messages")
                .insert({

                    conversation_id:
                        conversationId,

                    sender_id:
                        userId,

                    body:
                        content

                });

        if (!isStillInCapturedChat()) {
            return;
        }

        if (error) {

            console.error(
                "SEND MESSAGE ERROR:",
                error
            );

            message(
                "Could not send message."
            );

            return;

        }

        if (input.value === originalInputValue) {
            input.value = "";
        }

    } catch (error) {

        console.error(
            "SEND MESSAGE ERROR:",
            error
        );

        message(
            "Could not send message."
        );

    } finally {

        isSendingMessage = false;

    }

}


// ======================================================
// UPDATE SELECTED USER STATUS
// ======================================================
// Refreshes the selected peer's visible status without applying stale presence results.
// PERFORMANCE AUDIT ONLY
async function updateSelectedUserStatus(
    perf = null,
    expectedUserId = null,
    expectedSelectionGeneration = null
) {

    const userId = expectedUserId || selectedUser?.id;
    const selectionGeneration =
        expectedSelectionGeneration ?? selectedChatGeneration;
    const authUserId = currentUser?.id;
    const expectedConversationId = selectedConversation?.id ?? null;
    const isCurrentPresenceRequest = () =>
        currentUser?.id === authUserId &&
        isCurrentChatSelection(userId, selectionGeneration) &&
        (selectedConversation?.id ?? null) === expectedConversationId;

    if (!userId || !authUserId || !isCurrentPresenceRequest()) {
        return null;
    }

    const friendPresenceRevision =
        friendPresenceStates.get(userId)?.revision || 0;

    const stage = startChatOpenStage(
        perf,
        "Presence table SELECT",
        "Supabase/network wait"
    );
    const {
        data,
        error
    } =
        await client
            .from("presence")
            .select(
                "is_online, last_seen"
            )
            .eq(
                "user_id",
                userId
            )
            .maybeSingle();
    endChatOpenStage(perf, stage);

    if (!isCurrentPresenceRequest()) {
        return null;
    }


    if (error) {

        console.error(
            "STATUS ERROR:",
            error
        );

        // Fail closed: private messages stay unavailable until presence is
        // confirmed for this exact selected user.
        chatMessageLoadGeneration += 1;
        $("chatUserStatus").textContent = "Status unavailable";
        $("chatUserStatus").classList.add("lastSeenStatus");
        const currentFriendPresence = friendPresenceStates.get(userId);
        if (
            (friendPresenceTrackingIds.has(userId) || currentFriendPresence) &&
            (!currentFriendPresence ||
                currentFriendPresence.revision === friendPresenceRevision)
        ) {
            friendPresenceStates.set(userId, {
                online: false,
                lastSeen: currentFriendPresence?.lastSeen || null,
                revision: friendPresenceRevision + 1
            });
            $("friendRequestsList")
                .querySelectorAll(`.friend-item[data-user-id="${userId}"]`)
                .forEach(showUnavailableFriendPreview);
            scheduleFriendPresenceExpiry();
        }
        return null;

    }


    // The account heartbeat is considered online only while recent.
    let online = isPresenceFresh(data);
    let lastSeen = data?.last_seen || null;
    const currentFriendPresence = friendPresenceStates.get(userId);
    const realtimePresenceChanged = Boolean(
        currentFriendPresence &&
        currentFriendPresence.revision !== friendPresenceRevision
    );

    if (realtimePresenceChanged) {
        if (currentFriendPresence.online) {
            expireFriendPresenceState(userId, currentFriendPresence.revision);
        }
        const latestPresence = friendPresenceStates.get(userId);
        online = isFriendPresenceStateFresh(latestPresence);
        lastSeen = latestPresence?.lastSeen || lastSeen;
    } else if (friendPresenceTrackingIds.has(userId) || currentFriendPresence) {
        const wasOnline = currentFriendPresence?.online || false;
        const nextLastSeen = data?.last_seen || null;
        const stateChanged =
            !currentFriendPresence ||
            wasOnline !== online ||
            currentFriendPresence.lastSeen !== nextLastSeen;

        if (stateChanged) {
            const revision = (currentFriendPresence?.revision ?? friendPresenceRevision) + 1;
            friendPresenceStates.set(userId, {
                online,
                lastSeen: nextLastSeen,
                revision
            });

            if (!online) {
                $("friendRequestsList")
                    .querySelectorAll(`.friend-item[data-user-id="${userId}"]`)
                    .forEach(showOfflineFriendPreview);
            } else if (!wasOnline) {
                void refreshOnlineFriendPreview(userId, revision);
            }
        }

        scheduleFriendPresenceExpiry();
        const latestPresence = friendPresenceStates.get(userId);
        if (latestPresence) {
            online = isFriendPresenceStateFresh(latestPresence);
            lastSeen = latestPresence.lastSeen || lastSeen;
        }
    }

    if (online) {

        $("chatUserStatus").textContent =
            "Online";

        $("chatUserStatus").classList.remove(
            "lastSeenStatus"
        );

    } else {

        $("chatUserStatus").textContent =
            formatLastSeen(
                lastSeen
            );

        $("chatUserStatus").classList.add(
            "lastSeenStatus"
        );

    }

    if (!isCurrentPresenceRequest()) {
        return null;
    }

    if (!online) {
        // Invalidate any history load that began before the offline result.
        chatMessageLoadGeneration += 1;
    }

    return online;
}


// ======================================================
// REALTIME
// ======================================================

// Creates the single authenticated database-change channel and tears it down on session loss.
function startRealtime() {

    if (realtimeChannel) {

        try {

            client.removeChannel(
                realtimeChannel
            );

        } catch (error) {

            console.error("Realtime channel removal failed:", error);

        }

    }


    // ------------------------------------------
    // CLEAR OLD PRESENCE CHECK
    // ------------------------------------------

    if (
        startRealtime.presenceCheckInterval
    ) {

        clearInterval(
            startRealtime.presenceCheckInterval
        );

        startRealtime.presenceCheckInterval =
            null;

    }


realtimeChannel =
    client
        .channel(
            "talkspace-realtime",
            {
                config: {
                    broadcast: {
                        self: false
                    }
                }
            }
        );

    const authenticatedRealtimeChannel = realtimeChannel;
    const realtimeUserId = currentUser?.id;


    realtimeChannel.on(
    "broadcast",
    {
        event: "typing"
    },
    payload => {

        const data =
            payload.payload;

        if (
            !data ||
            !currentUser ||
            !selectedConversation
        ) {

            return;

        }

        if (
            data.user_id ===
            currentUser.id
        ) {

            return;

        }

        if (
            data.conversation_id !==
            selectedConversation.id
        ) {

            return;

        }

        showTypingIndicator(
            data.typing
        );

    }
);


    realtimeChannel.on(
        "broadcast",
        { event: "block-status" },
        payload => {
            void handleBlockStatusBroadcast(
                payload,
                authenticatedRealtimeChannel
            );
        }
    );


    // ------------------------------------------
    // FRIEND REQUEST CHANGES
    // ------------------------------------------

    realtimeChannel.on(
        "postgres_changes",
        {
            event: "*",
            schema: "public",
            table: "friend_requests"
        },
        payload => {
            const eventUserId = currentUser?.id;
            if (
                !eventUserId ||
                eventUserId !== realtimeUserId ||
                realtimeChannel !== authenticatedRealtimeChannel
            ) {
                return;
            }

            const event = FriendRequestLifecycle.resolveRealtimeEvent(
                payload,
                eventUserId,
                friendRequestRelationshipRows
            );

            if (!event) {
                return;
            }

            const { eventType, request, peerId } = event;
            const panel = $("friendRequestsPanel");
            const refreshPlan = FriendRequestLifecycle.getRealtimeRefreshPlan({
                event,
                selectedPeerId: selectedUser?.id,
                panelVisible: Boolean(panel && !panel.classList.contains("hidden")),
                panelView: friendPanelView
            });

            if (eventType === "DELETE") {
                friendRequestRelationshipRows.delete(request.id);
            } else if (request.id) {
                friendRequestRelationshipRows.set(request.id, request);
            }

            if (refreshPlan.refreshSelected) {
                const selectedGeneration = selectedChatGeneration;
                if (
                    eventType === "DELETE" ||
                    (
                        eventType === "UPDATE" &&
                        request.status !== "accepted"
                    )
                ) {
                    showFriendshipRequiredState(
                        peerId,
                        selectedGeneration
                    );
                }

                void refreshSelectedFriendActionState(
                    peerId,
                    selectedGeneration
                ).then(friendship => {
                    if (
                        currentUser?.id !== eventUserId ||
                        realtimeChannel !== authenticatedRealtimeChannel ||
                        !isCurrentChatSelection(peerId, selectedGeneration)
                    ) {
                        return;
                    }

                    if (!friendship?.verified) {
                        showFriendRelationshipUnknownState(
                            peerId,
                            selectedGeneration
                        );
                        return;
                    }

                    if (!friendship.isFriend) {
                        showFriendshipRequiredState(
                            peerId,
                            selectedGeneration
                        );
                        return;
                    }

                    if (friendshipUnavailablePeerId === peerId) {
                        const peer = { ...selectedUser };
                        friendshipUnavailablePeerId = null;
                        void openUser(peer);
                    }
                });
            }

            if (!refreshPlan.refreshPanel) {
                return;
            }

            if (
                refreshPlan.panelView === "friends" &&
                currentUser?.id === eventUserId &&
                realtimeChannel === authenticatedRealtimeChannel
            ) {
                $("friendsBtn").click();
            } else if (
                refreshPlan.panelView === "requests" &&
                currentUser?.id === eventUserId &&
                realtimeChannel === authenticatedRealtimeChannel
            ) {
                $("requestsBtn").click();
            }
        }
    );


    // ------------------------------------------
    // MESSAGE CHANGES
    // ------------------------------------------

    realtimeChannel.on(
        "postgres_changes",
        {
            event: "INSERT",
            schema: "public",
            table: "messages"
        },
        async payload => {

            const newMessage =
                payload.new;


            if (
                !newMessage ||
                !currentUser
            ) {

                return;

            }

            const eventUserId = currentUser.id;
            const eventPeerId = selectedUser?.id;
            const eventConversationId = selectedConversation?.id;
            const eventSelectionGeneration = selectedChatGeneration;
            const eventLoadGeneration = chatMessageLoadGeneration;
            const eventBelongsToCurrentChat = () => Boolean(
                currentUser?.id === eventUserId &&
                eventPeerId &&
                isCurrentChatSelection(eventPeerId, eventSelectionGeneration) &&
                selectedConversation?.id === eventConversationId &&
                chatMessageLoadGeneration === eventLoadGeneration &&
                $("chatUserStatus").textContent === "Online"
            );

            const friendsList = $("friendRequestsList");
            if (
                friendsList &&
                !$("friendRequestsPanel").classList.contains("hidden")
            ) {
                const friendButtons = friendsList.querySelectorAll(
                    ".openFriendBtn"
                );

                friendButtons.forEach(button => {
                    if (
                        button.dataset.conversationId !==
                        newMessage.conversation_id
                    ) {
                        return;
                    }

                    const friendDiv = button.closest(".friend-item");
                    if (!friendDiv) {
                        return;
                    }

                    const friendId = button.dataset.userId;
                    const friendPresence = friendPresenceStates.get(friendId);
                    if (!isFriendPresenceStateFresh(friendPresence)) {
                        if (friendPresence?.online) {
                            scheduleFriendPresenceExpiry();
                        }
                        showOfflineFriendPreview(friendDiv);
                        return;
                    }

                    const preview = ensureFriendPreviewElement(friendDiv);
                    preview.textContent = newMessage.body;
                    friendDiv.dataset.lastMessageTime = newMessage.created_at;
                });

                sortFriendsList();
            }


            // ------------------------------------------
            // MESSAGE RECEIVED BY THIS USER
            // ------------------------------------------

            if (
                newMessage.sender_id !==
                currentUser.id
            ) {

                // ------------------------------------------
                // MARK DELIVERED
                // ------------------------------------------

                await markMessagesAsDelivered(
                    [newMessage]
                );


                // ------------------------------------------
                // CHAT IS CURRENTLY OPEN
                // ------------------------------------------

                 if (
    selectedConversation &&
    newMessage.conversation_id ===
        selectedConversation.id &&
    $("chatUserStatus").textContent === "Online"
) {

    // The user is already viewing
    // this conversation.
    // Do NOT increase unread count.

    const {
        data: statusData,
        error: statusError
    } =
        await client
            .from("message_status")
            .select(
                "message_id, delivered_at, seen_at"
            )
            .eq(
                "message_id",
                newMessage.id
            );

    if (statusError) {

        console.error(
            "LOAD NEW MESSAGE STATUS ERROR:",
            statusError
        );

    }

    if (!eventBelongsToCurrentChat()) {
        return;
    }

    renderMessages(
        [newMessage],
        statusData || [],
        true
    );

    const messagesBox =
        $("messages");

    if (messagesBox) {

        messagesBox.scrollTop =
            messagesBox.scrollHeight;

    }

    await markMessagesAsSeen(
        [newMessage]
    );

}


            }


// ------------------------------------------
// MESSAGE SENT BY THIS USER
// ------------------------------------------

else {

    if (
        selectedConversation &&
        newMessage.conversation_id ===
            selectedConversation.id &&
        $("chatUserStatus").textContent === "Online"
    ) {

        const {
            data: statusData,
            error: statusError
        } =
            await client
                .from("message_status")
                .select(
                    "message_id, delivered_at, seen_at"
                )
                .eq(
                    "message_id",
                    newMessage.id
                );

        if (statusError) {

            console.error(
                "LOAD SENT MESSAGE STATUS ERROR:",
                statusError
            );

        }

        if (!eventBelongsToCurrentChat()) {
            return;
        }

        renderMessages(
            [newMessage],
            statusData || [],
            true
        );

        const messagesBox =
            $("messages");

        if (messagesBox) {

            messagesBox.scrollTop =
                messagesBox.scrollHeight;

        }

    }

}

        }
    );
     

     // ======================================================
// MESSAGE UPDATE
// ======================================================

realtimeChannel.on(
    "postgres_changes",
    {
        event: "UPDATE",
        schema: "public",
        table: "messages"
    },
    async payload => {

        const updatedMessage =
            payload.new;

        if (
            !updatedMessage ||
            !currentUser
        ) {

            return;

        }

        // ------------------------------------------
        // UPDATE OPEN CHAT
        // ------------------------------------------

        if (
            selectedConversation &&
            updatedMessage.conversation_id ===
                selectedConversation.id
        ) {

            await loadMessages();

        }

        // ------------------------------------------
        // UPDATE FRIENDS PREVIEW
        // ------------------------------------------

        const friendsList =
            $("friendRequestsList");

        if (
            !friendsList ||
            $("friendRequestsPanel").classList.contains(
                "hidden"
            )
        ) {

            return;

        }

        const friendButtons =
            friendsList.querySelectorAll(
                ".openFriendBtn"
            );

        for (
            const button
            of friendButtons
        ) {

            if (
                button.dataset.conversationId !==
                updatedMessage.conversation_id
            ) {

                continue;

            }

            const friendDiv =
                button.closest(
                    ".friend-item"
                );

            if (!friendDiv) {

                continue;

            }

            const friendId = button.dataset.userId;
            if (!friendPresenceStates.get(friendId)?.online) {
                showOfflineFriendPreview(friendDiv);
                continue;
            }

            // ------------------------------------------
            // GET CURRENT LATEST VISIBLE MESSAGE
            // ------------------------------------------

            const lastMessage =
                await getLastMessage(
                    updatedMessage.conversation_id
                );

            if (!friendPresenceStates.get(friendId)?.online) {
                showOfflineFriendPreview(friendDiv);
                continue;
            }

            renderFriendLastMessage(friendDiv, lastMessage);

            sortFriendsList();

        }

    }
);


    // ------------------------------------------
    // MESSAGE STATUS REALTIME
    // ------------------------------------------

    realtimeChannel.on(
        "postgres_changes",
        {
            event: "*",
            schema: "public",
            table: "message_status"
        },
        payload => {

            window.TalkSpaceLogger?.debug(
                "MESSAGE STATUS REALTIME:",
                { eventType: payload.eventType }
            );


            const status =
                payload.new;


            if (
                !status ||
                !status.message_id
            ) {

                return;

            }


            const statusElement =
                document.getElementById(
                    "message-status-" +
                    status.message_id
                );


            if (
                !statusElement
            ) {

                return;

            }


            if (
                status.seen_at
            ) {

                statusElement.textContent =
                    "✓✓";

            } else if (
                status.delivered_at
            ) {

                statusElement.textContent =
                    "✓";

            }

        }
    );

     
    realtimeChannel.on(
    "postgres_changes",
    {
        event: "*",
        schema: "public",
        table: "conversation_unread"
    },
    payload => {

        if (
            !currentUser ||
            !payload.new
        ) {
            return;
        }

        if (
            payload.new.user_id !==
            currentUser.id
        ) {
            return;
        }

        const unreadCount =
            payload.new.unread_count || 0;

        const conversationId =
            payload.new.conversation_id;

        // ------------------------------------------
        // FIND THE FRIENDS PANEL
        // ------------------------------------------

        const list =
            $("friendRequestsList");

        if (
            !list ||
            $("friendRequestsPanel").classList.contains(
                "hidden"
            )
        ) {
            return;
        }

        // ------------------------------------------
        // FIND THE FRIEND ITEM
        // ------------------------------------------

        const openButton =
            list.querySelector(
                `.openFriendBtn[data-conversation-id="${conversationId}"]`
            );

        if (!openButton) {
            return;
        }

        const friendDiv =
            openButton.closest(
                ".friend-item"
            );

        if (!friendDiv) {
            return;
        }

        // ------------------------------------------
        // FIND / CREATE BADGE
        // ------------------------------------------

        let badge =
            friendDiv.querySelector(
                ".unreadBadge"
            );

        if (
            unreadCount > 0
        ) {

            if (!badge) {

                badge =
                    document.createElement(
                        "span"
                    );

                badge.className =
                    "unreadBadge";

                openButton
                    .parentElement
                    .appendChild(
                        badge
                    );

            }

            badge.textContent =
                unreadCount;

        } else {

            if (badge) {

                badge.remove();

            }

        }

    }
);
    

 
    // ------------------------------------------
// BLOCK STATUS CHANGES
// ------------------------------------------

realtimeChannel.on(
    "postgres_changes",
    {
        event: "*",
        schema: "public",
        table: "blocked_users"
    },
    async payload => {

        if (!currentUser) {
            return;
        }

        const row =
            payload.new || payload.old;

        if (!row) {
            return;
        }

        // Only refresh if the current user
        // is involved in this block action
        if (
            row.blocker_id !== currentUser.id &&
            row.blocked_id !== currentUser.id
        ) {
            return;
        }

        if (
    selectedUser &&
    (
        row.blocker_id ===
            selectedUser.id ||
        row.blocked_id ===
            selectedUser.id
    )
) {

    await refreshSelectedUserBlockState();

}

    }
);


    // ------------------------------------------
    // PRESENCE CHANGES
    // ------------------------------------------

    realtimeChannel.on(
        "postgres_changes",
        {
            event: "*",
            schema: "public",
            table: "presence"
        },
        async payload => {

            const row = payload.new || payload.old;
            if (!row?.user_id) {
                return;
            }

            const userId = row.user_id;
            if (
                !friendPresenceTrackingIds.has(userId) &&
                selectedUser?.id !== userId
            ) {
                return;
            }

            const payloadIsOnline = Boolean(
                payload.new &&
                isPresenceFresh(row)
            );
            const revision =
                (friendPresenceStates.get(userId)?.revision || 0) + 1;

            friendPresenceStates.set(userId, {
                online: payloadIsOnline,
                lastSeen: row.last_seen || null,
                revision
            });
            scheduleFriendPresenceExpiry();

            const friendRows = $("friendRequestsList").querySelectorAll(
                `.friend-item[data-user-id="${userId}"]`
            );
            if (payloadIsOnline) {
                void refreshOnlineFriendPreview(userId, revision);
            } else {
                friendRows.forEach(showOfflineFriendPreview);
            }

            if (!selectedUser || userId !== selectedUser.id) {
                return;
            }

            const selectionGeneration = selectedChatGeneration;

            // Invalidate pending history and hide it immediately on an offline
            // event, before waiting for the follow-up presence SELECT.
            if (!payloadIsOnline) {
                showOfflineChatState();
                $("chatUserStatus").textContent = formatLastSeen(row.last_seen);
                $("chatUserStatus").classList.add("lastSeenStatus");
            }

            const presenceOnline = await updateSelectedUserStatus(
                null,
                userId,
                selectionGeneration
            );

            if (!isCurrentChatSelection(userId, selectionGeneration)) {
                return;
            }

            if (presenceOnline !== true) {
                showOfflineChatState();
            } else if (!selectedConversation) {
                const opened = await openConversation(
                    null,
                    null,
                    null,
                    selectionGeneration
                );

                if (
                    opened &&
                    isCurrentChatSelection(userId, selectionGeneration) &&
                    $("chatUserStatus").textContent === "Online"
                ) {
                    $("messageInput").disabled = false;
                    $("sendMessageBtn").disabled = false;
                    setCallButtonsDisabled(false);
                    await loadOpenedConversationAndClearUnread(
                        null,
                        null,
                        null,
                        selectionGeneration
                    );
                }
            }

        }
    );


    // ------------------------------------------
    // SUBSCRIBE
    // ------------------------------------------

    realtimeChannel.subscribe(
        status => {

            window.TalkSpaceLogger?.debug(
                "REALTIME STATUS:",
                typeof status === "string" ? status : "unknown"
            );

        }
    );


    // ------------------------------------------
    // PERIODIC PRESENCE CHECK
    // ------------------------------------------

    startRealtime.presenceCheckInterval =
        setInterval(
            async () => {

                if (!selectedUser) {

                    return;

                }


                const userId = selectedUser.id;
                const selectionGeneration = selectedChatGeneration;
                const presenceOnline = await updateSelectedUserStatus(
                    null,
                    userId,
                    selectionGeneration
                );

                if (!isCurrentChatSelection(userId, selectionGeneration)) {
                    return;
                }

                if (presenceOnline !== true) {
                    showOfflineChatState();
                } else if (!selectedConversation) {
                    const opened = await openConversation(
                        null,
                        null,
                        null,
                        selectionGeneration
                    );

                    if (
                        opened &&
                        isCurrentChatSelection(userId, selectionGeneration) &&
                        $("chatUserStatus").textContent === "Online"
                    ) {
                        $("messageInput").disabled = false;
                        $("sendMessageBtn").disabled = false;
                        setCallButtonsDisabled(false);
                        await loadOpenedConversationAndClearUnread(
                            null,
                            null,
                            null,
                            selectionGeneration
                        );
                    }
                }

            },
            10000
        );

}


// ======================================================
// FRIENDS
// ======================================================

$("friendsBtn").addEventListener(
    "click",
    async () => {

        navigateToView("friends");
        setFriendPanelView("friends");
        const mainScreen = $("mainScreen");
        hide("emptyChat");
        hide("profilePanel");
        hide("chatPanel");
        friendRequestListLoadGeneration += 1;

        const panel = $("friendRequestsPanel");
        const list = $("friendRequestsList");

        panel.classList.remove("hidden");
        syncSidebarNavigationState("friendsBtn");

        showListFeedback(list, "Loading friends…");

        if (!currentUser) {
            list.innerHTML =
                "<p>Please log in again.</p>";
            return;
        }

        await waitForViewPaint();
        if (!currentUser) return;

        const friendsLoadUserId = currentUser.id;
        const friendsLoadGeneration = ++friendListLoadGeneration;
        friendPresenceStates.clear();
        friendPresenceTrackingIds.clear();
        scheduleFriendPresenceExpiry();

        const {
            data: friendships,
            error
        } = await client
            .from("friend_requests")
            .select(
                "id, sender_id, receiver_id, status"
            )
            .eq(
                "status",
                "accepted"
            )
            .or(
                `sender_id.eq.${currentUser.id},receiver_id.eq.${currentUser.id}`
            );

        if (
            currentUser?.id !== friendsLoadUserId ||
            friendListLoadGeneration !== friendsLoadGeneration
        ) {
            return;
        }

        if (error) {

            console.error(
                "FRIENDS LOAD ERROR:",
                error
            );

            list.innerHTML =
                "<p>Could not load friends.</p>";

            return;
        }

        if (Array.isArray(friendships)) {
            friendships.forEach(friendship => {
                friendRequestRelationshipRows.set(friendship.id, friendship);
            });
        }

        if (!friendships || friendships.length === 0) {

            showListFeedback(
                list,
                "No friends yet",
                "Find people to start a conversation.",
                "Find People",
                "findPeople"
            );

            return;
        }

        const friendIds = [...new Set(friendships.map(friendship =>
            friendship.sender_id === currentUser.id
                ? friendship.receiver_id
                : friendship.sender_id
        ))];
        friendIds.forEach(friendId => friendPresenceTrackingIds.add(friendId));

        const { data: friendProfiles, error: profilesError } = await client
            .from("profiles")
            .select("id, username, display_name, avatar_url")
            .in("id", friendIds);

        if (
            currentUser?.id !== friendsLoadUserId ||
            friendListLoadGeneration !== friendsLoadGeneration
        ) return;

        if (profilesError) {
            console.error("FRIEND PROFILES ERROR:", profilesError);
        }
        const friendProfilesById = new Map(
            (Array.isArray(friendProfiles) ? friendProfiles : [])
                .map(friend => [friend.id, friend])
        );

        const renderedFriendIds = new Set();
        let nextFriendshipIndex = 0;
        const loadNextFriend = async () => {
            while (nextFriendshipIndex < friendships.length) {
            const friendship = friendships[nextFriendshipIndex++];
            if (
                currentUser?.id !== friendsLoadUserId ||
                friendListLoadGeneration !== friendsLoadGeneration
            ) {
                return;
            }

            const friendId = friendship.sender_id === currentUser.id
                ? friendship.receiver_id
                : friendship.sender_id;

            if (renderedFriendIds.has(friendId)) {
                continue;
            }
            renderedFriendIds.add(friendId);

            const friend = friendProfilesById.get(friendId);
            if (!friend) continue;

            const presenceRevision =
                friendPresenceStates.get(friend.id)?.revision || 0;
            const [conversationResult, presenceResult] = await Promise.all([
                client
                    .from("conversations")
                    .select("id")
                    .or(
                        `and(user_one.eq.${currentUser.id},user_two.eq.${friend.id}),and(user_one.eq.${friend.id},user_two.eq.${currentUser.id})`
                    )
                    .limit(1)
                    .maybeSingle(),
                client
                    .from("presence")
                    .select("is_online, last_seen")
                    .eq("user_id", friend.id)
                    .maybeSingle()
            ]);
            const { data: conversation, error: conversationError } = conversationResult;
            const { data: friendPresence, error: presenceError } = presenceResult;

            if (
                currentUser?.id !== friendsLoadUserId ||
                friendListLoadGeneration !== friendsLoadGeneration
            ) return;

            if (conversationError) {
                console.error(
                    "FRIEND CONVERSATION ERROR:",
                    conversationError
                );
            }

            if (presenceError) {
                console.error("FRIEND PRESENCE ERROR:", presenceError);
            }

            const latestPresenceState = friendPresenceStates.get(friend.id);
            let isFriendOnline;
            let friendPresenceUnavailable = false;

            if (
                latestPresenceState &&
                latestPresenceState.revision !== presenceRevision
            ) {
                isFriendOnline = isFriendPresenceStateFresh(latestPresenceState);
            } else {
                friendPresenceUnavailable = Boolean(presenceError);
                isFriendOnline = Boolean(
                    !presenceError &&
                    isPresenceFresh(friendPresence)
                );
                friendPresenceStates.set(friend.id, {
                    online: isFriendOnline,
                    lastSeen: friendPresence?.last_seen || null,
                    revision: presenceRevision
                });
            }

            scheduleFriendPresenceExpiry();

            const currentPresenceState = friendPresenceStates.get(friend.id);
            if (
                currentPresenceState &&
                !isFriendPresenceStateFresh(currentPresenceState)
            ) {
                expireFriendPresenceState(friend.id, currentPresenceState.revision);
                isFriendOnline = false;
            }

            const shouldLoadLastMessage = Boolean(
                conversation &&
                isFriendOnline &&
                friendPresenceStates.get(friend.id)?.online === true
            );
            const [unreadCount, loadedLastMessage] = await Promise.all([
                conversation ? getUnreadCount(conversation.id) : 0,
                shouldLoadLastMessage ? getLastMessage(conversation.id) : null
            ]);
            let lastMessage = loadedLastMessage;

            if (
                currentUser?.id !== friendsLoadUserId ||
                friendListLoadGeneration !== friendsLoadGeneration
            ) {
                return;
            }

            const finalPresenceState = friendPresenceStates.get(friend.id);
            if (
                finalPresenceState &&
                !isFriendPresenceStateFresh(finalPresenceState)
            ) {
                expireFriendPresenceState(friend.id, finalPresenceState.revision);
                isFriendOnline = false;
                lastMessage = null;
            }

            const lastMessageTime = isFriendOnline && lastMessage
                ? lastMessage.created_at
                : "";
            const friendPresenceDisplay = friendPresenceUnavailable
                ? "unavailable"
                : isFriendOnline
                    ? "online"
                    : "offline";
            const friendPresenceLabel = friendPresenceDisplay === "online"
                ? "Online"
                : friendPresenceDisplay === "unavailable"
                    ? "Unavailable"
                    : "Offline";
            const privatePreviewMessage = friendPresenceUnavailable
                ? "This is private while your friend's status is unavailable."
                : "This is private because your friend is offline.";
            const preview = !isFriendOnline
                ? `<p class="lastMessagePreview">${privatePreviewMessage}</p>`
                : lastMessage
                    ? `<p class="lastMessagePreview">${lastMessage.deleted_at
                        ? "This message was deleted"
                        : escapeHtml(lastMessage.body)
                    }</p>`
                    : "";

            const friendDiv = document.createElement("div");
            friendDiv.dataset.userId = friend.id;
            friendDiv.dataset.lastMessageTime = lastMessageTime;
            const isSelectedFriend = selectedUser?.id === friend.id;
            friendDiv.className = isSelectedFriend
                ? "friend-item is-selected"
                : "friend-item";
            friendDiv.innerHTML = `
                <div class="friendIdentity">
                    <div class="friendIdentityMain">
                        <button class="friendProfileTrigger" type="button" aria-label="View profile of ${escapeHtml(friend.display_name || friend.username)}">
                            <span class="profileAvatar profileAvatarSmall" aria-hidden="true"></span>
                            <span class="friendProfileText">
                                <strong class="personName">${escapeHtml(friend.display_name || friend.username)}</strong>
                                <span class="personUsername">@${escapeHtml(friend.username)}</span>
                            </span>
                        </button>
                    </div>
                    <span class="friendPresence" data-state="${friendPresenceDisplay}">
                        <span class="presenceDot" aria-hidden="true"></span>
                        <span class="presenceLabel">${friendPresenceLabel}</span>
                    </span>
                    ${unreadCount > 0
                        ? `<span class="unreadBadge">${unreadCount}</span>`
                        : ""
                    }
                </div>
                ${preview}
                <button
                    class="openFriendBtn"
                    type="button"
                    aria-label="Open chat with ${escapeHtml(friend.display_name || friend.username)}"
                    ${isSelectedFriend ? 'aria-current="page"' : ""}
                    data-user-id="${friend.id}"
                    data-conversation-id="${conversation?.id || ""}"
                >
                    Open Chat
                </button>
            `;

            setProfileAvatar(friendDiv.querySelector(".profileAvatar"), friend);
            friendDiv.querySelector(".friendProfileTrigger").addEventListener("click", () => {
                void openPublicProfile(friend, "friends");
            });

            if (!list.querySelector(".friend-item")) list.innerHTML = "";
            list.appendChild(friendDiv);
            }
        };
        await Promise.all(
            Array.from(
                { length: Math.min(4, friendships.length) },
                () => loadNextFriend()
            )
        );
        sortFriendsList();

        if (!list.querySelector(".friend-item")) {
            showListFeedback(
                list,
                profilesError ? "Could not load friends" : "No friends found",
                profilesError ? "Please try again in a moment." : "Your friends will appear here."
            );
        }
    }
);

document.addEventListener("click", async (event) => {

    if (!event.target.classList.contains("openFriendBtn")) {
        return;
    }

    const friendOpenIntent =
        ++friendOpenIntentGeneration;
    const authUserId =
        currentUser?.id;
    const selectionGeneration =
        selectedChatGeneration;
    const isCurrentFriendOpenIntent = () => Boolean(
        authUserId &&
        currentUser?.id === authUserId &&
        friendOpenIntentGeneration === friendOpenIntent
    );

    // PERFORMANCE AUDIT ONLY
    const perf =
        startChatOpenPerformance("friend panel");
    const userId =
        event.target.dataset.userId;
    if (!userId || !authUserId) {
        return;
    }

    const profileStage = startChatOpenStage(
        perf,
        "Friend profile lookup SELECT",
        "Supabase/network wait"
    );
    const {
        data: friend,
        error
    } = await client
        .from("profiles")
        .select(
            "id, username, display_name"
        )
        .eq(
            "id",
            userId
        )
        .single();
    endChatOpenStage(perf, profileStage);

    if (
        !isCurrentFriendOpenIntent() ||
        selectedChatGeneration !== selectionGeneration
    ) {
        return;
    }

    if (error) {

        console.error(
            "OPEN FRIEND ERROR:",
            error
        );

        message("Could not open this friend.");
        markChatOpenMilestone(perf, "friend profile lookup failed");
        reportChatOpenPerformance(perf);

        return;
    }

    await openUser(friend, perf);

    if (
        !isCurrentFriendOpenIntent() ||
        selectedUser?.id !== userId
    ) {
        return;
    }

    friendPanelView = null;
    friendListLoadGeneration += 1;
    friendRequestListLoadGeneration += 1;
    $("friendRequestsPanel")
        .classList.add("hidden");
    syncSidebarNavigationState();
    markChatOpenMilestone(
        perf,
        "friend panel dismissed / header unoccluded"
    );

});


$("requestsBtn").addEventListener(
    "click",
    async () => {

        navigateToView("requests");
        setFriendPanelView("requests");
        friendListLoadGeneration += 1;
        const requestsLoadUserId = currentUser?.id;
        const requestsLoadGeneration =
            ++friendRequestListLoadGeneration;

        const panel =
            $("friendRequestsPanel");

        const list =
            $("friendRequestsList");

        panel.classList.remove("hidden");
        syncSidebarNavigationState("requestsBtn");

        showListFeedback(list, "Loading friend requests…");

        if (!requestsLoadUserId) {
            list.innerHTML =
                "<p>Please log in again.</p>";
            return;
        }

        await waitForViewPaint();
        if (currentUser?.id !== requestsLoadUserId ||
            friendRequestListLoadGeneration !== requestsLoadGeneration) return;

        const {
            data: requests,
            error
        } = await client
            .from("friend_requests")
            .select(
                "id, sender_id, receiver_id, status, created_at"
            )
            .eq(
                "receiver_id",
                requestsLoadUserId
            )
            .eq(
                "status",
                "pending"
            )
            .order(
                "created_at",
                {
                    ascending: false
                }
            );

        if (
            currentUser?.id !== requestsLoadUserId ||
            friendRequestListLoadGeneration !== requestsLoadGeneration ||
            friendPanelView !== "requests"
        ) {
            return;
        }

        if (error) {

            console.error(
                "FRIEND REQUESTS LOAD ERROR:",
                error
            );

            list.innerHTML =
                "<p>Could not load friend requests.</p>";

            return;
        }

        const incomingRequests = Array.isArray(requests)
            ? requests.filter(request =>
                request.receiver_id === requestsLoadUserId &&
                request.sender_id !== requestsLoadUserId &&
                request.status === "pending"
            )
            : [];

        if (incomingRequests.length) {
            incomingRequests.forEach(request => {
                friendRequestRelationshipRows.set(request.id, request);
            });
        }

        if (!incomingRequests.length) {

            showListFeedback(list, "No friend requests yet", "New requests will appear here.");

            return;
        }

        const senderIds = [...new Set(incomingRequests.map(request => request.sender_id))];
        const { data: senders, error: sendersError } = await client
            .from("profiles")
            .select("id, username, display_name, avatar_url")
            .in("id", senderIds);
        if (
            currentUser?.id !== requestsLoadUserId ||
            friendRequestListLoadGeneration !== requestsLoadGeneration ||
            friendPanelView !== "requests"
        ) return;
        if (sendersError) console.error("SENDER PROFILES ERROR:", sendersError);
        const sendersById = new Map(
            (Array.isArray(senders) ? senders : []).map(sender => [sender.id, sender])
        );
        list.innerHTML = "";

        for (const request of incomingRequests) {
            const sender = sendersById.get(request.sender_id);
            if (!sender) continue;

            const requestDiv =
                document.createElement("div");

            requestDiv.className =
                "friend-request-item";

            requestDiv.innerHTML = `
                <div class="relationshipIdentity">
                    <span class="profileAvatar profileAvatarSmall" aria-hidden="true"></span>
                    <div class="relationshipIdentityText">
                        <strong>${escapeHtml(sender.display_name || sender.username)}</strong>
                        <span class="personUsername">@${escapeHtml(sender.username)}</span>
                    </div>
                </div>

                <p class="requestDescription">
                    wants to be your friend.
                </p>

                <button
                    class="acceptRequestBtn"
                    data-request-id="${request.id}">
                    Accept
                </button>

                <button
                    class="rejectRequestBtn"
                    data-request-id="${request.id}">
                    Reject
                </button>
            `;

            setProfileAvatar(requestDiv.querySelector(".profileAvatar"), sender);

            list.appendChild(
                requestDiv
            );
        }

        if (sendersError && !list.querySelector(".friend-request-item")) {
            showListFeedback(list, "Could not load requests", "Please try again in a moment.");
        }

    }
);
$("closeFriendRequestsBtn").addEventListener(
    "click",
    () => {

        setFriendPanelView(null);
        friendListLoadGeneration += 1;
        friendRequestListLoadGeneration += 1;

        navigateToView("home");

    }
);

// ======================================================
// ACCEPT FRIEND REQUEST
// ======================================================

document.addEventListener(
    "click",
    async (event) => {

        if (
            !event.target.classList.contains(
                "acceptRequestBtn"
            )
        ) {
            return;
        }

        const requestId =
            event.target.dataset.requestId;

        const authUserId = currentUser?.id;
        const requestsGeneration = friendRequestListLoadGeneration;
        if (!authUserId) {
            return;
        }

        const decision = await FriendRequestLifecycle.decideIncomingRequest(
            client,
            requestId,
            authUserId,
            "accepted"
        );

        if (currentUser?.id !== authUserId) {
            return;
        }

        if (!decision.ok) {

            console.error(
                "ACCEPT FRIEND REQUEST ERROR:",
                decision.error
            );

            message(
                describeFriendRequestError(
                    decision.error,
                    "Could not accept friend request"
                )
            );

            return;
        }

        if (decision.peerId) {
            await getFriendRelationshipState(decision.peerId, authUserId);
            if (currentUser?.id !== authUserId) {
                return;
            }
        }

        message(
            "Friend request accepted."
        );

        if (
            friendRequestListLoadGeneration !== requestsGeneration ||
            friendPanelView !== "requests"
        ) {
            return;
        }

        event.target
            .parentElement
            .remove();

        const list =
            $("friendRequestsList");

        if (
            list.children.length === 0
        ) {
            showListFeedback(list, "No friend requests yet", "New requests will appear here.");
        }

    }
);


// ======================================================
// REJECT FRIEND REQUEST
// ======================================================

document.addEventListener(
    "click",
    async (event) => {

        if (
            !event.target.classList.contains(
                "rejectRequestBtn"
            )
        ) {
            return;
        }

        const requestId =
            event.target.dataset.requestId;

        const authUserId = currentUser?.id;
        const requestsGeneration = friendRequestListLoadGeneration;
        if (!authUserId) {
            return;
        }

        const decision = await FriendRequestLifecycle.decideIncomingRequest(
            client,
            requestId,
            authUserId,
            "rejected"
        );

        if (currentUser?.id !== authUserId) {
            return;
        }

        if (!decision.ok) {

            console.error(
                "REJECT FRIEND REQUEST ERROR:",
                decision.error
            );

            message(
                describeFriendRequestError(
                    decision.error,
                    "Could not reject friend request"
                )
            );

            return;
        }

        if (decision.peerId) {
            await getFriendRelationshipState(decision.peerId, authUserId);
            if (currentUser?.id !== authUserId) {
                return;
            }
        }

        message(
            "Friend request rejected."
        );

        if (
            friendRequestListLoadGeneration !== requestsGeneration ||
            friendPanelView !== "requests"
        ) {
            return;
        }

        event.target
            .parentElement
            .remove();

        const list =
            $("friendRequestsList");

        if (
            list.children.length === 0
        ) {
            showListFeedback(list, "No friend requests yet", "New requests will appear here.");
        }

    }
);

$("blockedBtn").addEventListener(
    "click",
    async () => {

        navigateToView("blocked");
        setFriendPanelView("blocked");
        friendListLoadGeneration += 1;
        const blockedLoadUserId = currentUser?.id;
        const blockedLoadGeneration = ++friendRequestListLoadGeneration;

        const panel = $("friendRequestsPanel");
        const list = $("friendRequestsList");

        panel.classList.remove("hidden");
        syncSidebarNavigationState("blockedBtn");

        showListFeedback(list, "Loading blocked users…");

        if (!blockedLoadUserId) {

            list.innerHTML =
                "<p>Please log in again.</p>";

            return;
        }

        await waitForViewPaint();
        if (currentUser?.id !== blockedLoadUserId ||
            friendRequestListLoadGeneration !== blockedLoadGeneration ||
            friendPanelView !== "blocked") return;

        const {
            data: blockedUsers,
            error
        } = await client
            .from("blocked_users")
            .select(
                "id, blocked_id, created_at"
            )
            .eq(
                "blocker_id",
                blockedLoadUserId
            )
            .order(
                "created_at",
                {
                    ascending: false
                }
            );

        if (
            currentUser?.id !== blockedLoadUserId ||
            friendRequestListLoadGeneration !== blockedLoadGeneration ||
            friendPanelView !== "blocked"
        ) return;

        if (error) {

            console.error(
                "BLOCKED USERS LOAD ERROR:",
                error
            );

            list.innerHTML =
                "<p>Could not load blocked users.</p>";

            return;
        }

        if (
            !blockedUsers ||
            blockedUsers.length === 0
        ) {

            showListFeedback(list, "No blocked users", "People you block will appear here.");

            return;
        }

        const blockedIds = [...new Set(blockedUsers.map(block => block.blocked_id))];
        const { data: blockedProfiles, error: blockedProfilesError } = await client
            .from("profiles")
            .select("id, username, display_name, avatar_url")
            .in("id", blockedIds);
        if (
            currentUser?.id !== blockedLoadUserId ||
            friendRequestListLoadGeneration !== blockedLoadGeneration ||
            friendPanelView !== "blocked"
        ) return;
        if (blockedProfilesError) console.error("BLOCKED USER PROFILES ERROR:", blockedProfilesError);
        const blockedProfilesById = new Map(
            (Array.isArray(blockedProfiles) ? blockedProfiles : [])
                .map(user => [user.id, user])
        );
        list.innerHTML = "";

        for (const block of blockedUsers) {
            const user = blockedProfilesById.get(block.blocked_id);
            if (!user) continue;

            const div =
                document.createElement("div");

            div.className =
                "blocked-user-item";

            div.innerHTML = `
                <div class="blockedIdentity">
                    <span class="profileAvatar profileAvatarSmall" aria-hidden="true"></span>
                    <div class="blockedIdentityText">
                        <strong class="personName">${escapeHtml(user.display_name || user.username)}</strong>
                        <span class="personUsername">@${escapeHtml(user.username)}</span>
                        <span class="blockedDescription">You blocked this person.</span>
                    </div>
                </div>

                <button
                    class="unblockUserBtn"
                    type="button"
                    aria-label="Unblock ${escapeHtml(user.display_name || user.username)}"
                    data-user-id="${user.id}"
                    data-block-id="${block.id}"
                >
                    Unblock
                </button>
            `;

            setProfileAvatar(div.querySelector(".profileAvatar"), user);

            list.appendChild(div);
        }

        if (list.children.length === 0) {

            showListFeedback(
                list,
                blockedProfilesError ? "Could not load blocked users" : "No blocked users found",
                blockedProfilesError ? "Please try again in a moment." : "People you block will appear here."
            );

        }

    }
);

document.addEventListener(
    "click",
    async event => {

        if (
            !event.target.classList.contains(
                "unblockUserBtn"
            )
        ) {
            return;
        }

        const blockId =
            event.target.dataset.blockId;

        if (!blockId) {
            return;
        }

        const {
            error
        } = await client
            .from("blocked_users")
            .delete()
            .eq(
                "id",
                blockId
            )
            .eq(
                "blocker_id",
                currentUser.id
            );

        if (error) {

            console.error(
                "UNBLOCK USER ERROR:",
                error
            );

            message(
                "Could not unblock user."
            );

            return;
        }

        await broadcastBlockStatus(event.target.dataset.userId, "unblocked");

        message(
            "User unblocked successfully."
        );

        event.target
            .closest(
                ".blocked-user-item"
            )
            .remove();

        const list =
            $("friendRequestsList");

        if (
            list.children.length === 0
        ) {

            showListFeedback(list, "No blocked users", "People you block will appear here.");

        }

    }
);

$("profileBtn").addEventListener("click", () => {
    closeAccountPopover();
    dedicatedViewReturnTo = accountReturnView;
    navigateToView("profile");

    $("profileUsername").textContent =
        currentProfile?.username || "-";

    $("profileDisplayName").textContent =
        currentProfile?.display_name || "-";

    $("profileEmail").textContent =
        currentUser?.email || "-";

    $("profileStatus").textContent =
        "Online";

});

// Applies profile changes saved from the settings page in another tab.
window.addEventListener("storage", event => {
    if (event.key !== "talkspace-profile-updated" || !currentUser) return;

    try {
        const update = JSON.parse(event.newValue || "null");
        if (
            !update ||
            update.userId !== currentUser.id ||
            typeof update.display_name !== "string"
        ) return;

        currentProfile = {
            ...currentProfile,
            display_name: update.display_name
        };
        $("profileDisplayName").textContent = update.display_name || "-";
    } catch (error) {
        console.error("PROFILE UPDATE EVENT ERROR:", error);
    }
});

$("closeProfileBtn").addEventListener("click", () => {
    returnFromDedicatedView();
});

$("mobileBackToFriendsBtn").addEventListener(
    "click",
    returnToFriendsFromMobileChat
);


// ======================================================
// AUTH STATE CHANGE
// ======================================================

// Routes Supabase auth transitions through the existing session restore/cleanup lifecycle.
client.auth.onAuthStateChange(
    (event, session) => {

        window.TalkSpaceLogger?.debug(
            "AUTH EVENT:",
            event
        );


        if (event === "SIGNED_OUT") {
            observedAuthIdentityId = null;
            authIdentityTransitionGeneration += 1;
            authIdentityTransitionPending = false;
            authIdentityTransitionTargetId = null;
            void cleanupSignedOutState().catch(error => {
                console.error(
                    "SIGNED-OUT CLEANUP ERROR:",
                    error
                );
            });
            return;
        }

        if (session?.user) {
            const nextUser = session.user;
            const nextUserId = nextUser.id || null;
            const previousUserId = observedAuthIdentityId || currentUser?.id || null;

            if (nextUserId) {
                observedAuthIdentityId = nextUserId;
            }

            // Ignore repeated auth events for the identity already waiting on
            // cleanup. It must not become active before the old channel is gone.
            if (
                authIdentityTransitionPending &&
                nextUserId === authIdentityTransitionTargetId
            ) {
                return;
            }

            if (previousUserId && nextUserId && previousUserId !== nextUserId) {
                const transitionGeneration = ++authIdentityTransitionGeneration;
                authIdentityTransitionPending = true;
                authIdentityTransitionTargetId = nextUserId;

                void (async () => {
                    try {
                        await cleanupSignedOutState();

                        if (
                            transitionGeneration !== authIdentityTransitionGeneration ||
                            observedAuthIdentityId !== nextUserId ||
                            authIdentityTransitionTargetId !== nextUserId
                        ) {
                            return;
                        }

                        currentUser = nextUser;
                        await loadCurrentUser();
                    } catch (error) {
                        console.error("AUTH IDENTITY TRANSITION ERROR:", error);
                    } finally {
                        if (transitionGeneration === authIdentityTransitionGeneration) {
                            authIdentityTransitionPending = false;
                            authIdentityTransitionTargetId = null;
                        }
                    }
                })();
                return;
            }

            currentUser = nextUser;
        }

    }
);


// ======================================================
// INITIAL SESSION CHECK
// ======================================================

// Initializes auth restoration and the private application only after session verification.
async function initializeApp() {

    const startupGeneration = authSessionGeneration;

    window.TalkSpaceLogger?.debug(
        "Checking existing session..."
    );


    const {
        data,
        error
    } =
        await client.auth.getSession();

    if (authSessionGeneration !== startupGeneration) {
        return;
    }


    if (error) {

        console.error(
            "SESSION ERROR:",
            error
        );

        return;

    }


    if (
        data &&
        data.session
    ) {

        currentUser =
            data.session.user;


        await loadCurrentUser();

    } else {

        window.TalkSpaceLogger?.debug(
            "No active session."
        );


        hide("mainScreen");

        show("authScreen");

        show("authChoice");

        hide("signupBox");

        hide("loginBox");

        hide("otpBox");

        hide("profileBox");

    }

}


// ======================================================
// START APPLICATION
// ======================================================

initializeApp();


// ======================================================
// MESSAGE CONTEXT MENU
// ======================================================

document.addEventListener(
    "contextmenu",
    event => {

        const message =
            event.target.closest(
                ".message"
            );

        if (!message) {
            return;
        }

        event.preventDefault();

        const menu =
            $("messageContextMenu");

        if (!menu) {
            return;
        }

        // ------------------------------------------
        // GET SELECTED MESSAGE
        // ------------------------------------------

        const messageId =
            message.dataset.messageId;

        const senderId =
            message.dataset.senderId;

        const isDeleted =
            message.dataset.deleted ===
            "true";

        if (!messageId) {
            return;
        }

        // ------------------------------------------
        // STORE SELECTED MESSAGE
        // ------------------------------------------

        menu.dataset.messageId =
            messageId;

        menu.dataset.senderId =
            senderId || "";

        menu.dataset.deleted =
            isDeleted
                ? "true"
                : "false";

        // ------------------------------------------
        // CHECK MESSAGE OWNER
        // ------------------------------------------

        const isOwnMessage =
            senderId ===
            currentUser.id;

        // ------------------------------------------
        // GET MENU OPTIONS
        // ------------------------------------------

        const copyButton =
            $("contextCopyMessage");

        const editButton =
            $("contextEditMessage");

        const deleteForMeButton =
            $("contextDeleteForMe");

        const deleteForEveryoneButton =
            $("contextDeleteForEveryone");

        // ------------------------------------------
        // DELETED MESSAGE
        // ------------------------------------------

        if (isDeleted) {

            if (copyButton) {

                copyButton.classList.add(
                    "hidden"
                );

            }

            if (editButton) {

                editButton.classList.add(
                    "hidden"
                );

            }

            if (deleteForEveryoneButton) {

                deleteForEveryoneButton.classList.add(
                    "hidden"
                );

            }

            if (deleteForMeButton) {

                deleteForMeButton.classList.remove(
                    "hidden"
                );

            }

        }

        // ------------------------------------------
        // NORMAL MESSAGE
        // ------------------------------------------

        else {

            if (copyButton) {

                copyButton.classList.remove(
                    "hidden"
                );

            }

            if (deleteForMeButton) {

                deleteForMeButton.classList.remove(
                    "hidden"
                );

            }

            if (editButton) {

                editButton.classList.toggle(
                    "hidden",
                    !isOwnMessage
                );

            }

            if (deleteForEveryoneButton) {

                deleteForEveryoneButton.classList.toggle(
                    "hidden",
                    !isOwnMessage
                );

            }

        }

        // ------------------------------------------
        // SHOW MENU
        // ------------------------------------------

        menu.classList.remove(
            "hidden"
        );

        const menuRect = menu.getBoundingClientRect();
        const edgePadding = 8;
        const maxLeft = Math.max(
            edgePadding,
            window.innerWidth - menuRect.width - edgePadding
        );
        const maxTop = Math.max(
            edgePadding,
            window.innerHeight - menuRect.height - edgePadding
        );

        menu.style.left = `${Math.min(
            Math.max(edgePadding, event.clientX),
            maxLeft
        )}px`;
        menu.style.top = `${Math.min(
            Math.max(edgePadding, event.clientY),
            maxTop
        )}px`;

    }
);


// ======================================================
// CLOSE MESSAGE CONTEXT MENU
// ======================================================

document.addEventListener(
    "click",
    event => {

        const menu =
            $("messageContextMenu");

        if (!menu) {
            return;
        }

        if (
            !menu.contains(
                event.target
            )
        ) {

            menu.classList.add(
                "hidden"
            );

        }

    }
);


// ======================================================
// CLOSE MENU WITH ESCAPE
// ======================================================

document.addEventListener(
    "keydown",
    event => {

        if (
            event.key !==
            "Escape"
        ) {
            return;
        }

        const menu =
            $("messageContextMenu");

        if (menu) {
            menu.classList.add(
                "hidden"
            );
        }

        const chatMenu = $("chatMoreMenu");
        const chatMoreButton = $("chatMoreBtn");

        if (chatMenu && !chatMenu.classList.contains("hidden")) {
            chatMenu.classList.add("hidden");
            chatMoreButton?.setAttribute("aria-expanded", "false");
            chatMoreButton?.focus();
        }

    }
);

// ======================================================
// COPY MESSAGE
// ======================================================

document.addEventListener(
    "click",
    async event => {

        if (
            event.target.id !==
            "contextCopyMessage"
        ) {
            return;
        }

        const menu =
            $("messageContextMenu");

        if (!menu) {
            return;
        }

        const messageId =
            menu.dataset.messageId;

        if (!messageId) {
            return;
        }

        const messageElement =
            document.querySelector(
                `.message[data-message-id="${messageId}"]`
            );

        if (!messageElement) {
            return;
        }

        const content =
            messageElement.querySelector(
                ".messageContent"
            );

        if (!content) {
            return;
        }

        const text =
            (content.dataset.messageBody ?? content.textContent).trim();

        if (!text) {
            return;
        }

        try {

            await navigator.clipboard.writeText(
                text
            );

            message(
                "Message copied."
            );

        } catch (error) {

            console.error(
                "COPY MESSAGE ERROR:",
                error
            );

            message(
                "Could not copy the message."
            );

        }

        menu.classList.add(
            "hidden"
        );

    }
);

// ======================================================
// CHAT MORE MENU
// ======================================================

document.addEventListener(
    "click",
    event => {

        const trigger = event.target.closest?.("#chatMoreBtn");
        const menu = $("chatMoreMenu");

        if (!menu) {
            return;
        }

        if (trigger) {
            const isOpening = menu.classList.contains("hidden");

            if (!isOpening) {
                menu.classList.add("hidden");
                trigger.setAttribute("aria-expanded", "false");
                return;
            }

            menu.classList.remove("hidden");
            trigger.setAttribute("aria-expanded", "true");

            const triggerRect = trigger.getBoundingClientRect();
            const menuRect = menu.getBoundingClientRect();
            const left = Math.max(
                8,
                Math.min(
                    triggerRect.right - menuRect.width,
                    window.innerWidth - menuRect.width - 8
                )
            );
            const top = Math.min(
                triggerRect.bottom + 6,
                window.innerHeight - menuRect.height - 8
            );

            menu.style.left = `${left}px`;
            menu.style.top = `${Math.max(8, top)}px`;
            menu.querySelector("button:not(:disabled)")?.focus();
            return;
        }

        if (menu.contains(event.target)) {
            if (event.target.closest("#friendRequestBtn, #blockBtn, #clearChatBtn")) {
                menu.classList.add("hidden");
                $("chatMoreBtn")?.setAttribute("aria-expanded", "false");
            }
            return;
        }

        menu.classList.add("hidden");
        $("chatMoreBtn")?.setAttribute("aria-expanded", "false");

    }
);

// Keep the same relationship and block buttons while placing them in the mobile overflow menu.
const chatManagementActions = $("chatManagementActions");
const chatMoreMenu = $("chatMoreMenu");
const chatMoreButton = $("chatMoreBtn");
const chatHeaderToolbar = chatMoreButton?.parentElement;
const mobileChatHeaderQuery = window.matchMedia("(max-width: 700px)");

function syncChatHeaderActionsForViewport(isMobile = mobileChatHeaderQuery.matches) {
    if (!chatManagementActions || !chatMoreMenu || !chatHeaderToolbar || !chatMoreButton) {
        return;
    }

    if (isMobile) {
        chatMoreMenu.prepend(chatManagementActions);
        return;
    }

    chatHeaderToolbar.insertBefore(chatManagementActions, chatMoreButton);
    chatMoreMenu.classList.add("hidden");
    chatMoreButton.setAttribute("aria-expanded", "false");
}

syncChatHeaderActionsForViewport();
mobileChatHeaderQuery.addEventListener("change", event => {
    syncChatHeaderActionsForViewport(event.matches);
});

// ======================================================
// CLEAR CHAT
// ======================================================

document.addEventListener(
    "click",
    async event => {

        if (
            event.target.id !==
            "clearChatBtn"
        ) {
            return;
        }

        if (
            !currentUser ||
            !selectedConversation ||
            !selectedUser
        ) {
            message(
                "Please open a chat first."
            );

            return;
        }

        const userId = currentUser.id;
        const conversationId = selectedConversation.id;
        const peerId = selectedUser.id;
        const selectionGeneration = selectedChatGeneration;
        const loadGeneration = chatMessageLoadGeneration;
        const operationGeneration = ++clearChatOperationGeneration;
        const isCurrentClearChat = () => Boolean(
            currentUser?.id === userId &&
            selectedConversation?.id === conversationId &&
            selectedUser?.id === peerId &&
            selectedChatGeneration === selectionGeneration &&
            chatMessageLoadGeneration === loadGeneration &&
            clearChatOperationGeneration === operationGeneration
        );

        const confirmed =
            confirm(
                "Clear this chat for you?"
            );

        if (!confirmed) {
            return;
        }

        if (!isCurrentClearChat()) {
            return;
        }

        try {

            // ----------------------------------
            // GET ALL MESSAGES
            // ----------------------------------

            const {
                data: messages,
                error: messagesError
            } =
                await client
                    .from("messages")
                    .select("id")
                    .eq(
                        "conversation_id",
                        conversationId
                    );

            if (messagesError) {
                throw messagesError;
            }

            if (!isCurrentClearChat()) {
                return;
            }

            if (
                !messages ||
                messages.length === 0
            ) {

                const menu =
                    $("chatMoreMenu");

                if (menu) {
                    menu.classList.add(
                        "hidden"
                    );
                }

                message(
                    "This chat is already empty."
                );

                return;

            }

            // ----------------------------------
            // GET ALREADY DELETED MESSAGES
            // ----------------------------------

            const {
                data: existingDeleted,
                error: existingError
            } =
                await client
                    .from("message_deleted_for")
                    .select("message_id")
                    .eq(
                        "user_id",
                        userId
                    );

            if (existingError) {
                throw existingError;
            }

            if (!isCurrentClearChat()) {
                return;
            }

            const alreadyDeleted =
                new Set(
                    (existingDeleted || [])
                        .map(
                            item =>
                                item.message_id
                        )
                );

            // ----------------------------------
            // KEEP ONLY NEW DELETIONS
            // ----------------------------------

            const newRows =
                messages
                    .filter(
                        item =>
                            !alreadyDeleted.has(
                                item.id
                            )
                    )
                    .map(
                        item => ({
                            message_id:
                                item.id,

                            user_id:
                                userId
                        })
                    );

            // ----------------------------------
            // INSERT NEW DELETIONS
            // ----------------------------------

            if (
                newRows.length > 0
            ) {

                if (!isCurrentClearChat()) {
                    return;
                }

                const {
                    error: insertError
                } =
                    await client
                        .from(
                            "message_deleted_for"
                        )
                        .insert(
                            newRows
                        );

                if (insertError) {
                    throw insertError;
                }

                if (!isCurrentClearChat()) {
                    return;
                }

            }

            // ----------------------------------
            // CLOSE MENU
            // ----------------------------------

            const menu =
                $("chatMoreMenu");

            if (menu) {
                menu.classList.add(
                    "hidden"
                );
            }

            // ----------------------------------
            // CLEAR SELECTION
            // ----------------------------------

            clearMessageSelection();

            // ----------------------------------
            // REFRESH CHAT IMMEDIATELY
            // ----------------------------------

            await loadMessages();

            if (!isCurrentClearChat()) {
                return;
            }

            message(
                "Chat cleared for you."
            );

        } catch (error) {

            console.error(
                "CLEAR CHAT ERROR:",
                error
            );

            if (isCurrentClearChat()) {
                message(
                    "Could not clear the chat."
                );
            }

        }

    }
);

// ======================================================
// SELECT MESSAGE FROM CONTEXT MENU
// ======================================================

document.addEventListener(
    "click",
    event => {

        if (
            event.target.id !==
            "contextSelectMessage"
        ) {
            return;
        }

        const menu =
            $("messageContextMenu");

        if (!menu) {
            return;
        }

        const messageId =
            menu.dataset.messageId;

        if (!messageId) {
            return;
        }

        const messageElement =
            document.querySelector(
                `.message[data-message-id="${messageId}"]`
            );

        if (!messageElement) {
            return;
        }

        menu.classList.add(
            "hidden"
        );

        toggleMessageSelection(
            messageElement
        );

    }
);


// ======================================================
// DELETE MESSAGE FOR ME
// ======================================================

document.addEventListener(
    "click",
    async event => {

        if (
            event.target.id !==
            "contextDeleteForMe"
        ) {
            return;
        }

        const menu =
            $("messageContextMenu");

        if (!menu) {
            return;
        }

        const messageId =
            menu.dataset.messageId;

        if (!messageId) {
            return;
        }

        const confirmed =
            confirm(
                "Delete this message for you?"
            );

        if (!confirmed) {
            return;
        }

        menu.classList.add(
            "hidden"
        );

        await deleteMessageForMe(
            messageId
        );

    }
);

// ======================================================
// DELETE MESSAGE FOR EVERYONE
// ======================================================

document.addEventListener(
    "click",
    async event => {

        if (
            event.target.id !==
            "contextDeleteForEveryone"
        ) {
            return;
        }

        const menu =
            $("messageContextMenu");

        if (!menu) {
            return;
        }

        const messageId =
            menu.dataset.messageId;

        if (!messageId) {
            return;
        }

        const confirmed =
            confirm(
                "Delete this message for everyone?"
            );

        if (!confirmed) {
            return;
        }

        menu.classList.add(
            "hidden"
        );

        await deleteMessageForEveryone(
            messageId
        );

    }
);

// ======================================================
// EDIT MESSAGE
// ======================================================

document.addEventListener(
    "click",
    event => {

        if (
            event.target.id !==
            "contextEditMessage"
        ) {
            return;
        }

        const menu =
            $("messageContextMenu");

        if (!menu) {
            return;
        }

        const messageId =
            menu.dataset.messageId;

        if (!messageId) {
            return;
        }

        const messageElement =
            document.querySelector(
                `.message[data-message-id="${messageId}"]`
            );

        if (!messageElement) {
            return;
        }

        const content =
            messageElement.querySelector(
                ".messageContent"
            );

        if (!content) {
            return;
        }

        const originalContentHTML =
            content.innerHTML;

        const currentText =
            content.dataset.messageBody ?? (() => {
                const textOnly = content.cloneNode(true);
                textOnly.querySelectorAll(".editedLabel").forEach(label => label.remove());
                return textOnly.textContent.trim();
            })();

        if (!currentText) {
            return;
        }

        // ------------------------------------------
        // CLOSE CONTEXT MENU
        // ------------------------------------------

        menu.classList.add(
            "hidden"
        );

        // ------------------------------------------
        // CREATE EDIT INPUT
        // ------------------------------------------

        const input =
            document.createElement(
                "input"
            );

        input.type =
            "text";

        input.value =
            currentText;

        input.className =
            "messageEditInput";

        // ------------------------------------------
        // CREATE EDIT ACTIONS
        // ------------------------------------------

        const actions =
            document.createElement(
                "div"
            );

        actions.className =
            "messageEditActions";

        const saveButton =
            document.createElement(
                "button"
            );

        saveButton.type =
            "button";

        saveButton.textContent =
            "Save";

        const cancelButton =
            document.createElement(
                "button"
            );

        cancelButton.type =
            "button";

        cancelButton.textContent =
            "Cancel";

        actions.appendChild(
            saveButton
        );

        actions.appendChild(
            cancelButton
        );

        // ------------------------------------------
        // REPLACE MESSAGE CONTENT
        // ------------------------------------------

        content.innerHTML =
            "";

        content.appendChild(
            input
        );

        content.appendChild(
            actions
        );

        input.focus();

        input.select();

        // ------------------------------------------
        // CANCEL
        // ------------------------------------------

        cancelButton.addEventListener(
            "click",
            () => {

                content.innerHTML =
                    originalContentHTML;

            }
        );

        // ------------------------------------------
        // SAVE
        // ------------------------------------------

        saveButton.addEventListener(
            "click",
            async () => {

                const newText =
                    input.value.trim();

                if (!newText) {

                    message(
                        "Message cannot be empty."
                    );

                    return;

                }

                if (
                    newText ===
                    currentText
                ) {

                    content.innerHTML =
                        originalContentHTML;

                    return;

                }

                saveButton.disabled =
                    true;

                const {
                    error
                } =
                    await client
                        .from("messages")
                        .update({
                            body:
                                newText,

                            edited_at:
                                new Date()
                                    .toISOString()
                        })
                        .eq(
                            "id",
                            messageId
                        )
                        .eq(
                            "sender_id",
                            currentUser.id
                        );

                if (error) {

                    console.error(
                        "EDIT MESSAGE ERROR:",
                        error
                    );

                    message(
                        "Could not edit the message."
                    );

                    saveButton.disabled =
                        false;

                    return;

                }

              await loadMessages();

               message(
                "Message edited."
                );

            }
        );

    }
);

// ======================================================
// MOBILE LONG PRESS MESSAGE MENU
// ======================================================

let messageLongPressTimer = null;

let messageLongPressTriggered = false;


document.addEventListener(
    "touchstart",
    event => {

        const message =
            event.target.closest(
                ".message"
            );

        if (!message) {
            return;
        }

        messageLongPressTriggered =
            false;

        messageLongPressTimer =
            setTimeout(
                () => {

                    messageLongPressTriggered =
                        true;

                    // ----------------------------------
                   // MESSAGE MULTI-SELECT
                  // ----------------------------------

                 if (messageSelectionMode) {

                    toggleMessageSelection(
                       message
                   );

                     return;

                    }

                    const menu =
                        $("messageContextMenu");

                    if (!menu) {
                        return;
                    }

                    const messageId =
                        message.dataset.messageId;

                    const senderId =
                        message.dataset.senderId;

                    const isDeleted =
                        message.dataset.deleted ===
                        "true";

                    if (!messageId) {
                        return;
                    }

                    // ----------------------------------
                    // STORE SELECTED MESSAGE
                    // ----------------------------------

                    menu.dataset.messageId =
                        messageId;

                    menu.dataset.senderId =
                        senderId || "";

                    menu.dataset.deleted =
                        isDeleted
                            ? "true"
                            : "false";

                    // ----------------------------------
                    // CHECK OWNER
                    // ----------------------------------

                    const isOwnMessage =
                        senderId ===
                        currentUser.id;

                    const copyButton =
                        $("contextCopyMessage");

                    const editButton =
                        $("contextEditMessage");

                    const deleteForMeButton =
                        $("contextDeleteForMe");

                    const deleteForEveryoneButton =
                        $("contextDeleteForEveryone");

                    // ----------------------------------
                    // DELETED MESSAGE
                    // ----------------------------------

                    if (isDeleted) {

                        if (copyButton) {

                            copyButton.classList.add(
                                "hidden"
                            );

                        }

                        if (editButton) {

                            editButton.classList.add(
                                "hidden"
                            );

                        }

                        if (
                            deleteForEveryoneButton
                        ) {

                            deleteForEveryoneButton.classList.add(
                                "hidden"
                            );

                        }

                        if (deleteForMeButton) {

                            deleteForMeButton.classList.remove(
                                "hidden"
                            );

                        }

                    }

                    // ----------------------------------
                    // NORMAL MESSAGE
                    // ----------------------------------

                    else {

                        if (copyButton) {

                            copyButton.classList.remove(
                                "hidden"
                            );

                        }

                        if (deleteForMeButton) {

                            deleteForMeButton.classList.remove(
                                "hidden"
                            );

                        }

                        if (editButton) {

                            editButton.classList.toggle(
                                "hidden",
                                !isOwnMessage
                            );

                        }

                        if (
                            deleteForEveryoneButton
                        ) {

                            deleteForEveryoneButton.classList.toggle(
                                "hidden",
                                !isOwnMessage
                            );

                        }

                    }

                    // ----------------------------------
                    // POSITION MENU
                    // ----------------------------------

                    const touch =
                        event.touches[0];

                    let left =
                        touch.clientX;

                    let top =
                        touch.clientY;

                    // ----------------------------------
                    // KEEP MENU INSIDE SCREEN
                    // ----------------------------------

                    const menuWidth =
                        190;

                    const menuHeight =
                        180;

                    const screenWidth =
                        window.innerWidth;

                    const screenHeight =
                        window.innerHeight;

                    if (
                        left +
                            menuWidth >
                        screenWidth
                    ) {

                        left =
                            screenWidth -
                            menuWidth -
                            10;

                    }

                    if (
                        top +
                            menuHeight >
                        screenHeight
                    ) {

                        top =
                            screenHeight -
                            menuHeight -
                            10;

                    }

                    if (left < 10) {

                        left = 10;

                    }

                    if (top < 10) {

                        top = 10;

                    }

                    menu.style.left =
                        `${left}px`;

                    menu.style.top =
                        `${top}px`;

                    menu.classList.remove(
                        "hidden"
                    );

                },
                600
            );

    },
    {
        passive: true
    }
);


// ======================================================
// CANCEL MOBILE LONG PRESS
// ======================================================

document.addEventListener(
    "touchend",
    () => {

        if (
            messageLongPressTimer
        ) {

            clearTimeout(
                messageLongPressTimer
            );

            messageLongPressTimer =
                null;

        }

    },
    {
        passive: true
    }
);


document.addEventListener(
    "touchmove",
    () => {

        if (
            messageLongPressTimer
        ) {

            clearTimeout(
                messageLongPressTimer
            );

            messageLongPressTimer =
                null;

        }

    },
    {
        passive: true
    }
);

// ======================================================
// DRAGGABLE LOCAL VIDEO PREVIEW
// ======================================================

function setupLocalVideoDrag() {

    const localVideo =
        document.getElementById(
            "localVideo"
        );

    const videoArea =
        document.getElementById(
            "videoCallArea"
        );


    if (
        !localVideo ||
        !videoArea
    ) {
        return;
    }


    let isDragging =
        false;

    let startX =
        0;

    let startY =
        0;

    let startLeft =
        0;

    let startTop =
        0;


    function startDrag(
        clientX,
        clientY
    ) {

        const videoRect =
            localVideo.getBoundingClientRect();

        const areaRect =
            videoArea.getBoundingClientRect();


        startX =
            clientX;

        startY =
            clientY;


        startLeft =
            videoRect.left -
            areaRect.left;

        startTop =
            videoRect.top -
            areaRect.top;


        localVideo.style.right =
            "auto";

        localVideo.style.bottom =
            "auto";

        localVideo.style.left =
            startLeft + "px";

        localVideo.style.top =
            startTop + "px";


        isDragging =
            true;


        localVideo.classList.add(
            "dragging"
        );

    }


    function moveDrag(
        clientX,
        clientY
    ) {

        if (!isDragging) {
            return;
        }


        const areaRect =
            videoArea.getBoundingClientRect();

        const videoRect =
            localVideo.getBoundingClientRect();


        let newLeft =
            startLeft +
            (
                clientX -
                startX
            );


        let newTop =
            startTop +
            (
                clientY -
                startY
            );


        const maxLeft =
            areaRect.width -
            videoRect.width;


        const maxTop =
            areaRect.height -
            videoRect.height;


        newLeft =
            Math.max(
                0,
                Math.min(
                    newLeft,
                    maxLeft
                )
            );


        newTop =
            Math.max(
                0,
                Math.min(
                    newTop,
                    maxTop
                )
            );


        localVideo.style.left =
            newLeft + "px";

        localVideo.style.top =
            newTop + "px";

    }


    function stopDrag() {

        if (!isDragging) {
            return;
        }


        isDragging =
            false;


        localVideo.classList.remove(
            "dragging"
        );

    }


    // --------------------------------------------------
    // MOUSE
    // --------------------------------------------------

    localVideo.addEventListener(
        "mousedown",
        event => {

            event.preventDefault();

            startDrag(
                event.clientX,
                event.clientY
            );

        }
    );


    document.addEventListener(
        "mousemove",
        event => {

            moveDrag(
                event.clientX,
                event.clientY
            );

        }
    );


    document.addEventListener(
        "mouseup",
        () => {

            stopDrag();

        }
    );


    // --------------------------------------------------
    // TOUCH
    // --------------------------------------------------

    localVideo.addEventListener(
        "touchstart",
        event => {

            if (
                !event.touches ||
                !event.touches.length
            ) {
                return;
            }


            const touch =
                event.touches[0];


            startDrag(
                touch.clientX,
                touch.clientY
            );

        },
        {
            passive: false
        }
    );


    document.addEventListener(
        "touchmove",
        event => {

            if (!isDragging) {
                return;
            }


            if (
                !event.touches ||
                !event.touches.length
            ) {
                return;
            }


            event.preventDefault();


            const touch =
                event.touches[0];


            moveDrag(
                touch.clientX,
                touch.clientY
            );

        },
        {
            passive: false
        }
    );


    document.addEventListener(
        "touchend",
        () => {

            stopDrag();

        }
    );

}


// ------------------------------------------------------
// INITIALIZE LOCAL VIDEO DRAG
// ------------------------------------------------------

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        setupLocalVideoDrag
    );

} else {

    setupLocalVideoDrag();

}
