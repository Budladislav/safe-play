import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import * as core from "../js/core.js";

const source = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
function harness() {
  const state = core.createDefaultState();
  const context = vm.createContext({
    ...core, state, Date, FormData,
    saveState() {}, closeModal() {}, render() {}, navigate() {}, toast() {},
    prepareWarningAudio() {}, requestWakeLock() {}, releaseWakeLock() {},
    closeCurrentGameSegment() {}, openSessionSummary() {},
  });
  for (const name of ["beginSession", "extendSession", "finishSession"]) {
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf("\nfunction ", start + 1);
    vm.runInContext(source.slice(start, end), context);
  }
  return { state, context };
}

test("diary sessions accept unchecked conditions and unlimited extensions without a reason", () => {
  const { state, context } = harness();
  context.beginSession({ gameId: "test", plannedMinutes: 30, afterAction: "", preState: 1, motives: [], checklistResults: {}, missingRequired: ["food"] });
  assert.ok(state.activeSession);
  assert.equal(state.activeSession.override, null);
  state.settings.extensionLimit = 0;
  // The UI supplies FormData; this stub supplies the same two values.
  context.FormData = class { get(key) { return key === "minutes" ? "15" : ""; } };
  for (let i = 0; i < 6; i++) context.extendSession({});
  assert.equal(state.activeSession.extensions.length, 6);
  assert.equal(state.activeSession.plannedMinutes, 120);
  assert.equal(state.events.some(event => event.type === "override"), false);
});

test("honest maximum ratings and large overtime never create a cooldown", () => {
  const { state, context } = harness();
  context.beginSession({ gameId: "test", plannedMinutes: 1, afterAction: "", preState: 5, motives: [], checklistResults: {} });
  state.activeSession.startedAt = new Date(Date.now() - 90 * 60_000).toISOString();
  context.FormData = class { get(key) { return key === "compulsivity" || key === "satisfaction" ? "5" : ""; } has() { return false; } };
  context.finishSession({});
  assert.equal(state.sessions[0].compulsivity, 5);
  assert.ok(state.sessions[0].overtimeMinutes >= 88);
  assert.equal(state.cooldown, null);
  assert.equal(state.events.some(event => event.type === "cooldown-started"), false);
});
