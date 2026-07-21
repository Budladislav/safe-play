export const STORAGE_KEY = "safe-play:v2";
export const LEGACY_STORAGE_KEY = "gaming-guard:v2";
export const SCHEMA_VERSION = 3;
export const APP_VERSION = "2.1.0";

export const MOTIVES = [
  { value: "planned", label: "Запланированный отдых" },
  { value: "story", label: "Продолжить историю" },
  { value: "boredom", label: "Скука" },
  { value: "fatigue", label: "Усталость" },
  { value: "stress", label: "Стресс" },
  { value: "avoidance", label: "Избегаю другого дела" }
];

export const GAME_COLORS = ["#c9f27b", "#8bc9ff", "#ffad7d", "#c9a8ff", "#7de2d1", "#f4d06f"];

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
    games: games.map((game, index) => ({
      id: String(game.id || createId("game")),
      title: String(game.title || "Без названия").slice(0, 100),
      color: String(game.color || GAME_COLORS[index % GAME_COLORS.length]),
      createdAt: validIso(game.createdAt) ? game.createdAt : new Date().toISOString()
    })),
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

function normalizeSession(session) {
  const plannedMinutes = Math.max(1, Number(session.plannedMinutes || session.basePlannedMinutes || 1));
  const actualMinutes = Math.max(0, Number(session.actualMinutes || 0));
  const motives = normalizeMotives(session);
  return {
    ...session,
    id: String(session.id || createId("session")),
    gameId: String(session.gameId),
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    basePlannedMinutes: Math.max(1, Number(session.basePlannedMinutes || plannedMinutes)),
    plannedMinutes,
    actualMinutes,
    overtimeMinutes: Math.max(0, Number(session.overtimeMinutes ?? Math.ceil(actualMinutes - plannedMinutes))),
    onTime: typeof session.onTime === "boolean" ? session.onTime : actualMinutes <= plannedMinutes + 1,
    extensions: Array.isArray(session.extensions) ? session.extensions : [],
    checklistResults: session.checklistResults && typeof session.checklistResults === "object" ? session.checklistResults : {},
    preState: clamp(Number(session.preState ?? 3), 1, 5),
    satisfaction: clamp(Number(session.satisfaction ?? 3), 1, 5),
    compulsivity: clamp(Number(session.compulsivity ?? 3), 1, 5),
    motives,
    motive: motives[0] || "",
    afterAction: String(session.afterAction || ""),
    afterActionConfirmed: Boolean(session.afterActionConfirmed),
    outcomeNote: String(session.outcomeNote || ""),
    override: session.override || null
  };
}

function normalizeActiveSession(session) {
  const planned = Math.max(1, Number(session.plannedMinutes || session.basePlannedMinutes || 1));
  const motives = normalizeMotives(session);
  return {
    ...session,
    id: String(session.id || createId("session")),
    gameId: String(session.gameId),
    startedAt: session.startedAt,
    basePlannedMinutes: Math.max(1, Number(session.basePlannedMinutes || planned)),
    plannedMinutes: planned,
    plannedEndAt: validIso(session.plannedEndAt)
      ? session.plannedEndAt
      : new Date(new Date(session.startedAt).getTime() + planned * 60_000).toISOString(),
    extensions: Array.isArray(session.extensions) ? session.extensions : [],
    checklistResults: session.checklistResults && typeof session.checklistResults === "object" ? session.checklistResults : {},
    preState: clamp(Number(session.preState ?? 3), 1, 5),
    motives,
    motive: motives[0] || "",
    afterAction: String(session.afterAction || ""),
    override: session.override || null
  };
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

function isValidSession(session) {
  return Boolean(
    session &&
    typeof session === "object" &&
    session.gameId &&
    validIso(session.startedAt) &&
    validIso(session.endedAt)
  );
}

function isValidActiveSession(session) {
  return Boolean(session && typeof session === "object" && session.gameId && validIso(session.startedAt));
}

export function validIso(value) {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function calculateSessionMetrics(startedAt, endedAt, plannedMinutes) {
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  const actualMinutesExact = Math.max(0, (end - start) / 60_000);
  const actualMinutes = Math.max(1, Math.ceil(actualMinutesExact));
  const overtimeMinutes = Math.max(0, Math.ceil(actualMinutesExact - plannedMinutes));
  return {
    actualMinutes,
    overtimeMinutes,
    onTime: actualMinutesExact <= plannedMinutes + 1 / 60
  };
}

export function getTimerState(activeSession, now = Date.now()) {
  const start = new Date(activeSession.startedAt).getTime();
  const plannedEnd = new Date(activeSession.plannedEndAt).getTime();
  const elapsedMs = Math.max(0, now - start);
  const remainingMs = plannedEnd - now;
  const plannedMs = Math.max(1, plannedEnd - start);
  return {
    elapsedMs,
    remainingMs,
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
    if (!totals[session.gameId]) totals[session.gameId] = { minutes: 0, sessions: 0 };
    totals[session.gameId].minutes += Number(session.actualMinutes) || 0;
    totals[session.gameId].sessions += 1;
  });
  return totals;
}

export function summarizeStats(state, now = new Date()) {
  const sessions = [...state.sessions].sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
  const totalMinutes = sessions.reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0);
  const totalPlanned = sessions.reduce((sum, session) => sum + Number(session.plannedMinutes || 0), 0);
  const onTimeCount = sessions.filter((session) => session.onTime).length;
  const extensions = sessions.reduce((sum, session) => sum + (session.extensions?.length || 0), 0);
  const overrides = sessions.filter((session) => session.override).length;
  const lateHour = state.settings?.lateHour ?? 22;
  const lateSessions = sessions.filter((session) => new Date(session.startedAt).getHours() >= lateHour).length;

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
    byGame[session.gameId] = (byGame[session.gameId] || 0) + Number(session.actualMinutes || 0);
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
    onTimePercent: sessions.length ? Math.round((onTimeCount / sessions.length) * 100) : 0,
    extensions,
    overrides,
    lateSessions,
    byDay,
    byGame,
    motives,
    preState,
    satisfaction,
    compulsivity,
    weeks: buildWeeklyStats(sessions, 8, now)
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
    const minutes = selected.reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0);
    const plannedMinutes = selected.reduce((sum, session) => sum + Number(session.plannedMinutes || 0), 0);
    const onTimeCount = selected.filter((session) => session.onTime).length;
    result.push({
      key: localDateKey(start),
      start: start.toISOString(),
      end: end.toISOString(),
      minutes,
      plannedMinutes,
      sessions: selected.length,
      onTimeCount,
      onTimePercent: selected.length ? Math.round(onTimeCount / selected.length * 100) : 0
    });
  }
  return result;
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

export function motiveLabel(value) {
  return MOTIVES.find((item) => item.value === value)?.label || "Не указан";
}
