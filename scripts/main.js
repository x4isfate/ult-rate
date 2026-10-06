/**
 * ULT's Session Rating — entry point and hook wiring.
 *
 *   init    settings and the "open" menu button are registered
 *   ready   the socket is wired; a GM loads the private store; every client
 *           looks at the open round (a player who reloads mid-round gets the
 *           window back)
 *   getSceneControlButtons / renderSceneControls
 *           one button in the left toolbar: the hub for the GM, the rating
 *           window for players (pulsing while there is something to rate)
 *
 * The open round is public state in a world setting; its change event is what
 * makes windows appear and disappear on every client (`syncRound`). Votes go
 * through net.js to the GM and never through settings.
 */

import {
  MODULE_ID,
  bus,
  loc,
  fmt,
  registerSettings,
  getActiveRound
} from "./settings.js";
import { initStore, onJournalChanged } from "./store.js";
import { registerSocket } from "./net.js";
import { RateHub } from "./hub.js";
import { RateWindow } from "./rate-window.js";

const TOOL = "ultRate";

/** The round id this client already opened its window for, so a later vote does not pop it up again. */
let shownFor = null;
/** Was there a round open the last time `syncRound` ran? Lets us notice the close. */
let hadRound = false;

function isParticipant(round) {
  return Boolean(round?.participants?.some((p) => p.id === game.user.id));
}

function hasVoted(round) {
  return Boolean(round?.voted?.includes(game.user.id));
}

/* -------------------------------------------------------------------------- */
/*  Toolbar                                                                   */
/* -------------------------------------------------------------------------- */

function openFromToolbar() {
  if (game.user.isGM) {
    RateHub.open();
    return;
  }
  const round = getActiveRound();
  if (!round) {
    ui.notifications?.info(loc("ULTRATE.Notify.NoRound"));
    return;
  }
  if (!isParticipant(round)) {
    ui.notifications?.info(loc("ULTRATE.Notify.NotIn"));
    return;
  }
  RateWindow.open(round);
}

function registerToolboxButton(controls) {
  if (!controls || typeof controls !== "object") return;

  const group =
    controls.tokens ??
    controls.token ??
    Object.values(controls).find((g) => g?.name === "tokens" || g?.name === "token");
  if (!group) return;

  group.tools ??= {};
  group.tools[TOOL] = {
    name: TOOL,
    title: loc(game.user?.isGM ? "ULTRATE.Toolbox.Hub" : "ULTRATE.Toolbox.Rate"),
    icon: "fa-solid fa-star",
    order: Object.keys(group.tools).length + 1,
    button: true,
    visible: true,
    onChange: () => openFromToolbar()
  };
}

/** Make the button pulse when this player has a round to answer. */
function markToolbar(html) {
  try {
    const root = html instanceof HTMLElement ? html : html?.[0] ?? document;
    const button = root.querySelector?.(`[data-tool="${TOOL}"]`) ?? document.querySelector(`[data-tool="${TOOL}"]`);
    if (!button) return;
    const round = getActiveRound();
    const pending = Boolean(round) && isParticipant(round) && !hasVoted(round);
    button.classList.toggle("ultrate-pending", pending);
  } catch (err) {
    /* purely cosmetic */
  }
}

function refreshToolbar() {
  try {
    ui.controls?.render?.({ force: true });
  } catch (err) {
    /* purely cosmetic */
  }
}

/* -------------------------------------------------------------------------- */
/*  Following the open round                                                  */
/* -------------------------------------------------------------------------- */

function syncRound({ initial = false } = {}) {
  const round = getActiveRound();
  refreshToolbar();

  if (!round) {
    const open = RateWindow.current;
    if (open && hadRound) {
      ui.notifications?.info(loc("ULTRATE.Notify.RoundEnded"));
      open.close();
    }
    hadRound = false;
    shownFor = null;
    return;
  }
  hadRound = true;

  if (!isParticipant(round)) return;
  RateWindow.current?.refresh(round);

  if (shownFor === round.id) return;
  shownFor = round.id;
  if (hasVoted(round)) return;

  if (!initial && !game.user.isGM) {
    ui.notifications?.info(fmt("ULTRATE.Notify.RoundOpened", { title: round.title }));
  }
  RateWindow.open(round);
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                     */
/* -------------------------------------------------------------------------- */

Hooks.once("init", () => {
  registerSettings();

  game.settings.registerMenu(MODULE_ID, "hub", {
    name: "ULTRATE.Hub.MenuName",
    label: "ULTRATE.Hub.MenuLabel",
    hint: "ULTRATE.Hub.MenuHint",
    icon: "fa-solid fa-star",
    type: RateHub,
    restricted: true
  });
});

Hooks.once("ready", () => {
  if (game.user.isGM) initStore();
  registerSocket();

  bus.addEventListener("round", () => syncRound());
  bus.addEventListener("remind", () => {
    const round = getActiveRound();
    if (round && isParticipant(round) && !hasVoted(round)) RateWindow.open(round);
  });

  const mod = game.modules?.get?.(MODULE_ID);
  if (mod) {
    mod.api = {
      /** Open the hub (GM) or the rating window (players, while a round is open). */
      open: () => openFromToolbar(),
      /** Names the ULT module hub calls from a tile's "Settings" button. */
      openHub: () => (game.user.isGM ? RateHub.open() : openFromToolbar()),
      openSettings: () => (game.user.isGM ? RateHub.open("settings") : openFromToolbar()),
      /** The public state of the open round, or null. */
      get round() {
        return getActiveRound();
      }
    };
  }

  syncRound({ initial: true });
});

Hooks.on("getSceneControlButtons", (controls) => {
  try {
    registerToolboxButton(controls);
  } catch (err) {
    console.warn(`${MODULE_ID} | could not register the toolbar button`, err);
  }
});

Hooks.on("renderSceneControls", (app, html) => markToolbar(html));

// The private store is a journal entry; keep the GM's copy and windows current
// when it changes (another GM, or our own write coming back).
Hooks.on("updateJournalEntry", (entry) => onJournalChanged(entry));
Hooks.on("createJournalEntry", (entry) => onJournalChanged(entry));
