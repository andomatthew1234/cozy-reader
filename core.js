export const RATE_DENOMINATOR = 3_600_000;
export const APP_SCHEMA = 2;

const OPEN_LIBRARY_FIELDS = [
  "key", "title", "author_name", "first_publish_year", "cover_i", "cover_edition_key", "publisher", "publish_year", "edition_count",
  "editions", "editions.key", "editions.title", "editions.cover_i", "editions.publisher", "editions.publish_date",
];

export function buildOpenLibrarySearchUrl(query, limit = 18) {
  const safeLimit = finiteInteger(limit, 18, 1, 30);
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("q", String(query || "").trim());
  url.searchParams.set("fields", OPEN_LIBRARY_FIELDS.join(","));
  url.searchParams.set("limit", String(safeLimit));
  return url.toString();
}

export function normaliseCoverSearchDocs(docs, limit = 18) {
  if (!Array.isArray(docs)) return [];
  const safeLimit = finiteInteger(limit, 18, 1, 30);
  const seen = new Set();
  const results = [];
  const addResult = (candidate, doc, isEdition = false) => {
    const coverId = Number(candidate?.cover_i);
    const title = String(candidate?.title || doc?.title || "").trim();
    if (!Number.isSafeInteger(coverId) || coverId <= 0 || !title || seen.has(coverId)) return;
    seen.add(coverId);
    const firstYear = Number(doc?.first_publish_year);
    const publicationYear = Array.isArray(doc?.publish_year)
      ? doc.publish_year.map(Number).find((year) => Number.isInteger(year) && year > 0)
      : null;
    const editionYearText = Array.isArray(candidate?.publish_date)
      ? candidate.publish_date.map((value) => String(value || "")).join(" ")
      : String(candidate?.publish_date || "");
    const editionYear = Number(editionYearText.match(/\b(?:1[0-9]{3}|20[0-9]{2})\b/)?.[0]);
    const publisherSource = isEdition ? candidate?.publisher : doc?.publisher;
    const publisher = Array.isArray(publisherSource)
      ? publisherSource.map((value) => String(value || "").trim()).find(Boolean) || ""
      : "";
    const author = Array.isArray(doc?.author_name)
      ? doc.author_name.map((value) => String(value || "").trim()).find(Boolean) || ""
      : "";
    results.push({
      coverId,
      key: String(candidate?.key || doc?.key || ""),
      title,
      author,
      publisher,
      year: isEdition && Number.isInteger(editionYear) && editionYear > 0
        ? editionYear
        : (Number.isInteger(firstYear) && firstYear > 0 ? firstYear : (publicationYear || null)),
      editionCount: finiteInteger(doc?.edition_count, 0, 0, 1_000_000),
    });
  };
  for (const doc of docs) {
    const editions = Array.isArray(doc?.editions?.docs) ? doc.editions.docs : [];
    editions.forEach((edition) => addResult(edition, doc, true));
    addResult(doc, doc, false);
    if (results.length >= safeLimit) break;
  }
  return results.slice(0, safeLimit);
}

export function makeId(prefix = "item") {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function finiteInteger(value, fallback = 0, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

export function defaultState() {
  return {
    schema: APP_SCHEMA,
    balanceNumerator: 0,
    settings: {
      rateCents: 200,
      hapticsEnabled: true,
      wakeLockEnabled: false,
      reminder: { enabled: false, time: "19:00", days: [1, 2, 3, 4, 5], lastNotifiedDate: null },
    },
    preferences: { installGuideDismissed: false },
    books: [],
    goal: null,
    session: null,
    pendingStop: null,
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normaliseSegment(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const activeMs = finiteInteger(candidate.activeMs, 0);
  const earningsNumerator = finiteInteger(candidate.earningsNumerator, 0);
  if (!activeMs && !earningsNumerator) return null;
  return {
    id: String(candidate.id || makeId("segment")),
    bookId: candidate.bookId == null ? null : String(candidate.bookId),
    activeMs,
    earningsNumerator,
    rateCents: candidate.rateCents == null ? null : finiteInteger(candidate.rateCents, 0, 0, 999_999),
    adjustment: Boolean(candidate.adjustment),
  };
}

export function normaliseSession(candidate, defaultRate = 200) {
  if (!candidate || typeof candidate !== "object" || !["running", "paused"].includes(candidate.status)) return null;
  const activeMs = finiteInteger(candidate.activeMs, 0);
  const earningsNumerator = finiteInteger(candidate.earningsNumerator, 0);
  const rateCents = finiteInteger(candidate.rateCents, defaultRate, 0, 999_999);
  const createdAt = finiteInteger(candidate.createdAt, Date.now(), 0);
  const segments = Array.isArray(candidate.segments) ? candidate.segments.map(normaliseSegment).filter(Boolean) : [];
  if (!segments.length && (activeMs || earningsNumerator)) {
    segments.push({
      id: makeId("segment"),
      bookId: null,
      activeMs,
      earningsNumerator,
      rateCents: null,
      adjustment: false,
    });
  }
  const hasValidTimestamp = Number.isSafeInteger(Number(candidate.runningSince));
  const status = candidate.status === "running" && !hasValidTimestamp ? "paused" : candidate.status;
  return {
    id: String(candidate.id || makeId("session")),
    status,
    createdAt,
    activeMs,
    earningsNumerator,
    rateCents,
    runningSince: status === "running" ? finiteInteger(candidate.runningSince, Date.now(), 0) : null,
    selectedBookId: candidate.selectedBookId == null ? null : String(candidate.selectedBookId),
    segments,
    adjustments: Array.isArray(candidate.adjustments) ? candidate.adjustments.slice(-100).map((item) => ({
      id: String(item?.id || makeId("adjustment")),
      bookId: item?.bookId == null ? null : String(item.bookId),
      deltaMs: Math.trunc(Number(item?.deltaMs) || 0),
      createdAt: finiteInteger(item?.createdAt, Date.now(), 0),
    })) : [],
  };
}

function normaliseBook(candidate) {
  if (!candidate || typeof candidate !== "object" || !String(candidate.title || "").trim()) return null;
  const totalPages = candidate.totalPages == null || candidate.totalPages === "" ? null : finiteInteger(candidate.totalPages, 0, 1, 1_000_000);
  let currentPage = candidate.currentPage == null || candidate.currentPage === "" ? 0 : finiteInteger(candidate.currentPage, 0, 0, 1_000_000);
  if (totalPages != null) currentPage = Math.min(currentPage, totalPages);
  return {
    id: String(candidate.id || makeId("book")),
    title: String(candidate.title).trim().slice(0, 180),
    author: String(candidate.author || "").trim().slice(0, 180),
    totalPages,
    currentPage,
    status: candidate.status === "finished" ? "finished" : "reading",
    coverId: candidate.coverId ? String(candidate.coverId) : null,
    totalActiveMs: finiteInteger(candidate.totalActiveMs, 0),
    totalEarningsNumerator: finiteInteger(candidate.totalEarningsNumerator, 0),
    createdAt: finiteInteger(candidate.createdAt, Date.now(), 0),
    updatedAt: finiteInteger(candidate.updatedAt, Date.now(), 0),
  };
}

function normaliseGoal(candidate) {
  if (!candidate || typeof candidate !== "object" || !String(candidate.name || "").trim()) return null;
  const targetCents = finiteInteger(candidate.targetCents, 0, 1, 100_000_000);
  if (!targetCents) return null;
  return {
    id: String(candidate.id || makeId("goal")),
    name: String(candidate.name).trim().slice(0, 100),
    targetCents,
    celebrated: Boolean(candidate.celebrated),
    createdAt: finiteInteger(candidate.createdAt, Date.now(), 0),
  };
}

function normalisePendingStop(candidate, defaultRate) {
  if (!candidate || typeof candidate !== "object") return null;
  const sessionSnapshot = normaliseSession(candidate.sessionSnapshot, defaultRate);
  if (!sessionSnapshot) return null;
  sessionSnapshot.status = "paused";
  sessionSnapshot.runningSince = null;
  return {
    id: String(candidate.id || makeId("stop")),
    sessionSnapshot,
    creditedNumerator: finiteInteger(candidate.creditedNumerator, sessionSnapshot.earningsNumerator),
    stoppedAt: finiteInteger(candidate.stoppedAt, Date.now(), 0),
    bookDeltas: Array.isArray(candidate.bookDeltas) ? candidate.bookDeltas.map((delta) => ({
      bookId: String(delta?.bookId || ""),
      activeMs: finiteInteger(delta?.activeMs, 0),
      earningsNumerator: finiteInteger(delta?.earningsNumerator, 0),
    })).filter((delta) => delta.bookId) : [],
  };
}

export function normalise(candidate) {
  const base = defaultState();
  if (!candidate || typeof candidate !== "object") return base;
  const rateCents = finiteInteger(candidate.settings?.rateCents, base.settings.rateCents, 0, 999_999);
  const reminderCandidate = candidate.settings?.reminder || {};
  const days = Array.isArray(reminderCandidate.days)
    ? [...new Set(reminderCandidate.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : base.settings.reminder.days;
  const books = Array.isArray(candidate.books) ? candidate.books.map(normaliseBook).filter(Boolean) : [];
  const bookIds = new Set(books.map((book) => book.id));
  const session = normaliseSession(candidate.session, rateCents);
  if (session && session.selectedBookId && !bookIds.has(session.selectedBookId)) session.selectedBookId = null;
  return {
    schema: APP_SCHEMA,
    balanceNumerator: finiteInteger(candidate.balanceNumerator, 0),
    settings: {
      rateCents,
      hapticsEnabled: candidate.settings?.hapticsEnabled !== false,
      wakeLockEnabled: Boolean(candidate.settings?.wakeLockEnabled),
      reminder: {
        enabled: Boolean(reminderCandidate.enabled),
        time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(reminderCandidate.time || "")) ? String(reminderCandidate.time) : base.settings.reminder.time,
        days: days.length ? days : base.settings.reminder.days,
        lastNotifiedDate: typeof reminderCandidate.lastNotifiedDate === "string" ? reminderCandidate.lastNotifiedDate : null,
      },
    },
    preferences: { installGuideDismissed: Boolean(candidate.preferences?.installGuideDismissed) },
    books,
    goal: normaliseGoal(candidate.goal),
    session,
    pendingStop: normalisePendingStop(candidate.pendingStop, rateCents),
  };
}

function appendSegment(session, bookId, activeMs, earningsNumerator, rateCents, adjustment = false) {
  if (!activeMs && !earningsNumerator) return;
  const normalizedBookId = bookId == null ? null : String(bookId);
  const previous = session.segments.at(-1);
  if (previous && previous.bookId === normalizedBookId && previous.rateCents === rateCents && previous.adjustment === adjustment) {
    previous.activeMs += activeMs;
    previous.earningsNumerator += earningsNumerator;
    return;
  }
  session.segments.push({ id: makeId("segment"), bookId: normalizedBookId, activeMs, earningsNumerator, rateCents, adjustment });
}

export function settleRunning(session, timestamp = Date.now()) {
  if (!session || session.status !== "running") return 0;
  const elapsedMs = Math.max(0, finiteInteger(timestamp, session.runningSince, 0) - session.runningSince);
  if (!elapsedMs) return 0;
  const timeCapacity = Number.MAX_SAFE_INTEGER - session.activeMs;
  const earningsCapacity = session.rateCents > 0 ? Math.floor((Number.MAX_SAFE_INTEGER - session.earningsNumerator) / session.rateCents) : Number.MAX_SAFE_INTEGER;
  const acceptedMs = Math.min(elapsedMs, timeCapacity, earningsCapacity);
  if (acceptedMs <= 0) {
    session.status = "paused";
    session.runningSince = null;
    return 0;
  }
  const earned = acceptedMs * session.rateCents;
  session.activeMs += acceptedMs;
  session.earningsNumerator += earned;
  appendSegment(session, session.selectedBookId, acceptedMs, earned, session.rateCents);
  if (acceptedMs < elapsedMs) {
    session.status = "paused";
    session.runningSince = null;
  } else {
    session.runningSince = timestamp;
  }
  return acceptedMs;
}

export function liveSession(session, timestamp = Date.now()) {
  if (!session) return { activeMs: 0, earningsNumerator: 0, segments: [] };
  const copy = clone(session);
  settleRunning(copy, timestamp);
  return copy;
}

export function startSession(state, bookId = null, timestamp = Date.now()) {
  if (state.session) return state.session;
  state.pendingStop = null;
  state.session = {
    id: makeId("session"), status: "running", createdAt: timestamp, activeMs: 0, earningsNumerator: 0,
    rateCents: state.settings.rateCents, runningSince: timestamp, selectedBookId: bookId, segments: [], adjustments: [],
  };
  return state.session;
}

export function pauseSession(state, timestamp = Date.now()) {
  if (state.session?.status !== "running") return false;
  settleRunning(state.session, timestamp);
  state.session.status = "paused";
  state.session.runningSince = null;
  return true;
}

export function continueSession(state, timestamp = Date.now()) {
  if (state.session?.status !== "paused") return false;
  state.session.status = "running";
  state.session.runningSince = timestamp;
  return true;
}

export function changeSessionBook(state, bookId = null, timestamp = Date.now()) {
  if (!state.session) return false;
  settleRunning(state.session, timestamp);
  state.session.selectedBookId = bookId == null ? null : String(bookId);
  return true;
}

function removeAttributedTime(session, bookId, milliseconds) {
  let remaining = milliseconds;
  let removedEarnings = 0;
  for (let index = session.segments.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const segment = session.segments[index];
    if (segment.bookId !== bookId || segment.activeMs <= 0) continue;
    const taken = Math.min(remaining, segment.activeMs);
    const earningsTaken = taken === segment.activeMs
      ? segment.earningsNumerator
      : Math.round((segment.earningsNumerator * taken) / segment.activeMs);
    segment.activeMs -= taken;
    segment.earningsNumerator = Math.max(0, segment.earningsNumerator - earningsTaken);
    remaining -= taken;
    removedEarnings += earningsTaken;
    if (!segment.activeMs && !segment.earningsNumerator) session.segments.splice(index, 1);
  }
  return { removedMs: milliseconds - remaining, removedEarnings };
}

export function attributedTime(session, bookId = null) {
  if (!session) return 0;
  return session.segments.filter((segment) => segment.bookId === bookId).reduce((total, segment) => total + segment.activeMs, 0);
}

export function adjustSessionTime(state, { direction, milliseconds, bookId = null, timestamp = Date.now() }) {
  const session = state.session;
  if (!session || session.status !== "paused") throw new Error("The session must be paused before adjusting time.");
  const amount = finiteInteger(milliseconds, 0, 1);
  if (!amount) throw new Error("Enter a time adjustment greater than zero.");
  const normalizedBookId = bookId == null ? null : String(bookId);
  let deltaMs;
  if (direction === "add") {
    if (amount > Number.MAX_SAFE_INTEGER - session.activeMs) throw new Error("That adjustment is too large to store safely.");
    const earned = amount * session.rateCents;
    if (!Number.isSafeInteger(earned) || earned > Number.MAX_SAFE_INTEGER - session.earningsNumerator) throw new Error("That adjustment is too large to store safely.");
    session.activeMs += amount;
    session.earningsNumerator += earned;
    appendSegment(session, normalizedBookId, amount, earned, session.rateCents, true);
    deltaMs = amount;
  } else if (direction === "remove") {
    if (attributedTime(session, normalizedBookId) < amount) throw new Error("That part of the session does not contain enough time to remove.");
    const removed = removeAttributedTime(session, normalizedBookId, amount);
    session.activeMs = Math.max(0, session.activeMs - removed.removedMs);
    session.earningsNumerator = Math.max(0, session.earningsNumerator - removed.removedEarnings);
    deltaMs = -removed.removedMs;
  } else {
    throw new Error("Choose whether to add or remove time.");
  }
  session.adjustments.push({ id: makeId("adjustment"), bookId: normalizedBookId, deltaMs, createdAt: timestamp });
  return session;
}

function groupBookDeltas(session, existingBookIds) {
  const grouped = new Map();
  for (const segment of session.segments) {
    if (!segment.bookId || !existingBookIds.has(segment.bookId)) continue;
    const current = grouped.get(segment.bookId) || { bookId: segment.bookId, activeMs: 0, earningsNumerator: 0 };
    current.activeMs += segment.activeMs;
    current.earningsNumerator += segment.earningsNumerator;
    grouped.set(segment.bookId, current);
  }
  return [...grouped.values()];
}

export function stopSession(state, timestamp = Date.now()) {
  if (!state.session || state.pendingStop) return null;
  settleRunning(state.session, timestamp);
  state.session.status = "paused";
  state.session.runningSince = null;
  const snapshot = clone(state.session);
  const existingBookIds = new Set(state.books.map((book) => book.id));
  const bookDeltas = groupBookDeltas(snapshot, existingBookIds);
  if (snapshot.earningsNumerator > Number.MAX_SAFE_INTEGER - state.balanceNumerator) throw new Error("Your balance is too large to add this session safely. Reset the balance before stopping.");
  for (const delta of bookDeltas) {
    const book = state.books.find((item) => item.id === delta.bookId);
    if (book && (delta.activeMs > Number.MAX_SAFE_INTEGER - book.totalActiveMs || delta.earningsNumerator > Number.MAX_SAFE_INTEGER - book.totalEarningsNumerator)) {
      throw new Error("This book's stored totals are too large to add the session safely.");
    }
  }
  for (const delta of bookDeltas) {
    const book = state.books.find((item) => item.id === delta.bookId);
    if (!book) continue;
    book.totalActiveMs += delta.activeMs;
    book.totalEarningsNumerator += delta.earningsNumerator;
    book.updatedAt = timestamp;
  }
  state.balanceNumerator += snapshot.earningsNumerator;
  state.pendingStop = {
    id: makeId("stop"), sessionSnapshot: snapshot, creditedNumerator: snapshot.earningsNumerator, bookDeltas, stoppedAt: timestamp,
  };
  state.session = null;
  return state.pendingStop;
}

export function undoStop(state) {
  const pending = state.pendingStop;
  if (!pending || state.session) return null;
  state.balanceNumerator = Math.max(0, state.balanceNumerator - pending.creditedNumerator);
  for (const delta of pending.bookDeltas) {
    const book = state.books.find((item) => item.id === delta.bookId);
    if (!book) continue;
    book.totalActiveMs = Math.max(0, book.totalActiveMs - delta.activeMs);
    book.totalEarningsNumerator = Math.max(0, book.totalEarningsNumerator - delta.earningsNumerator);
  }
  state.session = normaliseSession(pending.sessionSnapshot, state.settings.rateCents);
  state.session.status = "paused";
  state.session.runningSince = null;
  state.pendingStop = null;
  if (state.goal && state.balanceNumerator < state.goal.targetCents * RATE_DENOMINATOR) state.goal.celebrated = false;
  return state.session;
}

export function finalizeStop(state) {
  state.pendingStop = null;
}

export function sessionAttribution(session, timestamp = Date.now()) {
  const live = liveSession(session, timestamp);
  const grouped = new Map();
  for (const segment of live.segments) {
    const key = segment.bookId ?? "__unassigned__";
    const current = grouped.get(key) || { bookId: segment.bookId, activeMs: 0, earningsNumerator: 0 };
    current.activeMs += segment.activeMs;
    current.earningsNumerator += segment.earningsNumerator;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

export function formatDuration(milliseconds, includeSeconds = true) {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  const parts = [hours, minutes];
  if (includeSeconds) parts.push(remaining);
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatMoney(numerator) {
  const dollars = Math.max(0, numerator) / (RATE_DENOMINATOR * 100);
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(dollars);
}

export function durationPhrase(milliseconds) {
  const totalMinutes = Math.round(Math.max(0, milliseconds) / 60_000);
  if (totalMinutes < 1) return "You read for less than a minute.";
  if (totalMinutes < 60) return `You read for ${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}.`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `You read for ${hours} hour${hours === 1 ? "" : "s"}${minutes ? ` and ${minutes} minute${minutes === 1 ? "" : "s"}` : ""}.`;
}
