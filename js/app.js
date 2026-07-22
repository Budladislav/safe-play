import {
  STORAGE_KEY,
  APP_VERSION,
  APP_RELEASE_DATE,
  MOTIVES,
  GAME_COLORS,
  SESSION_WARNING_LEADS,
  LEGACY_STORAGE_KEY,
  buildHeatmapDays,
  calculateSessionMetrics,
  clamp,
  createDefaultState,
  createId,
  formatClock,
  formatDateTime,
  formatDuration,
  formatTimer,
  getAccumulatedPausedMs,
  getGameTotals,
  getSessionsInRange,
  getTimerState,
  isCooldownActive,
  motiveLabel,
  normalizeState,
  shouldTriggerSessionWarning,
  startOfWeek,
  summarizeStats
} from "./core.js";

const app = document.querySelector("#app");
const modalRoot = document.querySelector("#modalRoot");
const toastStack = document.querySelector("#toastStack");
const importInput = document.querySelector("#importInput");
const validViews = ["home", "library", "history", "stats", "settings"];

let state = loadState();
let currentView = getViewFromHash();
let timerInterval = null;
let deferredInstallPrompt = null;
let wakeLock = null;
let lastTimerWasOvertime = null;
let gameSaveReturn = null;
let warningAudioContext = null;

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const legacy = raw ? null : localStorage.getItem(LEGACY_STORAGE_KEY);
    const restored = raw || legacy;
    const normalized = restored ? normalizeState(JSON.parse(restored)) : createDefaultState();
    if (legacy) localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch (error) {
    console.error("Could not load state", error);
    return createDefaultState();
  }
}

function saveState() {
  state.meta.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getViewFromHash() {
  const candidate = window.location.hash.replace("#", "");
  return validViews.includes(candidate) ? candidate : "home";
}

function navigate(view) {
  if (!validViews.includes(view)) return;
  currentView = view;
  if (window.location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function render() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.querySelectorAll("[data-view-link]").forEach((item) => {
    item.classList.toggle("active", item.dataset.viewLink === currentView);
  });

  const renderers = {
    home: renderHome,
    library: renderLibrary,
    history: renderHistory,
    stats: renderStats,
    settings: renderSettings
  };
  app.innerHTML = renderers[currentView]();
  app.focus({ preventScroll: true });

  if (currentView === "home" && state.activeSession) {
    tickTimer();
    timerInterval = window.setInterval(tickTimer, 1000);
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
}

function renderHome() {
  if (state.activeSession) return renderActiveSession();

  const stats = summarizeStats(state);
  const cooldown = isCooldownActive(state.cooldown);
  const lastSession = [...state.sessions].sort((a, b) => new Date(b.endedAt) - new Date(a.endedAt))[0];
  const lastGame = lastSession ? gameById(lastSession.gameId) : null;

  return `
    <section class="view">
      <div class="view-header">
        <div>
          <span class="eyebrow">${getGreeting()}</span>
          <h1>Сначала решение. Потом игра.</h1>
          <p>Короткая пауза помогает заранее выбрать границы и не спорить с собой уже внутри сессии.</p>
        </div>
      </div>

      ${cooldown ? renderCooldownBanner() : ""}

      <div class="dashboard-grid">
        <article class="card hero">
          <div class="hero-copy">
            <span class="eyebrow">Новая сессия</span>
            <h1>Один спокойный вдох <span>до старта.</span></h1>
            <p>Проверь базовые вещи, назови своё состояние и зафиксируй время окончания. Это займёт около минуты.</p>
          </div>
          <div class="hero-actions">
            <button class="button primary" data-action="open-entry" ${!state.games.length ? "data-needs-game='true'" : ""}>
              ${icon("play")}
              ${state.games.length ? "Подготовить сессию" : "Сначала добавить игру"}
            </button>
            <span class="hero-hint">Никаких очков и серий — только план и факты.</span>
          </div>
        </article>

        <div class="stack">
          <article class="card accent-card">
            <div class="card-header">
              <div>
                <span class="eyebrow">Эта неделя</span>
                <h2>${formatDuration(stats.weekMinutes)}</h2>
              </div>
              <span class="pill">${stats.sessions.filter((s) => isThisWeek(s.startedAt)).length} сесс.</span>
            </div>
            <div class="mini-metrics">
              <div class="mini-metric"><strong>${stats.onTimePercent}%</strong><span>вовремя</span></div>
              <div class="mini-metric"><strong>${stats.extensions}</strong><span>продлений</span></div>
            </div>
          </article>

          <article class="card compact">
            <div class="card-header">
              <div>
                <h3>Последний факт</h3>
                <p>${lastSession ? formatDateTime(lastSession.endedAt) : "История пока пуста"}</p>
              </div>
            </div>
            ${lastSession ? `
              <div class="session-fact">
                <div class="fact-icon">${escapeHTML((lastGame?.title || "?").slice(0, 1).toUpperCase())}</div>
                <div>
                  <strong>${escapeHTML(lastGame?.title || "Удалённая игра")}</strong>
                  <span>${formatDuration(lastSession.actualMinutes)} · ${lastSession.onTime ? "в границах плана" : `+${formatDuration(lastSession.overtimeMinutes)}`}</span>
                </div>
              </div>
              <button class="button ghost small" data-view-link="history">Открыть историю →</button>
            ` : `
              <p class="muted-text">После первой сессии здесь появится краткий итог — без оценок и наград.</p>
            `}
          </article>
        </div>
      </div>
    </section>
  `;
}

function renderCooldownBanner() {
  const until = formatDateTime(state.cooldown.until, { weekday: "short" });
  return `
    <article class="card warning-card" style="margin-bottom:18px">
      <div class="card-header" style="margin:0">
        <div>
          <span class="eyebrow">Мягкая пауза</span>
          <h2>Библиотека приглушена до ${until}</h2>
          <p>Предыдущая сессия закончилась с сильным желанием продолжить или заметным перерасходом.</p>
        </div>
        <button class="button small" data-action="release-cooldown">Снять паузу осознанно</button>
      </div>
    </article>
  `;
}

function renderActiveSession() {
  const session = state.activeSession;
  const game = gameById(session.gameId);
  const timer = getTimerState(session);
  const extensionsLeft = Math.max(0, state.settings.extensionLimit - session.extensions.length);
  lastTimerWasOvertime = timer.isOvertime;

  return `
    <section class="view">
      <div class="view-header">
        <div>
          <span class="eyebrow">${timer.isPaused ? "Сессия на паузе" : "Сессия идёт"}</span>
          <h1>${escapeHTML(game?.title || "Игра")}</h1>
        </div>
        <div class="header-actions">
          <button class="button danger" data-action="open-finish">Завершить сессию</button>
        </div>
      </div>

      <div class="timer-layout">
        <article class="card timer-stage ${timer.isPaused ? "paused" : timer.isOvertime ? "overtime" : ""}" id="timerStage">
          <div class="timer-topline">
            <span class="status-pill ${timer.isOvertime ? "required" : "info"}" id="timerStatus">${timer.isPaused ? "На паузе" : timer.isOvertime ? "План завершён" : "В границах плана"}</span>
            <span class="subtle-text">старт ${formatClock(session.startedAt)}</span>
          </div>

          <div class="timer-center">
            <div class="timer-label" id="timerLabel">${timer.isPaused ? "Пауза" : timer.isOvertime ? "Перерасход" : "До решения"}</div>
            <div class="timer-value" id="timerValue">${formatTimer(timer.remainingMs)}</div>
            <div class="timer-subtext" id="timerSubtext">
              ${timer.isPaused ? "Игровое время и граница сессии остановлены" : timer.isOvertime ? "Пора принять новое явное решение" : `Плановое окончание в ${formatClock(session.plannedEndAt)}`}
            </div>
          </div>

          <div>
            <div class="progress-track"><div class="progress-bar" id="timerProgress" style="width:${timer.progress}%"></div></div>
            <div class="button-row" style="justify-content:center;margin-top:24px">
              <button class="button ${timer.isPaused ? "primary" : ""}" data-action="toggle-session-pause">${timer.isPaused ? "Продолжить" : "Пауза"}</button>
              <button class="button ${timer.isPaused ? "" : "primary"}" data-action="open-finish">Закончить сейчас</button>
              <button class="button" data-action="open-extension" ${extensionsLeft <= 0 ? "disabled" : ""}>
                Продлить ${extensionsLeft > 0 ? `· осталось ${extensionsLeft}` : "· лимит исчерпан"}
              </button>
            </div>
          </div>
        </article>

        <div class="stack">
          <article class="card compact">
            <div class="card-header">
              <div><h3>Зафиксированный план</h3><p>Не обещание, а ориентир для решения.</p></div>
            </div>
            <div class="session-fact">
              <div class="fact-icon">◷</div>
              <div><strong>${formatDuration(session.plannedMinutes)}</strong><span>плановая длительность${session.extensions.length ? ` · +${session.extensions.reduce((s, e) => s + e.minutes, 0)} мин продления` : ""}</span></div>
            </div>
            <div class="session-fact">
              <div class="fact-icon">→</div>
              <div><strong>${escapeHTML(session.afterAction || "Не указано")}</strong><span>следующее действие</span></div>
            </div>
            <div class="session-fact">
              <div class="fact-icon">${session.preState}</div>
              <div><strong>Состояние до игры</strong><span>${motiveLabels(session)}</span></div>
            </div>
          </article>

          <article class="card compact ${timer.isOvertime ? "danger-card" : ""}" id="decisionCard">
            ${renderTimerDecision(timer.isOvertime, extensionsLeft)}
          </article>
        </div>
      </div>
    </section>
  `;
}

function renderTimerDecision(isOvertime, extensionsLeft) {
  if (!isOvertime) {
    return `
      <div class="card-header"><div><h3>Когда время закончится</h3><p>Экран останется доступным.</p></div></div>
      <p class="muted-text">Таймер станет красным и начнёт показывать перерасход. После этого нужно закончить или отдельно зафиксировать продление.</p>
    `;
  }
  return `
    <span class="eyebrow text-danger">Новая точка решения</span>
    <h3 style="margin:8px 0 6px">Плановое время вышло</h3>
    <p class="muted-text">Не нужно останавливаться мгновенно. Нужно только снова решить, что происходит.</p>
    <div class="decision-box">
      <button class="button primary" data-action="open-finish">Завершить</button>
      <button class="button" data-action="open-extension" ${extensionsLeft <= 0 ? "disabled" : ""}>Продлить на 15/30 минут</button>
      ${extensionsLeft <= 0 ? `<span class="subtle-text">Лимит продлений на эту сессию исчерпан.</span>` : ""}
    </div>
  `;
}

function tickTimer() {
  if (!state.activeSession) return;
  const timer = getTimerState(state.activeSession);
  const value = document.querySelector("#timerValue");
  const progress = document.querySelector("#timerProgress");
  if (!value) return;

  value.textContent = formatTimer(timer.remainingMs);
  if (progress) progress.style.width = `${timer.progress}%`;

  if (shouldTriggerSessionWarning(state.activeSession, state.settings)) {
    triggerSessionWarning();
  }

  if (lastTimerWasOvertime === false && timer.isOvertime) {
    lastTimerWasOvertime = true;
    showTimerNotification();
    render();
  }
}

function renderLibrary() {
  const totals = getGameTotals(state);
  const cooldown = isCooldownActive(state.cooldown);
  return `
    <section class="view">
      <div class="view-header">
        <div>
          <span class="eyebrow">Библиотека</span>
          <h1>Ваши игры</h1>
        </div>
        <div class="header-actions">
          ${cooldown ? `<button class="button" data-action="release-cooldown">Снять мягкую паузу</button>` : ""}
          <button class="button primary" data-action="add-game">${icon("plus")} Добавить игру</button>
        </div>
      </div>

      ${cooldown ? `<div class="notice warning" style="margin-bottom:18px"><span>◈</span><div><strong>Библиотека приглушена</strong><br>Это визуальная пауза, а не запрет. Её можно снять явным действием.</div></div>` : ""}

      ${state.games.length ? `
        <div class="game-grid">
          ${state.games.map((game) => renderGameCard(game, totals[game.id], cooldown)).join("")}
        </div>
      ` : `
        <div class="empty-state">
          <div>
            <div class="empty-icon">＋</div>
            <h2>Добавьте первую игру</h2>
            <p>Достаточно названия. Обложки и игровые достижения здесь намеренно не нужны.</p>
            <button class="button primary" data-action="add-game">Добавить игру</button>
          </div>
        </div>
      `}
    </section>
  `;
}

function renderGameCard(game, totals = { minutes: 0, sessions: 0 }, cooldown = false) {
  return `
    <article class="game-card ${cooldown ? "cooldown" : ""}" style="--game-color:${escapeAttr(game.color)}">
      <div>
        <div class="game-card-header">
          <div class="game-symbol">${escapeHTML(game.title.slice(0, 1))}</div>
          <div class="game-menu">
            <button class="icon-button" data-action="edit-game" data-id="${escapeAttr(game.id)}" title="Редактировать">${icon("edit")}</button>
            <button class="icon-button" data-action="delete-game" data-id="${escapeAttr(game.id)}" title="Удалить">${icon("trash")}</button>
          </div>
        </div>
        <h3>${escapeHTML(game.title)}</h3>
        <p>${totals.sessions} ${plural(totals.sessions, ["сессия", "сессии", "сессий"])}</p>
      </div>
      <div class="game-card-footer">
        <div class="game-time"><strong>${formatDuration(totals.minutes)}</strong><span>всего в игре</span></div>
        ${cooldown ? `<span class="lock-chip">◇ пауза</span>` : `<button class="button small" data-action="open-entry" data-game-id="${escapeAttr(game.id)}">Играть</button>`}
      </div>
    </article>
  `;
}

function renderHistory() {
  const sessions = [...state.sessions].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  return `
    <section class="view">
      <div class="view-header">
        <div>
          <span class="eyebrow">Журнал фактов</span>
          <h1>История сессий</h1>
          <p>План, фактическое время и короткий итог — без игровых серий и оценки «хорошо/плохо».</p>
        </div>
      </div>

      ${sessions.length ? `
        <article class="card">
          <div class="history-list">
            ${sessions.map((session) => {
              const game = gameById(session.gameId);
              return `
                <button class="history-item" data-action="session-details" data-id="${escapeAttr(session.id)}" style="color:inherit;text-align:left;cursor:pointer">
                  <div class="history-main">
                    <strong>${escapeHTML(game?.title || "Удалённая игра")}</strong>
                    <span>${formatDateTime(session.startedAt)}</span>
                  </div>
                  <div class="history-stat">
                    <strong>${formatDuration(session.actualMinutes)}</strong>
                    <span>факт · план ${formatDuration(session.plannedMinutes)}</span>
                  </div>
                  <div class="history-stat">
                    <strong>${escapeHTML(session.outcomeNote || "Без заметки")}</strong>
                    <span>${session.afterActionConfirmed ? "следующее действие подтверждено" : "следующее действие не подтверждено"}</span>
                  </div>
                  <span class="status-pill ${session.onTime ? "info" : "required"}">${session.onTime ? "вовремя" : `+${session.overtimeMinutes} мин`}</span>
                </button>
              `;
            }).join("")}
          </div>
        </article>
      ` : `
        <div class="empty-state"><div><div class="empty-icon">◷</div><h2>Здесь появятся факты</h2><p>Завершите первую сессию, чтобы увидеть план и фактическое время рядом.</p><button class="button primary" data-view-link="home">На главную</button></div></div>
      `}
    </section>
  `;
}

function renderStats() {
  const stats = summarizeStats(state);
  const days = buildHeatmapDays(stats.byDay, 18);
  const recent = stats.sessions.slice(-12);
  const maxPlanActual = Math.max(1, ...recent.flatMap((s) => [s.plannedMinutes, s.actualMinutes]));
  const maxGame = Math.max(1, ...Object.values(stats.byGame));
  const gameBars = Object.entries(stats.byGame).sort((a, b) => b[1] - a[1]);
  const maxDistribution = Math.max(1, ...stats.compulsivity);
  const currentWeek = stats.weeks.at(-1);
  const maxWeek = Math.max(1, ...stats.weeks.map((week) => week.minutes));

  return `
    <section class="view">
      <div class="view-header">
        <div>
          <span class="eyebrow">Паттерны, не награды</span>
          <h1>Статистика контроля</h1>
          <p>Главный сигнал — разница между заранее выбранным планом и тем, что произошло.</p>
        </div>
        <div class="button-row">
          <button class="button" data-action="download-week-report">↓ Скачать картинку недели</button>
          <button class="button" data-action="share-week-report">↗ Поделиться картинкой</button>
          <button class="button primary" data-action="open-text-report">↓ Подробный TXT-отчёт</button>
        </div>
      </div>

      <div class="grid three" style="margin-bottom:18px">
        <article class="card"><div class="metric"><span class="metric-value">${stats.onTimePercent}%</span><span class="metric-label">сессий завершены вовремя</span><span class="metric-caption">${stats.onTimeCount} из ${stats.sessions.length}</span></div></article>
        <article class="card"><div class="metric"><span class="metric-value">${formatDuration(stats.totalMinutes)}</span><span class="metric-label">общее игровое время</span><span class="metric-caption">план: ${formatDuration(stats.totalPlanned)}</span></div></article>
        <article class="card"><div class="metric"><span class="metric-value">${stats.extensions}</span><span class="metric-label">явных продлений</span><span class="metric-caption">обходов чек-листа: ${stats.overrides}</span></div></article>
      </div>

      <article class="card" style="margin-bottom:18px">
        <div class="card-header"><div><h2>Игровое время по неделям</h2><p>Последние 8 недель · текущая: ${formatDuration(currentWeek.minutes)}</p></div></div>
        <div class="bar-list weekly-bars">
          ${[...stats.weeks].reverse().map((week, index) => `<div class="bar-row"><span class="bar-label">${index === 0 ? "Текущая неделя" : formatWeekRange(week.start, week.end)}</span><span class="bar-track"><span class="bar-fill ${week.minutes > week.plannedMinutes ? "danger" : ""}" style="display:block;width:${week.minutes / maxWeek * 100}%"></span></span><span class="bar-value">${formatDuration(week.minutes)} · ${week.sessions} ${plural(week.sessions, ["сессия", "сессии", "сессий"])}</span></div>`).join("")}
        </div>
      </article>

      <div class="grid two" style="margin-bottom:18px">
        <article class="card">
          <div class="card-header"><div><h2>Игровое время по дням</h2><p>Последние 18 недель</p></div></div>
          <div class="heatmap-wrap">
            <div class="heatmap">
              ${days.map((day) => `<span class="heat-cell" data-level="${day.level}" title="${formatDateTime(day.date, { year: "numeric" })}: ${formatDuration(day.minutes)}"></span>`).join("")}
            </div>
          </div>
          <div class="heatmap-legend"><span>Пустой день — тоже нормальный день.</span><span class="legend-scale">меньше <i class="heat-cell"></i><i class="heat-cell" data-level="1"></i><i class="heat-cell" data-level="2"></i><i class="heat-cell" data-level="3"></i><i class="heat-cell" data-level="4"></i> больше</span></div>
        </article>

        <article class="card">
          <div class="card-header"><div><h2>План и факт</h2><p>Последние ${recent.length} сессий</p></div></div>
          ${recent.length ? `
            <div class="plan-actual-chart">
              ${recent.map((session) => `
                <div class="plan-group" title="${escapeAttr(gameById(session.gameId)?.title || "Игра")}: план ${session.plannedMinutes}, факт ${session.actualMinutes} мин">
                  <span class="plan-column" style="height:${Math.max(2, session.plannedMinutes / maxPlanActual * 100)}%"></span>
                  <span class="actual-column ${session.onTime ? "" : "over"}" style="height:${Math.max(2, session.actualMinutes / maxPlanActual * 100)}%"></span>
                </div>
              `).join("")}
            </div>
            <div class="chart-legend"><span class="chart-key" style="--key-color:#66705e">план</span><span class="chart-key" style="--key-color:var(--accent)">факт в плане</span><span class="chart-key" style="--key-color:var(--danger)">факт с перерасходом</span></div>
          ` : `<div class="empty-state" style="min-height:190px"><p>Нужно хотя бы одно завершённое занятие.</p></div>`}
        </article>
      </div>

      <div class="grid two" style="margin-bottom:18px">
        <article class="card">
          <div class="card-header"><div><h2>Распределение времени</h2><p>Между играми</p></div></div>
          ${gameBars.length ? `<div class="bar-list">${gameBars.map(([gameId, minutes]) => `
            <div class="bar-row">
              <span class="bar-label">${escapeHTML(gameById(gameId)?.title || "Удалённая игра")}</span>
              <span class="bar-track"><span class="bar-fill" style="display:block;width:${minutes / maxGame * 100}%"></span></span>
              <span class="bar-value">${formatDuration(minutes)}</span>
            </div>
          `).join("")}</div>` : `<p class="muted-text">Пока нет данных.</p>`}
        </article>

        <article class="card">
          <div class="card-header"><div><h2>Желание продолжить</h2><p>Оценка на выходе, 1–5</p></div></div>
          <div class="distribution">
            ${stats.compulsivity.map((count, index) => `
              <div class="distribution-column"><div class="distribution-bar-wrap"><span class="distribution-bar" style="height:${Math.max(count ? 8 : 2, count / maxDistribution * 100)}%"></span></div><span>${index + 1} · ${count}</span></div>
            `).join("")}
          </div>
        </article>
      </div>

      <div class="grid two">
        <article class="card">
          <div class="card-header"><div><h2>Почему хотелось играть</h2><p>Можно выбрать несколько причин на входе</p></div></div>
          ${Object.keys(stats.motives).length ? `<div class="bar-list">${Object.entries(stats.motives).sort((a,b) => b[1]-a[1]).map(([key, count]) => `
            <div class="bar-row"><span class="bar-label">${escapeHTML(motiveLabel(key))}</span><span class="bar-track"><span class="bar-fill blue" style="display:block;width:${count / Math.max(...Object.values(stats.motives)) * 100}%"></span></span><span class="bar-value">${count}</span></div>
          `).join("")}</div>` : `<p class="muted-text">Причины пока не указывались.</p>`}
        </article>
        <article class="card">
          <div class="card-header"><div><h2>Дополнительные сигналы</h2><p>Для наблюдения, не для наказания</p></div></div>
          <div class="mini-metrics">
            <div class="mini-metric"><strong>${stats.lateSessions}</strong><span>поздних сессий</span></div>
            <div class="mini-metric"><strong>${stats.overrides}</strong><span>обходов чек-листа</span></div>
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderSettings() {
  const checklist = [...state.checklist].sort((a, b) => a.order - b.order);
  return `
    <section class="view">
      <div class="view-header">
        <div>
          <span class="eyebrow">Ваши правила</span>
          <h1>Настройки</h1>
          <p>Подстройте трение под себя. Все изменения сохраняются только на этом устройстве.</p>
        </div>
      </div>

      <div class="grid two">
        <div class="stack">
          <article class="card settings-section">
            <div class="card-header">
              <div><h2>Пункты входа</h2><p>Порядок, статус и активность</p></div>
              <button class="button small" data-action="add-check">${icon("plus")} Добавить</button>
            </div>
            <div class="settings-list">
              ${checklist.map((item, index) => `
                <div class="settings-item">
                  <div class="order-actions">
                    <button data-action="move-check" data-id="${escapeAttr(item.id)}" data-direction="-1" ${index === 0 ? "disabled" : ""}>↑</button>
                    <button data-action="move-check" data-id="${escapeAttr(item.id)}" data-direction="1" ${index === checklist.length - 1 ? "disabled" : ""}>↓</button>
                  </div>
                  <button class="setting-copy" data-action="edit-check" data-id="${escapeAttr(item.id)}" style="border:0;background:none;color:inherit;text-align:left;cursor:pointer">
                    <strong>${escapeHTML(item.title)}</strong><span>нажмите, чтобы изменить</span>
                  </button>
                  <span class="status-pill ${item.required ? "required" : "info"}">${item.required ? "обязательный" : "информационный"}</span>
                  <label class="switch" title="Включить пункт"><input type="checkbox" data-setting="check-enabled" data-id="${escapeAttr(item.id)}" ${item.enabled ? "checked" : ""}><span class="switch-slider"></span></label>
                </div>
              `).join("")}
            </div>
          </article>

          <article class="card">
            <div class="card-header"><div><h2>Поведение сессии</h2><p>Границы и возможности устройства</p></div></div>
            <div class="form-grid">
              <div class="field full">
                <label for="extensionLimit">Лимит продлений на сессию</label>
                <select class="select" id="extensionLimit" data-setting="extension-limit">
                  ${[0,1,2,3].map((value) => `<option value="${value}" ${state.settings.extensionLimit === value ? "selected" : ""}>${value}</option>`).join("")}
                </select>
                <small>Продление всегда требует выбрать 15/30 минут и записать причину.</small>
              </div>
              <div class="field full">
                <label for="lateHour">Поздняя сессия начинается с</label>
                <select class="select" id="lateHour" data-setting="late-hour">
                  ${[20,21,22,23,24].map((value) => `<option value="${value}" ${state.settings.lateHour === value ? "selected" : ""}>${value === 24 ? "00:00" : `${value}:00`}</option>`).join("")}
                </select>
              </div>
              <div class="field full session-warning-settings">
                <span class="field-label">Предупреждение перед концом</span>
                <div class="settings-item" style="grid-template-columns:minmax(0,1fr) auto">
                  <div class="setting-copy"><strong>Звук</strong><span>Короткий сигнал, если PWA и браузер разрешат воспроизведение.</span></div>
                  <label class="switch"><input type="checkbox" data-setting="warning-sound" ${state.settings.warningSound ? "checked" : ""}><span class="switch-slider"></span></label>
                </div>
                <div class="settings-item" style="grid-template-columns:minmax(0,1fr) auto">
                  <div class="setting-copy"><strong>Вибрация</strong><span>Best effort на поддерживаемых Android-устройствах.</span></div>
                  <label class="switch"><input type="checkbox" data-setting="warning-vibration" ${state.settings.warningVibration ? "checked" : ""}><span class="switch-slider"></span></label>
                </div>
                <label for="warningLeadMinutes">Когда предупредить</label>
                <select class="select" id="warningLeadMinutes" data-setting="warning-lead">
                  ${SESSION_WARNING_LEADS.map((value) => `<option value="${value}" ${state.settings.warningLeadMinutes === value ? "selected" : ""}>За ${value} ${value === 1 ? "минуту" : "минут"}</option>`).join("")}
                </select>
                <small>${state.settings.warningSound || state.settings.warningVibration ? "Активные способы можно сочетать." : "Сейчас выключено: включите звук, вибрацию или оба способа."}</small>
              </div>
              <div class="field full">
                <div class="settings-item" style="grid-template-columns:minmax(0,1fr) auto">
                  <div class="setting-copy"><strong>Не выключать экран</strong><span>Best effort: Wake Lock работает не на всех устройствах и только пока PWA открыто.</span></div>
                  <label class="switch"><input type="checkbox" data-setting="keep-awake" ${state.settings.keepAwake ? "checked" : ""}><span class="switch-slider"></span></label>
                </div>
              </div>
            </div>
          </article>
        </div>

        <div class="stack">
          <article class="card accent-card">
            <div class="card-header"><div><span class="eyebrow">О приложении · v${APP_VERSION}</span><h2>Шлюз между импульсом и действием</h2></div><a class="button small" href="./CHANGELOG.md" target="_blank" rel="noopener">Ченджлог</a></div>
            <p class="muted-text">Safe Play не считает игры проблемой и не блокирует их силой. Он добавляет короткую паузу до старта, фиксирует выбранные границы и возвращает факты после.</p>
          </article>

          <article class="card">
            <div class="card-header"><div><h2>Все данные</h2><p>Резервная копия и перенос</p></div></div>
            <div class="data-actions">
              <button class="data-action" data-action="export-data"><span class="fact-icon">↓</span><span><strong>Экспорт JSON</strong><span>${state.sessions.length} сессий · ${state.games.length} игр</span></span></button>
              <button class="data-action" data-action="import-data"><span class="fact-icon">↑</span><span><strong>Импорт JSON</strong><span>заменит локальные данные после подтверждения</span></span></button>
            </div>
            <p class="subtle-text" style="margin:14px 0 0">Последнее изменение: ${formatDateTime(state.meta.updatedAt)}</p>
          </article>

          <article class="card danger-card">
            <div class="card-header"><div><h2>Сброс приложения</h2><p>Игры, история и настройки будут удалены</p></div></div>
            <div class="button-row"><button class="button danger small" data-action="reset-data">Удалить все локальные данные</button></div>
          </article>

          <div class="version-stamp"><span>Safe Play</span><strong>v${APP_VERSION}</strong><span>· обновлено ${formatReleaseDate(APP_RELEASE_DATE)}</span></div>
        </div>
      </div>
    </section>
  `;
}

function openEntryModal(preselectedGameId = "") {
  if (!state.games.length) {
    gameSaveReturn = "entry";
    openGameModal();
    toast("Сначала одна игра", "Для планирования нужно название игры.");
    return;
  }

  if (isCooldownActive(state.cooldown)) {
    openReleaseCooldownModal(() => openEntryModal(preselectedGameId));
    return;
  }

  const checks = [...state.checklist].filter((item) => item.enabled).sort((a, b) => a.order - b.order);
  const end = new Date(Date.now() + 60 * 60_000);
  openModal(`
    <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="entryTitle">
      <div class="modal-header">
        <div><span class="eyebrow">Пауза перед стартом</span><h2 id="entryTitle">Подготовить сессию</h2><p>Заполните это для себя, не для приложения.</p></div>
        <button class="icon-button" data-close-modal aria-label="Закрыть">${icon("close")}</button>
      </div>
      <form id="entryForm">
        <div class="modal-body">
          <section class="modal-section">
            <div class="section-heading"><div><h3>1. Базовые вещи</h3><p>Информационный пункт не блокирует старт.</p></div></div>
            <div class="checklist">
              ${checks.map((item) => `
                <label class="check-row">
                  <input type="checkbox" name="check-${escapeAttr(item.id)}" data-check-id="${escapeAttr(item.id)}" data-required="${item.required}">
                  <span><strong>${escapeHTML(item.title)}</strong><small>${item.required ? "нужно подтвердить или осознанно обойти" : "только для контекста"}</small></span>
                  <span class="status-pill ${item.required ? "required" : "info"}">${item.required ? "обяз." : "инфо"}</span>
                </label>
              `).join("")}
            </div>
          </section>

          <section class="modal-section">
            <div class="section-heading"><div><h3>2. Как вы сейчас?</h3><p>1 — совсем нет ресурса, 5 — отлично.</p></div></div>
            <div class="rating-control"><div class="range-field"><input type="range" name="preState" min="1" max="5" value="3" data-range-output="preStateValue"><output class="range-value" id="preStateValue">3</output></div>${renderRatingScale(["Очень плохо", "Плохо", "Нормально", "Хорошо", "Отлично"])}</div>
            <div class="field">
              <span class="field-label">Почему хочется играть? <span class="subtle-text">можно выбрать несколько</span></span>
              <div class="chip-group">
                ${MOTIVES.map((item) => `<label class="choice-chip"><input type="checkbox" name="motives" value="${item.value}"><span>${escapeHTML(item.label)}</span></label>`).join("")}
              </div>
            </div>
          </section>

          <section class="modal-section">
            <div class="section-heading"><div><h3>3. Зафиксируйте границы</h3><p>План можно продлить позже, но только отдельным решением.</p></div></div>
            <div class="form-grid">
              <div class="field">
                <label for="entryGame">Игра</label>
                <select class="select" id="entryGame" name="gameId" required>
                  ${state.games.map((game) => `<option value="${escapeAttr(game.id)}" ${game.id === preselectedGameId ? "selected" : ""}>${escapeHTML(game.title)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label for="plannedMinutes">Плановая длительность</label>
                <select class="select" id="plannedMinutes" name="plannedMinutes">
                  ${[30,45,60,90,120,180].map((minutes) => `<option value="${minutes}" ${minutes === 60 ? "selected" : ""}>${formatDuration(minutes)}</option>`).join("")}
                </select>
              </div>
              <div class="field full">
                <div class="plan-preview"><span>Плановое окончание</span><strong id="plannedEndPreview">${formatClock(end)}</strong></div>
              </div>
              <div class="field full">
                <label for="afterAction">Что я сделаю после?</label>
                <input class="input" id="afterAction" name="afterAction" maxlength="120" placeholder="Например: душ, чай, дневник" required>
                <small>Короткий мост обратно в реальную жизнь.</small>
              </div>
            </div>
          </section>
        </div>
        <div class="modal-footer">
          <span class="subtle-text" id="entryHint">Подтвердите обязательные пункты.</span>
          <div class="button-row">
            <button class="button ghost" type="button" data-close-modal>Отмена</button>
            <button class="button primary" type="submit">Запустить таймер</button>
          </div>
        </div>
      </form>
    </div>
  `);
  updateEntryHint();
}

function collectEntryPayload(form) {
  const data = new FormData(form);
  const checks = {};
  form.querySelectorAll("[data-check-id]").forEach((input) => { checks[input.dataset.checkId] = input.checked; });
  const missingRequired = [...form.querySelectorAll("[data-check-id][data-required='true']")]
    .filter((input) => !input.checked)
    .map((input) => input.dataset.checkId);
  return {
    gameId: data.get("gameId"),
    plannedMinutes: Number(data.get("plannedMinutes")),
    afterAction: String(data.get("afterAction") || "").trim(),
    preState: Number(data.get("preState")),
    motives: data.getAll("motives").map(String),
    checklistResults: checks,
    missingRequired
  };
}

function beginSession(payload, override = null) {
  const startedAt = new Date();
  const plannedEndAt = new Date(startedAt.getTime() + payload.plannedMinutes * 60_000);
  state.activeSession = {
    id: createId("session"),
    gameId: payload.gameId,
    startedAt: startedAt.toISOString(),
    plannedEndAt: plannedEndAt.toISOString(),
    basePlannedMinutes: payload.plannedMinutes,
    plannedMinutes: payload.plannedMinutes,
    afterAction: payload.afterAction,
    preState: payload.preState,
    motives: payload.motives,
    motive: payload.motives[0] || "",
    checklistResults: payload.checklistResults,
    extensions: [],
    pauses: [],
    totalPausedMs: 0,
    pausedAt: null,
    warningForEndAt: null,
    override
  };
  if (override) {
    state.events.push({ id: createId("event"), type: "override", at: startedAt.toISOString(), sessionId: state.activeSession.id, ...override });
  }
  if (state.settings.warningSound) void prepareWarningAudio();
  saveState();
  closeModal();
  navigate("home");
  toast("Сессия началась", `Плановое окончание в ${formatClock(plannedEndAt)}.`);
}

function openOverrideModal(payload) {
  const missing = payload.missingRequired.map((id) => state.checklist.find((item) => item.id === id)?.title).filter(Boolean);
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="overrideTitle">
      <div class="modal-header"><div><span class="eyebrow text-danger">Осознанный обход</span><h2 id="overrideTitle">Остановитесь ещё на несколько секунд</h2><p>Это не запрет. Просто назовите происходящее.</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <div class="modal-body">
        <div class="notice warning"><span>!</span><div><strong>Не подтверждено:</strong><br>${missing.map(escapeHTML).join("; ")}</div></div>
        <div class="field"><label for="overrideReason">Почему всё равно запускаю игру?</label><textarea class="textarea" id="overrideReason" minlength="8" maxlength="240" placeholder="Напишите честную причину — минимум несколько слов"></textarea><small>Причина сохранится отдельным событием override.</small></div>
        <button class="button danger hold-button" id="holdOverride" disabled>Удерживать 3 секунды</button>
        <p class="subtle-text" style="margin:0;text-align:center">Отпустите раньше — отсчёт сбросится.</p>
      </div>
      <div class="modal-footer"><button class="button ghost" data-action="back-to-entry">Вернуться и проверить</button></div>
    </div>
  `);
  const reason = document.querySelector("#overrideReason");
  const hold = document.querySelector("#holdOverride");
  reason.addEventListener("input", () => { hold.disabled = reason.value.trim().length < 8; });
  setupHoldButton(hold, () => {
    beginSession(payload, {
      reason: reason.value.trim(),
      missingChecklistIds: payload.missingRequired
    });
  });
}

function setupHoldButton(button, onComplete) {
  let started = 0;
  let frame = null;
  const duration = 3000;
  const reset = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = null;
    started = 0;
    button.style.setProperty("--hold-progress", "0%");
    button.textContent = "Удерживать 3 секунды";
  };
  const step = (time) => {
    if (!started) started = time;
    const progress = clamp((time - started) / duration, 0, 1);
    button.style.setProperty("--hold-progress", `${progress * 100}%`);
    button.textContent = progress < 1 ? `Удерживайте… ${Math.ceil((duration - progress * duration) / 1000)} с` : "Подтверждено";
    if (progress >= 1) {
      frame = null;
      onComplete();
    } else {
      frame = requestAnimationFrame(step);
    }
  };
  button.addEventListener("pointerdown", (event) => {
    if (button.disabled) return;
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    frame = requestAnimationFrame(step);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => button.addEventListener(eventName, reset));
  button.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && !frame && !button.disabled) frame = requestAnimationFrame(step);
  });
  button.addEventListener("keyup", reset);
}

function toggleSessionPause() {
  const session = state.activeSession;
  if (!session) return;
  const now = new Date();
  if (session.pausedAt) {
    const durationMs = Math.max(0, now.getTime() - new Date(session.pausedAt).getTime());
    const pause = { startedAt: session.pausedAt, endedAt: now.toISOString(), durationMs };
    session.totalPausedMs = Math.max(0, Number(session.totalPausedMs || 0)) + durationMs;
    const previousEndAt = session.plannedEndAt;
    session.plannedEndAt = new Date(new Date(session.plannedEndAt).getTime() + durationMs).toISOString();
    if (session.warningForEndAt === previousEndAt) session.warningForEndAt = session.plannedEndAt;
    session.pauses = [...(session.pauses || []), pause];
    session.pausedAt = null;
    state.events.push({ id: createId("event"), type: "session-resumed", at: pause.endedAt, sessionId: session.id, durationMs });
    saveState();
    render();
    toast("Сессия продолжена", `Новая точка окончания — ${formatClock(session.plannedEndAt)}.`);
    return;
  }
  session.pausedAt = now.toISOString();
  state.events.push({ id: createId("event"), type: "session-paused", at: session.pausedAt, sessionId: session.id });
  saveState();
  releaseWakeLock();
  render();
  toast("Таймер на паузе", "Игровое время сейчас не учитывается.");
}

function openFinishModal() {
  const session = state.activeSession;
  if (!session) return;
  const now = new Date();
  const metrics = calculateSessionMetrics(session.startedAt, now.toISOString(), session.plannedMinutes, getAccumulatedPausedMs(session, now.getTime()));
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="finishTitle">
      <div class="modal-header"><div><span class="eyebrow">Короткий выход</span><h2 id="finishTitle">Зафиксировать итог</h2><p>${formatDuration(metrics.actualMinutes)} в игре · ${metrics.onTime ? "в рамках плана" : `перерасход ${formatDuration(metrics.overtimeMinutes)}`}</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <form id="finishForm">
        <div class="modal-body">
          <div class="form-grid">
            <div class="field full"><label>Удовлетворение от игры</label><div class="rating-control"><div class="range-field"><input type="range" name="satisfaction" min="1" max="5" value="3" data-range-output="satisfactionValue"><output class="range-value" id="satisfactionValue">3</output></div>${renderRatingScale(["Совсем нет", "Скорее нет", "Средне", "Скорее да", "Полностью"])}</div></div>
            <div class="field full"><label>Желание продолжить</label><div class="rating-control"><div class="range-field"><input type="range" name="compulsivity" min="1" max="5" value="3" data-range-output="compulsivityValue"><output class="range-value" id="compulsivityValue">3</output></div>${renderRatingScale(["Не тянет", "Слабо", "Средне", "Сильно", "Очень сильно"])}</div></div>
            <div class="field full"><label for="outcomeNote">Чем закончилась сессия?</label><textarea class="textarea" id="outcomeNote" name="outcomeNote" maxlength="240" placeholder="Например: прошёл главу, сохранился у босса"></textarea></div>
            <div class="field full"><label class="check-row"><input type="checkbox" name="afterActionConfirmed"><span><strong>Следующее действие: ${escapeHTML(session.afterAction || "не указано")}</strong><small>Я подтверждаю, что сейчас возвращаюсь к нему</small></span><span class="status-pill info">мост</span></label></div>
          </div>
          <div class="plan-preview"><span>План / факт на эту минуту</span><strong>${session.plannedMinutes} / ${metrics.actualMinutes} мин</strong></div>
        </div>
        <div class="modal-footer"><span class="subtle-text">Два ползунка и одна короткая заметка.</span><div class="button-row"><button class="button ghost" type="button" data-close-modal>Продолжить игру</button><button class="button primary" type="submit">Завершить и сохранить</button></div></div>
      </form>
    </div>
  `);
}

function finishSession(form) {
  const active = state.activeSession;
  if (!active) return;
  const data = new FormData(form);
  const endedAt = new Date().toISOString();
  const endedAtMs = new Date(endedAt).getTime();
  const totalPausedMs = getAccumulatedPausedMs(active, endedAtMs);
  const pauses = active.pausedAt
    ? [...(active.pauses || []), { startedAt: active.pausedAt, endedAt, durationMs: Math.max(0, endedAtMs - new Date(active.pausedAt).getTime()) }]
    : [...(active.pauses || [])];
  const metrics = calculateSessionMetrics(active.startedAt, endedAt, active.plannedMinutes, totalPausedMs);
  const session = {
    ...active,
    endedAt,
    pausedAt: null,
    totalPausedMs,
    pauses,
    ...metrics,
    satisfaction: Number(data.get("satisfaction")),
    compulsivity: Number(data.get("compulsivity")),
    outcomeNote: String(data.get("outcomeNote") || "").trim(),
    afterActionConfirmed: data.has("afterActionConfirmed")
  };
  state.sessions.push(session);
  state.activeSession = null;

  const cooldownTriggered = session.compulsivity >= 4 || session.overtimeMinutes >= 30;
  if (cooldownTriggered) {
    const until = new Date(Date.now() + 48 * 60 * 60_000).toISOString();
    state.cooldown = {
      id: createId("cooldown"),
      startedAt: endedAt,
      until,
      reason: session.compulsivity >= 4 ? "high-compulsivity" : "large-overtime",
      sourceSessionId: session.id
    };
    state.events.push({ id: createId("event"), type: "cooldown-started", at: endedAt, sourceSessionId: session.id, until });
  }
  saveState();
  closeModal();
  releaseWakeLock();
  render();
  openSessionSummary(session, cooldownTriggered);
}

function openSessionSummary(session, cooldownTriggered) {
  const game = gameById(session.gameId);
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="summaryTitle">
      <div class="modal-header"><div><span class="eyebrow">Сессия завершена</span><h2 id="summaryTitle">Факт сохранён</h2><p>${escapeHTML(game?.title || "Игра")} · ${formatDuration(session.actualMinutes)}</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <div class="modal-body">
        <div class="mini-metrics">
          <div class="mini-metric"><strong>${session.plannedMinutes} мин</strong><span>план</span></div>
          <div class="mini-metric"><strong class="${session.onTime ? "text-success" : "text-danger"}">${session.actualMinutes} мин</strong><span>факт</span></div>
        </div>
        <div class="notice ${session.onTime ? "" : "warning"}"><span>${session.onTime ? "✓" : "◷"}</span><div><strong>${session.onTime ? "Остановились в границах плана" : `Перерасход: ${session.overtimeMinutes} мин`}</strong><br>Это наблюдение, а не оценка.</div></div>
        ${cooldownTriggered ? `<div class="notice warning"><span>◇</span><div><strong>Включена мягкая пауза на 48 часов</strong><br>Библиотека будет визуально приглушена. Паузу можно снять вручную.</div></div>` : ""}
        <div class="session-fact"><div class="fact-icon">→</div><div><strong>${escapeHTML(session.afterAction || "Следующее действие не указано")}</strong><span>${session.afterActionConfirmed ? "подтверждено на выходе" : "не подтверждено"}</span></div></div>
      </div>
      <div class="modal-footer"><button class="button primary" data-close-modal>Готово</button></div>
    </div>
  `);
}

function openExtensionModal() {
  const session = state.activeSession;
  if (!session) return;
  const left = state.settings.extensionLimit - session.extensions.length;
  if (left <= 0) {
    toast("Лимит исчерпан", "Для этой сессии больше нет запланированных продлений.");
    return;
  }
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="extensionTitle">
      <div class="modal-header"><div><span class="eyebrow">Новое решение</span><h2 id="extensionTitle">Продлить сессию</h2><p>Продление будет записано отдельно.</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <form id="extensionForm">
        <div class="modal-body">
          <div class="field"><span class="field-label">На сколько?</span><div class="chip-group"><label class="choice-chip"><input type="radio" name="minutes" value="15" checked><span>15 минут</span></label><label class="choice-chip"><input type="radio" name="minutes" value="30"><span>30 минут</span></label></div></div>
          <div class="field"><label for="extensionReason">Почему продлеваю?</label><textarea class="textarea" id="extensionReason" name="reason" minlength="5" maxlength="240" required placeholder="Например: завершу текущий бой и сохранюсь"></textarea></div>
          <div class="notice"><span>i</span><div>После продления останется решений: <strong>${left - 1}</strong>.</div></div>
        </div>
        <div class="modal-footer"><button class="button ghost" type="button" data-close-modal>Не продлевать</button><button class="button primary" type="submit">Зафиксировать продление</button></div>
      </form>
    </div>
  `);
}

function extendSession(form) {
  const data = new FormData(form);
  const minutes = Number(data.get("minutes"));
  const reason = String(data.get("reason") || "").trim();
  if (reason.length < 5 || ![15, 30].includes(minutes)) return;
  const at = new Date().toISOString();
  const extension = { id: createId("extension"), at, minutes, reason };
  state.activeSession.extensions.push(extension);
  state.activeSession.plannedMinutes += minutes;
  state.activeSession.plannedEndAt = new Date(new Date(state.activeSession.plannedEndAt).getTime() + minutes * 60_000).toISOString();
  state.events.push({ ...extension, type: "extension", sessionId: state.activeSession.id });
  saveState();
  closeModal();
  render();
  toast("Продление зафиксировано", `Новая точка решения — ${formatClock(state.activeSession.plannedEndAt)}.`);
}

function openGameModal(game = null) {
  const color = game?.color || GAME_COLORS[state.games.length % GAME_COLORS.length];
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="gameTitle">
      <div class="modal-header"><div><span class="eyebrow">Библиотека</span><h2 id="gameTitle">${game ? "Изменить игру" : "Новая игра"}</h2><p>Только контекст для сессий.</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <form id="gameForm" data-id="${escapeAttr(game?.id || "")}">
        <div class="modal-body">
          <div class="field"><label for="gameName">Название</label><input class="input" id="gameName" name="title" value="${escapeAttr(game?.title || "")}" maxlength="100" required autofocus placeholder="Например: Elden Ring"></div>
          <div class="field"><span class="field-label">Цвет карточки</span><div class="chip-group">${GAME_COLORS.map((item) => `<label class="choice-chip"><input type="radio" name="color" value="${item}" ${item === color ? "checked" : ""}><span style="color:${item}">●</span></label>`).join("")}</div></div>
        </div>
        <div class="modal-footer"><button class="button ghost" type="button" data-close-modal>Отмена</button><button class="button primary" type="submit">Сохранить</button></div>
      </form>
    </div>
  `);
}

function saveGame(form) {
  const data = new FormData(form);
  const id = form.dataset.id;
  const game = {
    id: id || createId("game"),
    title: String(data.get("title") || "").trim(),
    color: String(data.get("color") || GAME_COLORS[0]),
    createdAt: id ? state.games.find((item) => item.id === id)?.createdAt : new Date().toISOString()
  };
  if (!game.title) return;
  if (id) state.games = state.games.map((item) => item.id === id ? game : item);
  else state.games.push(game);
  const returnTo = gameSaveReturn;
  saveState();
  closeModal();
  render();
  toast(id ? "Игра обновлена" : "Игра добавлена", game.title);
  if (returnTo === "entry") {
    openEntryModal(game.id);
  }
}

function confirmDeleteGame(id) {
  const game = gameById(id);
  if (!game) return;
  if (state.activeSession?.gameId === id) {
    toast("Игра сейчас активна", "Сначала завершите текущую сессию.");
    return;
  }
  openConfirm({
    title: `Удалить «${game.title}»?`,
    body: "Завершённые сессии сохранятся в истории как записи удалённой игры.",
    confirmLabel: "Удалить игру",
    danger: true,
    onConfirm: () => {
      state.games = state.games.filter((item) => item.id !== id);
      saveState();
      closeModal();
      render();
      toast("Игра удалена", "История сессий сохранена.");
    }
  });
}

function openCheckModal(item = null) {
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="checkTitle">
      <div class="modal-header"><div><span class="eyebrow">Процедура входа</span><h2 id="checkTitle">${item ? "Изменить пункт" : "Новый пункт"}</h2></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <form id="checkForm" data-id="${escapeAttr(item?.id || "")}">
        <div class="modal-body">
          <div class="field"><label for="checkName">Название</label><textarea class="textarea" id="checkName" name="title" maxlength="180" required>${escapeHTML(item?.title || "")}</textarea></div>
          <div class="field"><span class="field-label">Статус</span><div class="chip-group"><label class="choice-chip"><input type="radio" name="required" value="true" ${item?.required !== false ? "checked" : ""}><span>Обязательный</span></label><label class="choice-chip"><input type="radio" name="required" value="false" ${item?.required === false ? "checked" : ""}><span>Информационный</span></label></div></div>
          ${item ? `<button class="button danger small" type="button" data-action="delete-check" data-id="${escapeAttr(item.id)}">Удалить пункт</button>` : ""}
        </div>
        <div class="modal-footer"><button class="button ghost" type="button" data-close-modal>Отмена</button><button class="button primary" type="submit">Сохранить</button></div>
      </form>
    </div>
  `);
}

function saveCheck(form) {
  const data = new FormData(form);
  const id = form.dataset.id;
  const title = String(data.get("title") || "").trim();
  if (!title) return;
  if (id) {
    state.checklist = state.checklist.map((item) => item.id === id ? { ...item, title, required: data.get("required") === "true" } : item);
  } else {
    state.checklist.push({ id: createId("check"), title, required: data.get("required") === "true", enabled: true, order: state.checklist.length });
  }
  normalizeChecklistOrder();
  saveState();
  closeModal();
  render();
}

function deleteCheck(id) {
  state.checklist = state.checklist.filter((item) => item.id !== id);
  normalizeChecklistOrder();
  saveState();
  closeModal();
  render();
  toast("Пункт удалён", "Новые сессии будут использовать обновлённый чек-лист.");
}

function moveCheck(id, direction) {
  const list = [...state.checklist].sort((a, b) => a.order - b.order);
  const index = list.findIndex((item) => item.id === id);
  const target = index + Number(direction);
  if (index < 0 || target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  state.checklist = list.map((item, order) => ({ ...item, order }));
  saveState();
  render();
}

function normalizeChecklistOrder() {
  state.checklist = [...state.checklist].sort((a, b) => a.order - b.order).map((item, order) => ({ ...item, order }));
}

function openReleaseCooldownModal(afterRelease = null) {
  if (!isCooldownActive(state.cooldown)) {
    afterRelease?.();
    return;
  }
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="releaseTitle">
      <div class="modal-header"><div><span class="eyebrow">Явное действие</span><h2 id="releaseTitle">Снять мягкую паузу?</h2><p>Это разрешено в любой момент и будет сохранено как факт.</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <form id="releaseCooldownForm">
        <div class="modal-body">
          <div class="notice warning"><span>◇</span><div>Пауза должна была действовать до <strong>${formatDateTime(state.cooldown.until)}</strong>.</div></div>
          <div class="field"><label for="releaseReason">Почему снимаю сейчас? <span class="subtle-text">необязательно</span></label><textarea class="textarea" id="releaseReason" name="reason" maxlength="240" placeholder="Коротко назовите изменившиеся обстоятельства"></textarea></div>
        </div>
        <div class="modal-footer"><button class="button ghost" type="button" data-close-modal>Оставить паузу</button><button class="button primary" type="submit">Снять и зафиксировать</button></div>
      </form>
    </div>
  `);
  document.querySelector("#releaseCooldownForm")._afterRelease = afterRelease;
}

function releaseCooldown(form) {
  const reason = String(new FormData(form).get("reason") || "").trim();
  const releasedAt = new Date().toISOString();
  state.cooldown.releasedAt = releasedAt;
  state.cooldown.releaseReason = reason;
  state.events.push({ id: createId("event"), type: "cooldown-released", at: releasedAt, cooldownId: state.cooldown.id, reason });
  saveState();
  const callback = form._afterRelease;
  closeModal();
  render();
  toast("Мягкая пауза снята", "Решение сохранено в журнале событий.");
  callback?.();
}

function openSessionDetails(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  const game = gameById(session.gameId);
  openModal(`
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="detailsTitle">
      <div class="modal-header"><div><span class="eyebrow">${formatDateTime(session.startedAt)}</span><h2 id="detailsTitle">${escapeHTML(game?.title || "Удалённая игра")}</h2><p>${formatClock(session.startedAt)} — ${formatClock(session.endedAt)}</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <div class="modal-body">
        <div class="mini-metrics"><div class="mini-metric"><strong>${session.plannedMinutes} мин</strong><span>план</span></div><div class="mini-metric"><strong class="${session.onTime ? "text-success" : "text-danger"}">${session.actualMinutes} мин</strong><span>факт</span></div></div>
        <div class="form-grid">
          <div class="session-fact"><div class="fact-icon">${session.preState}</div><div><strong>Состояние до</strong><span>${motiveLabels(session)}</span></div></div>
          <div class="session-fact"><div class="fact-icon">${session.satisfaction}</div><div><strong>Удовлетворение</strong><span>из 5</span></div></div>
          <div class="session-fact"><div class="fact-icon">${session.compulsivity}</div><div><strong>Желание продолжить</strong><span>из 5</span></div></div>
          <div class="session-fact"><div class="fact-icon">${session.extensions.length}</div><div><strong>Продления</strong><span>${session.extensions.map((e) => `+${e.minutes} мин`).join(", ") || "не было"}</span></div></div>
          ${session.totalPausedMs ? `<div class="session-fact"><div class="fact-icon">Ⅱ</div><div><strong>Паузы</strong><span>${formatDuration(session.totalPausedMs / 60_000)}</span></div></div>` : ""}
        </div>
        <div class="session-fact"><div class="fact-icon">→</div><div><strong>${escapeHTML(session.afterAction || "Не указано")}</strong><span>${session.afterActionConfirmed ? "следующее действие подтверждено" : "не подтверждено"}</span></div></div>
        <div class="session-fact"><div class="fact-icon">≡</div><div><strong>${escapeHTML(session.outcomeNote || "Без заметки")}</strong><span>чем закончилась сессия</span></div></div>
        ${session.override ? `<div class="notice warning"><span>!</span><div><strong>Был использован override</strong><br>${escapeHTML(session.override.reason)}</div></div>` : ""}
      </div>
      <div class="modal-footer"><button class="button danger" data-action="delete-session" data-id="${escapeAttr(session.id)}">${icon("trash")} Удалить</button><div class="button-row"><button class="button" data-action="edit-session" data-id="${escapeAttr(session.id)}">${icon("edit")} Редактировать</button><button class="button primary" data-close-modal>Закрыть</button></div></div>
    </div>
  `);
}

function openEditSessionModal(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  const selectedMotives = new Set(session.motives?.length ? session.motives : session.motive ? [session.motive] : []);
  openModal(`
    <div class="modal wide" role="dialog" aria-modal="true" aria-labelledby="editSessionTitle">
      <div class="modal-header"><div><span class="eyebrow">Коррекция фактов</span><h2 id="editSessionTitle">Редактировать сессию</h2><p>После сохранения план, факт и статистика будут пересчитаны.</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <form id="editSessionForm" data-session-id="${escapeAttr(session.id)}">
        <div class="modal-body">
          <div class="form-grid">
            <div class="field"><label for="editSessionGame">Игра</label><select class="select" id="editSessionGame" name="gameId" required>${state.games.map((game) => `<option value="${escapeAttr(game.id)}" ${game.id === session.gameId ? "selected" : ""}>${escapeHTML(game.title)}</option>`).join("")}</select></div>
            <div class="field"><label for="editPlannedMinutes">План, минут</label><input class="input" id="editPlannedMinutes" name="plannedMinutes" type="number" min="1" max="1440" value="${session.plannedMinutes}" required></div>
            <div class="field"><label for="editStartedAt">Начало</label><input class="input" id="editStartedAt" name="startedAt" type="datetime-local" value="${toDateTimeLocal(session.startedAt)}" required></div>
            <div class="field"><label for="editEndedAt">Окончание</label><input class="input" id="editEndedAt" name="endedAt" type="datetime-local" value="${toDateTimeLocal(session.endedAt)}" required></div>
            <div class="field full"><label>Состояние до</label><div class="rating-control"><div class="range-field"><input type="range" name="preState" min="1" max="5" value="${session.preState}" data-range-output="editPreStateValue"><output class="range-value" id="editPreStateValue">${session.preState}</output></div>${renderRatingScale(["Очень плохо", "Плохо", "Нормально", "Хорошо", "Отлично"])}</div></div>
            <div class="field full"><span class="field-label">Почему хотелось играть?</span><div class="chip-group">${MOTIVES.map((item) => `<label class="choice-chip"><input type="checkbox" name="motives" value="${item.value}" ${selectedMotives.has(item.value) ? "checked" : ""}><span>${escapeHTML(item.label)}</span></label>`).join("")}</div></div>
            <div class="field full"><label for="editAfterAction">Что планировалось после?</label><input class="input" id="editAfterAction" name="afterAction" maxlength="120" value="${escapeAttr(session.afterAction)}"></div>
            <div class="field full"><label>Удовлетворение от игры</label><div class="rating-control"><div class="range-field"><input type="range" name="satisfaction" min="1" max="5" value="${session.satisfaction}" data-range-output="editSatisfactionValue"><output class="range-value" id="editSatisfactionValue">${session.satisfaction}</output></div>${renderRatingScale(["Совсем нет", "Скорее нет", "Средне", "Скорее да", "Полностью"])}</div></div>
            <div class="field full"><label>Желание продолжить</label><div class="rating-control"><div class="range-field"><input type="range" name="compulsivity" min="1" max="5" value="${session.compulsivity}" data-range-output="editCompulsivityValue"><output class="range-value" id="editCompulsivityValue">${session.compulsivity}</output></div>${renderRatingScale(["Не тянет", "Слабо", "Средне", "Сильно", "Очень сильно"])}</div></div>
            <div class="field full"><label for="editOutcomeNote">Чем закончилась сессия?</label><textarea class="textarea" id="editOutcomeNote" name="outcomeNote" maxlength="240">${escapeHTML(session.outcomeNote)}</textarea></div>
            <div class="field full"><label class="check-row"><input type="checkbox" name="afterActionConfirmed" ${session.afterActionConfirmed ? "checked" : ""}><span><strong>Следующее действие подтверждено</strong><small>Факт, отмеченный при завершении</small></span><span class="status-pill info">мост</span></label></div>
          </div>
        </div>
        <div class="modal-footer"><button class="button ghost" type="button" data-close-modal>Отмена</button><button class="button primary" type="submit">Сохранить изменения</button></div>
      </form>
    </div>
  `);
}

function updateSession(form) {
  const id = form.dataset.sessionId;
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  const data = new FormData(form);
  const startedAt = new Date(String(data.get("startedAt")));
  const endedAt = new Date(String(data.get("endedAt")));
  const plannedMinutes = Number(data.get("plannedMinutes"));
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(endedAt.getTime()) || !Number.isFinite(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 1440 || endedAt <= startedAt) {
    toast("Проверьте время", "Окончание должно быть позже начала.");
    return;
  }
  const motives = data.getAll("motives").map(String);
  const metrics = calculateSessionMetrics(startedAt.toISOString(), endedAt.toISOString(), plannedMinutes, session.totalPausedMs || 0);
  const updated = {
    ...session,
    gameId: String(data.get("gameId")),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    plannedMinutes,
    basePlannedMinutes: Math.max(1, plannedMinutes - session.extensions.reduce((sum, extension) => sum + Number(extension.minutes || 0), 0)),
    ...metrics,
    preState: Number(data.get("preState")),
    satisfaction: Number(data.get("satisfaction")),
    compulsivity: Number(data.get("compulsivity")),
    motives,
    motive: motives[0] || "",
    afterAction: String(data.get("afterAction") || "").trim(),
    outcomeNote: String(data.get("outcomeNote") || "").trim(),
    afterActionConfirmed: data.has("afterActionConfirmed"),
    editedAt: new Date().toISOString()
  };
  state.sessions = state.sessions.map((item) => item.id === id ? updated : item);
  state.events.push({ id: createId("event"), type: "session-edited", at: updated.editedAt, sessionId: id });
  saveState();
  closeModal();
  render();
  toast("Сессия обновлена", "План, факт и статистика пересчитаны.");
}

function confirmDeleteSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  if (!session) return;
  openConfirm({
    title: "Удалить сессию?",
    body: `${gameById(session.gameId)?.title || "Игра"} · ${formatDateTime(session.startedAt)}. Это действие нельзя отменить без JSON-копии.`,
    confirmLabel: "Удалить сессию",
    danger: true,
    onConfirm: () => {
      state.sessions = state.sessions.filter((item) => item.id !== id);
      state.events = state.events.filter((event) => event.sessionId !== id && event.sourceSessionId !== id);
      if (state.cooldown?.sourceSessionId === id) state.cooldown = null;
      saveState();
      closeModal();
      render();
      toast("Сессия удалена", "Она больше не учитывается в истории и статистике.");
    }
  });
}

function currentIsoWeekValue(date = new Date()) {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((target - yearStart) / 86_400_000) + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatReportDate(value) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
}

function formatReportDateTime(value) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function openTextReportModal() {
  const now = new Date();
  const weekStart = startOfWeek(now);
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="textReportTitle">
      <div class="modal-header"><div><span class="eyebrow">Экспорт статистики</span><h2 id="textReportTitle">Подробный TXT-отчёт</h2><p>Выберите период. Файл можно отправить в любой мессенджер.</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <form id="textReportForm">
        <div class="modal-body">
          <div class="field">
            <label for="reportPeriodType">Интервал</label>
            <select class="select" id="reportPeriodType" name="periodType">
              <option value="week">Неделя</option>
              <option value="month">Месяц</option>
              <option value="custom">Свой интервал</option>
            </select>
          </div>
          <div class="field" data-report-period-field="week">
            <label for="reportWeek">Какая неделя</label>
            <input class="input" id="reportWeek" type="week" name="week" value="${currentIsoWeekValue(now)}" required>
          </div>
          <div class="field" data-report-period-field="month" hidden>
            <label for="reportMonth">Какой месяц</label>
            <input class="input" id="reportMonth" type="month" name="month" value="${localDateKey(now).slice(0, 7)}">
          </div>
          <div class="form-grid" data-report-period-field="custom" hidden>
            <div class="field"><label for="reportStart">С</label><input class="input" id="reportStart" type="date" name="start" value="${localDateKey(weekStart)}"></div>
            <div class="field"><label for="reportEnd">По</label><input class="input" id="reportEnd" type="date" name="end" value="${localDateKey(now)}"></div>
          </div>
          <div class="notice"><span>i</span><div>В отчёт войдут завершённые сессии, сводные показатели и связанные события контроля. Активная сессия не учитывается до завершения.</div></div>
        </div>
        <div class="modal-footer"><button class="button ghost" type="button" data-close-modal>Отмена</button><button class="button primary" type="submit">Скачать TXT</button></div>
      </form>
    </div>
  `);
}

function updateTextReportFields() {
  const type = document.querySelector("#reportPeriodType")?.value || "week";
  modalRoot.querySelectorAll("[data-report-period-field]").forEach((field) => {
    field.hidden = field.dataset.reportPeriodField !== type;
  });
}

function resolveTextReportPeriod(form) {
  const data = new FormData(form);
  const type = String(data.get("periodType") || "week");
  let start;
  let end;
  let label;

  if (type === "week") {
    const match = /^(\d{4})-W(\d{2})$/.exec(String(data.get("week") || ""));
    if (!match) throw new Error("Выберите неделю.");
    start = startOfWeek(new Date(Number(match[1]), 0, 4));
    start.setDate(start.getDate() + (Number(match[2]) - 1) * 7);
    end = new Date(start);
    end.setDate(end.getDate() + 7);
    label = `Неделя ${formatReportDate(start)} — ${formatReportDate(new Date(end.getTime() - 1))}`;
  } else if (type === "month") {
    const match = /^(\d{4})-(\d{2})$/.exec(String(data.get("month") || ""));
    if (!match) throw new Error("Выберите месяц.");
    start = new Date(Number(match[1]), Number(match[2]) - 1, 1);
    end = new Date(Number(match[1]), Number(match[2]), 1);
    label = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(start);
  } else {
    start = parseLocalDate(data.get("start"));
    const inclusiveEnd = parseLocalDate(data.get("end"));
    if (!start || !inclusiveEnd) throw new Error("Укажите начало и конец интервала.");
    end = new Date(inclusiveEnd);
    end.setDate(end.getDate() + 1);
    if (end <= start) throw new Error("Конец интервала должен быть не раньше начала.");
    label = `${formatReportDate(start)} — ${formatReportDate(inclusiveEnd)}`;
  }

  return { type, start, end, label };
}

function ratingSummary(sessions, field) {
  const distribution = [1, 2, 3, 4, 5].map((rating) => sessions.filter((session) => Number(session[field]) === rating).length);
  const average = sessions.length ? sessions.reduce((sum, session) => sum + Number(session[field] || 0), 0) / sessions.length : 0;
  return `${average.toFixed(1)} из 5 · ${distribution.map((count, index) => `${index + 1}: ${count}`).join("; ")}`;
}

function eventLabel(type) {
  return ({
    override: "обход чек-листа",
    extension: "продление",
    "session-paused": "пауза",
    "session-resumed": "продолжение после паузы",
    "session-warning": "предупреждение о конце",
    "cooldown-started": "cooldown включён",
    "cooldown-released": "cooldown снят",
    "session-edited": "сессия отредактирована"
  })[type] || type || "событие";
}

function buildDetailedTextReport(period) {
  const sessions = getSessionsInRange(state.sessions, period.start, period.end);
  const events = state.events
    .filter((event) => event.at && new Date(event.at) >= period.start && new Date(event.at) < period.end)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const totalActual = sessions.reduce((sum, session) => sum + Number(session.actualMinutes || 0), 0);
  const totalPlanned = sessions.reduce((sum, session) => sum + Number(session.plannedMinutes || 0), 0);
  const totalPausedMs = sessions.reduce((sum, session) => sum + Number(session.totalPausedMs || 0), 0);
  const onTimeCount = sessions.filter((session) => session.onTime).length;
  const extensions = sessions.reduce((sum, session) => sum + (session.extensions?.length || 0), 0);
  const overrides = sessions.filter((session) => session.override).length;
  const lateSessions = sessions.filter((session) => new Date(session.startedAt).getHours() >= state.settings.lateHour).length;
  const motives = {};
  const games = {};
  sessions.forEach((session) => {
    (session.motives || (session.motive ? [session.motive] : [])).forEach((motive) => { motives[motive] = (motives[motive] || 0) + 1; });
    games[session.gameId] = (games[session.gameId] || 0) + Number(session.actualMinutes || 0);
  });
  const drift = totalActual - totalPlanned;
  const lines = [
    "SAFE PLAY — ПОДРОБНЫЙ ОТЧЁТ",
    `Период: ${period.label}`,
    `Создан: ${formatReportDateTime(new Date())}`,
    `Версия приложения: ${APP_VERSION}`,
    "",
    "СВОДКА",
    `Завершённых сессий: ${sessions.length}`,
    `Игровое время: ${formatDuration(totalActual)}`,
    `Плановое время: ${formatDuration(totalPlanned)}`,
    `Отклонение факт − план: ${drift > 0 ? "+" : drift < 0 ? "−" : ""}${formatDuration(Math.abs(drift))}`,
    `Завершены вовремя: ${sessions.length ? Math.round(onTimeCount / sessions.length * 100) : 0}% (${onTimeCount} из ${sessions.length})`,
    `Продлений: ${extensions}`,
    `Обходов чек-листа: ${overrides}`,
    `Поздних сессий (с ${state.settings.lateHour}:00): ${lateSessions}`,
    `Суммарное время на паузе: ${formatDuration(totalPausedMs / 60_000)}`,
    `Состояние до игры: ${ratingSummary(sessions, "preState")}`,
    `Удовлетворение от игры: ${ratingSummary(sessions, "satisfaction")}`,
    `Желание продолжить: ${ratingSummary(sessions, "compulsivity")}`,
    "",
    "ПРИЧИНЫ ИГРАТЬ",
    ...(Object.keys(motives).length ? Object.entries(motives).sort((a, b) => b[1] - a[1]).map(([motive, count]) => `${motiveLabel(motive)}: ${count}`) : ["Не указаны"]),
    "",
    "ВРЕМЯ ПО ИГРАМ",
    ...(Object.keys(games).length ? Object.entries(games).sort((a, b) => b[1] - a[1]).map(([gameId, minutes]) => `${gameById(gameId)?.title || "Удалённая игра"}: ${formatDuration(minutes)}`) : ["Нет завершённых сессий"]),
    "",
    "СЕССИИ"
  ];

  if (!sessions.length) lines.push("Нет завершённых сессий за выбранный период.");
  sessions.forEach((session, index) => {
    const game = gameById(session.gameId)?.title || "Удалённая игра";
    const sessionMotives = session.motives || (session.motive ? [session.motive] : []);
    const checklist = Object.entries(session.checklistResults || {}).map(([id, passed]) => `${state.checklist.find((item) => item.id === id)?.title || id}: ${passed ? "да" : "нет"}`);
    lines.push(
      "",
      `${index + 1}. ${game}`,
      `Начало: ${formatReportDateTime(session.startedAt)}`,
      `Окончание: ${formatReportDateTime(session.endedAt)}`,
      `План: ${formatDuration(session.plannedMinutes)} · факт: ${formatDuration(session.actualMinutes)} · перерасход: ${formatDuration(session.overtimeMinutes)}`,
      `Остановился вовремя: ${session.onTime ? "да" : "нет"}`,
      `Состояние до: ${session.preState}/5`,
      `Причины: ${sessionMotives.length ? sessionMotives.map(motiveLabel).join(", ") : "не указаны"}`,
      `Удовлетворение: ${session.satisfaction}/5`,
      `Желание продолжить: ${session.compulsivity}/5`,
      `Что после: ${session.afterAction || "не указано"} · подтверждено: ${session.afterActionConfirmed ? "да" : "нет"}`,
      `Чем закончилась: ${session.outcomeNote || "без заметки"}`,
      `Чек-лист: ${checklist.length ? checklist.join("; ") : "нет сохранённых ответов"}`,
      `Паузы: ${session.pauses?.length || 0} · ${formatDuration(Number(session.totalPausedMs || 0) / 60_000)}`,
      `Продления: ${session.extensions?.length ? session.extensions.map((extension) => `+${extension.minutes} мин — ${extension.reason || "без причины"}`).join("; ") : "не было"}`,
      `Обход чек-листа: ${session.override ? session.override.reason || "причина не указана" : "не использовался"}`
    );
  });

  lines.push("", "СОБЫТИЯ КОНТРОЛЯ");
  if (!events.length) lines.push("Нет событий за выбранный период.");
  events.forEach((event) => {
    const details = event.reason ? ` · ${event.reason}` : event.minutes ? ` · +${event.minutes} мин` : event.leadMinutes ? ` · за ${event.leadMinutes} мин` : "";
    lines.push(`${formatReportDateTime(event.at)} · ${eventLabel(event.type)}${details}`);
  });

  return lines.join("\n");
}

function downloadDetailedTextReport(form) {
  try {
    const period = resolveTextReportPeriod(form);
    const text = buildDetailedTextReport(period);
    const startKey = localDateKey(period.start);
    const endKey = localDateKey(new Date(period.end.getTime() - 1));
    downloadBlob(new Blob(["\uFEFF", text], { type: "text/plain;charset=utf-8" }), `safe-play-report-${startKey}_${endKey}.txt`);
    closeModal();
    toast("Текстовый отчёт готов", `Сохранён период: ${period.label}.`);
  } catch (error) {
    toast("Не удалось создать отчёт", error.message);
  }
}

function buildCurrentWeekReport() {
  const stats = summarizeStats(state);
  const week = stats.weeks.at(-1);
  const start = new Date(week.start);
  const end = new Date(week.end);
  const sessions = state.sessions.filter((session) => {
    const date = new Date(session.startedAt);
    return date >= start && date < end;
  });
  const byGame = {};
  sessions.forEach((session) => { byGame[session.gameId] = (byGame[session.gameId] || 0) + Number(session.actualMinutes || 0); });
  const games = Object.entries(byGame).sort((a, b) => b[1] - a[1]).map(([gameId, minutes]) => ({ title: gameById(gameId)?.title || "Удалённая игра", minutes }));
  const range = formatWeekRange(week.start, week.end);
  const text = [`Safe Play · ${range}`, `Игровое время: ${formatDuration(week.minutes)}`, `Сессий: ${week.sessions}`, `Вовремя: ${week.onTimePercent}%`, ...games.map((game) => `${game.title}: ${formatDuration(game.minutes)}`)].join("\n");
  return { ...week, games, range, text, filename: `safe-play-week-${week.key}.png` };
}

async function createWeeklyReportBlob(report) {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1080;
  const context = canvas.getContext("2d");
  context.fillStyle = "#11130f";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#c9f27b";
  context.font = "700 42px system-ui, sans-serif";
  context.fillText("SAFE PLAY", 76, 100);
  context.fillStyle = "#f3f5ee";
  context.font = "700 72px system-ui, sans-serif";
  context.fillText("Статистика за неделю", 76, 210);
  context.fillStyle = "#9da793";
  context.font = "400 34px system-ui, sans-serif";
  context.fillText(report.range, 76, 270);
  const metrics = [["Игровое время", formatDuration(report.minutes)], ["Сессий", String(report.sessions)], ["Завершены вовремя", `${report.onTimePercent}%`]];
  metrics.forEach(([label, value], index) => {
    const y = 380 + index * 130;
    context.fillStyle = "#8a9381";
    context.font = "500 29px system-ui, sans-serif";
    context.fillText(label, 76, y);
    context.fillStyle = index === 0 ? "#c9f27b" : "#f3f5ee";
    context.font = "700 52px system-ui, sans-serif";
    context.fillText(value, 76, y + 58);
  });
  context.fillStyle = "#8a9381";
  context.font = "500 28px system-ui, sans-serif";
  context.fillText("По играм", 570, 380);
  report.games.slice(0, 5).forEach((game, index) => {
    const y = 445 + index * 82;
    context.fillStyle = "#f3f5ee";
    context.font = "600 30px system-ui, sans-serif";
    const title = game.title.length > 22 ? `${game.title.slice(0, 21)}…` : game.title;
    context.fillText(title, 570, y);
    context.fillStyle = "#c9f27b";
    context.font = "700 30px system-ui, sans-serif";
    context.fillText(formatDuration(game.minutes), 570, y + 38);
  });
  if (!report.games.length) {
    context.fillStyle = "#8a9381";
    context.font = "400 30px system-ui, sans-serif";
    context.fillText("На этой неделе сессий не было", 570, 450);
  }
  context.fillStyle = "#697061";
  context.font = "400 25px system-ui, sans-serif";
  context.fillText(`Safe Play v${APP_VERSION} · контроль без геймификации`, 76, 1000);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Не удалось создать изображение")), "image/png"));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadWeekReport() {
  try {
    const report = buildCurrentWeekReport();
    downloadBlob(await createWeeklyReportBlob(report), report.filename);
    toast("Отчёт готов", "PNG со статистикой за неделю сохранён в загрузки.");
  } catch (error) {
    toast("Не удалось создать отчёт", error.message);
  }
}

async function shareWeekReport() {
  try {
    const report = buildCurrentWeekReport();
    const blob = await createWeeklyReportBlob(report);
    const file = new File([blob], report.filename, { type: "image/png" });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({ title: "Safe Play — статистика за неделю", text: report.text, files: [file] });
      return;
    }
    if (navigator.share) {
      await navigator.share({ title: "Safe Play — статистика за неделю", text: report.text });
      return;
    }
    downloadBlob(blob, report.filename);
    toast("Отчёт скачан", "На этом устройстве нет системного меню «Поделиться». Отправьте PNG из загрузок.");
  } catch (error) {
    if (error.name !== "AbortError") toast("Не удалось поделиться", error.message);
  }
}
function exportData() {
  const payload = { ...state, exportedAt: new Date().toISOString(), app: "Safe Play", appVersion: APP_VERSION };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `safe-play-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  toast("Экспорт готов", "JSON-копия сохранена в загрузки.");
}

async function handleImport(file) {
  try {
    const parsed = JSON.parse(await file.text());
    const imported = normalizeState(parsed);
    openConfirm({
      title: "Заменить локальные данные?",
      body: `В файле: ${imported.games.length} игр и ${imported.sessions.length} сессий. Текущие данные будут заменены.`,
      confirmLabel: "Импортировать",
      danger: true,
      onConfirm: () => {
        state = imported;
        saveState();
        closeModal();
        navigate("home");
        toast("Импорт завершён", "Все данные и настройки восстановлены.");
      }
    });
  } catch (error) {
    toast("Не удалось импортировать", error.message || "Проверьте формат JSON-файла.");
  } finally {
    importInput.value = "";
  }
}

function resetData() {
  openConfirm({
    title: "Удалить все данные?",
    body: "Это действие нельзя отменить без ранее сохранённого JSON-экспорта.",
    confirmLabel: "Удалить навсегда",
    danger: true,
    onConfirm: () => {
      state = createDefaultState();
      saveState();
      closeModal();
      navigate("home");
      toast("Приложение сброшено", "Создан чистый локальный профиль.");
    }
  });
}

function openConfirm({ title, body, confirmLabel, danger = false, onConfirm }) {
  openModal(`
    <div class="modal narrow" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
      <div class="modal-header"><div><h2 id="confirmTitle">${escapeHTML(title)}</h2><p>${escapeHTML(body)}</p></div><button class="icon-button" data-close-modal>${icon("close")}</button></div>
      <div class="modal-footer"><button class="button ghost" data-close-modal>Отмена</button><button class="button ${danger ? "danger" : "primary"}" id="confirmAction">${escapeHTML(confirmLabel)}</button></div>
    </div>
  `);
  document.querySelector("#confirmAction").addEventListener("click", onConfirm, { once: true });
}

function openModal(content) {
  modalRoot.innerHTML = `<div class="modal-backdrop">${content}</div>`;
  document.body.style.overflow = "hidden";
  window.setTimeout(() => modalRoot.querySelector("input:not([type='radio']):not([type='checkbox']), textarea, select, button")?.focus(), 40);
}

function closeModal() {
  modalRoot.innerHTML = "";
  document.body.style.overflow = "";
  gameSaveReturn = null;
}

function updateEntryHint() {
  const form = document.querySelector("#entryForm");
  const hint = document.querySelector("#entryHint");
  if (!form || !hint) return;
  const missing = [...form.querySelectorAll("[data-check-id][data-required='true']")].filter((input) => !input.checked).length;
  hint.textContent = missing ? `Не подтверждено обязательных пунктов: ${missing}. Доступен осознанный обход.` : "Базовые условия подтверждены.";
  hint.className = missing ? "subtle-text text-danger" : "subtle-text text-success";
}

function updatePlanPreview() {
  const select = document.querySelector("#plannedMinutes");
  const preview = document.querySelector("#plannedEndPreview");
  if (!select || !preview) return;
  preview.textContent = formatClock(new Date(Date.now() + Number(select.value) * 60_000));
}

function gameById(id) {
  return state.games.find((game) => game.id === id);
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "Поздняя ночь";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

function isThisWeek(value) {
  const date = new Date(value);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return date >= start;
}

function plural(number, words) {
  const n = Math.abs(number) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return words[2];
  if (n1 > 1 && n1 < 5) return words[1];
  if (n1 === 1) return words[0];
  return words[2];
}

function renderRatingScale(labels) {
  return `<div class="rating-scale">${labels.map((label) => `<span title="${escapeAttr(label)}">${escapeHTML(label)}</span>`).join("")}</div>`;
}

function motiveLabels(session) {
  const motives = session.motives?.length ? session.motives : session.motive ? [session.motive] : [];
  return escapeHTML(motives.length ? motives.map(motiveLabel).join(", ") : "Причины не указаны");
}

function toDateTimeLocal(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatReleaseDate(value) {
  const [year, month, day] = String(value).split("-");
  return `${day}.${month}.${year.slice(-2)}`;
}

function formatWeekRange(startValue, endValue) {
  const start = new Date(startValue);
  const end = new Date(new Date(endValue).getTime() - 1);
  const format = (date) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
  return `${format(start)} — ${format(end)}`;
}
function toast(title, message) {
  const element = document.createElement("div");
  element.className = "toast";
  element.innerHTML = `<span class="toast-icon">●</span><span><strong>${escapeHTML(title)}</strong><span>${escapeHTML(message)}</span></span>`;
  toastStack.appendChild(element);
  window.setTimeout(() => element.remove(), 4200);
}

function escapeHTML(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function escapeAttr(value = "") {
  return escapeHTML(value);
}

function icon(name) {
  const paths = {
    play: `<path d="m8 5 11 7-11 7V5Z"/>`,
    plus: `<path d="M12 5v14M5 12h14"/>`,
    edit: `<path d="m4 20 4.5-1L19 8.5 15.5 5 5 15.5 4 20ZM13.5 7l3.5 3.5"/>`,
    trash: `<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/>`,
    close: `<path d="m6 6 12 12M18 6 6 18"/>`
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}

async function requestWakeLock() {
  if (!state.settings.keepAwake || !state.activeSession || state.activeSession.pausedAt || !navigator.wakeLock || document.visibilityState !== "visible") return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (error) {
    console.info("Wake lock unavailable", error);
  }
}

async function releaseWakeLock() {
  try { await wakeLock?.release(); } catch { /* no-op */ }
  wakeLock = null;
}

async function prepareWarningAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  warningAudioContext ||= new AudioContextClass();
  if (warningAudioContext.state === "suspended") await warningAudioContext.resume();
  return warningAudioContext;
}

async function playWarningSound() {
  try {
    const context = await prepareWarningAudio();
    if (!context) return;
    const start = context.currentTime;
    [0, 0.28, 0.56].forEach((delay, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(index === 2 ? 920 : 760, start + delay);
      gain.gain.setValueAtTime(0.0001, start + delay);
      gain.gain.exponentialRampToValueAtTime(0.18, start + delay + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.2);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start + delay);
      oscillator.stop(start + delay + 0.22);
    });
  } catch (error) {
    console.info("Warning sound unavailable", error);
  }
}

function triggerSessionWarning() {
  const session = state.activeSession;
  if (!session) return;
  const sound = Boolean(state.settings.warningSound);
  const vibration = Boolean(state.settings.warningVibration);
  session.warningForEndAt = session.plannedEndAt;
  if (sound) void playWarningSound();
  if (vibration) navigator.vibrate?.([180, 100, 180]);
  state.events.push({
    id: createId("event"),
    type: "session-warning",
    at: new Date().toISOString(),
    sessionId: session.id,
    plannedEndAt: session.plannedEndAt,
    leadMinutes: state.settings.warningLeadMinutes,
    sound,
    vibration
  });
  saveState();
  toast("Сессия скоро закончится", `До точки решения — ${state.settings.warningLeadMinutes} мин.`);
}

function showTimerNotification() {
  if ("Notification" in window && Notification.permission === "granted") {
    navigator.serviceWorker?.ready.then((registration) => registration.showNotification("Плановое время вышло", {
      body: "Завершите сессию или зафиксируйте продление.",
      icon: "assets/icon.svg",
      tag: "safe-play-timer"
    })).catch(() => {});
  }
}

document.addEventListener("click", (event) => {
  const viewLink = event.target.closest("[data-view-link]");
  if (viewLink) {
    event.preventDefault();
    navigate(viewLink.dataset.viewLink);
    return;
  }

  if (event.target.closest("[data-close-modal]")) {
    closeModal();
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  const actions = {
    "open-entry": () => openEntryModal(target.dataset.gameId || ""),
    "add-game": () => openGameModal(),
    "edit-game": () => openGameModal(gameById(id)),
    "delete-game": () => confirmDeleteGame(id),
    "open-finish": openFinishModal,
    "open-extension": openExtensionModal,
    "toggle-session-pause": toggleSessionPause,
    "session-details": () => openSessionDetails(id),
    "edit-session": () => openEditSessionModal(id),
    "delete-session": () => confirmDeleteSession(id),
    "download-week-report": downloadWeekReport,
    "share-week-report": shareWeekReport,
    "open-text-report": openTextReportModal,
    "add-check": () => openCheckModal(),
    "edit-check": () => openCheckModal(state.checklist.find((item) => item.id === id)),
    "delete-check": () => deleteCheck(id),
    "move-check": () => moveCheck(id, target.dataset.direction),
    "release-cooldown": () => openReleaseCooldownModal(),
    "export-data": exportData,
    "import-data": () => importInput.click(),
    "reset-data": resetData,
    "back-to-entry": () => openEntryModal()
  };
  actions[action]?.();
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "entryForm") {
    const payload = collectEntryPayload(form);
    if (!payload.afterAction) return;
    payload.missingRequired.length ? openOverrideModal(payload) : beginSession(payload);
  }
  if (form.id === "finishForm") finishSession(form);
  if (form.id === "extensionForm") extendSession(form);
  if (form.id === "gameForm") saveGame(form);
  if (form.id === "checkForm") saveCheck(form);
  if (form.id === "releaseCooldownForm") releaseCooldown(form);
  if (form.id === "editSessionForm") updateSession(form);
  if (form.id === "textReportForm") downloadDetailedTextReport(form);
});

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-range-output]")) {
    const output = document.querySelector(`#${event.target.dataset.rangeOutput}`);
    if (output) output.textContent = event.target.value;
  }
  if (event.target.matches("[data-check-id]")) updateEntryHint();
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.id === "plannedMinutes") updatePlanPreview();
  if (target.id === "reportPeriodType") updateTextReportFields();
  if (target.dataset.setting === "extension-limit") state.settings.extensionLimit = Number(target.value);
  if (target.dataset.setting === "late-hour") state.settings.lateHour = Number(target.value);
  if (target.dataset.setting === "keep-awake") state.settings.keepAwake = target.checked;
  if (target.dataset.setting === "warning-sound") {
    state.settings.warningSound = target.checked;
    if (target.checked) void prepareWarningAudio();
  }
  if (target.dataset.setting === "warning-vibration") state.settings.warningVibration = target.checked;
  if (target.dataset.setting === "warning-lead") state.settings.warningLeadMinutes = Number(target.value);
  if (target.dataset.setting === "check-enabled") {
    state.checklist = state.checklist.map((item) => item.id === target.dataset.id ? { ...item, enabled: target.checked } : item);
  }
  if (target.dataset.setting) {
    saveState();
    toast("Настройка сохранена", "Изменение применяется к новым сессиям.");
  }
});

modalRoot.addEventListener("click", (event) => {
  if (event.target.classList.contains("modal-backdrop")) closeModal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalRoot.innerHTML) closeModal();
});

window.addEventListener("hashchange", () => {
  currentView = getViewFromHash();
  render();
});

window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (state.activeSession) tickTimer();
    requestWakeLock();
  }
});

importInput.addEventListener("change", () => {
  const file = importInput.files?.[0];
  if (file) handleImport(file);
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.querySelector("#installButton")?.classList.remove("hidden");
});

document.querySelector("#installButton")?.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.querySelector("#installButton")?.classList.add("hidden");
});

function updateConnectionStatus() {
  const pill = document.querySelector("#connectionPill");
  const text = document.querySelector("#connectionText");
  pill?.classList.toggle("offline", !navigator.onLine);
  if (text) text.textContent = navigator.onLine ? "офлайн-режим готов" : "работает без сети";
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch((error) => console.error("Service worker registration failed", error));
}

updateConnectionStatus();
render();
