"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const settingsSource = fs.readFileSync(path.join(__dirname, "../src/settings.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const settingsMarkup = fs.readFileSync(path.join(__dirname, "../setting.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../src/style.css"), "utf8");

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function makeElement() {
    return {
        value: "",
        textContent: "",
        disabled: false,
        dataset: {},
        listeners: {},
        addEventListener(type, callback) { this.listeners[type] = callback; },
        focus() {},
        showModal() { this.open = true; },
        close() { this.open = false; }
    };
}

function setup(options = {}) {
    const elements = Object.fromEntries(
        [
            "displayName", "saveBtn", "backBtn", "settingsMessage",
            "deleteAccountButton", "deleteAccountDialog", "deleteAccountConfirmation",
            "confirmDeleteAccountButton", "cancelDeleteAccountButton", "deleteAccountStatus"
        ].map(id => [id, makeElement()])
    );
    const calls = { updates: [], profileReads: 0, storageWrites: [], storageRemovals: [], deletionInvocations: [], signOutScopes: [] };
    const user = { id: "user-a" };
    let authListener;
    let authSubscriptions = 0;
    let inAppController = null;
    const client = {
        auth: {
            onAuthStateChange(callback) { authSubscriptions += 1; authListener = callback; },
            async getUser() { return { data: { user }, error: null }; },
            async signOut(options) {
                calls.signOutScopes.push(options?.scope);
                return { error: options?.signOutError || null };
            }
        },
        functions: {
            async invoke(name, options) {
                calls.deletionInvocations.push({ name, options });
                if (options?.deletePromise) return options.deletePromise.promise;
                if (options?.deleteError) return { data: null, error: options.deleteError };
                if (options?.deleteResponse) return options.deleteResponse;
                return { data: { success: true }, error: null };
            }
        },
        from(table) {
            assert.equal(table, "profiles");
            return {
                action: "select",
                values: null,
                userId: null,
                select() { return this; },
                update(values) { this.action = "update"; this.values = values; return this; },
                eq(column, value) { assert.equal(column, "id"); this.userId = value; return this; },
                async maybeSingle() {
                    if (this.action === "select") {
                        calls.profileReads += 1;
                        return { data: { id: this.userId, display_name: "Saved Name" }, error: null };
                    }
                    calls.updates.push({ userId: this.userId, values: this.values });
                    if (options.updatePromise) return options.updatePromise.promise;
                    if (options.updateError) return { data: null, error: options.updateError };
                    return { data: { id: this.userId, display_name: this.values.display_name }, error: null };
                }
            };
        }
    };
    const window = {
        supabase: { createClient: () => client },
        SUPABASE_CONFIG: { url: "test", anonKey: "public" },
        localStorage: {
            setItem(key, value) { calls.storageWrites.push([key, value]); },
            removeItem(key) { calls.storageRemovals.push(["local", key]); }
        },
        sessionStorage: { removeItem(key) { calls.storageRemovals.push(["session", key]); } },
        location: {}
    };
    vm.runInNewContext(settingsSource, {
        window,
        document: {
            body: { classList: { contains: className => options.standalone !== false && className === "settings-page" } },
            getElementById: id => elements[id]
        },
        console: { error() {} },
        JSON,
        Promise,
        Error
    });

    if (options.standalone === false) {
        inAppController = window.TalkSpaceSettings.initialize(
            client,
            options.onBack || (() => {}),
            options.onProfileUpdated,
            options.onAccountDeleted
        );
    }

    return { elements, calls, client, authListener, inAppController, getAuthListener: () => authListener, getAuthSubscriptions: () => authSubscriptions };
}

async function settle() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

test("settings load authenticated profile and persist supported display name", async () => {
    const state = setup();
    await settle();
    assert.equal(state.elements.displayName.value, "Saved Name");

    state.elements.displayName.value = "Updated Name";
    await state.elements.saveBtn.listeners.click();

    assert.equal(JSON.stringify(state.calls.updates), JSON.stringify([
        { userId: "user-a", values: { display_name: "Updated Name" } }
    ]));
    assert.equal(state.elements.settingsMessage.textContent, "Settings saved successfully.");
    assert.equal(state.calls.storageWrites.length, 1);
});

test("unchanged values do not issue a database write", async () => {
    const state = setup();
    await settle();
    await state.elements.saveBtn.listeners.click();
    assert.equal(state.calls.updates.length, 0);
    assert.equal(state.elements.settingsMessage.textContent, "There are no changes to save.");
});

test("rapid submissions share one in-flight save and restore controls after failure", async () => {
    const updatePromise = deferred();
    const state = setup({ updatePromise });
    await settle();
    state.elements.displayName.value = "Updated Name";

    const first = state.elements.saveBtn.listeners.click();
    const second = state.elements.saveBtn.listeners.click();
    assert.equal(state.calls.updates.length, 1);
    assert.equal(state.elements.saveBtn.disabled, true);
    updatePromise.resolve({ data: null, error: { message: "write failed" } });
    await Promise.all([first, second]);

    assert.equal(state.elements.settingsMessage.dataset.kind, "error");
    assert.equal(state.elements.displayName.disabled, false);
    assert.equal(state.elements.saveBtn.disabled, false);
    assert.equal(state.elements.saveBtn.textContent, "Save Changes");
});

test("session changes during a save suppress stale feedback and storage update", async () => {
    const updatePromise = deferred();
    const state = setup({ updatePromise });
    await settle();
    state.elements.displayName.value = "Updated Name";
    const saving = state.elements.saveBtn.listeners.click();

    state.getAuthListener()("SIGNED_OUT", null);
    await settle();
    updatePromise.resolve({ data: { id: "user-a", display_name: "Updated Name" }, error: null });
    await saving;

    assert.equal(state.calls.storageWrites.length, 0);
    assert.notEqual(state.elements.settingsMessage.textContent, "Settings saved successfully.");
    assert.equal(state.elements.saveBtn.disabled, true);
});

test("in-app Settings reuses the app client without adding an auth listener", async () => {
    let backCalls = 0;
    const profileUpdates = [];
    const state = setup({
        standalone: false,
        onBack: () => { backCalls += 1; },
        onProfileUpdated: name => profileUpdates.push(name)
    });
    assert.equal(state.getAuthSubscriptions(), 0);
    await state.inAppController.setUser({ id: "user-a" });
    assert.equal(state.elements.displayName.value, "Saved Name");
    state.elements.displayName.value = "In-app Name";
    await state.elements.saveBtn.listeners.click();
    assert.deepEqual(profileUpdates, ["In-app Name"]);
    await state.elements.backBtn.listeners.click();
    assert.equal(backCalls, 1);
});

test("settings page and app use a single supported profile propagation path", () => {
    assert.equal((settingsSource.match(/saveButton\.addEventListener\("click"/g) || []).length, 1);
    assert.match(settingsSource, /\.update\(\{ display_name: displayName \}\)/);
    assert.match(settingsSource, /talkspace-profile-updated/);
    assert.match(appSource, /event\.key !== "talkspace-profile-updated"/);
});

test("display name has one visible semantic label and settings states use shared visual tokens", () => {
    assert.match(settingsMarkup, /<label class="settings-field-label" for="displayName">Display name<\/label>/);
    assert.match(settingsMarkup, /id="displayName"[\s\S]*?placeholder="Display name"/);
    assert.doesNotMatch(settingsMarkup, /id="displayName"[\s\S]*?aria-label=/);
    assert.match(styles, /\.settings-message\[data-kind="success"\][\s\S]*?color: var\(--color-success\)/);
    assert.match(styles, /\.settings-message\[data-kind="error"\][\s\S]*?color: var\(--color-danger\)/);
    assert.match(styles, /\.settings-card input,[\s\S]*?\.settings-card textarea/);
});

test("Delete Account is available in both Settings entry points with explicit permanent warning", () => {
    assert.match(settingsMarkup, /id="deleteAccountButton"/);
    assert.match(settingsMarkup, /id="deleteAccountDialog"[\s\S]*?permanently removed[\s\S]*?Type DELETE to confirm/);
    assert.match(settingsMarkup, /id="confirmDeleteAccountButton"[^>]*disabled/);
    assert.match(appSource, /settingsViewController\.setUser\(currentUser\)/);
});

test("typed DELETE alone enables final confirmation and invalid text stays disabled", async () => {
    const state = setup({ standalone: false });
    await state.inAppController.setUser({ id: "user-a" });
    state.elements.deleteAccountButton.listeners.click();
    assert.equal(state.elements.deleteAccountDialog.open, true);
    assert.equal(state.elements.confirmDeleteAccountButton.disabled, true);

    state.elements.deleteAccountConfirmation.value = "delete";
    state.elements.deleteAccountConfirmation.listeners.input();
    assert.equal(state.elements.confirmDeleteAccountButton.disabled, true);
    state.elements.deleteAccountConfirmation.value = " DELETE";
    state.elements.deleteAccountConfirmation.listeners.input();
    assert.equal(state.elements.confirmDeleteAccountButton.disabled, true);
    state.elements.deleteAccountConfirmation.value = "DELETE";
    state.elements.deleteAccountConfirmation.listeners.input();
    assert.equal(state.elements.confirmDeleteAccountButton.disabled, false);
});

test("deletion invokes the server function without a client-selected account ID", async () => {
    const state = setup({ standalone: false });
    await state.inAppController.setUser({ id: "user-a" });
    state.elements.deleteAccountButton.listeners.click();
    state.elements.deleteAccountConfirmation.value = "DELETE";
    state.elements.deleteAccountConfirmation.listeners.input();
    await state.elements.confirmDeleteAccountButton.listeners.click();

    assert.equal(state.calls.deletionInvocations.length, 1);
    assert.equal(state.calls.deletionInvocations[0].name, "delete-account");
    assert.equal(state.calls.deletionInvocations[0].options, undefined);
    assert.deepEqual(state.calls.signOutScopes, ["local"]);
});

test("deletion failure leaves the user signed in and allows retry", async () => {
    const state = setup({ standalone: false });
    await state.inAppController.setUser({ id: "user-a" });
    state.elements.deleteAccountButton.listeners.click();
    state.elements.deleteAccountConfirmation.value = "DELETE";
    state.elements.deleteAccountConfirmation.listeners.input();
    state.client.functions.invoke = async () => ({ data: null, error: { message: "private provider detail" } });

    await state.elements.confirmDeleteAccountButton.listeners.click();
    assert.match(state.elements.deleteAccountStatus.textContent, /still signed in/);
    assert.equal(state.elements.deleteAccountStatus.dataset.kind, "error");
    assert.equal(state.calls.signOutScopes.length, 0);
    assert.equal(state.elements.confirmDeleteAccountButton.disabled, false);
    assert.equal(state.elements.deleteAccountConfirmation.disabled, false);
});

test("duplicate confirmation clicks share one in-flight account deletion", async () => {
    const deletionPromise = deferred();
    const state = setup({ standalone: false });
    await state.inAppController.setUser({ id: "user-a" });
    state.client.functions.invoke = async (...args) => {
        state.calls.deletionInvocations.push(args);
        return deletionPromise.promise;
    };
    state.elements.deleteAccountButton.listeners.click();
    state.elements.deleteAccountConfirmation.value = "DELETE";
    state.elements.deleteAccountConfirmation.listeners.input();

    const first = state.elements.confirmDeleteAccountButton.listeners.click();
    const second = state.elements.confirmDeleteAccountButton.listeners.click();
    assert.equal(state.calls.deletionInvocations.length, 1);
    assert.equal(state.elements.confirmDeleteAccountButton.disabled, true);
    assert.equal(state.elements.deleteAccountConfirmation.disabled, true);
    deletionPromise.resolve({ data: { success: true }, error: null });
    await Promise.all([first, second]);
});

test("successful deletion runs app cleanup, signs out locally, and clears TalkSpace storage", async () => {
    let cleanupCalls = 0;
    const state = setup({ standalone: false, onAccountDeleted: async () => { cleanupCalls += 1; } });
    await state.inAppController.setUser({ id: "user-a" });
    state.elements.deleteAccountButton.listeners.click();
    state.elements.deleteAccountConfirmation.value = "DELETE";
    state.elements.deleteAccountConfirmation.listeners.input();
    await state.elements.confirmDeleteAccountButton.listeners.click();

    assert.equal(cleanupCalls, 1);
    assert.equal(state.calls.signOutScopes[0], "local");
    assert.deepEqual(state.calls.storageRemovals, [
        ["local", "talkspace-profile-updated"],
        ["session", "talkspace-profile-updated"]
    ]);
    assert.equal(state.elements.deleteAccountDialog.open, false);
    assert.equal(state.elements.settingsMessage.textContent, "Your account has been permanently deleted.");
});
