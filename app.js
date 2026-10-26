const RATE_DENOMINATOR = 3_600_000; // milliseconds in an hour; numerator unit is milliseconds × cents/hour.
const STORAGE_KEY = "cozy-reader-state-v1";
const DB_NAME = "cozy-reader";
const STORE_NAME = "settings";
const RECORD_ID = "app";

const $ = (selector) => document.querySelector(selector);
const dom = {
  screens: document.querySelectorAll("[data-screen]"),
  tabs: document.querySelectorAll("[data-tab]"),
  timer: $("#timer"),
  earnings: $("#session-earnings"),
  timerActions: $("#timer-actions"),
  pausedPill: $("#paused-pill"),
  balance: $("#balance-amount"),
  balanceRate: $("#balance-rate"),
  rateInput: $("#rate-input"),
  rateForm: $("#rate-form"),
  resetModal: $("#reset-modal"),
  completionModal: $("#completion-modal"),
  completionDuration: $("#completion-duration"),
  completionEarnings: $("#completion-earnings"),
  toast: $("#toast"),
  installGuide: $("#install-guide"),
};

const defaultState = () => ({
  schema: 1,
  balanceNumerator: 0,
  settings: { rateCents: 200 },
  session: null,
  preferences: { installGuideDismissed: false },
});

function finiteInteger(value, fallback, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function normaliseSession(candidate, defaultRate) {
  if (!candidate || typeof candidate !== "object" || !["running", "paused"].includes(candidate.status)) return null;
  const activeMs = finiteInteger(candidate.activeMs, 0);
  const earningsNumerator = finiteInteger(candidate.earningsNumerator, 0);
  const rateCents = finiteInteger(candidate.rateCents, defaultRate, 0, 999_999);
  const createdAt = finiteInteger(candidate.createdAt, Date.now(), 0);
  if (candidate.status === "running" && !Number.isSafeInteger(Number(candidate.runningSince))) {
    // A broken running timestamp must never manufacture reading time.
    return { id: String(candidate.id || makeId()), status: "paused", createdAt, activeMs, earningsNumerator, rateCents, runningSince: null };
  }
  return {
    id: String(candidate.id || makeId()),
    status: candidate.status,
    createdAt,
    activeMs,
    earningsNumerator,
    rateCents,
    runningSince: candidate.status === "running" ? finiteInteger(candidate.runningSince, Date.now(), 0) : null,
  };
}

function normalise(candidate) {
  const base = defaultState();
  if (!candidate || typeof candidate !== "object") return base;
  const rateCents = finiteInteger(candidate.settings?.rateCents, base.settings.rateCents, 0, 999_999);
  return {
    schema: 1,
    balanceNumerator: finiteInteger(candidate.balanceNumerator, 0),
    settings: { rateCents },
    session: normaliseSession(candidate.session, rateCents),
    preferences: { installGuideDismissed: Boolean(candidate.preferences?.installGuideDismissed) },
  };
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const Store = (() => {
  let databasePromise;
  let fallback = false;
  let queue = Promise.resolve();

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error("IndexedDB is unavailable"));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open reading storage"));
    }).catch((error) => {
      fallback = true;
      console.warn("Using local storage fallback", error);
      return null;
    });
    return databasePromise;
  }

  async function readFallback() {
    try { return normalise(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); }
    catch { return defaultState(); }
  }

  async function writeFallback(next) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch (error) { console.error("Unable to save reading state", error); }
  }

  async function read() {
    const database = await openDatabase();
    if (fallback || !database) return readFallback();
    return new Promise((resolve) => {
      const transaction = database.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(RECORD_ID);
      request.onsuccess = () => resolve(normalise(request.result?.value));
      request.onerror = () => resolve(defaultState());
    });
  }

  async function write(next) {
    const clean = normalise(next);
    const database = await openDatabase();
    if (fallback || !database) return writeFallback(clean);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put({ id: RECORD_ID, value: clean });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Unable to save reading state"));
      transaction.onabort = () => reject(transaction.error || new Error("Reading storage write aborted"));
    });
  }

  function update(mutator) {
    const work = queue.then(async () => {
      const draft = await read();
      const result = await mutator(draft);
      const clean = normalise(draft);
      await write(clean);
      return { state: clean, result };
    });
    queue = work.catch(() => undefined);
    return work;
  }

  return { read, write, update };
})();

function settleRunning(session, timestamp = Date.now()) {
  if (!session || session.status !== "running") return;
  const elapsedMs = Math.max(0, timestamp - session.runningSince);
  if (elapsedMs === 0) return;
  session.activeMs += elapsedMs;
  session.earningsNumerator += elapsedMs * session.rateCents;
  session.runningSince = timestamp;
}

function liveSession(session, timestamp = Date.now()) {
  if (!session) return { activeMs: 0, earningsNumerator: 0 };
  if (session.status !== "running") return session;
  const elapsedMs = Math.max(0, timestamp - session.runningSince);
  return {
    ...session,
    activeMs: session.activeMs + elapsedMs,
    earningsNumerator: session.earningsNumerator + elapsedMs * session.rateCents,
  };
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  return [hours, minutes, remaining].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatMoney(numerator) {
  const dollars = numerator / (RATE_DENOMINATOR * 100);
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(dollars);
}

function formatRate(rateCents) {
  return `$${(rateCents / 100).toFixed(2)}`;
}

function durationPhrase(milliseconds) {
  const totalMinutes = Math.round(milliseconds / 60_000);
  if (totalMinutes < 1) return "You read for less than a minute.";
  if (totalMinutes < 60) return `You read for ${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}.`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `You read for ${hours} hour${hours === 1 ? "" : "s"}${minutes ? ` and ${minutes} minute${minutes === 1 ? "" : "s"}` : ""}.`;
}

function readingAction(label, icon, action, className = "primary-button") {
  return `<button class="${className}" data-action="${action}"><svg aria-hidden="true" viewBox="0 0 24 24">${icon}</svg>${label}</button>`;
}

function renderTimer() {
  const session = liveSession(state.session);
  dom.timer.textContent = formatDuration(session.activeMs);
  dom.earnings.textContent = formatMoney(session.earningsNumerator);
  dom.pausedPill.classList.toggle("is-hidden", state.session?.status !== "paused");
  const status = state.session?.status || "idle";
  const controls = {
    idle: readingAction("Start Reading", "<path d=\"m9 6 8 6-8 6z\"/>", "start"),
    running: readingAction("Pause Reading", "<path d=\"M9 6v12m6-12v12\"/>", "pause"),
    paused: `${readingAction("Continue", "<path d=\"m9 6 8 6-8 6z\"/>", "continue")} ${readingAction("Stop", "<path d=\"M8 8h8v8H8z\"/>", "stop", "secondary-button")}`,
  };
  dom.timerActions.innerHTML = controls[status];
}

function renderInstallGuide() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
  dom.installGuide.classList.toggle("is-hidden", standalone || !ios || !safari || state.preferences.installGuideDismissed);
}

function render() {
  renderTimer();
  dom.balance.textContent = formatMoney(state.balanceNumerator);
  dom.balanceRate.textContent = formatRate(state.settings.rateCents);
  if (document.activeElement !== dom.rateInput) dom.rateInput.value = (state.settings.rateCents / 100).toFixed(2);
  renderInstallGuide();
}

function selectTab(tab) {
  dom.screens.forEach((screen) => {
    const selected = screen.dataset.screen === tab;
    screen.hidden = !selected;
    screen.classList.toggle("screen--active", selected);
  });
  dom.tabs.forEach((button) => {
    const selected = button.dataset.tab === tab;
    button.classList.toggle("is-active", selected);
    button.toggleAttribute("aria-current", selected);
  });
}

let toastTimeout;
function showToast(message) {
  clearTimeout(toastTimeout);
  dom.toast.textContent = message;
  dom.toast.classList.remove("is-hidden");
  toastTimeout = window.setTimeout(() => dom.toast.classList.add("is-hidden"), 2800);
}

function setModal(modal, visible) {
  modal.classList.toggle("is-hidden", !visible);
}

let state = defaultState();
let busy = false;

async function runAction(action) {
  if (busy) return;
  busy = true;
  try {
    if (action === "start") {
      const { state: next } = await Store.update((draft) => {
        if (draft.session) return;
        draft.session = { id: makeId(), status: "running", createdAt: Date.now(), activeMs: 0, earningsNumerator: 0, rateCents: draft.settings.rateCents, runningSince: Date.now() };
      });
      state = next; render(); showToast("Your reading time has begun.");
    }
    if (action === "pause") {
      const { state: next } = await Store.update((draft) => {
        if (draft.session?.status !== "running") return;
        settleRunning(draft.session);
        draft.session.status = "paused";
        draft.session.runningSince = null;
      });
      state = next; render(); showToast("Timer paused.");
    }
    if (action === "continue") {
      const { state: next } = await Store.update((draft) => {
        if (draft.session?.status !== "paused") return;
        draft.session.status = "running";
        draft.session.runningSince = Date.now();
      });
      state = next; render(); showToast("Welcome back to your book.");
    }
    if (action === "stop") {
      let completion;
      const { state: next } = await Store.update((draft) => {
        const session = draft.session;
        if (!session) return;
        settleRunning(session);
        completion = { activeMs: session.activeMs, earningsNumerator: session.earningsNumerator };
        // Balance credit and clearing the session are one IndexedDB transaction, so retries cannot double-credit it.
        draft.balanceNumerator += session.earningsNumerator;
        draft.session = null;
      });
      state = next; render();
      if (completion) {
        dom.completionDuration.textContent = durationPhrase(completion.activeMs);
        dom.completionEarnings.textContent = `+${formatMoney(completion.earningsNumerator)} earned`;
        setModal(dom.completionModal, true);
      }
    }
  } catch (error) {
    console.error(error);
    showToast("Your change could not be saved. Please try again.");
  } finally { busy = false; }
}

dom.tabs.forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.tab)));
dom.timerActions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) runAction(button.dataset.action);
});

dom.rateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const rateCents = Math.round(Number(dom.rateInput.value) * 100);
  if (!Number.isSafeInteger(rateCents) || rateCents < 0 || rateCents > 999_999) {
    showToast("Please enter a rate between $0.00 and $9,999.99.");
    return;
  }
  busy = true;
  try {
    const { state: next } = await Store.update((draft) => {
      if (draft.session?.status === "running") settleRunning(draft.session);
      draft.settings.rateCents = rateCents;
      if (draft.session) draft.session.rateCents = rateCents;
    });
    state = next; render(); showToast("Hourly rate saved.");
  } catch (error) { console.error(error); showToast("Your rate could not be saved. Please try again."); }
  finally { busy = false; }
});

$("#open-reset-modal").addEventListener("click", () => setModal(dom.resetModal, true));
$("#cancel-reset").addEventListener("click", () => setModal(dom.resetModal, false));
$("#confirm-reset").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  try {
    const { state: next } = await Store.update((draft) => { draft.balanceNumerator = 0; });
    state = next; render(); setModal(dom.resetModal, false); showToast("Your reading balance was reset.");
  } catch (error) { console.error(error); showToast("Your balance could not be reset. Please try again."); }
  finally { busy = false; }
});
$("#close-completion").addEventListener("click", () => setModal(dom.completionModal, false));
$("#dismiss-install-guide").addEventListener("click", async () => {
  try {
    const { state: next } = await Store.update((draft) => { draft.preferences.installGuideDismissed = true; });
    state = next; render();
  } catch (error) { console.error(error); dom.installGuide.classList.add("is-hidden"); }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) render();
  // Every state transition is committed immediately. Rendering from the persisted timestamp
  // here makes suspended iOS sessions accurate without treating an interval as the clock.
});
window.addEventListener("pageshow", () => render());

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker unavailable", error));

state = await Store.read();
render();
window.setInterval(() => {
  if (!document.hidden && state.session?.status === "running") {
    const session = liveSession(state.session);
    dom.timer.textContent = formatDuration(session.activeMs);
    dom.earnings.textContent = formatMoney(session.earningsNumerator);
  }
}, 1000);
