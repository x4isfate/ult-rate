/**
 * ULT's Session Rating — constants, settings and the small helpers that both
 * the players' window and the GM's hub share.
 *
 * Everything the module persists lives in a handful of *world* settings, all
 * `config: false` (nothing appears in Foundry's own settings list except one
 * menu button that opens the hub):
 *
 *   categories   the GM's edits to the five criteria (names, descriptions)
 *   appearance   colours
 *   defaults     what a new round starts with (anonymous, notes, editing)
 *   activeRound  the PUBLIC state of the round that is open right now
 *   fallbackStore  only used if the private data document cannot be created
 *
 * The votes themselves are not stored here. World settings are sent to every
 * client, so a curious player could read other people's votes out of them.
 * store.js keeps votes in a GM-only journal document instead.
 */

export const MODULE_ID = "ult-rate";
export const SOCKET = `module.${MODULE_ID}`;
export const GITHUB_URL = "https://github.com/x4isfate/ult-rate";

export const SCALE = { min: 1, max: 10 };

/** The five criteria, in display order. The last one is drawn as the wide bar. */
export const CATEGORY_IDS = ["acting", "story", "audiovisual", "tech", "vibe"];
export const WIDE_CATEGORY = "vibe";

export const LIMITS = { title: 80, system: 60, note: 800, catName: 40, catDesc: 320, catAlso: 200 };

export const DEFAULT_APPEARANCE = {
  colBg: "#151a20",
  colBg2: "#0b0e12",
  colBorder: "#3d5a75",
  colText: "#e4eaf0",
  colAccent: "#5b87ab",
  colAccentText: "#8fa8c2",
  colGlow: "#456379",
  colLow: "#d97a6a",
  colHigh: "#7bbf8f",
  valueColors: true
};

export const COLOR_KEYS = Object.keys(DEFAULT_APPEARANCE).filter((k) => k !== "valueColors");

export const DEFAULT_OPTIONS = { anonymous: true, notes: true, allowEdit: true };

/** Tiny event bus: settings changes, store changes and round changes fan out to open windows. */
export const bus = new EventTarget();

function emit(name) {
  bus.dispatchEvent(new CustomEvent(name));
}

export function loc(key) {
  return game.i18n.localize(key);
}

export function fmt(key, data) {
  return game.i18n.format(key, data);
}

function parseJSON(text, fallback) {
  if (typeof text !== "string" || !text.trim()) return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch (err) {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/*  Registration                                                              */
/* -------------------------------------------------------------------------- */

export function registerSettings() {
  const world = (key, def, event) =>
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: false,
      type: String,
      default: def,
      onChange: () => event && emit(event)
    });

  world("categories", "{}", "categories");
  world("appearance", "{}", "appearance");
  world("defaults", "{}", "defaults");
  world("activeRound", "", "round");
  world("fallbackStore", "", "store");

  // Client scope: this browser's own memory of what it voted, so an edit can
  // start from the previous values. Never shared.
  game.settings.register(MODULE_ID, "myVotes", {
    scope: "client",
    config: false,
    type: String,
    default: "{}"
  });
}

function read(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (err) {
    return undefined;
  }
}

export async function writeSetting(key, value) {
  try {
    return await game.settings.set(MODULE_ID, key, value);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not save setting`, key, err);
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/*  Appearance                                                                */
/* -------------------------------------------------------------------------- */

const HEX = /^#[0-9a-f]{6}$/i;

export function getAppearance() {
  const stored = parseJSON(read("appearance"), {});
  const out = { ...DEFAULT_APPEARANCE };
  for (const key of COLOR_KEYS) {
    if (typeof stored[key] === "string" && HEX.test(stored[key])) out[key] = stored[key].toLowerCase();
  }
  if (typeof stored.valueColors === "boolean") out.valueColors = stored.valueColors;
  return out;
}

export function saveAppearance(values) {
  return writeSetting("appearance", JSON.stringify(values));
}

/** Paint the theme onto an element (the window itself, so the chrome matches too). */
export function applyAppearance(node, appearance = getAppearance()) {
  if (!node) return;
  const map = {
    "--ur-bg": appearance.colBg,
    "--ur-bg2": appearance.colBg2,
    "--ur-border": appearance.colBorder,
    "--ur-text": appearance.colText,
    "--ur-accent": appearance.colAccent,
    "--ur-accent-text": appearance.colAccentText,
    "--ur-glow": appearance.colGlow,
    "--ur-low": appearance.colLow,
    "--ur-high": appearance.colHigh
  };
  for (const [name, value] of Object.entries(map)) node.style.setProperty(name, value);
  node.dataset.valuecolors = String(Boolean(appearance.valueColors));
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  const c = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${c(r1, r2)}, ${c(g1, g2)}, ${c(b1, b2)})`;
}

/** Colour of a slider fill at position t (0..1): low, through the accent, to high. */
export function valueColor(t, appearance = getAppearance()) {
  if (!appearance.valueColors) return appearance.colAccent;
  if (t < 0.5) return mix(appearance.colLow, appearance.colAccent, t * 2);
  return mix(appearance.colAccent, appearance.colHigh, (t - 0.5) * 2);
}

/* -------------------------------------------------------------------------- */
/*  Round defaults                                                            */
/* -------------------------------------------------------------------------- */

export function getDefaults() {
  const stored = parseJSON(read("defaults"), {});
  const out = { ...DEFAULT_OPTIONS };
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (typeof stored[key] === "boolean") out[key] = stored[key];
  }
  return out;
}

export function saveDefaults(values) {
  return writeSetting("defaults", JSON.stringify(values));
}

/* -------------------------------------------------------------------------- */
/*  Categories                                                                */
/* -------------------------------------------------------------------------- */

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** The GM's edits only: an empty field means "use the recommended text". */
export function getCategoryOverrides() {
  const stored = parseJSON(read("categories"), {});
  return CATEGORY_IDS.map((id) => {
    const c = stored?.[id] ?? {};
    return {
      id,
      name: clean(c.name, LIMITS.catName),
      desc: clean(c.desc, LIMITS.catDesc),
      also: clean(c.also, LIMITS.catAlso)
    };
  });
}

export function saveCategoryOverrides(list) {
  const out = {};
  for (const c of list) {
    if (c.name || c.desc || c.also) out[c.id] = { name: c.name, desc: c.desc, also: c.also };
  }
  return writeSetting("categories", JSON.stringify(out));
}

function splitAlso(text) {
  return String(text ?? "")
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Turn a snapshot of overrides into displayable categories. A round stores only
 * the overrides, so anything the GM did not customise is translated on each
 * player's own client, in that player's language.
 */
export function resolveCategories(snapshot = getCategoryOverrides()) {
  const byId = new Map((Array.isArray(snapshot) ? snapshot : []).map((c) => [c.id, c]));
  return CATEGORY_IDS.map((id) => {
    const c = byId.get(id) ?? {};
    const key = `ULTRATE.Cat.${id}`;
    return {
      id,
      wide: id === WIDE_CATEGORY,
      name: clean(c.name, LIMITS.catName) || loc(`${key}.Name`),
      desc: clean(c.desc, LIMITS.catDesc) || loc(`${key}.Desc`),
      also: splitAlso(clean(c.also, LIMITS.catAlso) || loc(`${key}.Also`))
    };
  });
}

/* -------------------------------------------------------------------------- */
/*  The open round (public state)                                             */
/* -------------------------------------------------------------------------- */

/**
 * {id, title, date, system, anonymous, notes, allowEdit, cats, gmName,
 *  participants:[{id,name}], voted:[userId], openedAt} or null.
 * Never contains scores or notes.
 */
export function getActiveRound() {
  const round = parseJSON(read("activeRound"), null);
  if (!round || typeof round !== "object" || !round.id) return null;
  round.participants = Array.isArray(round.participants) ? round.participants : [];
  round.voted = Array.isArray(round.voted) ? round.voted : [];
  return round;
}

export function saveActiveRound(round) {
  return writeSetting("activeRound", round ? JSON.stringify(round) : "");
}

export function getRawStoreFallback() {
  return read("fallbackStore") ?? "";
}

export function saveRawStoreFallback(text) {
  return writeSetting("fallbackStore", text);
}

/* -------------------------------------------------------------------------- */
/*  This browser's memory of its own vote                                     */
/* -------------------------------------------------------------------------- */

const MY_VOTES_KEEP = 12;

export function getMyVote(roundId) {
  const all = parseJSON(read("myVotes"), {});
  return all?.[roundId] ?? null;
}

export function saveMyVote(roundId, data) {
  const all = parseJSON(read("myVotes"), {});
  delete all[roundId];
  all[roundId] = data;
  const ids = Object.keys(all);
  for (const id of ids.slice(0, Math.max(0, ids.length - MY_VOTES_KEEP))) delete all[id];
  return writeSetting("myVotes", JSON.stringify(all));
}

/* -------------------------------------------------------------------------- */
/*  Misc helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Is this client the GM that should answer socket requests? */
export function isResponsibleGM() {
  if (!game.user?.isGM) return false;
  const active = game.users?.activeGM;
  if (active) return active.id === game.user.id;
  const gms = (game.users?.filter?.((u) => u.isGM && u.active) ?? []).map((u) => u.id).sort();
  return gms[0] === game.user.id;
}

export function currentSystemTitle() {
  try {
    return String(game.system?.title ?? game.system?.id ?? "").trim();
  } catch (err) {
    return "";
  }
}

export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(iso);
  try {
    return date.toLocaleDateString(game.i18n?.lang || undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch (err) {
    return String(iso);
  }
}

/** Day and month only, for chart axes where the year is just noise. */
export function formatDateShort(iso) {
  if (!iso) return "";
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return String(iso);
  try {
    return date.toLocaleDateString(game.i18n?.lang || undefined, { day: "numeric", month: "short" });
  } catch (err) {
    return String(iso);
  }
}

export function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "–";
  return (Math.round(value * 10) / 10).toLocaleString(game.i18n?.lang || undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  });
}
