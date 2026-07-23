import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHeatmapDays,
  buildHeatmapMonths,
  buildWeeklyStats,
  calculateSessionMetrics,
  createDefaultState,
  getAvailableWeekCount,
  getAccumulatedPausedMs,
  getGameTotals,
  getSessionGameBreakdown,
  getSessionsInRange,
  getTimerState,
  normalizeState,
  shouldTriggerSessionWarning,
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

test("paused timer stays fixed and reconstructs accumulated pause time", () => {
  const session = {
    startedAt: "2026-07-20T10:00:00.000Z",
    plannedEndAt: "2026-07-20T11:05:00.000Z",
    pausedAt: "2026-07-20T10:20:00.000Z",
    totalPausedMs: 5 * 60_000
  };
  const timer = getTimerState(session, new Date("2026-07-20T10:50:00.000Z").getTime());
  assert.equal(timer.isPaused, true);
  assert.equal(timer.elapsedMs, 15 * 60_000);
  assert.equal(timer.remainingMs, 45 * 60_000);
  assert.equal(getAccumulatedPausedMs(session, new Date("2026-07-20T10:50:00.000Z").getTime()), 35 * 60_000);
});

test("near-end warning respects channels, lead time, pause and delivery marker", () => {
  const active = {
    plannedEndAt: "2026-07-20T11:00:00.000Z",
    pausedAt: null,
    warningForEndAt: null
  };
  const enabled = { warningSound: true, warningVibration: false, warningLeadMinutes: 5 };
  assert.equal(shouldTriggerSessionWarning(active, enabled, new Date("2026-07-20T10:54:59.000Z").getTime()), false);
  assert.equal(shouldTriggerSessionWarning(active, enabled, new Date("2026-07-20T10:55:00.000Z").getTime()), true);
  assert.equal(shouldTriggerSessionWarning({ ...active, pausedAt: "2026-07-20T10:55:00.000Z" }, enabled, new Date("2026-07-20T10:56:00.000Z").getTime()), false);
  assert.equal(shouldTriggerSessionWarning({ ...active, warningForEndAt: active.plannedEndAt }, enabled, new Date("2026-07-20T10:56:00.000Z").getTime()), false);
  assert.equal(shouldTriggerSessionWarning(active, { ...enabled, warningSound: false }, new Date("2026-07-20T10:56:00.000Z").getTime()), false);
  assert.equal(shouldTriggerSessionWarning(active, enabled, new Date("2026-07-20T11:00:01.000Z").getTime()), false);
});

test("session metrics separate actual duration and overrun", () => {
  const metrics = calculateSessionMetrics(
    "2026-07-20T10:00:00.000Z",
    "2026-07-20T11:12:20.000Z",
    60
  );
  assert.deepEqual(metrics, { actualMinutes: 73, overtimeMinutes: 13, onTime: false });
  const pausedMetrics = calculateSessionMetrics(
    "2026-07-20T10:00:00.000Z",
    "2026-07-20T11:12:20.000Z",
    60,
    20 * 60_000
  );
  assert.deepEqual(pausedMetrics, { actualMinutes: 53, overtimeMinutes: 0, onTime: true });
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
  assert.equal(normalized.version, 5);
  assert.equal(normalized.games[0].title, "Test");
  assert.equal(normalized.settings.extensionLimit, 5);
  assert.equal(normalized.settings.lateHour, 18);
  assert.equal(normalized.settings.warningSound, false);
  assert.equal(normalized.settings.warningVibration, false);
  assert.equal(normalized.settings.warningLeadMinutes, 5);
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
    motives: ["story", "stress"],
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
  assert.equal(stats.motives.story, 1);
  assert.equal(stats.motives.stress, 1);
});

test("normalization migrates a legacy motive to the multi-select format", () => {
  const normalized = normalizeState({
    games: [{ id: "g1", title: "Game" }],
    sessions: [{
      id: "s1", gameId: "g1", startedAt: "2026-07-20T10:00:00.000Z", endedAt: "2026-07-20T11:00:00.000Z",
      plannedMinutes: 60, actualMinutes: 60, preState: 1, satisfaction: 5, compulsivity: 1, motive: "story"
    }]
  });
  assert.deepEqual(normalized.sessions[0].motives, ["story"]);
  assert.equal(normalized.sessions[0].preState, 1);
});

test("weekly statistics keep sessions in their Monday-to-Sunday buckets", () => {
  const weeks = buildWeeklyStats([
    { startedAt: "2026-07-13T12:00:00.000Z", actualMinutes: 30, plannedMinutes: 30, onTime: true },
    { startedAt: "2026-07-20T12:00:00.000Z", actualMinutes: 80, plannedMinutes: 60, onTime: false }
  ], 2, new Date("2026-07-21T12:00:00"));
  assert.equal(weeks[0].minutes, 30);
  assert.equal(weeks[1].minutes, 80);
  assert.equal(weeks[1].sessions, 1);
  assert.equal(weeks[1].onTimePercent, 0);
});

test("report period includes its start and excludes its end", () => {
  const sessions = [
    { id: "before", startedAt: "2026-07-19T23:59:59.999Z" },
    { id: "first", startedAt: "2026-07-20T00:00:00.000Z" },
    { id: "second", startedAt: "2026-07-24T18:00:00.000Z" },
    { id: "after", startedAt: "2026-07-27T00:00:00.000Z" }
  ];
  assert.deepEqual(
    getSessionsInRange(sessions, "2026-07-20T00:00:00.000Z", "2026-07-27T00:00:00.000Z").map((session) => session.id),
    ["first", "second"]
  );
  assert.deepEqual(getSessionsInRange(sessions, "invalid", "2026-07-27T00:00:00.000Z"), []);
});

test("heatmap always returns full weeks", () => {
  const days = buildHeatmapDays({ "2026-07-20": 90 }, 4, new Date("2026-07-20T12:00:00"));
  assert.equal(days.length, 28);
  assert.equal(days.find((day) => day.key === "2026-07-20").level, 2);
});

test("available week count covers the full history with a four-week minimum", () => {
  assert.equal(getAvailableWeekCount([], new Date("2026-07-22T12:00:00")), 4);
  assert.equal(getAvailableWeekCount([
    { startedAt: "2026-05-18T12:00:00" },
    { startedAt: "2026-07-22T12:00:00" }
  ], new Date("2026-07-22T12:00:00")), 10);
});

test("monthly heatmap separates calendar months and can select active history", () => {
  const byDay = { "2026-04-03": 30, "2026-06-10": 90, "2026-07-20": 250 };
  const recent = buildHeatmapMonths(byDay, 3, new Date("2026-07-22T12:00:00"));
  assert.deepEqual(recent.map((month) => month.key), ["2026-05", "2026-06", "2026-07"]);
  assert.equal(recent[2].days.find((day) => day?.key === "2026-07-20").level, 4);
  const active = buildHeatmapMonths(byDay, 3, new Date("2026-07-22T12:00:00"), true);
  assert.deepEqual(active.map((month) => month.key), ["2026-04", "2026-06", "2026-07"]);
});


test("legacy single-game sessions migrate to one game segment", () => {
  const normalized = normalizeState({
    games: [{ id: "g1", title: "Game" }],
    sessions: [{
      id: "s1",
      gameId: "g1",
      startedAt: "2026-07-20T10:00:00.000Z",
      endedAt: "2026-07-20T11:00:00.000Z",
      plannedMinutes: 60,
      actualMinutes: 60
    }]
  });
  assert.equal(normalized.sessions[0].gameSegments.length, 1);
  assert.equal(normalized.sessions[0].gameSegments[0].gameId, "g1");
  assert.equal(normalized.sessions[0].gameSegments[0].durationMs, 60 * 60_000);
});

test("game breakdown aggregates repeated segments and a running segment", () => {
  const breakdown = getSessionGameBreakdown({
    gameSegments: [
      { gameId: "g1", startedAt: "2026-07-20T10:00:00.000Z", endedAt: "2026-07-20T10:20:00.000Z", durationMs: 20 * 60_000 },
      { gameId: "g2", startedAt: "2026-07-20T10:20:00.000Z", endedAt: "2026-07-20T10:35:00.000Z", durationMs: 15 * 60_000 },
      { gameId: "g1", startedAt: "2026-07-20T10:35:00.000Z", endedAt: null, durationMs: 0 }
    ]
  }, new Date("2026-07-20T10:45:00.000Z").getTime());
  assert.deepEqual(breakdown.map(({ gameId, minutes }) => [gameId, minutes]), [["g1", 30], ["g2", 15]]);
});

test("game totals count a multi-game session once for every played game", () => {
  const state = createDefaultState();
  state.games = [{ id: "g1" }, { id: "g2" }];
  state.sessions = [{
    id: "s1",
    gameId: "g1",
    actualMinutes: 60,
    gameSegments: [
      { gameId: "g1", startedAt: "2026-07-20T10:00:00.000Z", endedAt: "2026-07-20T10:40:00.000Z", durationMs: 40 * 60_000 },
      { gameId: "g2", startedAt: "2026-07-20T10:40:00.000Z", endedAt: "2026-07-20T11:00:00.000Z", durationMs: 20 * 60_000 }
    ]
  }];
  assert.deepEqual(getGameTotals(state), {
    g1: { minutes: 40, sessions: 1 },
    g2: { minutes: 20, sessions: 1 }
  });
  const stats = summarizeStats(state, new Date("2026-07-20T12:00:00.000Z"));
  assert.equal(stats.byGame.g1, 40);
  assert.equal(stats.byGame.g2, 20);
});
