/**
 * ULT's Session Rating — the GM's private data and every operation on it.
 *
 * Two pieces of state exist, on purpose:
 *
 *   public   the open round (settings.js, `activeRound`): title, date, who may
 *            vote, who already did. Every client reads it. It never holds scores.
 *   private  the sessions with their votes. A world setting would be sent to
 *            every player's browser, so the votes live in a JournalEntry whose
 *            default ownership is NONE: the server never hands it to players.
 *            If that document cannot be created, a world setting is used as a
 *            fallback and a warning is logged.
 *
 * Only a GM client ever touches the private store. Players send their vote over
 * the socket, addressed to the GM(s) only, and the GM writes it.
 *
 * Anonymous rounds: the entry has no user id and no timestamp, entries are kept
 * sorted by a random id (not by time) and the list of who voted follows the
 * participant order — so nothing in the stored data can be lined up with a
 * person. Results of an open anonymous round are also not shown until it is closed.
 */

import {
  MODULE_ID,
  CATEGORY_IDS,
  SCALE,
  LIMITS,
  bus,
  getActiveRound,
  saveActiveRound,
  getCategoryOverrides,
  getRawStoreFallback,
  saveRawStoreFallback
} from "./settings.js";

let cache = { sessions: [] };
let storeDoc = null;
let warnedFallback = false;
let queue = Promise.resolve();

/** Run `fn` after everything queued before it, so read-modify-write cycles never interleave. */
export function enqueue(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/* -------------------------------------------------------------------------- */
/*  Persistence                                                               */
/* -------------------------------------------------------------------------- */

function normalize(raw) {
  let data = null;
  try {
    data = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : null;
  } catch (err) {
    data = null;
  }
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  return {
    sessions: sessions.filter((s) => s && typeof s === "object" && s.id).map((s) => ({ ...s, entries: Array.isArray(s.entries) ? s.entries : [] }))
  };
}

export function findStoreDoc() {
  try {
    return game.journal?.find?.((j) => j.getFlag?.(MODULE_ID, "isStore")) ?? null;
  } catch (err) {
    return null;
  }
}

/** Load the private store into memory. GM only; harmless to call again. */
export function initStore() {
  if (!game.user?.isGM) return;
  storeDoc = findStoreDoc();
  const raw = storeDoc ? storeDoc.getFlag(MODULE_ID, "data") : getRawStoreFallback();
  cache = normalize(raw);
}

/** A journal changed; if it is ours, re-read and tell the windows. */
export function onJournalChanged(entry) {
  if (!game.user?.isGM) return;
  if (!entry?.getFlag?.(MODULE_ID, "isStore")) return;
  initStore();
  bus.dispatchEvent(new CustomEvent("store"));
}

async function writeStore() {
  const text = JSON.stringify(cache);
  try {
    if (!storeDoc) storeDoc = findStoreDoc();
    if (storeDoc) {
      await storeDoc.update({ [`flags.${MODULE_ID}.data`]: text });
    } else {
      storeDoc = await JournalEntry.create({
        name: "ULT's Session Rating — data (do not delete)",
        ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE },
        flags: { [MODULE_ID]: { isStore: true, data: text } }
      });
    }
    if (getRawStoreFallback()) await saveRawStoreFallback("");
  } catch (err) {
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(`${MODULE_ID} | could not use a private journal for the votes; falling back to a world setting`, err);
    }
    await saveRawStoreFallback(text);
  }
}

export function getSessions() {
  return cache.sessions;
}

export function getSession(id) {
  return cache.sessions.find((s) => s.id === id) ?? null;
}

/* -------------------------------------------------------------------------- */
/*  Summaries                                                                 */
/* -------------------------------------------------------------------------- */

/** Averages per category and overall. `null` where there are no votes. */
export function summarize(session) {
  const entries = session?.entries ?? [];
  const avg = {};
  for (const id of CATEGORY_IDS) {
    const values = entries.map((e) => Number(e.scores?.[id])).filter((n) => Number.isFinite(n));
    avg[id] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  }
  const present = Object.values(avg).filter((n) => n !== null);
  const overall = present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
  return { count: entries.length, avg, overall };
}

/** Finished sessions, oldest first (by the date the GM typed, then by when it was opened). */
export function closedSessions() {
  return cache.sessions
    .filter((s) => s.closedAt)
    .slice()
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) || (a.openedAt ?? 0) - (b.openedAt ?? 0));
}

/** "Session N" for the next round, counting the ones that already exist. */
export function nextSessionNumber() {
  return cache.sessions.length + 1;
}

/* -------------------------------------------------------------------------- */
/*  Round lifecycle (GM)                                                      */
/* -------------------------------------------------------------------------- */

function makeId() {
  return foundry.utils.randomID(16);
}

function cleanText(value, max) {
  return typeof value === "string" ? value.replace(/\s+\n/g, "\n").trim().slice(0, max) : "";
}

export function startRound(opts) {
  return enqueue(async () => {
    if (!game.user?.isGM) throw new Error("GM only");
    if (getActiveRound()) throw new Error("A round is already open");

    const participants = (opts.participants ?? []).map((p) => ({ id: String(p.id), name: String(p.name ?? "") }));
    if (participants.length === 0) throw new Error("No participants");

    const round = {
      id: makeId(),
      title: cleanText(opts.title, LIMITS.title) || "—",
      date: /^\d{4}-\d{2}-\d{2}$/.test(opts.date ?? "") ? opts.date : "",
      system: cleanText(opts.system, LIMITS.system),
      anonymous: Boolean(opts.anonymous),
      notes: Boolean(opts.notes),
      allowEdit: Boolean(opts.allowEdit),
      cats: getCategoryOverrides(),
      gmName: game.user.name,
      participants,
      voted: [],
      openedAt: Date.now()
    };

    cache.sessions.push({ ...round, voted: undefined, closedAt: null, entries: [] });
    await writeStore();
    await saveActiveRound(round);
    return round;
  });
}

export function closeRound() {
  return enqueue(async () => {
    const round = getActiveRound();
    if (!round) return null;
    const session = getSession(round.id);
    if (session) {
      session.closedAt = Date.now();
      session.allowEdit = round.allowEdit;
      await writeStore();
    }
    await saveActiveRound(null);
    return round.id;
  });
}

/** Throw the open round away, including any votes already cast in it. */
export function cancelRound() {
  return enqueue(async () => {
    const round = getActiveRound();
    if (!round) return;
    cache.sessions = cache.sessions.filter((s) => s.id !== round.id);
    await writeStore();
    await saveActiveRound(null);
  });
}

export function setAllowEdit(value) {
  return enqueue(async () => {
    const round = getActiveRound();
    if (!round) return;
    round.allowEdit = Boolean(value);
    await saveActiveRound(round);
  });
}

export function deleteSession(id) {
  return enqueue(async () => {
    if (getActiveRound()?.id === id) return;
    cache.sessions = cache.sessions.filter((s) => s.id !== id);
    await writeStore();
  });
}

export function clearHistory() {
  return enqueue(async () => {
    const openId = getActiveRound()?.id;
    cache.sessions = cache.sessions.filter((s) => s.id === openId);
    await writeStore();
  });
}

/* -------------------------------------------------------------------------- */
/*  Receiving a vote (GM)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Validate and store one vote. Returns `{ ok, reason?, token? }`; `token` is
 * only set for the first vote of an anonymous round, and is what lets that
 * player edit the same entry later without the GM ever learning which is theirs.
 */
export function handleSubmit(msg) {
  return enqueue(async () => {
    const round = getActiveRound();
    if (!round || round.id !== msg?.roundId) return { ok: false, reason: "closed" };

    const userId = String(msg.userId ?? "");
    if (!round.participants.some((p) => p.id === userId)) return { ok: false, reason: "forbidden" };

    const scores = {};
    for (const id of CATEGORY_IDS) {
      const v = Number(msg.scores?.[id]);
      if (!Number.isInteger(v) || v < SCALE.min || v > SCALE.max) return { ok: false, reason: "invalid" };
      scores[id] = v;
    }

    const session = getSession(round.id);
    if (!session) return { ok: false, reason: "closed" };

    const already = round.voted.includes(userId);
    if (already && !round.allowEdit) return { ok: false, reason: "locked" };

    let entryId;
    let token = null;
    if (round.anonymous) {
      if (already) {
        entryId = String(msg.token ?? "");
        if (!session.entries.some((e) => e.id === entryId)) return { ok: false, reason: "no-token" };
      } else {
        entryId = makeId();
        token = entryId;
      }
    } else {
      entryId = userId;
    }

    const entry = {
      id: entryId,
      userId: round.anonymous ? null : userId,
      scores,
      good: round.notes ? cleanText(msg.good, LIMITS.note) : "",
      bad: round.notes ? cleanText(msg.bad, LIMITS.note) : ""
    };
    if (!round.anonymous) entry.at = Date.now();

    const index = session.entries.findIndex((e) => e.id === entryId);
    if (index >= 0) session.entries[index] = entry;
    else session.entries.push(entry);
    if (round.anonymous) session.entries.sort((a, b) => (a.id < b.id ? -1 : 1));

    await writeStore();

    if (!already) {
      const order = round.participants.map((p) => p.id);
      round.voted = [...round.voted, userId].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      await saveActiveRound(round);
    }

    return { ok: true, token };
  });
}

/* -------------------------------------------------------------------------- */
/*  Export                                                                    */
/* -------------------------------------------------------------------------- */

export function exportPayload(sessionIds = null) {
  const sessions = cache.sessions.filter((s) => s.closedAt && (!sessionIds || sessionIds.includes(s.id)));
  return {
    module: MODULE_ID,
    kind: "session-ratings",
    exportedAt: new Date().toISOString(),
    scale: SCALE,
    sessions: sessions.map((s) => ({
      title: s.title,
      date: s.date,
      system: s.system,
      anonymous: s.anonymous,
      participants: s.anonymous ? s.participants.length : s.participants.map((p) => p.name),
      summary: summarize(s),
      entries: s.entries.map((e) => ({
        by: s.anonymous ? null : (s.participants.find((p) => p.id === e.userId)?.name ?? null),
        scores: e.scores,
        good: e.good,
        bad: e.bad
      }))
    }))
  };
}
