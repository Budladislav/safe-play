import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHeatmapDays,
  calculateSessionMetrics,
  createDefaultState,
  getTimerState,
  normalizeState,
  summarizeStats
} from "../js/core.js";

test("timestamp timer reconstructs elapsed time after a reload", () => {
  const session = {
    startedAt: "2026-07-20T10:00:00.000Z",
    plannedEndAt: "2026-07-20T11:00:00.000Z"
  };
  const timer = getTimerState(session, new Date("2026-07-20T10:42:30.000Z").getTime());
  assert.equal(timer.elapsedMs, 42.5 * 60_000);
  assert.equal(timer.remainingMs, 17.5 * 60_000);
  assert.equal(timer.isOvertime, false);
  assert.equal(timer.progress, 70.83333333333334);
});

test("timestamp timer reports overtime instead of stopping", () => {
  const timer = getTimerState({
    startedAt: "2026-07-20T10:00:00.000Z",
    plannedEndAt: "2026-07-20T10:30:00.000Z"
  }, new Date("2026-07-20T10:37:00.000Z").getTime());
  assert.equal(timer.isOvertime, true);
  assert.equal(timer.remainingMs, -7 * 60_000);
  assert.equal(timer.progress, 100);
});

test("session metrics separate actual duration and overrun", () => {
  const metrics = calculateSessionMetrics(
    "2026-07-20T10:00:00.000Z",
    "2026-07-20T11:12:20.000Z",
    60
  );
  assert.deepEqual(metrics, { actualMinutes: 73, overtimeMinutes: 13, onTime: false });
});

test("import normalization preserves valid data and clamps settings", () => {
  const normalized = normalizeState({
    version: 1,
    games: [{ id: "g1", title: "Test", color: "#fff" }],
    checklist: [],
    sessions: [],
    events: [],
    settings: { extensionLimit: 99, lateHour: 4 }
  });
  assert.equal(normalized.version, 2);
  assert.equal(normalized.games[0].title, "Test");
  assert.equal(normalized.settings.extensionLimit, 5);
  assert.equal(normalized.settings.lateHour, 18);
  assert.ok(normalized.checklist.length >= 4);
});

test("statistics aggregate plan, actual time, extensions and overrides", () => {
  const state = createDefaultState();
  state.games = [{ id: "g1", title: "Game", color: "#fff", createdAt: "2026-07-20T00:00:00.000Z" }];
  state.sessions = [{
    id: "s1",
    gameId: "g1",
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: "2026-07-20T11:10:00.000Z",
    basePlannedMinutes: 45,
    plannedMinutes: 60,
    actualMinutes: 70,
    overtimeMinutes: 10,
    onTime: false,
    extensions: [{ minutes: 15 }],
    override: { reason: "test" },
    preState: 2,
    satisfaction: 4,
    compulsivity: 5,
    motive: "story"
  }];
  const stats = summarizeStats(state, new Date("2026-07-20T12:00:00.000Z"));
  assert.equal(stats.totalMinutes, 70);
  assert.equal(stats.totalPlanned, 60);
  assert.equal(stats.onTimePercent, 0);
  assert.equal(stats.extensions, 1);
  assert.equal(stats.overrides, 1);
  assert.equal(stats.byGame.g1, 70);
  assert.equal(stats.compulsivity[4], 1);
});

test("heatmap always returns full weeks", () => {
  const days = buildHeatmapDays({ "2026-07-20": 90 }, 4, new Date("2026-07-20T12:00:00"));
  assert.equal(days.length, 28);
  assert.equal(days.find((day) => day.key === "2026-07-20").level, 2);
});
