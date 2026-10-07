"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const functionSource = fs.readFileSync(
    path.join(__dirname, "../supabase/functions/delete-account/index.ts"),
    "utf8"
);
const frontendFiles = ["index.html", "setting.html", "src/app.js", "src/settings.js", "src/config.js"]
    .map(file => fs.readFileSync(path.join(__dirname, "..", file), "utf8"));

test("account deletion verifies the bearer token and derives the only target from Auth", () => {
    assert.match(functionSource, /request\.headers\.get\("Authorization"\)/);
    assert.match(functionSource, /authClient\.auth\.getUser\(bearerMatch\[1\]\)/);
    assert.match(functionSource, /adminClient\.auth\.admin\.deleteUser\(authData\.user\.id, false\)/);
    assert.doesNotMatch(functionSource, /request\.json\(|body\.user_id|body\.userId/);
});

test("service-role credential is read only in server-side function code", () => {
    assert.match(functionSource, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
    for (const source of frontendFiles) {
        assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|service_role\s*[:=]/i);
    }
});

test("function returns generic errors and does not log or expose credentials or account data", () => {
    assert.match(functionSource, /return jsonResponse\(200, \{ success: true \}\)/);
    assert.doesNotMatch(functionSource, /console\.(log|error|warn)|console\.debug/);
    assert.doesNotMatch(functionSource, /JSON\.stringify\(authData|JSON\.stringify\(deletionError/);
});

test("app routes confirmed deletion through existing signed-out cleanup", () => {
    const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
    assert.match(appSource, /async \(\) => \{\s*await cleanupSignedOutState\(\);\s*\}/);
    assert.match(appSource, /async function cleanupSignedOutState\(\)/);
    assert.match(appSource, /endCallSessionForLogout\(\)/);
    assert.match(appSource, /client\.removeChannel\(channel\)/);
});
