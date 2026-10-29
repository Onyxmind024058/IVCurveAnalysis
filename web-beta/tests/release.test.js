/* =============================================================================
   Release check: every script and stylesheet in index.html carries ?v=<APP_VERSION>.
   A new version then gets new file addresses, so no browser or service-worker
   cache can run old scripts with a new page.
       node --test <folder>/tests/release.test.js
   ============================================================================= */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const version = fs.readFileSync(path.join(dir, "js", "app.js"), "utf8").match(/const APP_VERSION = "([^"]+)"/)[1];

test("all local scripts and stylesheets use ?v=APP_VERSION", () => {
  const refs = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="((?:js|css|vendor|model)\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 10, `found ${refs.length} references`);
  for (const ref of refs) assert.ok(ref.endsWith(`?v=${version}`), `${ref} should end with ?v=${version}`);
});

test("every versioned file exists and is in the service worker's offline list", () => {
  const sw = fs.readFileSync(path.join(dir, "sw.js"), "utf8");
  for (const [, file] of html.matchAll(/<(?:script src|link rel="stylesheet" href)="((?:js|css|vendor|model)\/[^"?]+)\?v=/g)) {
    assert.ok(fs.existsSync(path.join(dir, file)), `${file} exists`);
    assert.ok(sw.includes(`"./${file}"`), `${file} is precached in sw.js`);
  }
});

test("the newest What's new entry is this version", () => {
  const app = fs.readFileSync(path.join(dir, "js", "app.js"), "utf8");
  const first = app.match(/const CHANGELOG = \[\s*\{\s*version: "([^"]+)"/)[1];
  assert.equal(first, version);
});
