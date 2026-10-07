"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const appSource = fs.readFileSync(path.join(__dirname, "../src/app.js"), "utf8");
const start = appSource.indexOf("function normalizeAndValidateEmail(value)");
const end = appSource.indexOf("// TURNSTILE CONFIGURATION CHECK", start);
assert.notEqual(start, -1, "email validator must be present in app.js");
assert.notEqual(end, -1, "email validator must end before Turnstile setup");

const context = vm.createContext({});
vm.runInContext(appSource.slice(start, end), context);

function validate(value) {
    return vm.runInContext(
        `normalizeAndValidateEmail(${JSON.stringify(value)})`,
        context
    );
}

test("email validator rejects empty input", () => {
    assert.equal(validate(""), null);
});

test("email validator rejects a missing at sign", () => {
    assert.equal(validate("abc"), null);
});

test("email validator rejects a missing local part", () => {
    assert.equal(validate("@gmail.com"), null);
});

test("email validator rejects a missing domain", () => {
    assert.equal(validate("abc@"), null);
});

test("email validator rejects multiple at signs", () => {
    assert.equal(validate("abc@@gmail.com"), null);
});

test("email validator rejects internal whitespace and controls", () => {
    assert.equal(validate("abc gmail@gmail.com"), null);
    assert.equal(validate("abc\n@gmail.com"), null);
});

test("email validator rejects a domain beginning with a dot", () => {
    assert.equal(validate("abc@.com"), null);
});

test("email validator rejects a domain ending with a dot", () => {
    assert.equal(validate("abc@gmail."), null);
});

test("email validator rejects consecutive domain dots", () => {
    assert.equal(validate("abc@gmail..com"), null);
});

test("email validator accepts a normal Gmail address", () => {
    assert.equal(validate("test@gmail.com"), "test@gmail.com");
});

test("email validator accepts a normal domain email", () => {
    assert.equal(validate("name.surname@example.test"), "name.surname@example.test");
});

test("email validator accepts plus-addressing", () => {
    assert.equal(validate("user+talkspace@example.com"), "user+talkspace@example.com");
});

test("email validator trims surrounding whitespace", () => {
    assert.equal(validate("  test@gmail.com  "), "test@gmail.com");
});
