import {
  RATE_DENOMINATOR, adjustSessionTime, attributedTime, changeSessionBook, continueSession, defaultState,
  durationPhrase, finalizeStop, formatDuration, formatMoney, liveSession, makeId, normalise, pauseSession,
  sessionAttribution, settleRunning, startSession, stopSession, undoStop,
} from "./core.js";

const STORAGE_KEY = "cozy-reader-state-v1";
const DB_NAME = "cozy-reader";
const DB_VERSION = 2;
const STATE_STORE = "settings";
const COVER_STORE = "bookCovers";
const RECORD_ID = "app";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const dom = {
  screens: $$('[data-screen]'), tabs: $$('[data-tab]'), timer: $("#timer"), earnings: $("#session-earnings"),
  timerActions: $("#timer-actions"), pausedPill: $("#paused-pill"), adjustTime: $("#adjust-time"),
  currentBookCard: $("#current-book-card"), currentBookCover: $("#current-book-cover"), currentBookTitle: $("#current-book-title"),
  wakeToggle: $("#wake-toggle"), wakeStatus: $("#wake-status"), balance: $("#balance-amount"), balanceRate: $("#balance-rate"),
  rateInput: $("#rate-input"), rateForm: $("#rate-form"), bookGrid: $("#book-grid"), booksEmpty: $("#books-empty"),
  libraryView: $("#books-library-view"), detailView: $("#book-detail-view"), bookSheet: $("#book-sheet"), bookForm: $("#book-form"),
  bookPicker: $("#book-picker"), pickerGrid: $("#book-picker-grid"), adjustSheet: $("#adjust-sheet"), adjustForm: $("#adjust-form"),
  resetModal: $("#reset-modal"), completionModal: $("#completion-modal"), completionDuration: $("#completion-duration"),
  completionEarnings: $("#completion-earnings"), deleteBookModal: $("#delete-book-modal"), deleteGoalModal: $("#delete-goal-modal"),
  goalForm: $("#goal-form"), goalName: $("#goal-name"), goalTarget: $("#goal-target"), deleteGoal: $("#delete-goal"),
  reminderForm: $("#reminder-form"), reminderEnabled: $("#reminder-enabled"), reminderTime: $("#reminder-time"),
  reminderNote: $("#reminder-note"), hapticToggle: $("#haptic-toggle"), hapticStatus: $("#haptic-status"),
  toast: $("#toast"), installGuide: $("#install-guide"), storageWarning: $("#storage-warning"),
};

const Store = (() => {
  let databasePromise;
  let fallback = false;
  let queue = Promise.resolve();

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) return reject(new Error("IndexedDB is unavailable"));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STATE_STORE)) database.createObjectStore(STATE_STORE, { keyPath: "id" });
        if (!database.objectStoreNames.contains(COVER_STORE)) database.createObjectStore(COVER_STORE, { keyPath: "id" });
      };
      request.onblocked = () => {
        blocked = true;
        const error = new Error("Another Cozy Reader window is blocking the safe data upgrade.");
        error.code = "IDB_BLOCKED";
        reject(error);
      };
      request.onsuccess = () => {
        if (blocked) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error("Unable to open reading storage"));
    }).catch((error) => {
      if (error?.code === "IDB_BLOCKED") {
        databasePromise = null;
        throw error;
      }
      fallback = true;
      console.warn("Using local storage fallback; cover uploads are unavailable", error);
      return null;
    });
    return databasePromise;
  }

  function readFallback() {
    try { return normalise(JSON.parse(localStorage.getItem(STORAGE_KEY) || "null")); }
    catch { return defaultState(); }
  }

  function writeFallback(next) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalise(next)));
  }

  async function read() {
    const database = await openDatabase();
    if (fallback || !database) return readFallback();
    return new Promise((resolve) => {
      const transaction = database.transaction(STATE_STORE, "readonly");
      const request = transaction.objectStore(STATE_STORE).get(RECORD_ID);
      request.onsuccess = () => resolve(normalise(request.result?.value));
      request.onerror = () => resolve(defaultState());
    });
  }

  function update(mutator) {
    const work = queue.then(async () => {
      const database = await openDatabase();
      if (fallback || !database) {
        const draft = readFallback();
        const result = mutator(draft);
        const clean = normalise(draft);
        writeFallback(clean);
        return { state: clean, result };
      }
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(STATE_STORE, "readwrite");
        const objectStore = transaction.objectStore(STATE_STORE);
        const request = objectStore.get(RECORD_ID);
        let clean;
        let result;
        request.onsuccess = () => {
          try {
            const draft = normalise(request.result?.value);
            result = mutator(draft);
            clean = normalise(draft);
            objectStore.put({ id: RECORD_ID, value: clean });
          } catch (error) {
            transaction.abort();
            reject(error);
          }
        };
        request.onerror = () => reject(request.error || new Error("Unable to read reading storage"));
        transaction.oncomplete = () => resolve({ state: clean, result });
        transaction.onerror = () => reject(transaction.error || new Error("Reading storage update failed"));
        transaction.onabort = () => reject(transaction.error || new Error("Reading storage update was cancelled"));
      });
    });
    queue = work.catch(() => undefined);
    return work;
  }

  async function readCover(id) {
    const database = await openDatabase();
    if (fallback || !database) return null;
    return new Promise((resolve) => {
      const request = database.transaction(COVER_STORE, "readonly").objectStore(COVER_STORE).get(id);
      request.onsuccess = () => resolve(request.result?.blob instanceof Blob ? request.result.blob : null);
      request.onerror = () => resolve(null);
    });
  }

  async function writeCover(id, blob) {
    const database = await openDatabase();
    if (fallback || !database) throw new Error("Cover uploads require IndexedDB in this browser.");
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(COVER_STORE, "readwrite");
      transaction.objectStore(COVER_STORE).put({ id, blob });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Cover could not be saved"));
    });
  }

  async function deleteCover(id) {
    const database = await openDatabase();
    if (fallback || !database) return;
    return new Promise((resolve) => {
      const transaction = database.transaction(COVER_STORE, "readwrite");
      transaction.objectStore(COVER_STORE).delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
    });
  }

  return { read, update, readCover, writeCover, deleteCover };
})();

let state = defaultState();
let hydrated = false;
let selectedBookDetailId = null;
let pendingDeleteBookId = null;
let busy = false;
let toastTimeout;
let celebrationTimeout;
let modalFocusOrigin = null;
const coverUrls = new Map();

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const formatRate = (rateCents) => `$${(rateCents / 100).toFixed(2)}`;
const formatReadingTime = (milliseconds) => {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${remainder ? ` ${remainder}m` : ""}`;
};

function showToast(message) {
  clearTimeout(toastTimeout);
  dom.toast.textContent = message;
  dom.toast.classList.remove("is-hidden");
  toastTimeout = window.setTimeout(() => dom.toast.classList.add("is-hidden"), 3000);
}

function setModal(modal, visible) {
  if (!modal) return;
  const wasVisible = !modal.classList.contains("is-hidden");
  if (wasVisible === visible) return;
  modal.classList.toggle("is-hidden", !visible);
  const app = $(".app-shell");
  const navigation = $(".bottom-nav");
  if (visible) {
    modalFocusOrigin = document.activeElement;
    app.inert = true;
    navigation.inert = true;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => modal.querySelector("button, input, select, [tabindex]:not([tabindex='-1'])")?.focus(), 0);
  } else if (!$(".modal-backdrop:not(.is-hidden)")) {
    app.inert = false;
    navigation.inert = false;
    document.body.style.overflow = "";
    modalFocusOrigin?.focus?.();
    modalFocusOrigin = null;
  }
}

const Haptics = {
  patterns: { start: 35, pause: [18, 45, 18], continue: 22, stop: [45, 35, 55], select: 12, tab: 8, celebrate: [25, 35, 25, 35, 70], warning: [55, 35, 55] },
  supported: "vibrate" in navigator,
  pulse(kind) {
    document.documentElement.dataset.feedback = kind;
    window.setTimeout(() => delete document.documentElement.dataset.feedback, 180);
    if (!state.settings.hapticsEnabled || !this.supported) return false;
    return navigator.vibrate(this.patterns[kind] || 12);
  },
};

const WakeLock = {
  lock: null,
  pending: false,
  rejected: false,
  systemReleased: false,
  get supported() { return "wakeLock" in navigator; },
  async request() {
    if (!this.supported || this.pending || this.lock || document.hidden || state.session?.status !== "running" || !state.settings.wakeLockEnabled) return;
    this.pending = true;
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      this.lock = sentinel;
      this.rejected = false;
      this.systemReleased = false;
      sentinel.addEventListener("release", () => {
        if (this.lock !== sentinel) return;
        this.lock = null;
        this.systemReleased = true;
        renderWakeStatus();
      }, { once: true });
    } catch (error) {
      this.rejected = true;
      console.info("Screen wake lock was not granted", error);
    } finally {
      this.pending = false;
      renderWakeStatus();
    }
  },
  async release() {
    const current = this.lock;
    this.lock = null;
    this.systemReleased = false;
    if (current) await current.release().catch(() => undefined);
    renderWakeStatus();
  },
  sync() {
    if (state.settings.wakeLockEnabled && state.session?.status === "running" && !document.hidden) this.request();
    else this.release();
  },
};

function coverTone(book) {
  const tones = ["#dce7d9", "#eadfd5", "#e5dfef", "#d9e5e7", "#eee5c9", "#e8d8d5"];
  const seed = [...book.title].reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
  return tones[seed % tones.length];
}

function coverMarkup(book, className = "book-cover") {
  return `<div class="${className}" style="--cover:${coverTone(book)}" data-cover-container="${escapeHtml(book.id)}">${book.coverId ? `<img alt="${escapeHtml(book.title)} cover" data-cover-id="${escapeHtml(book.coverId)}" />` : ""}<span class="book-cover__title">${escapeHtml(book.title)}</span></div>`;
}

async function refreshCoverImages() {
  const images = $$('img[data-cover-id]');
  await Promise.all(images.map(async (image) => {
    const coverId = image.dataset.coverId;
    let url = coverUrls.get(coverId);
    if (!url) {
      const blob = await Store.readCover(coverId);
      if (!blob) { image.remove(); return; }
      url = URL.createObjectURL(blob);
      coverUrls.set(coverId, url);
    }
    image.src = url;
    image.closest(".book-cover")?.classList.add("has-image");
  }));
}

function invalidateCover(id) {
  const url = coverUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  coverUrls.delete(id);
}

function readingAction(label, icon, action, className = "primary-button") {
  return `<button class="${className}" data-reading-action="${action}" ${hydrated ? "" : "disabled"}><svg aria-hidden="true" viewBox="0 0 24 24">${icon}</svg>${label}</button>`;
}

function getBook(id) { return state.books.find((book) => book.id === id) || null; }

function renderTimer() {
  const session = liveSession(state.session);
  dom.timer.textContent = formatDuration(session.activeMs);
  dom.earnings.textContent = formatMoney(session.earningsNumerator);
  const status = state.session?.status || "idle";
  dom.pausedPill.classList.toggle("is-hidden", status !== "paused");
  dom.adjustTime.classList.toggle("is-hidden", status !== "paused");
  const controls = {
    idle: readingAction("Start Reading", '<path d="m9 6 8 6-8 6z"/>', "start"),
    running: readingAction("Pause Reading", '<path d="M9 6v12m6-12v12"/>', "pause"),
    paused: `${readingAction("Continue", '<path d="m9 6 8 6-8 6z"/>', "continue")} ${readingAction("Stop", '<path d="M8 8h8v8H8z"/>', "stop", "secondary-button")}`,
  };
  dom.timerActions.innerHTML = controls[status];
  dom.currentBookCard.classList.toggle("is-hidden", !state.session);
  if (state.session) {
    const book = getBook(state.session.selectedBookId);
    dom.currentBookTitle.textContent = book?.title || "Just Reading";
    dom.currentBookCover.innerHTML = book
      ? (book.coverId ? `<img alt="" data-cover-id="${escapeHtml(book.coverId)}" />` : `<span>${escapeHtml(book.title.slice(0, 2).toUpperCase())}</span>`)
      : "<span>JR</span>";
  }
}

function bookProgress(book) {
  if (!book.totalPages) return 0;
  return Math.min(100, Math.round((book.currentPage / book.totalPages) * 100));
}

function liveBookTotals(book) {
  const live = sessionAttribution(state.session).find((part) => part.bookId === book.id);
  return {
    activeMs: book.totalActiveMs + (live?.activeMs || 0),
    earningsNumerator: book.totalEarningsNumerator + (live?.earningsNumerator || 0),
  };
}

function renderBooks() {
  dom.booksEmpty.classList.toggle("is-hidden", state.books.length > 0);
  dom.bookGrid.classList.toggle("is-hidden", state.books.length === 0);
  dom.bookGrid.innerHTML = state.books.map((book) => {
    const progress = bookProgress(book);
    const totals = liveBookTotals(book);
    return `<button class="book-tile" data-open-book="${escapeHtml(book.id)}">${coverMarkup(book)}<h3>${escapeHtml(book.title)}</h3><p>${escapeHtml(book.author || "Unknown author")}</p><div class="tile-progress"><span style="width:${progress}%"></span></div><div class="tile-meta"><span>${book.totalPages ? `${book.currentPage} / ${book.totalPages} pages` : `${book.currentPage} pages`}</span><span>${formatReadingTime(totals.activeMs)}</span></div></button>`;
  }).join("");
  renderBookDetail();
}

function renderBookDetail() {
  const book = getBook(selectedBookDetailId);
  dom.libraryView.classList.toggle("is-hidden", Boolean(book));
  dom.detailView.classList.toggle("is-hidden", !book);
  if (!book) { dom.detailView.innerHTML = ""; return; }
  const progress = bookProgress(book);
  const totals = liveBookTotals(book);
  dom.detailView.innerHTML = `<div class="book-detail__header"><button class="icon-button" data-detail-action="back" aria-label="Back to My Books"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg></button><button class="icon-button" data-detail-action="edit" aria-label="Edit book"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m14 5 5 5M4 20l3.5-.7L19 7.8a2 2 0 0 0-2.8-2.8L4.7 16.5z"/></svg></button></div><div class="book-detail__hero">${coverMarkup(book, "book-cover book-detail__cover")}<div class="book-detail__copy"><span class="status-label">${book.status === "finished" ? "Finished" : "Currently reading"}</span><h1>${escapeHtml(book.title)}</h1><p>${escapeHtml(book.author || "Unknown author")}</p></div></div><div class="detail-progress"><div class="detail-progress__line"><strong>${progress}% complete</strong><span>${book.totalPages ? `Page ${book.currentPage} of ${book.totalPages}` : `${book.currentPage} pages read`}</span></div><div class="goal-progress"><span style="width:${progress}%"></span></div></div><div class="detail-stats"><article class="detail-stat"><span>Total reading time</span><strong>${formatReadingTime(totals.activeMs)}</strong></article><article class="detail-stat"><span>Total earned</span><strong>${formatMoney(totals.earningsNumerator)}</strong></article></div><form class="page-update" id="page-update-form"><input class="field" id="detail-current-page" type="number" min="0" max="${book.totalPages || 1_000_000}" value="${book.currentPage}" aria-label="Current page" /><button class="small-primary-button">Update page</button></form><div class="detail-actions"><button class="secondary-button" data-detail-action="finish">${book.status === "finished" ? "Marked as Finished" : "Mark as Finished"}</button><button class="danger-button" data-detail-action="delete">Delete Book</button></div>`;
}

function goalMarkup(mode) {
  const goal = state.goal;
  if (!goal) return "";
  const targetNumerator = goal.targetCents * RATE_DENOMINATOR;
  const rawPercent = targetNumerator ? (state.balanceNumerator / targetNumerator) * 100 : 0;
  const percent = Math.min(100, Math.max(0, rawPercent));
  const remaining = Math.max(0, targetNumerator - state.balanceNumerator);
  const remainingMs = state.settings.rateCents > 0 ? remaining / state.settings.rateCents : null;
  let estimate = "Goal complete";
  if (remaining > 0 && remainingMs == null) estimate = "Set a rate to estimate reading time";
  if (remaining > 0 && remainingMs != null) {
    if (remainingMs < 60_000) estimate = "Less than a minute of reading remaining";
    else if (remainingMs < 3_600_000) {
      const minutes = Math.ceil(remainingMs / 60_000);
      estimate = `${minutes} minute${minutes === 1 ? "" : "s"} of reading remaining`;
    } else {
      const hours = Math.ceil(remainingMs / 3_600_000);
      estimate = `${hours} hour${hours === 1 ? "" : "s"} of reading remaining`;
    }
  }
  const displayPercent = remaining <= 0 ? 100 : Math.min(99, Math.floor(percent));
  const remainingLabel = remaining > 0 && remaining < RATE_DENOMINATOR ? "<$0.01 remaining" : `${formatMoney(remaining)} remaining`;
  return `<article class="goal-card ${mode === "full" ? "goal-card--full" : ""}"><div class="goal-card__top"><strong>${escapeHtml(goal.name)}${remaining <= 0 ? " ✨" : ""}</strong><span>${displayPercent}% COMPLETE</span></div><div class="goal-progress"><span style="width:${percent}%"></span></div><div class="goal-card__meta"><span>${formatMoney(state.balanceNumerator)} / ${(goal.targetCents / 100).toLocaleString("en-AU", { style: "currency", currency: "AUD" })}</span><span>${remainingLabel}</span></div><p class="goal-card__estimate">${estimate}</p></article>`;
}

function renderGoals() {
  $$('[data-goal-host]').forEach((host) => { host.innerHTML = goalMarkup(host.dataset.goalHost); });
}

function renderSettings() {
  if (document.activeElement !== dom.rateInput) dom.rateInput.value = (state.settings.rateCents / 100).toFixed(2);
  if (document.activeElement !== dom.goalName) dom.goalName.value = state.goal?.name || "";
  if (document.activeElement !== dom.goalTarget) dom.goalTarget.value = state.goal ? (state.goal.targetCents / 100).toFixed(2) : "";
  dom.deleteGoal.classList.toggle("is-hidden", !state.goal);
  dom.reminderEnabled.checked = state.settings.reminder.enabled;
  dom.reminderTime.value = state.settings.reminder.time;
  $$('.weekday-picker input').forEach((input) => { input.checked = state.settings.reminder.days.includes(Number(input.value)); });
  dom.hapticToggle.checked = state.settings.hapticsEnabled;
  dom.hapticStatus.textContent = Haptics.supported ? "Subtle feedback is available on this device" : "Not supported here; visual feedback stays on";
  dom.reminderNote.textContent = "Reminders work while Cozy Reader is open. Reliable closed-app reminders on iOS require a push service, which is not included.";
}

function renderWakeStatus() {
  dom.wakeToggle.checked = state.settings.wakeLockEnabled;
  dom.wakeToggle.disabled = !WakeLock.supported;
  if (!WakeLock.supported) dom.wakeStatus.textContent = "Not supported by this browser";
  else if (WakeLock.lock) dom.wakeStatus.textContent = "Screen will stay awake";
  else if (WakeLock.systemReleased && state.session?.status === "running") dom.wakeStatus.textContent = "Released by the system; pause and continue to retry";
  else if (WakeLock.rejected) dom.wakeStatus.textContent = "Unavailable right now";
  else if (state.settings.wakeLockEnabled && state.session?.status !== "running") dom.wakeStatus.textContent = "Ready for your next active session";
  else dom.wakeStatus.textContent = "Available while actively reading";
}

function renderInstallGuide() {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const safari = /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
  dom.installGuide.classList.toggle("is-hidden", standalone || !ios || !safari || state.preferences.installGuideDismissed);
}

function renderCompletion() {
  const pending = state.pendingStop;
  setModal(dom.completionModal, Boolean(pending));
  if (!pending) return;
  dom.completionDuration.textContent = durationPhrase(pending.sessionSnapshot.activeMs);
  dom.completionEarnings.textContent = `+${formatMoney(pending.creditedNumerator)} earned`;
}

function render() {
  renderTimer();
  dom.balance.textContent = formatMoney(state.balanceNumerator);
  dom.balanceRate.textContent = formatRate(state.settings.rateCents);
  renderBooks();
  renderGoals();
  renderSettings();
  renderWakeStatus();
  renderInstallGuide();
  renderCompletion();
  refreshCoverImages().catch((error) => console.warn("A book cover could not be shown", error));
}

function selectTab(tab) {
  dom.screens.forEach((screen) => { const selected = screen.dataset.screen === tab; screen.hidden = !selected; screen.classList.toggle("screen--active", selected); });
  dom.tabs.forEach((button) => { const selected = button.dataset.tab === tab; button.classList.toggle("is-active", selected); button.toggleAttribute("aria-current", selected); });
  if (tab !== "books") selectedBookDetailId = null;
  if (tab === "books") renderBookDetail();
  Haptics.pulse("tab");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openBookPicker() {
  dom.pickerGrid.innerHTML = state.books.length ? state.books.map((book) => `<button class="picker-book" data-pick-book="${escapeHtml(book.id)}">${coverMarkup(book)}<strong>${escapeHtml(book.title)}</strong><small>${escapeHtml(book.author || "Unknown author")}</small></button>`).join("") : '<div class="empty-state" style="grid-column:1/-1;margin:0"><h2>No books yet</h2><p>You can still start a free reading session below.</p></div>';
  setModal(dom.bookPicker, true);
  refreshCoverImages();
}

async function updateState(mutator) {
  await ready;
  const result = await Store.update(mutator);
  state = result.state;
  dom.storageWarning.classList.add("is-hidden");
  render();
  return result.result;
}

async function runReadingAction(action) {
  if (busy) return;
  if (action === "start") { openBookPicker(); return; }
  busy = true;
  try {
    if (action === "pause") {
      await updateState((draft) => pauseSession(draft));
      Haptics.pulse("pause");
      await WakeLock.release();
      showToast("Timer paused.");
    } else if (action === "continue") {
      await updateState((draft) => continueSession(draft));
      Haptics.pulse("continue");
      WakeLock.sync();
      showToast("Welcome back to your book.");
    } else if (action === "stop") {
      const stopped = await updateState((draft) => stopSession(draft));
      if (stopped) Haptics.pulse("stop");
      await WakeLock.release();
      await maybeCelebrateGoal();
    }
  } catch (error) {
    console.error(error);
    showToast("Your change could not be saved. Please try again.");
  } finally { busy = false; }
}

async function pickBook(bookId) {
  if (busy) return;
  busy = true;
  try {
    const selected = bookId || null;
    if (state.session) await updateState((draft) => changeSessionBook(draft, selected));
    else await updateState((draft) => startSession(draft, selected));
    Haptics.pulse(state.session?.activeMs ? "select" : "start");
    setModal(dom.bookPicker, false);
    WakeLock.sync();
    showToast(selected ? `Now reading ${getBook(selected)?.title || "your book"}.` : "Reading without a selected book.");
  } catch (error) { console.error(error); showToast("That book could not be selected."); }
  finally { busy = false; }
}

function openBookForm(book = null) {
  dom.bookForm.reset();
  $("#book-id").value = book?.id || "";
  $("#book-title").value = book?.title || "";
  $("#book-author").value = book?.author || "";
  $("#book-total-pages").value = book?.totalPages || "";
  $("#book-current-page").value = book?.currentPage || 0;
  $("#book-form-title").textContent = book ? "Edit book" : "Add a book";
  $("#remove-cover-row").classList.toggle("is-hidden", !book?.coverId);
  $("#book-form-message").textContent = "";
  setModal(dom.bookSheet, true);
  window.setTimeout(() => $("#book-title").focus(), 100);
}

async function saveBook(event) {
  event.preventDefault();
  if (busy) return;
  const id = $("#book-id").value || makeId("book");
  const title = $("#book-title").value.trim();
  const author = $("#book-author").value.trim();
  const totalRaw = $("#book-total-pages").value;
  const currentRaw = $("#book-current-page").value;
  const totalPages = totalRaw === "" ? null : Number(totalRaw);
  const currentPage = currentRaw === "" ? 0 : Number(currentRaw);
  const message = $("#book-form-message");
  if (!title) { message.textContent = "Please add a book title."; return; }
  if (totalPages != null && (!Number.isInteger(totalPages) || totalPages < 1)) { message.textContent = "Total pages must be a whole number above zero."; return; }
  if (!Number.isInteger(currentPage) || currentPage < 0) { message.textContent = "Current page must be zero or a positive whole number."; return; }
  if (totalPages != null && currentPage > totalPages) { message.textContent = "Current page cannot be higher than total pages."; return; }
  const file = $("#book-cover").files[0];
  if (file && (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024)) { message.textContent = "Choose an image smaller than 5 MB."; return; }
  busy = true;
  try {
    const existing = getBook(id);
    let coverId = existing?.coverId || null;
    let coverWarning = "";
    if (file) {
      try { await Store.writeCover(id, file); invalidateCover(id); coverId = id; }
      catch (error) { console.warn("Cover storage unavailable", error); coverWarning = "Book saved without its cover because image storage is unavailable."; }
    }
    if ($("#remove-cover").checked) { coverId = null; await Store.deleteCover(id); invalidateCover(id); }
    await updateState((draft) => {
      const index = draft.books.findIndex((book) => book.id === id);
      const saved = {
        id, title, author, totalPages, currentPage, status: existing?.status || "reading", coverId,
        totalActiveMs: existing?.totalActiveMs || 0, totalEarningsNumerator: existing?.totalEarningsNumerator || 0,
        createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now(),
      };
      if (index >= 0) draft.books[index] = saved; else draft.books.unshift(saved);
    });
    setModal(dom.bookSheet, false);
    selectedBookDetailId = id;
    render();
    Haptics.pulse("select");
    showToast(coverWarning || (existing ? "Book updated." : "Book added to your shelf."));
  } catch (error) { console.error(error); message.textContent = error.message || "Your book could not be saved."; }
  finally { busy = false; }
}

async function deleteBook() {
  const id = pendingDeleteBookId;
  if (!id || busy) return;
  busy = true;
  try {
    await updateState((draft) => {
      draft.books = draft.books.filter((book) => book.id !== id);
      if (draft.session?.selectedBookId === id) draft.session.selectedBookId = null;
    });
    await Store.deleteCover(id);
    invalidateCover(id);
    selectedBookDetailId = null;
    pendingDeleteBookId = null;
    setModal(dom.deleteBookModal, false);
    render();
    Haptics.pulse("warning");
    showToast("Book deleted. Your balance was not changed.");
  } catch (error) { console.error(error); showToast("The book could not be deleted."); }
  finally { busy = false; }
}

function openAdjustSheet() {
  if (state.session?.status !== "paused") return;
  $("#adjust-hours").value = 0;
  $("#adjust-minutes").value = 0;
  $("#adjust-message").textContent = "";
  $("#adjust-book").innerHTML = `<option value="">Just Reading</option>${state.books.map((book) => `<option value="${escapeHtml(book.id)}" ${book.id === state.session.selectedBookId ? "selected" : ""}>${escapeHtml(book.title)}</option>`).join("")}`;
  updateAdjustmentPreview();
  setModal(dom.adjustSheet, true);
}

function adjustmentInput() {
  const hours = Math.max(0, Number($("#adjust-hours").value) || 0);
  const minutes = Math.max(0, Number($("#adjust-minutes").value) || 0);
  return {
    direction: $('input[name="adjust-direction"]:checked').value,
    milliseconds: Math.round((hours * 60 + minutes) * 60_000),
    bookId: $("#adjust-book").value || null,
  };
}

function updateAdjustmentPreview() {
  const input = adjustmentInput();
  const preview = $("#adjust-preview strong");
  const message = $("#adjust-message");
  if (!input.milliseconds) { preview.textContent = `${formatDuration(state.session?.activeMs || 0)} · ${formatMoney(state.session?.earningsNumerator || 0)}`; message.textContent = ""; return; }
  try {
    const candidate = normalise(state);
    adjustSessionTime(candidate, input);
    preview.textContent = `${formatDuration(candidate.session.activeMs)} · ${formatMoney(candidate.session.earningsNumerator)}`;
    message.textContent = "";
  } catch (error) { preview.textContent = "Adjustment unavailable"; message.textContent = error.message; }
}

async function applyAdjustment(event) {
  event.preventDefault();
  if (busy) return;
  const input = adjustmentInput();
  try {
    busy = true;
    await updateState((draft) => adjustSessionTime(draft, input));
    setModal(dom.adjustSheet, false);
    Haptics.pulse("select");
    showToast("Session time adjusted.");
  } catch (error) { $("#adjust-message").textContent = error.message; }
  finally { busy = false; }
}

async function maybeCelebrateGoal() {
  const goal = state.goal;
  if (!goal || goal.celebrated || state.balanceNumerator < goal.targetCents * RATE_DENOMINATOR) return;
  await updateState((draft) => { if (draft.goal?.id === goal.id) draft.goal.celebrated = true; });
  Haptics.pulse("celebrate");
  $$('.goal-card').forEach((card) => card.classList.add("is-celebrating"));
  clearTimeout(celebrationTimeout);
  celebrationTimeout = window.setTimeout(() => $$('.goal-card').forEach((card) => card.classList.remove("is-celebrating")), 1000);
  showToast(`You reached your ${goal.name} goal ✨`);
}

async function checkReminder() {
  const reminder = state.settings.reminder;
  if (!hydrated || !reminder.enabled || document.hidden) return;
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const localTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  if (!reminder.days.includes(now.getDay()) || localTime < reminder.time || reminder.lastNotifiedDate === localDate) return;
  await updateState((draft) => { draft.settings.reminder.lastNotifiedDate = localDate; });
  showToast("Time for a little reading 📖");
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
      await registration?.showNotification?.("Cozy Reader", { body: "Time for a little reading 📖", icon: "icon-192.png" });
    } catch (error) { console.info("System notification unavailable; the in-app reminder was shown", error); }
  }
}

dom.tabs.forEach((button) => button.addEventListener("click", () => selectTab(button.dataset.tab)));
dom.timerActions.addEventListener("click", (event) => { const button = event.target.closest("[data-reading-action]"); if (button) runReadingAction(button.dataset.readingAction); });
dom.bookPicker.addEventListener("click", (event) => { const button = event.target.closest("[data-pick-book]"); if (button) pickBook(button.dataset.pickBook); });
$("#change-book").addEventListener("click", openBookPicker);
dom.adjustTime.addEventListener("click", openAdjustSheet);
dom.adjustForm.addEventListener("input", updateAdjustmentPreview);
dom.adjustForm.addEventListener("submit", applyAdjustment);
$("#add-book").addEventListener("click", () => openBookForm());
$("#empty-add-book").addEventListener("click", () => openBookForm());
dom.bookForm.addEventListener("submit", saveBook);
dom.bookGrid.addEventListener("click", (event) => { const tile = event.target.closest("[data-open-book]"); if (tile) { selectedBookDetailId = tile.dataset.openBook; render(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
dom.detailView.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-detail-action]")?.dataset.detailAction;
  const book = getBook(selectedBookDetailId);
  if (!action || !book) return;
  if (action === "back") { selectedBookDetailId = null; render(); }
  if (action === "edit") openBookForm(book);
  if (action === "delete") { pendingDeleteBookId = book.id; setModal(dom.deleteBookModal, true); }
  if (action === "finish" && book.status !== "finished") {
    await updateState((draft) => { const saved = draft.books.find((item) => item.id === book.id); if (saved) { saved.status = "finished"; if (saved.totalPages) saved.currentPage = saved.totalPages; saved.updatedAt = Date.now(); } });
    Haptics.pulse("select"); showToast("Book marked as finished.");
  }
});
dom.detailView.addEventListener("submit", async (event) => {
  if (event.target.id !== "page-update-form") return;
  event.preventDefault();
  const book = getBook(selectedBookDetailId);
  const page = Number($("#detail-current-page").value);
  if (!book || !Number.isInteger(page) || page < 0 || (book.totalPages && page > book.totalPages)) { showToast("Enter a valid page number."); return; }
  await updateState((draft) => { const saved = draft.books.find((item) => item.id === book.id); if (saved) { saved.currentPage = page; saved.status = saved.totalPages && page >= saved.totalPages ? "finished" : "reading"; saved.updatedAt = Date.now(); } });
  showToast("Reading progress updated.");
});
$("#confirm-delete-book").addEventListener("click", deleteBook);

dom.rateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const rateCents = Math.round(Number(dom.rateInput.value) * 100);
  if (!Number.isSafeInteger(rateCents) || rateCents < 0 || rateCents > 999_999) { showToast("Please enter a rate between $0.00 and $9,999.99."); return; }
  try {
    await updateState((draft) => { if (draft.session?.status === "running") settleRunning(draft.session); draft.settings.rateCents = rateCents; if (draft.session) draft.session.rateCents = rateCents; });
    showToast("Hourly rate saved.");
  } catch (error) { console.error(error); showToast("Your rate could not be saved."); }
});

dom.goalForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = dom.goalName.value.trim();
  const targetCents = Math.round(Number(dom.goalTarget.value) * 100);
  if (!name || !Number.isSafeInteger(targetCents) || targetCents < 1) { showToast("Add a goal name and a target above $0.00."); return; }
  const previous = state.goal;
  await updateState((draft) => { draft.goal = { id: previous?.id || makeId("goal"), name, targetCents, celebrated: previous?.targetCents === targetCents ? previous.celebrated : false, createdAt: previous?.createdAt || Date.now() }; });
  showToast(previous ? "Savings goal updated." : "Savings goal created.");
  await maybeCelebrateGoal();
});
dom.deleteGoal.addEventListener("click", () => setModal(dom.deleteGoalModal, true));
$("#confirm-delete-goal").addEventListener("click", async () => { await updateState((draft) => { draft.goal = null; }); setModal(dom.deleteGoalModal, false); Haptics.pulse("warning"); showToast("Savings goal deleted. Your balance is unchanged."); });

dom.reminderEnabled.addEventListener("change", async () => {
  if (!dom.reminderEnabled.checked || !("Notification" in window) || Notification.permission !== "default") return;
  try {
    const permission = await Notification.requestPermission();
    showToast(permission === "granted" ? "Notifications enabled while Cozy Reader can deliver them." : "No problem — in-app reminders can still appear while the app is open.");
  } catch (error) {
    console.info("Notification permission is unavailable", error);
    showToast("In-app reminders can still appear while Cozy Reader is open.");
  }
});
dom.reminderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const days = $$('.weekday-picker input:checked').map((input) => Number(input.value));
  if (!days.length) { showToast("Choose at least one reminder day."); return; }
  await updateState((draft) => { draft.settings.reminder.enabled = dom.reminderEnabled.checked; draft.settings.reminder.time = dom.reminderTime.value || "19:00"; draft.settings.reminder.days = days; });
  showToast("Reading reminder saved.");
});
dom.hapticToggle.addEventListener("change", async () => { await updateState((draft) => { draft.settings.hapticsEnabled = dom.hapticToggle.checked; }); if (dom.hapticToggle.checked) Haptics.pulse("select"); showToast(dom.hapticToggle.checked ? "Haptic feedback enabled where supported." : "Haptic feedback disabled."); });
dom.wakeToggle.addEventListener("change", async () => { await updateState((draft) => { draft.settings.wakeLockEnabled = dom.wakeToggle.checked; }); WakeLock.sync(); showToast(dom.wakeToggle.checked ? "Screen wake preference enabled." : "Screen wake preference disabled."); });

$("#open-reset-modal").addEventListener("click", () => setModal(dom.resetModal, true));
$("#confirm-reset").addEventListener("click", async () => { await updateState((draft) => { draft.balanceNumerator = 0; if (draft.goal) draft.goal.celebrated = false; }); setModal(dom.resetModal, false); Haptics.pulse("warning"); showToast("Your reading balance was reset. Your goal remains."); });
$("#undo-stop").addEventListener("click", async () => { const restored = await updateState((draft) => undoStop(draft)); if (restored) { setModal(dom.completionModal, false); Haptics.pulse("select"); showToast("Session restored in a paused state."); } });
$("#close-completion").addEventListener("click", async () => { await updateState((draft) => finalizeStop(draft)); setModal(dom.completionModal, false); });
$$('[data-close]').forEach((button) => button.addEventListener("click", () => setModal($(`#${button.dataset.close}`), false)));
$("#dismiss-install-guide").addEventListener("click", async () => { await updateState((draft) => { draft.preferences.installGuideDismissed = true; }); });

document.addEventListener("visibilitychange", () => { if (!document.hidden) { render(); WakeLock.sync(); checkReminder(); } else WakeLock.release(); });
window.addEventListener("pageshow", () => { render(); WakeLock.sync(); });
window.addEventListener("beforeunload", () => { coverUrls.forEach((url) => URL.revokeObjectURL(url)); });
document.addEventListener("keydown", (event) => {
  const open = $$('.modal-backdrop:not(.is-hidden)').at(-1);
  if (!open) return;
  if (event.key === "Escape" && open !== dom.completionModal) { setModal(open, false); return; }
  if (event.key !== "Tab") return;
  const focusable = $$('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', open).filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Service worker unavailable", error));

let resolveReady;
const ready = new Promise((resolve) => { resolveReady = resolve; });
function initialise() {
  render();
  Store.read().then((saved) => {
    state = saved;
    hydrated = true;
    resolveReady();
    render();
    WakeLock.sync();
    checkReminder();
  }).catch((error) => {
    console.warn("Could not restore saved reading state", error);
    hydrated = true;
    resolveReady();
    if (error?.code === "IDB_BLOCKED") dom.storageWarning.classList.remove("is-hidden");
    render();
  });
}

initialise();
window.setInterval(() => {
  if (!document.hidden && state.session?.status === "running") {
    const session = liveSession(state.session);
    dom.timer.textContent = formatDuration(session.activeMs);
    dom.earnings.textContent = formatMoney(session.earningsNumerator);
  }
}, 1000);
window.setInterval(checkReminder, 30_000);
