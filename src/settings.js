"use strict";

function createSettingsController(client, onBack, onProfileUpdated, subscribeToAuth, onAccountDeleted) {
    const displayNameInput = document.getElementById("displayName");
    const saveButton = document.getElementById("saveBtn");
    const backButton = document.getElementById("backBtn") || document.getElementById("settingsBackBtn");
    const status = document.getElementById("settingsMessage");
    const deleteAccountButton = document.getElementById("deleteAccountButton");
    const deleteAccountDialog = document.getElementById("deleteAccountDialog");
    const deleteAccountConfirmation = document.getElementById("deleteAccountConfirmation");
    const confirmDeleteAccountButton = document.getElementById("confirmDeleteAccountButton");
    const cancelDeleteAccountButton = document.getElementById("cancelDeleteAccountButton");
    const deleteAccountStatus = document.getElementById("deleteAccountStatus");

    let currentUserId = null;
    let currentDisplayName = "";
    let sessionGeneration = 0;
    let saveInProgress = false;
    let deletionInProgress = false;

    function showStatus(text, kind) {
        status.textContent = text;
        status.dataset.kind = kind;
    }

    function isCurrentSession(userId, generation) {
        return currentUserId === userId && sessionGeneration === generation;
    }

    function setSignedOut() {
        currentUserId = null;
        currentDisplayName = "";
        displayNameInput.value = "";
        displayNameInput.disabled = true;
        saveButton.disabled = true;
        showStatus("Sign in to manage your settings.", "error");
    }

    async function loadProfile(userId, generation) {
        const { data: profile, error } = await client
            .from("profiles")
            .select("id, display_name")
            .eq("id", userId)
            .maybeSingle();

        if (!isCurrentSession(userId, generation)) return;
        if (error) {
            showStatus("Could not load your saved settings. Please refresh and try again.", "error");
            return;
        }
        if (!profile) {
            showStatus("Your profile could not be found.", "error");
            return;
        }

        currentDisplayName = profile.display_name || "";
        displayNameInput.value = currentDisplayName;
        displayNameInput.disabled = false;
        saveButton.disabled = false;
        showStatus("Your saved settings are loaded.", "info");
    }

    async function applySessionUser(user) {
        if (user?.id && currentUserId === user.id) return;
        const generation = ++sessionGeneration;
        saveInProgress = false;
        deletionInProgress = false;
        saveButton.textContent = "Save Changes";
        deleteAccountButton.disabled = !user?.id;
        cancelDeleteAccountButton.disabled = false;
        deleteAccountConfirmation.disabled = false;
        confirmDeleteAccountButton.textContent = "Delete my account";
        updateDeleteConfirmation();
        if (!user?.id) {
            setSignedOut();
            return;
        }

        currentUserId = user.id;
        displayNameInput.disabled = true;
        saveButton.disabled = true;
        showStatus("Loading your saved settings…", "info");
        await loadProfile(user.id, generation);
    }

    async function saveSettings() {
        if (saveInProgress || !currentUserId) return;

        const userId = currentUserId;
        const generation = sessionGeneration;
        const displayName = displayNameInput.value.trim();

        if (!displayName) {
            showStatus("Display name cannot be empty.", "error");
            displayNameInput.focus();
            return;
        }
        if (displayName.length > 80) {
            showStatus("Display name must be 80 characters or fewer.", "error");
            displayNameInput.focus();
            return;
        }
        if (displayName === currentDisplayName) {
            showStatus("There are no changes to save.", "info");
            return;
        }

        saveInProgress = true;
        saveButton.disabled = true;
        displayNameInput.disabled = true;
        saveButton.textContent = "Saving…";
        showStatus("Saving your display name…", "info");

        try {
            const { data, error } = await client
                .from("profiles")
                .update({ display_name: displayName })
                .eq("id", userId)
                .select("id, display_name")
                .maybeSingle();

            if (!isCurrentSession(userId, generation)) return;
            if (error) throw error;
            if (!data) throw new Error("No profile row was updated.");

            const { data: authData, error: authError } = await client.auth.getUser();
            if (!isCurrentSession(userId, generation)) return;
            if (authError || authData?.user?.id !== userId) {
                sessionGeneration += 1;
                setSignedOut();
                return;
            }

            currentDisplayName = data.display_name || displayName;
            displayNameInput.value = currentDisplayName;
            if (onProfileUpdated) onProfileUpdated(currentDisplayName);
            try {
                window.localStorage.setItem("talkspace-profile-updated", JSON.stringify({
                    userId,
                    display_name: currentDisplayName
                }));
            } catch (storageError) {
                console.error("PROFILE UPDATE PROPAGATION ERROR:", storageError);
            }
            showStatus("Settings saved successfully.", "success");
        } catch (error) {
            if (!isCurrentSession(userId, generation)) return;
            console.error("SETTINGS SAVE ERROR:", error);
            showStatus("Could not save your settings. Please try again.", "error");
        } finally {
            if (isCurrentSession(userId, generation)) {
                saveInProgress = false;
                displayNameInput.disabled = false;
                saveButton.disabled = false;
                saveButton.textContent = "Save Changes";
            }
        }
    }

    function updateDeleteConfirmation() {
        confirmDeleteAccountButton.disabled =
            deletionInProgress || deleteAccountConfirmation.value !== "DELETE";
    }

    function closeDeleteAccountDialog() {
        if (deletionInProgress) return;
        deleteAccountDialog.close();
        deleteAccountConfirmation.value = "";
        deleteAccountStatus.textContent = "";
        deleteAccountStatus.dataset.kind = "";
        updateDeleteConfirmation();
    }

    async function deleteAccount() {
        if (
            deletionInProgress ||
            !currentUserId ||
            deleteAccountConfirmation.value !== "DELETE"
        ) return;

        const userId = currentUserId;
        const generation = sessionGeneration;
        deletionInProgress = true;
        deleteAccountButton.disabled = true;
        cancelDeleteAccountButton.disabled = true;
        deleteAccountConfirmation.disabled = true;
        confirmDeleteAccountButton.textContent = "Deleting…";
        deleteAccountStatus.textContent = "Deleting your account…";
        deleteAccountStatus.dataset.kind = "info";
        updateDeleteConfirmation();

        try {
            // The function derives the target from the verified bearer token.
            // No user ID or other deletion authority is sent by this client.
            const { data, error } = await client.functions.invoke("delete-account");
            if (error || data?.success !== true) {
                throw new Error("Account deletion was not confirmed.");
            }

            if (!isCurrentSession(userId, generation)) return;

            deleteAccountStatus.textContent = "Account deleted. Signing out…";
            deleteAccountStatus.dataset.kind = "success";
            deleteAccountDialog.close();

            try {
                if (onAccountDeleted) await onAccountDeleted();
            } catch (cleanupError) {
                console.error("ACCOUNT DELETION LOCAL CLEANUP ERROR:", cleanupError);
            }

            try {
                const { error: signOutError } = await client.auth.signOut({ scope: "local" });
                if (signOutError) {
                    console.error("ACCOUNT DELETION LOCAL SIGN-OUT ERROR:", signOutError);
                }
            } catch (signOutError) {
                console.error("ACCOUNT DELETION LOCAL SIGN-OUT ERROR:", signOutError);
            }

            try {
                window.localStorage.removeItem("talkspace-profile-updated");
                window.sessionStorage?.removeItem("talkspace-profile-updated");
            } catch (storageError) {
                console.error("ACCOUNT DELETION LOCAL STORAGE CLEANUP ERROR:", storageError);
            }

            await applySessionUser(null);
            showStatus("Your account has been permanently deleted.", "success");
        } catch (_error) {
            if (!isCurrentSession(userId, generation)) return;
            deleteAccountStatus.textContent = "Could not delete your account. You are still signed in. Please try again.";
            deleteAccountStatus.dataset.kind = "error";
        } finally {
            if (isCurrentSession(userId, generation)) {
                deletionInProgress = false;
                deleteAccountButton.disabled = false;
                cancelDeleteAccountButton.disabled = false;
                deleteAccountConfirmation.disabled = false;
                confirmDeleteAccountButton.textContent = "Delete my account";
                updateDeleteConfirmation();
            }
        }
    }

    saveButton.addEventListener("click", saveSettings);
    displayNameInput.addEventListener("keydown", event => {
        if (event.key === "Enter") saveSettings();
    });
    backButton.addEventListener("click", () => {
        if (onBack) onBack();
        else window.location.href = "index.html";
    });

    deleteAccountButton.addEventListener("click", () => {
        if (!currentUserId || deletionInProgress) return;
        deleteAccountConfirmation.value = "";
        deleteAccountConfirmation.disabled = false;
        deleteAccountStatus.textContent = "";
        deleteAccountStatus.dataset.kind = "";
        updateDeleteConfirmation();
        deleteAccountDialog.showModal();
        deleteAccountConfirmation.focus();
    });
    deleteAccountConfirmation.addEventListener("input", updateDeleteConfirmation);
    confirmDeleteAccountButton.addEventListener("click", deleteAccount);
    cancelDeleteAccountButton.addEventListener("click", closeDeleteAccountDialog);
    deleteAccountDialog.addEventListener("cancel", event => {
        if (deletionInProgress) event.preventDefault();
    });

    if (subscribeToAuth) {
        client.auth.onAuthStateChange((_event, session) => {
            void applySessionUser(session?.user || null);
        });

        const initialGeneration = sessionGeneration;
        client.auth.getUser().then(({ data, error }) => {
            if (sessionGeneration !== initialGeneration) return;
            if (error) {
                setSignedOut();
                return;
            }
            return applySessionUser(data?.user || null);
        }).catch(error => {
            console.error("SETTINGS SESSION ERROR:", error);
            if (sessionGeneration === initialGeneration) setSignedOut();
        });
    }

    return { setUser: applySessionUser };
}

window.TalkSpaceSettings = {
    initialize(client, onBack, onProfileUpdated, onAccountDeleted) {
        return createSettingsController(client, onBack, onProfileUpdated, false, onAccountDeleted);
    }
};

// Keep the standalone Settings document working while the main app reuses the
// same controller and its existing save implementation inside the SPA.
if (document.body?.classList?.contains("settings-page")) {
    const client = window.supabase.createClient(
        window.SUPABASE_CONFIG.url,
        window.SUPABASE_CONFIG.anonKey
    );
    createSettingsController(client, null, null, true);
}
