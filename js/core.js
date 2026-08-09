export const STORAGE_KEY = "safe-play:v2";
export const LEGACY_STORAGE_KEY = "gaming-guard:v2";
export const SCHEMA_VERSION = 6;
export const APP_VERSION = "2.4.0";
export const APP_RELEASE_DATE = "2026-07-26";

export const MOTIVES = [
  { value: "planned", label: "Запланированный отдых" },
  { value: "story", label: "Продолжить историю" },
  { value: "boredom", label: "Скука" },
  { value: "fatigue", label: "Усталость" },
  { value: "stress", label: "Стресс" },
  { value: "avoidance", label: "Избегаю другого дела" }
];

export const GAME_COLORS = ["#c9f27b", "#8bc9ff", "#ffad7d", "#c9a8ff", "#7de2d1", "#f4d06f"];
export const SESSION_WARNING_LEADS = [1, 3, 5, 10, 15];
export const SESSION_MODES = {
  GUARDED: "guarded",
  DUO: "duo"
};

export function createId(prefix = "id") {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${id}`;
}

export function createDefaultState() {
  const now = new Date().toISOString();
  return {
    version: SCHEMA_VERSION,
    games: [],
    checklist: [
      { id: createId("check"), title: "Я поел и не заменяю игрой нормальный приём пищи", order: 0, enabled: true, required: true },
      { id: createId("check"), title: "Бытовой минимум на сегодня закрыт", order: 1, enabled: true, required: true },
      { id: createId("check"), title: "Эта сессия не навредит сну", order: 2, enabled: true, required: true },
      { id: createId("check"), title: "Сегодня была физическая активность", order: 3, enabled: true, required: false }
    ],
    sessions: [],
    events: [],
    activeSession: null,
    cooldown: null,
    settings: {
      extensionLimit: 1,
      keepAwake: false,
      warningSound: false,
      warningVibration: false,
      warningLeadMinutes: 5,
      lateHour: 22
    },
    meta: {
      createdAt: now,
      updatedAt: now
    }
  };
}

export function normalizeState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Файл не содержит данных Safe Play.");
  }

  const defaults = createDefaultState();
  const games = Array.isArray(input.games) ? input.games : [];
  const checklist = Array.isArray(input.checklist) && input.checklist.length ? input.checklist : defaults.checklist;
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const events = Array.isArray(input.events) ? input.events : [];

  const normalized = {
    ...defaults,
    ...input,
    version: SCHEMA_VERSION,
    games: games.map((game, index) => normalizeGame(game, index)),
    checklist: checklist.map((item, index) => ({
      id: String(item.id || createId("check")),
      title: String(item.title || "Пункт чек-листа").slice(0, 180),
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      enabled: item.enabled !== false,
      required: item.required !== false
    })).sort((a, b) => a.order - b.order),
    sessions: sessions.filter(isValidSession).map(normalizeSession),
    events: events.filter((event) => event && typeof event === "object"),
    activeSession: input.activeSession && isValidActiveSession(input.activeSession)
      ? normalizeActiveSession(input.activeSession)
      : null,
    cooldown: input.cooldown && validIso(input.cooldown.until) ? input.cooldown : null,
    settings: {
      ...defaults.settings,
      ...(input.settings || {}),
      extensionLimit: clamp(Number(input.settings?.extensionLimit ?? defaults.settings.extensionLimit), 0, 5),
      keepAwake: Boolean(input.settings?.keepAwake),
      warningSound: Boolean(input.settings?.warningSound),
      warningVibration: Boolean(input.settings?.warningVibration),
      warningLeadMinutes: normalizeWarningLead(input.settings?.warningLeadMinutes, defaults.settings.warningLeadMinutes),
      lateHour: clamp(Number(input.settings?.lateHour ?? defaults.settings.lateHour), 18, 24)
    },
    meta: {
      ...defaults.meta,
      ...(input.meta || {}),
      updatedAt: new Date().toISOString()
    }
  };

  return normalized;
}

function normalizeGame(game, index) {
  const createdAt = validIso(game.createdAt) ? game.createdAt : new Date().toISOString();
  const rawPlatforms = Array.isArray(game.platforms)
    ? game.platforms
    : game.platform || game.device
      ? [game.platform || game.device]
      : [];
  const releaseYear = Number(game.releaseYear);
  return {
    id: String(game.id || createId("game")),
    title: String(game.title || "Без названия").slice(0, 100),
    color: String(game.color || GAME_COLORS[index % GAME_COLORS.length]),
    releaseYear: Number.isInteger(releaseYear) && releaseYear >= 1950 && releaseYear <= 2100 ? releaseYear : null,
    platforms: [...new Set(rawPlatforms.map((platform) => String(platform).trim().slice(0, 40)).filter(Boolean))].slice(0, 8),
    archivedAt: validIso(game.archivedAt) ? game.archivedAt : null,
    completedAt: validIso(game.completedAt) ? game.completedAt : null,
    coverId: game.coverId ? String(game.coverId) : null,
    createdAt,
    updatedAt: validIso(game.updatedAt) ? game.updatedAt : createdAt
  };
}

function normalizeSession(session) {
  const mode = normalizeSessionMode(session.mode);
  const plannedMinutes = mode === SESSION_MODES.DUO
    ? 0
    : Math.max(1, Number(session.plannedMinutes || session.basePlannedMinutes || 1));
  const actualMinutes = Math.max(0, Number(session.actualMinutes || 0));
  const motives = normalizeMotives(session);
  const gameSegments = normalizeGameSegments(session, false);
  return {
    ...session,
    id: String(session.id || createId("session")),
    mode,
    gameId: String(session.gameId || gameSegments[0]?.gameId || ""),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    basePlannedMinutes: mode === SESSION_MODES.DUO ? 0 : Math.max(1, Number(session.basePlannedMinutes || plannedMinutes)),
    plannedMinutes,
    actualMinutes,
    overtimeMinutes: mode === SESSION_MODES.DUO ? 0 : Math.max(0, Number(session.overtimeMinutes ?? Math.ceil(actualMinutes - plannedMinutes))),
    onTime: mode === SESSION_MODES.DUO ? null : typeof session.onTime === "boolean" ? session.onTime : actualMinutes <= plannedMinutes + 1,
    extensions: mode === SESSION_MODES.DUO ? [] : Array.isArray(session.extensions) ? session.extensions : [],
    pauses: Array.isArray(session.pauses) ? session.pauses : [],
    totalPausedMs: Math.max(0, Number(session.totalPausedMs || 0)),
    gameSegments,
    checklistResults: mode === SESSION_MODES.DUO ? {} : session.checklistResults && typeof session.checklistResults === "object" ? session.checklistResults : {},
    preState: mode === SESSION_MODES.DUO ? null : clamp(Number(session.preState ?? 3), 1, 5),
    satisfaction: mode === SESSION_MODES.DUO ? null : clamp(Number(session.satisfaction ?? 3), 1, 5),
    compulsivity: mode === SESSION_MODES.DUO ? null : clamp(Number(session.compulsivity ?? 3), 1, 5),
    motives: mode === SESSION_MODES.DUO ? [] : motives,
    motive: mode === SESSION_MODES.DUO ? "" : motives[0] || "",
    afterAction: mode === SESSION_MODES.DUO ? "" : String(session.afterAction || ""),
    afterActionConfirmed: mode === SESSION_MODES.DUO ? false : Boolean(session.afterActionConfirmed),
    outcomeNote: mode === SESSION_MODES.DUO ? "" : String(session.outcomeNote || ""),
    override: mode === SESSION_MODES.DUO ? null : session.override || null
  };
}

function normalizeActiveSession(session) {
  const mode = normalizeSessionMode(session.mode);
  const planned = mode === SESSION_MODES.DUO
    ? 0
    : Math.max(1, Number(session.plannedMinutes || session.basePlannedMinutes || 1));
  const motives = normalizeMotives(session);
  const gameSegments = normalizeGameSegments(session, true);
  const fallbackGameId = String(session.gameId || gameSegments[0]?.gameId || "");
  return {
    ...session,
    id: String(session.id || createId("session")),
    mode,
    gameId: fallbackGameId,
    currentGameId: String(session.currentGameId || gameSegments.at(-1)?.gameId || fallbackGameId),
    startedAt: session.startedAt,
    basePlannedMinutes: mode === SESSION_MODES.DUO ? 0 : Math.max(1, Number(session.basePlannedMinutes || planned)),
    plannedMinutes: planned,
    plannedEndAt: mode === SESSION_MODES.DUO
      ? null
      : validIso(session.plannedEndAt)
      ? session.plannedEndAt
      : new Date(new Date(session.startedAt).getTime() + planned * 60_000).toISOString(),
    extensions: mode === SESSION_MODES.DUO ? [] : Array.isArray(session.extensions) ? session.extensions : [],
    pauses: Array.isArray(session.pauses) ? session.pauses : [],
    totalPausedMs: Math.max(0, Number(session.totalPausedMs || 0)),
    gameSegments,
    pausedAt: validIso(session.pausedAt) ? session.pausedAt : null,
    warningForEndAt: mode === SESSION_MODES.DUO ? null : validIso(session.warningForEndAt) ? session.warningForEndAt : null,
    checklistResults: mode === SESSION_MODES.DUO ? {} : session.checklistResults && typeof session.checklistResults === "object" ? session.checklistResults : {},
    preState: mode === SESSION_MODES.DUO ? null : clamp(Number(session.preState ?? 3), 1, 5),
    motives: mode === SESSION_MODES.DUO ? [] : motives,
    motive: mode === SESSION_MODES.DUO ? "" : motives[0] || "",
    afterAction: mode === SESSION_MODES.DUO ? "" : String(session.afterAction || ""),
    override: mode === SESSION_MODES.DUO ? null : session.override || null
  };
}

function normalizeSessionMode(value) {
  return value === SESSION_MODES.DUO ? SESSION_MODES.DUO : SESSION_MODES.GUARDED;
}

function normalizeWarningLead(value, fallback) {
  const minutes = Number(value);
  return SESSION_WARNING_LEADS.includes(minutes) ? minutes : fallback;
}

function normalizeMotives(session) {
  const raw = Array.isArray(session.motives)
    ? session.motives
    : session.motive
      ? [session.motive]
      : [];
  const allowed = new Set(MOTIVES.map((item) => item.value));
  return [...new Set(raw.map(String).filter((value) => allowed.has(value)))];
}

function normalizeGameSegments(session, active) {
  const fallbackGameId = String(session.gameId || session.currentGameId || "");
  const rawSegments = Array.isArray(session.gameSegments) ? session.gameSegments : [];
  const normalized = rawSegments
    .filter((segment) => segment && typeof segment === "object" && (segment.gameId || fallbackGameId) && validIso(segment.startedAt))
    .map((segment) => {
      const endedAt = validIso(segment.endedAt) ? segment.endedAt : null;
      const derivedDuration = endedAt
        ? Math.max(0, new Date(endedAt).getTime() - new Date(segment.startedAt).getTime())
        : 0;
      const duration = Number(segment.durationMs);
      return {
        id: String(segment.id || createId("game-segment")),
        gameId: String(segment.gameId || fallbackGameId),
        startedAt: segment.startedAt,
        endedAt,
        durationMs: Math.max(0, Number.isFinite(duration) ? duration : derivedDuration)
      };
    });

  if (normalized.length || !fallbackGameId || !validIso(session.startedAt)) return normalized;

  if (!active && validIso(session.endedAt)) {
    const fallbackDuration = Math.max(0, new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() - Math.max(0, Number(session.totalPausedMs || 0)));
    return [{
      id: createId("game-segment"),
      gameId: fallbackGameId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      durationMs: Math.max(0, Number(session.actualMinutes || 0) * 60_000 || fallbackDuration)
    }];
  }

  const now = Date.now();
  const pausedAt = validIso(session.pausedAt) ? new Date(session.pausedAt).getTime() : null;
  const effectiveNow = pausedAt ?? now;
  const migratedDuration = Math.max(0, effectiveNow - new Date(session.startedAt).getTime() - Math.max(0, Number(session.totalPausedMs || 0)));
  return [{
    id: createId("game-segment"),
    gameId: fallbackGameId,
    startedAt: pausedAt ? session.startedAt : new Date(now).toISOString(),
    endedAt: pausedAt ? session.pausedAt : null,
    durationMs: migratedDuration
  }];
}

function segmentDurationMs(segment, at = Date.now()) {
  const stored = Math.max(0, Number(segment?.durationMs || 0));
  if (!segment || validIso(segment.endedAt) || !validIso(segment.startedAt)) return stored;
  return stored + Math.max(0, Number(at) - new Date(segment.startedAt).getTime());
}

export function getSessionGameBreakdown(session, at = Date.now()) {
  const segments = Array.isArray(session?.gameSegments) ? session.gameSegments : [];
  const totals = new Map();

  if (!segments.length && session?.gameId) {
    const durationMs = Math.max(0, Number(session.actualMinutes || 0) * 60_000);
    return [{ gameId: String(session.gameId), durationMs, minutes: durationMs / 60_000 }];
  }

  segments.forEach((segment) => {
    if (!segment?.gameId) return;
    const gameId = String(segment.gameId);
    totals.set(gameId, (totals.get(gameId) || 0) + segmentDurationMs(segment, at));
  });

  return [...totals.entries()].map(([gameId, durationMs]) => ({
    gameId,
    durationMs,
    minutes: durationMs / 60_000
  }));
}

export function getSessionGameIds(session) {
  return getSessionGameBreakdown(session).map((item) => item.gameId);
}

export function orderGamesForSessionStart(games, sessions, preselectedGameId = "") {
  const items = Array.isArray(games) ? [...games] : [];
  const allowedIds = new Set(items.map((game) => String(game.id)));
  const recentRank = new Map();
  let rank = 0;

  [...(Array.isArray(sessions) ? sessions : [])]
    .sort((a, b) => new Date(b.endedAt || b.startedAt) - new Date(a.endedAt || a.startedAt))
    .forEach((session) => {
      const segmentIds = Array.isArray(session?.gameSegments)
        ? session.gameSegments.map((segment) => String(segment?.gameId || "")).filter(Boolean).reverse()
        : [];
      const candidates = [session?.currentGameId, ...segmentIds, session?.gameId, ...getSessionGameIds(session)]
        .map((id) => String(id || ""))
        .filter(Boolean);
      candidates.forEach((gameId) => {
        if (allowedIds.has(gameId) && !recentRank.has(gameId)) recentRank.set(gameId, rank++);
      });
    });

  const explicitId = allowedIds.has(String(preselectedGameId)) ? String(preselectedGameId) : "";
  return items
    .map((game, index) => ({ game, index }))
    .sort((a, b) => {
      if (explicitId) {
        if (String(a.game.id) === explicitId) return -1;
        if (String(b.game.id) === explicitId) return 1;
      }
      const aRank = recentRank.get(String(a.game.id));
      const bRank = recentRank.get(String(b.game.id));
      if (aRank !== undefined || bRank !== undefined) return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
      return a.index - b.index;
    })
    .map(({ game }) => game);
}

function isValidSession(session) {
  return Boolean(
    session &&
    typeof session === "object" &&
    (session.gameId || session.gameSegments?.some((segment) => segment?.gameId)) &&
    validIso(session.startedAt) &&
    validIso(session.endedAt)
  );
}

function isValidActiveSession(session) {
  return Boolean(session && typeof session === "object" && (session.gameId || session.gameSegments?.some((segment) => segment?.gameId)) && validIso(session.startedAt));
}

export function validIso(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function calculateSessionMetrics(startedAt, endedAt, plannedMinutes, pausedMs = 0) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const activeDurationMs = Math.max(0, end - start - Math.max(0, Number(pausedMs) || 0));
  const actualMinutesExact = activeDurationMs / 60_000;
  const actualMinutes = Math.max(1, Math.ceil(actualMinutesExact));
  const overtimeMinutes = Math.max(0, Math.ceil(actualMinutesExact - plannedMinutes));
  return {
    actualMinutes,
    overtimeMinutes,
    onTime: actualMinutesExact <= plannedMinutes + 1 / 60
  };
}

export function resolveEditedSessionTiming(startedAt, endedAt, { actualMinutes, pausedMinutes, source = "pause" } = {}) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const wallDurationMs = end - start;
  let activeDurationMs;
  let totalPausedMs;

  if (source === "actual") {
    activeDurationMs = Number(actualMinutes) * 60_000;
    if (!Number.isFinite(activeDurationMs) || activeDurationMs <= 0 || activeDurationMs > wallDurationMs) return null;
    totalPausedMs = wallDurationMs - activeDurationMs;
  } else {
    totalPausedMs = Number(pausedMinutes) * 60_000;
    if (!Number.isFinite(totalPausedMs) || totalPausedMs < 0 || totalPausedMs >= wallDurationMs) return null;
    activeDurationMs = wallDurationMs - totalPausedMs;
  }

  return { wallDurationMs, activeDurationMs, totalPausedMs };
}

export function getAccumulatedPausedMs(session, at = Date.now()) {
  const stored = Math.max(0, Number(session.totalPausedMs || 0));
  if (!validIso(session.pausedAt)) return stored;
  return stored + Math.max(0, Number(at) - new Date(session.pausedAt).getTime());
}

export function shouldTriggerSessionWarning(activeSession, settings, now = Date.now()) {
  if (!activeSession || activeSession.pausedAt) return false;
  if (!settings?.warningSound && !settings?.warningVibration) return false;
  if (!validIso(activeSession.plannedEndAt)) return false;
  if (activeSession.warningForEndAt === activeSession.plannedEndAt) return false;
  const remainingMs = new Date(activeSession.plannedEndAt).getTime() - Number(now);
  const leadMinutes = normalizeWarningLead(settings.warningLeadMinutes, 5);
  return remainingMs > 0 && remainingMs <= leadMinutes * 60_000;
}

export function getTimerState(activeSession, now = Date.now()) {
  const start = new Date(activeSession.startedAt).getTime();
  const isPaused = validIso(activeSession.pausedAt);
  const effectiveNow = isPaused ? new Date(activeSession.pausedAt).getTime() : now;
  const storedPausedMs = Math.max(0, Number(activeSession.totalPausedMs || 0));
  const elapsedMs = Math.max(0, effectiveNow - start - storedPausedMs);
  if (activeSession.mode === SESSION_MODES.DUO || !validIso(activeSession.plannedEndAt)) {
    return {
      elapsedMs,
      remainingMs: null,
      isPaused,
      isOvertime: false,
      progress: 0
    };
  }
  const plannedEnd = new Date(activeSession.plannedEndAt).getTime();
  const plannedMs = Math.max(1, plannedEnd - start - storedPausedMs);
  const remainingMs = plannedMs - elapsedMs;
  return {
    elapsedMs,
    remainingMs,
    isPaused,
    isOvertime: remainingMs <= 0,
    progress: clamp((elapsedMs / plannedMs) * 100, 0, 100)
  };
}

export function formatTimer(ms) {
  const totalSeconds = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

export function formatDuration(minutes) {
  const rounded = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (!hours) return `${mins} мин`;
  if (!mins) return `${hours} ч`;
  return `${hours} ч ${mins} мин`;
}

export function formatDateTime(value, options = {}) {
  const date = new Date(value);
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...options
  }).format(date);
}

export function formatClock(value) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function localDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isCooldownActive(cooldown, now = Date.now()) {
  return Boolean(cooldown?.until && new Date(cooldown.until).getTime() > now && !cooldown.releasedAt);
}

export function getGameTotals(state) {
  const totals = Object.fromEntries(state.games.map((game) => [game.id, { minutes: 0, sessions: 0 }]));
  state.sessions.forEach((session) => {
    getSessionGameBreakdown(session).forEach(({ gameId, minutes }) => {
      if (!totals[gameId]) totals[gameId] = { minutes: 0, sessions: 0 };
      totals[gameId].minutes += minutes;
      totals[gameId].sessions += 1;
    });
  });
  return totals;
}

export function getGameActivity(state, gameId) {
  const targetId = String(gameId);
  const sessions = [...(state.sessions || [])]
    .filter((session) => getSessionGameIds(session).includes(targetId))
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const byDayMs = {};
  let totalMs = 0;

  sessions.forEach((session) => {
    let segments = Array.isArray(session.gameSegments)
      ? session.gameSegments.filter((segment) => String(segment?.gameId || "") === targetId)
      : [];
    if (!segments.length && String(session.gameId || "") === targetId) {
      segments = [{
        gameId: targetId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        durationMs: Math.max(0, Number(session.actualMinutes || 0) * 60_000)
      }];
    }

    segments.forEach((segment) => {
      const durationMs = segmentDurationMs(segment, new Date(session.endedAt).getTime());
      if (!durationMs || !validIso(segment.startedAt)) return;
      totalMs += durationMs;
      distributeSegmentAcrossDays(byDayMs, segment.startedAt, segment.endedAt || session.endedAt, durationMs);
    });
  });

  const byDay = Object.fromEntries(Object.entries(byDayMs).map(([key, milliseconds]) => [key, milliseconds / 60_000]));
  const days = Object.entries(byDay)
    .map(([key, minutes]) => ({ key, date: localDateFromKey(key), minutes }))
    .sort((a, b) => b.key.localeCompare(a.key));
  return {
    gameId: targetId,
    sessions,
    sessionCount: sessions.length,
    totalMinutes: totalMs / 60_000,
    firstSessionAt: sessions[0]?.startedAt || null,
    lastSessionAt: sessions.at(-1)?.startedAt || null,
    byDay,
    days
  };
}

function distributeSegmentAcrossDays(target, startValue, endValue, durationMs) {
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (!Number.isFinite(start)) return;
  if (!Number.isFinite(end) || end <= start) {
    const key = localDateKey(startValue);
    target[key] = (target[key] || 0) + durationMs;
    return;
  }

  const wallDuration = end - start;
  let cursor = start;
  let allocated = 0;
  while (cursor < end) {
    const date = new Date(cursor);
    const nextDay = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const sliceEnd = Math.min(end, nextDay);
    const isLastSlice = sliceEnd >= end;
    const sliceDuration = isLastSlice ? durationMs - allocated : durationMs * ((sliceEnd - cursor) / wallDuration);
    const key = localDateKey(date);
    target[key] = (target[key] || 0) + Math.max(0, sliceDuration);
    allocated += sliceDuration;
    cursor = sliceEnd;
  }
}

function localDateFromKey(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function summarizeStats(state, now = new Date()) {
  const sessions = [...state.sessions].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const controlSessions = sessions.filter((session) => session.mode !== SESSION_MODES.DUO);
  const duoSessions = sessions.filter((session) => session.mode === SESSION_MODES.DUO);
  const totalMinutes = sessions.reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0);
  const totalPlanned = controlSessions.reduce((sum, session) => sum + Number(session.plannedMinutes || 0), 0);
  const onTimeCount = controlSessions.filter((session) => session.onTime).length;
  const extensions = controlSessions.reduce((sum, session) => sum + (session.extensions?.length || 0), 0);
  const overrides = controlSessions.filter((session) => session.override).length;
  const lateHour = state.settings?.lateHour ?? 22;
  const lateSessions = controlSessions.filter((session) => new Date(session.startedAt).getHours() >= lateHour).length;

  const weekStart = startOfWeek(now);
  const weekMinutes = sessions
    .filter((session) => new Date(session.startedAt) >= weekStart)
    .reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0);

  const byDay = {};
  const byGame = {};
  const motives = {};
  const preState = [0, 0, 0, 0, 0];
  const satisfaction = [0, 0, 0, 0, 0];
  const compulsivity = [0, 0, 0, 0, 0];

  sessions.forEach((session) => {
    const key = localDateKey(session.startedAt);
    byDay[key] = (byDay[key] || 0) + Number(session.actualMinutes || 0);
    getSessionGameBreakdown(session).forEach(({ gameId, minutes }) => {
      byGame[gameId] = (byGame[gameId] || 0) + minutes;
    });
    if (session.mode === SESSION_MODES.DUO) return;
    normalizeMotives(session).forEach((motive) => { motives[motive] = (motives[motive] || 0) + 1; });
    preState[clamp(Number(session.preState ?? 3), 1, 5) - 1] += 1;
    satisfaction[clamp(Number(session.satisfaction ?? 3), 1, 5) - 1] += 1;
    compulsivity[clamp(Number(session.compulsivity ?? 3), 1, 5) - 1] += 1;
  });

  return {
    sessions,
    totalMinutes,
    totalPlanned,
    weekMinutes,
    onTimeCount,
    onTimePercent: controlSessions.length ? Math.round((onTimeCount / controlSessions.length) * 100) : 0,
    extensions,
    overrides,
    lateSessions,
    controlSessions,
    duoSessions,
    duoMinutes: duoSessions.reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0),
    byDay,
    byGame,
    motives,
    preState,
    satisfaction,
    compulsivity,
    weeks: buildWeeklyStats(sessions, getAvailableWeekCount(sessions, now), now)
  };
}

export function startOfWeek(value = new Date()) {
  const start = new Date(value);
  start.setHours(0, 0, 0, 0);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

export function buildWeeklyStats(sessions, weeks = 8, now = new Date()) {
  const currentStart = startOfWeek(now);
  const result = [];
  for (let offset = weeks - 1; offset >= 0; offset -= 1) {
    const start = new Date(currentStart);
    start.setDate(start.getDate() - offset * 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    const selected = sessions.filter((session) => {
      const startedAt = new Date(session.startedAt);
      return startedAt >= start && startedAt < end;
    });
    const controlSessions = selected.filter((session) => session.mode !== SESSION_MODES.DUO);
    const duoSessions = selected.filter((session) => session.mode === SESSION_MODES.DUO);
    const minutes = selected.reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0);
    const duoMinutes = duoSessions.reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0);
    const plannedMinutes = controlSessions.reduce((sum, session) => sum + Number(session.plannedMinutes || 0), 0);
    const onTimeCount = controlSessions.filter((session) => session.onTime).length;
    result.push({
      key: localDateKey(start),
      start: start.toISOString(),
      end: end.toISOString(),
      minutes,
      plannedMinutes,
      sessions: selected.length,
      controlSessions: controlSessions.length,
      duoSessions: duoSessions.length,
      duoMinutes,
      onTimeCount,
      onTimePercent: controlSessions.length ? Math.round(onTimeCount / controlSessions.length * 100) : 0
    });
  }
  return result;
}

export function getAvailableWeekCount(sessions, now = new Date()) {
  if (!sessions.length) return 4;
  const currentStart = startOfWeek(now);
  const earliestStart = startOfWeek(sessions.reduce((earliest, session) => new Date(session.startedAt) < earliest ? new Date(session.startedAt) : earliest, new Date(sessions[0].startedAt)));
  const distance = Math.round((currentStart - earliestStart) / (7 * 86_400_000));
  return Math.max(4, distance + 1);
}

export function getSessionsInRange(sessions, startValue, endValue) {
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return sessions
    .filter((session) => new Date(session.startedAt).getTime() >= start && new Date(session.startedAt).getTime() < end)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
}

export function buildHeatmapDays(byDay, weeks = 16, now = new Date()) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const endDay = end.getDay() || 7;
  end.setDate(end.getDate() + (7 - endDay));
  const start = new Date(end);
  start.setDate(start.getDate() - weeks * 7 + 1);
  const days = [];

  for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor);
    const minutes = byDay[localDateKey(date)] || 0;
    const level = minutes === 0 ? 0 : minutes <= 60 ? 1 : minutes <= 120 ? 2 : minutes <= 240 ? 3 : 4;
    days.push({ date, minutes, level, key: localDateKey(date) });
  }
  return days;
}

export function buildHeatmapMonths(byDay, months = 3, now = new Date(), activeOnly = false) {
  let keys;
  if (activeOnly) {
    keys = [...new Set(Object.entries(byDay)
      .filter(([, minutes]) => Number(minutes) > 0)
      .map(([key]) => key.slice(0, 7)))]
      .sort();
  } else {
    const current = new Date(now.getFullYear(), now.getMonth(), 1);
    keys = [];
    for (let offset = Math.max(1, months) - 1; offset >= 0; offset -= 1) {
      const month = new Date(current.getFullYear(), current.getMonth() - offset, 1);
      keys.push(localDateKey(month).slice(0, 7));
    }
  }

  return keys.map((key) => {
    const [year, month] = key.split("-").map(Number);
    const start = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0).getDate();
    const leadingBlanks = (start.getDay() + 6) % 7;
    const days = Array.from({ length: leadingBlanks }, () => null);
    for (let day = 1; day <= lastDay; day += 1) {
      const date = new Date(year, month - 1, day);
      const dateKey = localDateKey(date);
      const minutes = Number(byDay[dateKey] || 0);
      const level = minutes === 0 ? 0 : minutes <= 60 ? 1 : minutes <= 120 ? 2 : minutes <= 240 ? 3 : 4;
      days.push({ date, key: dateKey, minutes, level });
    }
    return { key, start, days };
  });
}

export function motiveLabel(value) {
  return MOTIVES.find((item) => item.value === value)?.label || "Не указан";
}
