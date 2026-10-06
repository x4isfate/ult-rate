/**
 * ULT's Session Rating — the GM's hub.
 *
 * One ApplicationV2 window with a tab list down the left (same layout as the
 * ULT's Loading Screen hub) and a footer with the module signature and links:
 *
 *   rate       start a round, or watch the open one and close it
 *   results    finished sessions, with averages and the players' notes
 *   dynamics   the trend chart across sessions
 *   settings   the five criteria, colours, round defaults, data
 *
 * Plain DOM, no templates, no <form>: every control writes its setting as it
 * changes, the way Foundry's own settings sheet does.
 *
 * Results of a round that is still open are deliberately not shown — only how
 * many have voted. That keeps an anonymous round anonymous even against a GM
 * who watches the list while the votes arrive.
 */

import {
  MODULE_ID,
  GITHUB_URL,
  LIMITS,
  COLOR_KEYS,
  DEFAULT_APPEARANCE,
  bus,
  loc,
  fmt,
  applyAppearance,
  getAppearance,
  saveAppearance,
  getDefaults,
  saveDefaults,
  getCategoryOverrides,
  saveCategoryOverrides,
  resolveCategories,
  getActiveRound,
  currentSystemTitle,
  todayISO,
  formatDate,
  formatScore,
  valueColor
} from "./settings.js";
import {
  closedSessions,
  getSession,
  summarize,
  nextSessionNumber,
  startRound,
  closeRound,
  cancelRound,
  setAllowEdit,
  deleteSession,
  clearHistory,
  exportPayload
} from "./store.js";
import { remindPlayers } from "./net.js";
import { el, icon, button, downloadText, createSlider } from "./dom.js";
import { buildChart } from "./chart.js";
import { RateWindow } from "./rate-window.js";

const TABS = [
  { id: "rate", icon: "fa-solid fa-star" },
  { id: "results", icon: "fa-solid fa-list-check" },
  { id: "dynamics", icon: "fa-solid fa-chart-line" },
  { id: "settings", icon: "fa-solid fa-sliders" }
];

const WINDOW_ID = "ultrate-hub";

function hintIcon(text) {
  return el("i", "ultrate-hint fa-solid fa-circle-question", { title: text, "aria-hidden": "true" });
}

/** A label on the left, a control on the right. */
function field(labelKey, hintKey, control) {
  const row = el("div", "ultrate-field");
  const label = el("div", "ultrate-field-label");
  label.appendChild(el("span", null, {}, loc(labelKey)));
  if (hintKey) label.appendChild(hintIcon(loc(hintKey)));
  row.append(label, control);
  return row;
}

function toggle(checked, onChange) {
  const wrap = el("label", "ultrate-toggle");
  const input = el("input", null, { type: "checkbox" });
  input.checked = Boolean(checked);
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input, el("span", "ultrate-toggle-track"));
  return wrap;
}

/** A button that needs two clicks a few seconds apart. */
function armedButton({ label, confirm, iconClass, className = "ultrate-btn is-danger", onConfirm }) {
  const b = button(label, { icon: iconClass, className });
  const text = b.querySelector("span");
  let timer = null;
  const reset = () => {
    b.dataset.armed = "false";
    text.textContent = label;
  };
  b.addEventListener("click", () => {
    window.clearTimeout(timer);
    if (b.dataset.armed === "true") {
      reset();
      onConfirm();
      return;
    }
    b.dataset.armed = "true";
    text.textContent = confirm;
    timer = window.setTimeout(reset, 4000);
  });
  return b;
}

function userColor(userId) {
  try {
    const c = game.users?.get?.(userId)?.color;
    return c ? String(c.css ?? c) : null;
  } catch (err) {
    return null;
  }
}

export class RateHub extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: WINDOW_ID,
    classes: ["ultrate-app", "ultrate-hub-app"],
    tag: "div",
    window: {
      title: "ULTRATE.Hub.Title",
      icon: "fa-solid fa-star",
      resizable: true
    },
    position: { width: 960, height: 720 }
  };

  activeTab = "rate";
  detailId = null;
  form = null;

  #handlers = null;
  #statusEl = null;
  #previewEl = null;
  #localAppearance = null;
  #saveTimer = null;

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async _renderHTML() {
    const root = el("div", "ultrate-hub");
    root.appendChild(this.#buildSidebar());

    const content = el("div", "ultrate-hub-content");
    const panels = el("div", "ultrate-hub-panels");
    panels.replaceChildren(...TABS.map((tab) => this.#panelFor(tab.id)));
    content.appendChild(panels);
    root.appendChild(content);

    root.appendChild(this.#buildFooter());
    return root;
  }

  async _replaceHTML(result, content) {
    content.replaceChildren(result);
    this.#showTab(this.activeTab);
  }

  _onRender(context, options) {
    applyAppearance(this.element);
    if (!this.#handlers) {
      this.#handlers = {
        data: () => this.#onData(),
        appearance: () => {
          applyAppearance(this.element);
          this.#paintPreview();
        },
        user: () => this.#refreshParticipants()
      };
      bus.addEventListener("round", this.#handlers.data);
      bus.addEventListener("store", this.#handlers.data);
      bus.addEventListener("appearance", this.#handlers.appearance);
      Hooks.on("userConnected", this.#handlers.user);
    }
    return super._onRender?.(context, options);
  }

  _onClose(options) {
    if (this.#handlers) {
      bus.removeEventListener("round", this.#handlers.data);
      bus.removeEventListener("store", this.#handlers.data);
      bus.removeEventListener("appearance", this.#handlers.appearance);
      Hooks.off("userConnected", this.#handlers.user);
    }
    this.#handlers = null;
    window.clearTimeout(this.#saveTimer);
    return super._onClose?.(options);
  }

  static open(tab = null) {
    const existing = foundry.applications.instances?.get?.(WINDOW_ID);
    if (existing?.rendered) {
      if (tab) existing.goTo(tab);
      existing.bringToFront?.();
      return existing;
    }
    const app = new this();
    if (tab) app.activeTab = tab;
    app.render({ force: true });
    return app;
  }

  goTo(tabId) {
    this.#showTab(tabId);
  }

  /** The round or the stored sessions changed: rebuild what depends on them. */
  #onData() {
    if (!this.rendered) return;
    if (this.detailId && !getSession(this.detailId)) this.detailId = null;
    for (const id of ["rate", "results", "dynamics"]) this.#rebuildPanel(id);
  }

  /* ------------------------------------------------------------------ */
  /*  Sidebar, tabs, footer                                              */
  /* ------------------------------------------------------------------ */

  #buildSidebar() {
    const nav = el("nav", "ultrate-hub-sidebar");
    const list = el("div", "ultrate-hub-nav-list");
    for (const tab of TABS) {
      const btn = el("button", "ultrate-hub-nav-btn", { type: "button", "data-tab": tab.id });
      btn.append(icon(tab.icon), el("span", null, {}, loc(`ULTRATE.Hub.Tab.${tab.id}`)));
      btn.addEventListener("click", () => this.#showTab(tab.id));
      list.appendChild(btn);
    }
    nav.appendChild(list);
    return nav;
  }

  #showTab(tabId) {
    this.activeTab = tabId;
    const root = this.element;
    if (!root) return;
    for (const btn of root.querySelectorAll(".ultrate-hub-nav-btn")) btn.classList.toggle("is-active", btn.dataset.tab === tabId);
    for (const panel of root.querySelectorAll(".ultrate-hub-panel")) panel.classList.toggle("is-active", panel.dataset.tab === tabId);
  }

  #panelFor(tabId) {
    switch (tabId) {
      case "rate":
        return this.#buildRatePanel();
      case "results":
        return this.#buildResultsPanel();
      case "dynamics":
        return this.#buildDynamicsPanel();
      default:
        return this.#buildSettingsPanel();
    }
  }

  #panel(id, titleKey) {
    const panel = el("section", "ultrate-hub-panel", { "data-tab": id });
    panel.appendChild(el("h2", "ultrate-hub-panel-title", {}, loc(titleKey ?? `ULTRATE.Hub.Tab.${id}`)));
    return panel;
  }

  #rebuildPanel(tabId) {
    const old = this.element?.querySelector(`.ultrate-hub-panel[data-tab="${tabId}"]`);
    if (!old) return;
    const fresh = this.#panelFor(tabId);
    fresh.classList.toggle("is-active", this.activeTab === tabId);
    fresh.classList.add("no-anim");
    old.replaceWith(fresh);
  }

  #buildFooter() {
    const footer = el("div", "ultrate-hub-footer");

    const status = el("div", "ultrate-hub-status is-saved");
    status.append(icon("fa-solid fa-check"), el("span", null, {}, loc("ULTRATE.Hub.Saved")));
    this.#statusEl = status;
    footer.appendChild(status);

    const brand = el("div", "ultrate-hub-brand");
    brand.append(el("span", null, {}, "ULT's Session Rating"), el("span", "ultrate-hub-signature", {}, "by 4isfate"));
    footer.appendChild(brand);

    const actions = el("div", "ultrate-hub-actions");
    const github = el("a", "ultrate-hub-icon-btn", {
      href: GITHUB_URL,
      target: "_blank",
      rel: "noopener noreferrer",
      title: loc("ULTRATE.Hub.GitHub")
    });
    github.appendChild(icon("fa-brands fa-github"));
    actions.appendChild(github);

    // The wrapper carries the tooltip: a disabled button does not reliably show
    // its own. Live when the companion module hub (ult-hub) is installed and
    // active, a disabled placeholder otherwise — same as ULT's Loading Screen.
    const moduleHub = game.modules?.get?.("ult-hub");
    const hubApi = moduleHub?.active ? moduleHub.api : null;
    const hubWrap = el("span", "ultrate-hub-icon-wrap", { title: loc("ULTRATE.Hub.ModuleHub") });
    const hubBtn = hubApi?.open
      ? el("button", "ultrate-hub-icon-btn", { type: "button" })
      : el("button", "ultrate-hub-icon-btn is-disabled", { type: "button", disabled: "true" });
    hubBtn.appendChild(icon("fa-solid fa-diagram-project"));
    if (hubApi?.open) {
      hubBtn.addEventListener("click", () => {
        try {
          hubApi.open(MODULE_ID);
        } catch (err) {
          console.warn(`${MODULE_ID} | could not open the module hub`, err);
        }
      });
    }
    hubWrap.appendChild(hubBtn);
    actions.appendChild(hubWrap);

    footer.appendChild(actions);
    return footer;
  }

  /** Flash the footer status after a save, so the GM sees the change was kept. */
  #flashSaved() {
    const node = this.#statusEl;
    if (!node) return;
    node.classList.remove("is-flash");
    void node.offsetWidth;
    node.classList.add("is-flash");
  }

  /* ------------------------------------------------------------------ */
  /*  Tab: rate                                                          */
  /* ------------------------------------------------------------------ */

  #buildRatePanel() {
    const round = getActiveRound();
    return round ? this.#buildLive(round) : this.#buildStartForm();
  }

  #initForm() {
    const d = getDefaults();
    this.form = {
      title: fmt("ULTRATE.Hub.Start.DefaultTitle", { n: nextSessionNumber() }),
      date: todayISO(),
      system: currentSystemTitle(),
      anonymous: d.anonymous,
      notes: d.notes,
      allowEdit: d.allowEdit,
      selected: new Map()
    };
  }

  #buildStartForm() {
    if (!this.form) this.#initForm();
    const form = this.form;
    const panel = this.#panel("rate", "ULTRATE.Hub.Start.Title");
    panel.appendChild(el("p", "ultrate-lead", {}, loc("ULTRATE.Hub.Start.Lead")));

    const text = (key, max, type = "text") => {
      const input = el("input", null, { type, maxlength: type === "text" ? max : null });
      input.value = form[key];
      input.addEventListener("input", () => {
        form[key] = input.value;
      });
      return input;
    };

    panel.appendChild(field("ULTRATE.Hub.Start.Name", "ULTRATE.Hub.Start.NameHint", text("title", LIMITS.title)));
    panel.appendChild(field("ULTRATE.Hub.Start.Date", null, text("date", 10, "date")));
    panel.appendChild(field("ULTRATE.Hub.Start.System", "ULTRATE.Hub.Start.SystemHint", text("system", LIMITS.system)));
    panel.appendChild(field("ULTRATE.Hub.Start.Anonymous", "ULTRATE.Hub.Start.AnonymousHint", toggle(form.anonymous, (v) => (form.anonymous = v))));
    panel.appendChild(field("ULTRATE.Hub.Start.Notes", "ULTRATE.Hub.Start.NotesHint", toggle(form.notes, (v) => (form.notes = v))));
    panel.appendChild(field("ULTRATE.Hub.Start.AllowEdit", "ULTRATE.Hub.Start.AllowEditHint", toggle(form.allowEdit, (v) => (form.allowEdit = v))));

    const head = el("div", "ultrate-subhead");
    head.appendChild(el("h3", "ultrate-hub-subtitle", {}, loc("ULTRATE.Hub.Start.Participants")));
    const refresh = el("button", "ultrate-icon-btn-sm", { type: "button", title: loc("ULTRATE.Hub.Start.Refresh") });
    refresh.appendChild(icon("fa-solid fa-rotate"));
    refresh.addEventListener("click", () => this.#refreshParticipants());
    head.appendChild(refresh);
    panel.appendChild(head);
    panel.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Start.ParticipantsNote")));

    const list = el("div", "ultrate-people", { "data-role": "participants" });
    panel.appendChild(list);
    this.#fillParticipants(list);

    const start = button(loc("ULTRATE.Hub.Start.Button"), { icon: "fa-solid fa-play", className: "ultrate-btn is-primary is-big" });
    start.addEventListener("click", () => this.#start(start));
    const row = el("div", "ultrate-row ultrate-start-row");
    row.appendChild(start);
    panel.appendChild(row);
    return panel;
  }

  #connectedUsers() {
    return (game.users?.filter?.((u) => u.active) ?? []).map((u) => ({ id: u.id, name: u.name, isGM: Boolean(u.isGM) }));
  }

  #fillParticipants(list) {
    const users = this.#connectedUsers();
    const selected = this.form.selected;
    list.replaceChildren();

    if (users.length === 0) {
      list.appendChild(el("p", "ultrate-empty", {}, loc("ULTRATE.Hub.Start.NoOne")));
      return;
    }

    for (const user of users) {
      if (!selected.has(user.id)) selected.set(user.id, !user.isGM);

      const row = el("label", "ultrate-person");
      const box = el("input", null, { type: "checkbox" });
      box.checked = selected.get(user.id);
      box.addEventListener("change", () => selected.set(user.id, box.checked));

      const dot = el("span", "ultrate-avatar", {}, (user.name || "?").slice(0, 1).toUpperCase());
      const color = userColor(user.id);
      if (color) dot.style.background = color;

      row.append(box, dot, el("span", "ultrate-person-name", {}, user.name));
      if (user.isGM) row.appendChild(el("span", "ultrate-person-tag", {}, loc("ULTRATE.Hub.Start.GMTag")));
      list.appendChild(row);
    }
  }

  #refreshParticipants() {
    const list = this.element?.querySelector('[data-role="participants"]');
    if (list && this.form) this.#fillParticipants(list);
  }

  async #start(btn) {
    const form = this.form;
    const users = this.#connectedUsers().filter((u) => form.selected.get(u.id));
    if (users.length === 0) {
      ui.notifications?.warn(loc("ULTRATE.Hub.Start.NeedOne"));
      return;
    }

    btn.disabled = true;
    try {
      await startRound({
        title: form.title,
        date: form.date,
        system: form.system,
        anonymous: form.anonymous,
        notes: form.notes,
        allowEdit: form.allowEdit,
        participants: users.map((u) => ({ id: u.id, name: u.name }))
      });
      this.form = null;
      ui.notifications?.info(fmt("ULTRATE.Notify.Started", { count: users.length }));
    } catch (err) {
      console.warn(`${MODULE_ID} | could not start the round`, err);
      ui.notifications?.error(loc("ULTRATE.Notify.StartFailed"));
    } finally {
      btn.disabled = false;
    }
  }

  #buildLive(round) {
    const panel = this.#panel("rate", "ULTRATE.Hub.Live.Title");

    // --- summary --------------------------------------------------------------
    const card = el("div", "ultrate-live-card");
    card.appendChild(el("h3", "ultrate-live-title", {}, round.title));

    const meta = el("div", "ultrate-meta");
    const addMeta = (iconClass, textValue) => {
      if (!textValue) return;
      const item = el("span", "ultrate-meta-item");
      item.append(icon(iconClass), el("span", null, {}, textValue));
      meta.appendChild(item);
    };
    addMeta("fa-regular fa-calendar", formatDate(round.date));
    addMeta("fa-solid fa-dice-d20", round.system);
    addMeta(round.anonymous ? "fa-solid fa-user-secret" : "fa-solid fa-eye", loc(round.anonymous ? "ULTRATE.Hub.Live.Anonymous" : "ULTRATE.Hub.Live.Named"));
    card.appendChild(meta);

    const total = round.participants.length;
    const done = round.voted.length;
    const pending = round.participants.filter((p) => !round.voted.includes(p.id));

    const count = el("div", "ultrate-live-count");
    count.append(el("span", "ultrate-live-num", {}, String(done)), el("span", "ultrate-live-of", {}, fmt("ULTRATE.Hub.Live.Of", { total })));
    card.appendChild(count);

    const bar = el("div", "ultrate-live-bar");
    const fill = el("div", "ultrate-live-fill");
    fill.style.setProperty("--p", String(total ? done / total : 0));
    bar.appendChild(fill);
    card.appendChild(bar);
    panel.appendChild(card);

    // --- who ------------------------------------------------------------------
    panel.appendChild(el("h3", "ultrate-hub-subtitle", {}, loc("ULTRATE.Hub.Live.Who")));
    const people = el("div", "ultrate-people is-status");
    round.participants.forEach((p, i) => {
      const voted = round.voted.includes(p.id);
      const row = el("div", `ultrate-person${voted ? " is-done" : " is-waiting"}`);
      row.style.setProperty("--i", String(i));
      const dot = el("span", "ultrate-avatar", {}, (p.name || "?").slice(0, 1).toUpperCase());
      const color = userColor(p.id);
      if (color) dot.style.background = color;
      row.append(dot, el("span", "ultrate-person-name", {}, p.name));
      const state = el("span", "ultrate-person-state");
      state.append(icon(voted ? "fa-solid fa-circle-check" : "fa-regular fa-clock"), el("span", null, {}, loc(voted ? "ULTRATE.Hub.Live.Done" : "ULTRATE.Hub.Live.Waiting")));
      row.appendChild(state);
      people.appendChild(row);
    });
    panel.appendChild(people);
    panel.appendChild(el("p", "notes", {}, loc(round.anonymous ? "ULTRATE.Hub.Live.NoteAnon" : "ULTRATE.Hub.Live.NoteNamed")));

    // --- options --------------------------------------------------------------
    panel.appendChild(
      field("ULTRATE.Hub.Start.AllowEdit", "ULTRATE.Hub.Live.AllowEditHint", toggle(round.allowEdit, async (v) => {
        await setAllowEdit(v);
        this.#flashSaved();
      }))
    );

    // --- actions --------------------------------------------------------------
    const actions = el("div", "ultrate-row ultrate-live-actions");

    const gmIsIn = round.participants.some((p) => p.id === game.user.id);
    if (gmIsIn) {
      const mine = button(loc("ULTRATE.Hub.Live.OpenMine"), { icon: "fa-solid fa-star" });
      mine.addEventListener("click", () => RateWindow.open(round));
      actions.appendChild(mine);
    }

    const remindIds = pending.map((p) => p.id).filter((id) => id !== game.user.id);
    if (remindIds.length > 0) {
      const remind = button(fmt("ULTRATE.Hub.Live.Remind", { count: remindIds.length }), { icon: "fa-solid fa-bell" });
      remind.addEventListener("click", () => {
        remindPlayers(remindIds);
        ui.notifications?.info(loc("ULTRATE.Notify.Reminded"));
      });
      actions.appendChild(remind);
    }

    const closeLabel = loc("ULTRATE.Hub.Live.Close");
    const doClose = async () => {
      const id = await closeRound();
      if (!id) return;
      ui.notifications?.info(loc("ULTRATE.Notify.Closed"));
      this.detailId = id;
      this.#showTab("results");
      this.#onData();
    };
    if (pending.length > 0) {
      actions.appendChild(
        armedButton({
          label: closeLabel,
          confirm: fmt("ULTRATE.Hub.Live.CloseConfirm", { count: pending.length }),
          iconClass: "fa-solid fa-flag-checkered",
          className: "ultrate-btn is-primary",
          onConfirm: doClose
        })
      );
    } else {
      const close = button(closeLabel, { icon: "fa-solid fa-flag-checkered", className: "ultrate-btn is-primary" });
      close.addEventListener("click", doClose);
      actions.appendChild(close);
    }

    actions.appendChild(
      armedButton({
        label: loc("ULTRATE.Hub.Live.Cancel"),
        confirm: loc("ULTRATE.Hub.Live.CancelConfirm"),
        iconClass: "fa-solid fa-ban",
        onConfirm: async () => {
          await cancelRound();
          ui.notifications?.info(loc("ULTRATE.Notify.Cancelled"));
        }
      })
    );
    panel.appendChild(actions);
    return panel;
  }

  /* ------------------------------------------------------------------ */
  /*  Tab: results                                                       */
  /* ------------------------------------------------------------------ */

  #buildResultsPanel() {
    return this.detailId && getSession(this.detailId) ? this.#buildDetail(getSession(this.detailId)) : this.#buildList();
  }

  #buildList() {
    const panel = this.#panel("results");

    const round = getActiveRound();
    if (round) {
      const banner = el("p", "ultrate-notice");
      banner.append(icon("fa-solid fa-hourglass-half"), el("span", null, {}, fmt("ULTRATE.Hub.Results.Open", { title: round.title })));
      panel.appendChild(banner);
    }

    const sessions = closedSessions().reverse();
    if (sessions.length === 0) {
      panel.appendChild(el("p", "ultrate-empty", {}, loc("ULTRATE.Hub.Results.Empty")));
      return panel;
    }

    const list = el("div", "ultrate-session-list");
    sessions.forEach((session, i) => {
      const sum = summarize(session);
      const row = el("button", "ultrate-session", { type: "button" });
      row.style.setProperty("--i", String(i));

      const main = el("div", "ultrate-session-main");
      main.appendChild(el("div", "ultrate-session-title", {}, session.title));
      const sub = [formatDate(session.date), session.system, fmt("ULTRATE.Hub.Results.Votes", { count: sum.count })].filter(Boolean).join(" · ");
      main.appendChild(el("div", "ultrate-session-sub", {}, sub));
      row.appendChild(main);

      const bars = el("div", "ultrate-minibars", { "aria-hidden": "true" });
      for (const cat of resolveCategories(session.cats)) {
        const v = sum.avg[cat.id];
        const bar = el("span", "ultrate-minibar");
        const t = v === null ? 0 : (v - 1) / 9;
        bar.style.setProperty("--h", `${v === null ? 6 : 14 + t * 86}%`);
        bar.style.setProperty("--ur-fill", valueColor(t));
        bars.appendChild(bar);
      }
      row.appendChild(bars);

      const score = el("div", "ultrate-session-score", {}, formatScore(sum.overall));
      score.style.setProperty("--ur-fill", valueColor(sum.overall === null ? 0 : (sum.overall - 1) / 9));
      row.append(score, icon("fa-solid fa-chevron-right ultrate-session-go"));

      row.addEventListener("click", () => {
        this.detailId = session.id;
        this.#rebuildPanel("results");
      });
      list.appendChild(row);
    });
    panel.appendChild(list);

    const actions = el("div", "ultrate-row");
    const exportAll = button(loc("ULTRATE.Hub.Results.ExportAll"), { icon: "fa-solid fa-file-arrow-down" });
    exportAll.addEventListener("click", () => this.#export(null));
    actions.appendChild(exportAll);
    panel.appendChild(actions);
    return panel;
  }

  #buildDetail(session) {
    const panel = this.#panel("results", "ULTRATE.Hub.Results.DetailTitle");
    const sum = summarize(session);
    const cats = resolveCategories(session.cats);

    const back = button(loc("ULTRATE.Hub.Results.Back"), { icon: "fa-solid fa-arrow-left" });
    back.addEventListener("click", () => {
      this.detailId = null;
      this.#rebuildPanel("results");
    });
    panel.appendChild(back);

    const head = el("div", "ultrate-detail-head");
    const info = el("div", "ultrate-detail-info");
    info.appendChild(el("h3", "ultrate-live-title", {}, session.title));
    const meta = el("div", "ultrate-meta");
    const addMeta = (iconClass, value) => {
      if (!value) return;
      const item = el("span", "ultrate-meta-item");
      item.append(icon(iconClass), el("span", null, {}, value));
      meta.appendChild(item);
    };
    addMeta("fa-regular fa-calendar", formatDate(session.date));
    addMeta("fa-solid fa-dice-d20", session.system);
    addMeta("fa-solid fa-users", fmt("ULTRATE.Hub.Results.Votes", { count: sum.count }));
    addMeta(session.anonymous ? "fa-solid fa-user-secret" : "fa-solid fa-eye", loc(session.anonymous ? "ULTRATE.Hub.Live.Anonymous" : "ULTRATE.Hub.Live.Named"));
    info.appendChild(meta);
    head.appendChild(info);

    const big = el("div", "ultrate-detail-score");
    big.style.setProperty("--ur-fill", valueColor(sum.overall === null ? 0 : (sum.overall - 1) / 9));
    big.append(el("span", "ultrate-detail-num", {}, formatScore(sum.overall)), el("span", "ultrate-detail-label", {}, loc("ULTRATE.Hub.Results.Overall")));
    head.appendChild(big);
    panel.appendChild(head);

    // --- per-criterion bars ------------------------------------------------------
    const bars = el("div", "ultrate-bars");
    cats.forEach((cat, i) => {
      const v = sum.avg[cat.id];
      const t = v === null ? 0 : (v - 1) / 9;
      const row = el("div", "ultrate-bar-row");
      row.style.setProperty("--i", String(i));
      row.appendChild(el("span", "ultrate-bar-name", {}, cat.name));
      const track = el("div", "ultrate-bar-track");
      const fill = el("div", "ultrate-bar-fill");
      fill.style.setProperty("--w", `${v === null ? 0 : (v / 10) * 100}%`);
      fill.style.setProperty("--ur-fill", valueColor(t));
      track.appendChild(fill);
      row.append(track, el("span", "ultrate-bar-value", {}, formatScore(v)));
      bars.appendChild(row);
    });
    panel.appendChild(bars);

    // --- notes --------------------------------------------------------------
    const withNotes = session.entries.filter((e) => e.good || e.bad);
    if (session.notes) {
      panel.appendChild(el("h3", "ultrate-hub-subtitle", {}, loc("ULTRATE.Hub.Results.Notes")));
      if (withNotes.length === 0) {
        panel.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Results.NoNotes")));
      } else {
        const cols = el("div", "ultrate-notes-cols");
        const column = (key, iconClass, titleKey) => {
          const col = el("div", `ultrate-notes-col is-${key}`);
          const h = el("div", "ultrate-notes-col-title");
          h.append(icon(iconClass), el("span", null, {}, loc(titleKey)));
          col.appendChild(h);
          const items = withNotes.filter((e) => e[key]);
          if (items.length === 0) col.appendChild(el("p", "notes", {}, "—"));
          for (const entry of items) {
            const quote = el("blockquote", "ultrate-quote");
            quote.appendChild(el("p", null, {}, entry[key]));
            const who = session.anonymous
              ? loc("ULTRATE.Hub.Results.Anon")
              : session.participants.find((p) => p.id === entry.userId)?.name ?? "—";
            quote.appendChild(el("cite", null, {}, who));
            col.appendChild(quote);
          }
          return col;
        };
        cols.append(
          column("good", "fa-regular fa-thumbs-up", "ULTRATE.Rate.NoteGood"),
          column("bad", "fa-regular fa-lightbulb", "ULTRATE.Rate.NoteBad")
        );
        panel.appendChild(cols);
      }
    }

    // --- actions --------------------------------------------------------------
    const actions = el("div", "ultrate-row ultrate-detail-actions");
    const exportOne = button(loc("ULTRATE.Hub.Results.ExportOne"), { icon: "fa-solid fa-file-arrow-down" });
    exportOne.addEventListener("click", () => this.#export([session.id]));
    actions.appendChild(exportOne);
    actions.appendChild(
      armedButton({
        label: loc("ULTRATE.Hub.Results.Delete"),
        confirm: loc("ULTRATE.Hub.Results.DeleteConfirm"),
        iconClass: "fa-solid fa-trash",
        onConfirm: async () => {
          await deleteSession(session.id);
          this.detailId = null;
          this.#onData();
        }
      })
    );
    panel.appendChild(actions);
    return panel;
  }

  #export(ids) {
    const payload = exportPayload(ids);
    const stamp = todayISO();
    downloadText(`ult-rate-${ids?.length === 1 ? "session" : "all"}-${stamp}.json`, JSON.stringify(payload, null, 2));
    ui.notifications?.info(loc("ULTRATE.Notify.Exported"));
  }

  /* ------------------------------------------------------------------ */
  /*  Tab: dynamics                                                      */
  /* ------------------------------------------------------------------ */

  #buildDynamicsPanel() {
    const panel = this.#panel("dynamics");
    panel.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Dynamics.Lead")));
    panel.appendChild(buildChart(closedSessions()));
    return panel;
  }

  /* ------------------------------------------------------------------ */
  /*  Tab: settings                                                      */
  /* ------------------------------------------------------------------ */

  #buildSettingsPanel() {
    const panel = this.#panel("settings");
    panel.appendChild(this.#buildCategoriesSection());
    panel.appendChild(this.#buildAppearanceSection());
    panel.appendChild(this.#buildDefaultsSection());
    panel.appendChild(this.#buildDataSection());
    return panel;
  }

  // --- criteria ------------------------------------------------------------------

  #buildCategoriesSection() {
    const section = el("div", "ultrate-section");
    section.appendChild(el("h3", "ultrate-hub-subtitle", {}, loc("ULTRATE.Hub.Cats.Title")));
    section.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Cats.Lead")));

    const overrides = getCategoryOverrides();
    const defaults = resolveCategories([]);
    const inputs = [];

    const save = async () => {
      const list = overrides.map((o, i) => ({
        id: o.id,
        name: inputs[i].name.value.trim().slice(0, LIMITS.catName),
        desc: inputs[i].desc.value.trim().slice(0, LIMITS.catDesc),
        also: inputs[i].also.value.trim().slice(0, LIMITS.catAlso)
      }));
      await saveCategoryOverrides(list);
      this.#flashSaved();
    };

    overrides.forEach((o, i) => {
      const def = defaults[i];
      // Collapsed by default: five tall forms at once would bury everything below them.
      const card = el("details", `ultrate-cat-edit${def.wide ? " is-wide" : ""}`);

      const head = el("summary", "ultrate-cat-edit-head");
      const shownName = el("span", "ultrate-cat-edit-name", {}, o.name || def.name);
      head.append(el("span", "ultrate-cat-edit-num", {}, String(i + 1)), shownName);
      if (def.wide) head.appendChild(el("span", "ultrate-person-tag", {}, loc("ULTRATE.Hub.Cats.Wide")));
      head.appendChild(icon("fa-solid fa-chevron-down ultrate-cat-edit-chevron"));
      card.appendChild(head);

      const name = el("input", null, { type: "text", maxlength: LIMITS.catName, placeholder: def.name });
      name.value = o.name;
      name.addEventListener("input", () => {
        shownName.textContent = name.value.trim() || def.name;
      });
      const desc = el("textarea", null, { rows: 3, maxlength: LIMITS.catDesc, placeholder: def.desc });
      desc.value = o.desc;
      const also = el("input", null, { type: "text", maxlength: LIMITS.catAlso, placeholder: def.also.join(", ") });
      also.value = o.also;
      for (const control of [name, desc, also]) control.addEventListener("change", save);
      inputs.push({ name, desc, also });

      const grid = el("div", "ultrate-cat-edit-grid");
      const labelled = (key, control) => {
        const wrap = el("label", "ultrate-cat-edit-field");
        wrap.append(el("span", null, {}, loc(key)), control);
        return wrap;
      };
      grid.append(labelled("ULTRATE.Hub.Cats.Name", name), labelled("ULTRATE.Hub.Cats.Desc", desc), labelled("ULTRATE.Hub.Cats.Also", also));
      card.appendChild(grid);
      section.appendChild(card);
    });

    const actions = el("div", "ultrate-row");
    actions.appendChild(
      armedButton({
        label: loc("ULTRATE.Hub.Cats.Reset"),
        confirm: loc("ULTRATE.Hub.Cats.ResetConfirm"),
        iconClass: "fa-solid fa-rotate-left",
        onConfirm: async () => {
          await saveCategoryOverrides(overrides.map((o) => ({ id: o.id, name: "", desc: "", also: "" })));
          this.#rebuildPanel("settings");
          this.#flashSaved();
        }
      })
    );
    section.appendChild(actions);
    return section;
  }

  // --- appearance ------------------------------------------------------------------

  #buildAppearanceSection() {
    const section = el("div", "ultrate-section");
    section.appendChild(el("h3", "ultrate-hub-subtitle", {}, loc("ULTRATE.Hub.Look.Title")));
    section.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Look.Lead")));

    this.#localAppearance = getAppearance();
    const look = this.#localAppearance;

    const preview = el("div", "ultrate-look-preview");
    this.#previewEl = preview;
    section.appendChild(preview);
    this.#paintPreview();

    const colors = el("div", "ultrate-colors");
    section.appendChild(colors);

    for (const key of COLOR_KEYS) {
      const wrap = el("div", "ultrate-color");
      const swatch = el("input", null, { type: "color", value: look[key] });
      const hex = el("input", null, { type: "text", value: look[key], maxlength: 7 });

      const preview$ = (value) => {
        look[key] = value;
        applyAppearance(this.element, look);
        this.#paintPreview();
      };
      const commit = async (value) => {
        look[key] = value;
        await saveAppearance(look);
        this.#flashSaved();
      };

      swatch.addEventListener("input", () => {
        hex.value = swatch.value;
        preview$(swatch.value);
      });
      swatch.addEventListener("change", () => commit(swatch.value));
      hex.addEventListener("change", () => {
        const v = hex.value.trim();
        if (/^#[0-9a-f]{6}$/i.test(v)) {
          swatch.value = v.toLowerCase();
          preview$(v.toLowerCase());
          commit(v.toLowerCase());
        } else {
          hex.value = look[key];
        }
      });

      wrap.append(swatch, hex);
      const item = el("div", "ultrate-color-item");
      item.append(el("span", "ultrate-color-name", {}, loc(`ULTRATE.Hub.Color.${key}`)), wrap);
      colors.appendChild(item);
    }

    section.appendChild(
      field("ULTRATE.Hub.Look.ValueColors", "ULTRATE.Hub.Look.ValueColorsHint", toggle(look.valueColors, async (v) => {
        look.valueColors = v;
        applyAppearance(this.element, look);
        this.#paintPreview();
        await saveAppearance(look);
        this.#flashSaved();
      }))
    );

    const actions = el("div", "ultrate-row");
    const reset = button(loc("ULTRATE.Hub.Look.Reset"), { icon: "fa-solid fa-rotate-left" });
    reset.addEventListener("click", async () => {
      await saveAppearance({ ...DEFAULT_APPEARANCE });
      applyAppearance(this.element);
      this.#rebuildPanel("settings");
      this.#flashSaved();
    });
    actions.appendChild(reset);
    section.appendChild(actions);
    return section;
  }

  /** A miniature of the players' cards, so colour changes can be judged at once. */
  #paintPreview() {
    const box = this.#previewEl;
    if (!box) return;
    const look = this.#localAppearance ?? getAppearance();
    box.replaceChildren();
    for (const value of [3, 6, 9]) {
      const item = el("div", "ultrate-look-item");
      item.appendChild(el("span", "ultrate-look-num", {}, String(value)));
      const slider = createSlider({ label: String(value), value, disabled: true, appearance: look });
      item.appendChild(slider.root);
      box.appendChild(item);
    }
  }

  // --- defaults ------------------------------------------------------------------

  #buildDefaultsSection() {
    const section = el("div", "ultrate-section");
    section.appendChild(el("h3", "ultrate-hub-subtitle", {}, loc("ULTRATE.Hub.Defaults.Title")));
    section.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Defaults.Lead")));

    const d = getDefaults();
    const add = (key, labelKey, hintKey) => {
      section.appendChild(
        field(labelKey, hintKey, toggle(d[key], async (v) => {
          d[key] = v;
          await saveDefaults(d);
          if (this.form) this.form[key] = v;
          this.#flashSaved();
        }))
      );
    };
    add("anonymous", "ULTRATE.Hub.Start.Anonymous", "ULTRATE.Hub.Start.AnonymousHint");
    add("notes", "ULTRATE.Hub.Start.Notes", "ULTRATE.Hub.Start.NotesHint");
    add("allowEdit", "ULTRATE.Hub.Start.AllowEdit", "ULTRATE.Hub.Start.AllowEditHint");
    return section;
  }

  // --- data ------------------------------------------------------------------

  #buildDataSection() {
    const section = el("div", "ultrate-section");
    section.appendChild(el("h3", "ultrate-hub-subtitle", {}, loc("ULTRATE.Hub.Data.Title")));
    section.appendChild(el("p", "notes", {}, loc("ULTRATE.Hub.Data.Lead")));

    const actions = el("div", "ultrate-row");
    const exportAll = button(loc("ULTRATE.Hub.Results.ExportAll"), { icon: "fa-solid fa-file-arrow-down" });
    exportAll.addEventListener("click", () => this.#export(null));
    actions.appendChild(exportAll);
    actions.appendChild(
      armedButton({
        label: loc("ULTRATE.Hub.Data.Clear"),
        confirm: loc("ULTRATE.Hub.Data.ClearConfirm"),
        iconClass: "fa-solid fa-trash",
        onConfirm: async () => {
          await clearHistory();
          this.detailId = null;
          this.#onData();
          ui.notifications?.info(loc("ULTRATE.Notify.Cleared"));
        }
      })
    );
    section.appendChild(actions);
    return section;
  }
}
