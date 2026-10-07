"use strict";

function createSettingsController(client, onBack, onProfileUpdated, subscribeToAuth) {
    const displayNameInput = document.getElementById("displayName");
    const saveButton = document.getElementById("saveBtn");
    const backButton = document.getElementById("backBtn") || document.getElementById("settingsBackBtn");
    const status = document.getElementById("settingsMessage");

    let currentUserId = null;
    let currentDisplayName = "";
    let sessionGeneration = 0;
    let saveInProgress = false;

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
        saveButton.textContent = "Save Changes";
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

    saveButton.addEventListener("click", saveSettings);
    displayNameInput.addEventListener("keydown", event => {
        if (event.key === "Enter") saveSettings();
    });
    backButton.addEventListener("click", () => {
        if (onBack) onBack();
        else window.location.href = "index.html";
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
    initialize(client, onBack, onProfileUpdated) {
        return createSettingsController(client, onBack, onProfileUpdated, false);
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
