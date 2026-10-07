# ULT's Session Rating

Players rate the game master after a session **without leaving Foundry VTT**. Five smooth 1–10 sliders, optional notes, anonymous or named voting, a history of every session and a trend chart.

> **Version 0.5.0 — test build.**

## Install

In Foundry: **Add-on Modules → Install Module**, paste this into **Manifest URL**, and press Install:

```
https://github.com/x4isfate/ult-rate/releases/latest/download/module.json
```

After that, updates arrive through the normal **Update** button in Foundry. A step-by-step guide in Russian is in [INSTALL-RU.md](INSTALL-RU.md).

Foundry VTT v13–v14 (built and checked against v14 build 368). Languages: English, Русский, Deutsch.

## How it works

1. The GM clicks the ★ button in the token tools on the left, and the hub opens.
2. **Rating** tab: name, date and game system (filled in from the running system) of the session, then who takes part — only players connected to the world right now are listed. Start.
3. Every selected player gets the rating window at once. They set five sliders, optionally write two notes and confirm. Then they see a thank-you screen.
4. The GM watches how many have voted, can remind the others, and closes the round. **Results** and **Trend** tabs show averages, notes and the chart across sessions; a session can be exported as JSON or deleted.

### The five recommended criteria

| Criterion | What it covers |
|---|---|
| Roleplay | voices, delivery, NPC personalities |
| Encounters / Story | how gripping the story is, the situations, how scenes connect |
| Audio / Visuals | art, maps, music and sound |
| Tech prep | connection stability, how ready the table is |
| Atmosphere / Vibe *(wide bar)* | the overall mood of the evening |

Names, descriptions and the "also fits here" hints can all be edited in the hub (Settings → Criteria). Players can hover or click a criterion's name to read its description.

### Privacy model

* **Anonymous** (chosen per round): entries carry no user id and no timestamp and are stored in random order.
* While any round is open, the GM sees only how many have voted; results appear after the round is closed.
* **Named**: each rating carries the player's name.
* Votes are kept in a private journal entry ("ULT's Session Rating — data (do not delete)") with default ownership *None*, so Foundry never sends it to players. Votes reach the GM over the module socket, addressed to the GM only.
* The socket does not authenticate the sender, which is an accepted limit for a table of friends; the GM still checks that a vote comes from a listed participant of the open round.

### Colours

Defaults follow the *Idaris* theme of ULT's Loading Screen. Settings → Appearance changes the background (top and bottom), borders, text, accent, accent text, glow and the low/high score colours, with a live preview.

## Files

```
module.json
scripts/  main.js  settings.js  store.js  net.js  dom.js  rate-window.js  hub.js  chart.js
styles/   rate.css
lang/     en.json  ru.json  de.json
```

## Known limits of this test build

* Tested in a stand-in for Foundry (three simulated clients sharing a world), not yet in a real Foundry world.
* One round at a time. A closed round cannot be reopened.
* The module-hub button in the hub footer works when [ULT's Module Hub](https://github.com/x4isfate/ult-hub) is installed and active; otherwise it stays disabled. The GitHub button opens this repository.

## Bugs and feedback

<https://github.com/x4isfate/ult-rate/issues>

## License

MIT — see `LICENSE`.
