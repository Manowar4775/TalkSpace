"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const loggerSource = fs.readFileSync(path.join(__dirname, "../src/logger.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const callSource = fs.readFileSync(path.join(__dirname, "../src/call.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");

function createLogger(search) {
    const records = [];
    const window = { location: { search } };
    const console = { debug(...args) { records.push(args); } };
    vm.runInNewContext(loggerSource, { window, console, URLSearchParams });
    return { logger: window.TalkSpaceLogger, records };
}

test("diagnostics are disabled by default", () => {
    const { logger, records } = createLogger("");
    logger.debug("test event");
    assert.equal(logger.enabled, false);
    assert.deepEqual(records, []);
});

test("diagnostics can be explicitly enabled with the documented query flag", () => {
    const { logger, records } = createLogger("?talkspaceDebug=1");
    logger.debug("test event", { category: "lifecycle" });
    assert.equal(logger.enabled, true);
    assert.equal(records.length, 1);
    assert.equal(records[0][0], "[TalkSpace]");
    assert.equal(records[0][1], "test event");
});

test("routine app and call diagnostics use the opt-in logger without sensitive payload traces", () => {
    assert.match(indexSource, /src\/logger\.js[\s\S]*?src\/app\.js[\s\S]*?src\/call\.js/);
    assert.match(appSource, /if \(!window\.TalkSpaceLogger\?\.enabled\)\s*\{\s*return null;/);
    assert.doesNotMatch(appSource, /console\.(log|info|debug)\s*\(/);
    assert.doesNotMatch(callSource, /console\.(log|info|debug)\s*\(/);
    assert.doesNotMatch(appSource, /OTP LENGTH|message body.*TalkSpaceLogger/i);
    assert.doesNotMatch(callSource, /CALL SIGNAL RECEIVED|REJECT SIGNAL RECEIVED:[\s\S]{0,60}signal\s*[,)]/);
    assert.match(appSource, /console\.error\([\s\S]{0,100}LOGIN ERROR:/);
    assert.match(appSource, /console\.error\([\s\S]{0,120}SEND MESSAGE ERROR:/);
    assert.match(appSource, /console\.error\([\s\S]{0,100}BLOCK CHECK ERROR:/);
    assert.match(callSource, /console\.error\([\s\S]{0,100}VOICE CALL ERROR:/);
});
