/**
 * ULT's Session Rating — the players' window.
 *
 * Two screens, chosen by `mode`:
 *   form    four compact criteria, one wide criterion, optional notes, submit
 *   thanks  what the player sees after confirming, with an "edit" button when
 *           the GM allowed editing
 *
 * Plain DOM on ApplicationV2 with no templates, like the rest of the module
 * family: there is no template file that could fail to load and leave a blank
 * window. The window keeps its state on the instance, so the whole tree can be
 * rebuilt (on a mode change, or a colour change elsewhere) without losing what
 * the player has already set.
 */

import {
  CATEGORY_IDS,
  LIMITS,
  bus,
  applyAppearance,
  resolveCategories,
  getMyVote,
  saveMyVote,
  loc,
  fmt,
  formatDate
} from "./settings.js";
import { el, icon, button, createRoll, createSlider, createPopover } from "./dom.js";
import { submitVote } from "./net.js";

const WINDOW_ID = "ultrate-rate";

export class RateWindow extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: WINDOW_ID,
    classes: ["ultrate-app", "ultrate-rate-app"],
    tag: "div",
    window: {
      title: "ULTRATE.Rate.WindowTitle",
      icon: "fa-solid fa-star",
      resizable: false
    },
    position: { width: 700, height: "auto" }
  };

  #onAppearance = null;
  #sliders = {};
  #dots = [];
  #countEl = null;
  #submitEl = null;
  #popover = null;

  constructor(round, options = {}) {
    super(options);
    this.round = round;
    this.values = {};
    this.good = "";
    this.bad = "";
    this.notesOpen = false;
    this.sending = false;
    this.token = null;

    const mine = getMyVote(round.id);
    if (mine) {
      this.token = mine.token ?? null;
      for (const id of CATEGORY_IDS) {
        const v = Number(mine.scores?.[id]);
        if (Number.isInteger(v)) this.values[id] = v;
      }
      this.good = String(mine.good ?? "");
      this.bad = String(mine.bad ?? "");
    }
    this.notesOpen = Boolean(this.good || this.bad);
    this.mode = round.voted.includes(game.user.id) ? "thanks" : "form";
  }

  /* ------------------------------------------------------------------ */
  /*  Lifecycle                                                          */
  /* ------------------------------------------------------------------ */

  async _renderHTML() {
    this.#sliders = {};
    this.#dots = [];
    return this.mode === "thanks" ? this.#buildThanks() : this.#buildForm();
  }

  async _replaceHTML(result, content) {
    content.replaceChildren(result);
  }

  _onRender(context, options) {
    applyAppearance(this.element);
    if (!this.#onAppearance) {
      this.#onAppearance = () => {
        applyAppearance(this.element);
        for (const slider of Object.values(this.#sliders)) slider.repaint();
      };
      bus.addEventListener("appearance", this.#onAppearance);
    }
    return super._onRender?.(context, options);
  }

  _onClose(options) {
    if (this.#onAppearance) bus.removeEventListener("appearance", this.#onAppearance);
    this.#onAppearance = null;
    return super._onClose?.(options);
  }

  /** The public round changed (a vote came in, the GM toggled editing). */
  refresh(round) {
    this.round = round;
    if (this.sending) return;
    if (this.mode === "form" && !this.editing && round.voted.includes(game.user.id)) this.mode = "thanks";
    if (this.mode === "thanks" && this.rendered) this.render();
  }

  static open(round) {
    const existing = foundry.applications.instances?.get?.(WINDOW_ID);
    if (existing?.rendered) {
      existing.refresh(round);
      existing.bringToFront?.();
      return existing;
    }
    const app = new this(round);
    app.render({ force: true });
    return app;
  }

  static get current() {
    const existing = foundry.applications.instances?.get?.(WINDOW_ID);
    return existing?.rendered ? existing : null;
  }

  /* ------------------------------------------------------------------ */
  /*  Shared header                                                      */
  /* ------------------------------------------------------------------ */

  #buildHead() {
    const round = this.round;
    const head = el("header", "ultrate-head");
    head.appendChild(el("div", "ultrate-eyebrow", {}, "ULT's Session Rating"));
    head.appendChild(el("h2", "ultrate-title", {}, round.title));

    const meta = el("div", "ultrate-meta");
    const add = (iconClass, text) => {
      if (!text) return;
      const item = el("span", "ultrate-meta-item");
      item.append(icon(iconClass), el("span", null, {}, text));
      meta.appendChild(item);
    };
    add("fa-regular fa-calendar", formatDate(round.date));
    add("fa-solid fa-dice-d20", round.system);
    add("fa-solid fa-user-shield", fmt("ULTRATE.Rate.GM", { name: round.gmName }));
    head.appendChild(meta);

    const privacy = el("div", `ultrate-privacy ${round.anonymous ? "is-anon" : "is-named"}`);
    privacy.append(
      icon(round.anonymous ? "fa-solid fa-user-secret" : "fa-solid fa-eye"),
      el("span", null, {}, loc(round.anonymous ? "ULTRATE.Rate.Anonymous" : "ULTRATE.Rate.Named"))
    );
    head.appendChild(privacy);
    return head;
  }

  /* ------------------------------------------------------------------ */
  /*  The form                                                           */
  /* ------------------------------------------------------------------ */

  #buildForm() {
    const root = el("div", "ultrate ultrate-rate");
    root.appendChild(this.#buildHead());

    this.#popover = createPopover(root);

    const cats = resolveCategories(this.round.cats);
    const grid = el("div", "ultrate-grid");
    cats.forEach((cat, index) => grid.appendChild(this.#buildCard(cat, index)));
    root.appendChild(grid);

    if (this.round.notes) root.appendChild(this.#buildNotes());
    root.appendChild(this.#buildFooter());

    // Popover last so it stacks above every card.
    root.appendChild(this.#popover.element);
    this.#updateProgress();
    return root;
  }

  #buildCard(cat, index) {
    const card = el("section", `ultrate-card${cat.wide ? " is-wide" : ""}`, { "data-cat": cat.id });
    card.style.setProperty("--i", String(index));

    const top = el("div", "ultrate-card-top");

    const nameBtn = el("button", "ultrate-cat", { type: "button", "aria-label": `${cat.name}: ${loc("ULTRATE.Tip.Open")}` });
    nameBtn.append(el("span", "ultrate-cat-name", {}, cat.name), icon("fa-solid fa-circle-info ultrate-cat-i"));
    this.#popover.bind(nameBtn, cat);

    const roll = createRoll();
    const score = el("div", "ultrate-score");
    score.append(roll.root, el("span", "ultrate-score-max", {}, "/10"));
    top.append(nameBtn, score);

    const start = Number(this.values[cat.id]) || 0;
    roll.set(start);
    const slider = createSlider({
      label: cat.name,
      value: start,
      onChange: (v) => {
        this.values[cat.id] = v;
        roll.set(v);
        this.#updateProgress();
      }
    });
    this.#sliders[cat.id] = slider;

    card.append(top, slider.root);

    if (cat.wide) {
      const hint = el("div", "ultrate-scale-hint");
      hint.append(el("span", null, {}, loc("ULTRATE.Rate.ScaleLow")), el("span", null, {}, loc("ULTRATE.Rate.ScaleHigh")));
      card.appendChild(hint);
    }
    return card;
  }

  #buildNotes() {
    const wrap = el("section", `ultrate-notes${this.notesOpen ? " is-open" : ""}`);

    const toggle = el("button", "ultrate-notes-toggle", { type: "button", "aria-expanded": String(this.notesOpen) });
    toggle.append(
      icon("fa-solid fa-pen-to-square"),
      el("span", null, {}, loc("ULTRATE.Rate.NotesToggle")),
      el("span", "ultrate-notes-optional", {}, loc("ULTRATE.Rate.Optional")),
      icon("fa-solid fa-chevron-down ultrate-notes-chevron")
    );
    toggle.addEventListener("click", () => {
      this.notesOpen = !this.notesOpen;
      wrap.classList.toggle("is-open", this.notesOpen);
      toggle.setAttribute("aria-expanded", String(this.notesOpen));
    });
    wrap.appendChild(toggle);

    const body = el("div", "ultrate-notes-body");
    const inner = el("div", "ultrate-notes-inner");
    inner.appendChild(this.#noteField("good", "fa-regular fa-thumbs-up", "ULTRATE.Rate.NoteGood"));
    inner.appendChild(this.#noteField("bad", "fa-regular fa-lightbulb", "ULTRATE.Rate.NoteBad"));
    body.appendChild(inner);
    wrap.appendChild(body);
    return wrap;
  }

  #noteField(key, iconClass, labelKey) {
    const field = el("label", "ultrate-note");
    const label = el("span", "ultrate-note-label");
    label.append(icon(iconClass), el("span", null, {}, loc(labelKey)));

    const area = el("textarea", "ultrate-note-text", {
      rows: 3,
      maxlength: LIMITS.note,
      placeholder: loc("ULTRATE.Rate.NotePlaceholder")
    });
    area.value = this[key];

    const counter = el("span", "ultrate-note-count", {}, `${area.value.length}/${LIMITS.note}`);
    area.addEventListener("input", () => {
      this[key] = area.value;
      counter.textContent = `${area.value.length}/${LIMITS.note}`;
    });

    field.append(label, area, counter);
    return field;
  }

  #buildFooter() {
    const footer = el("footer", "ultrate-footer");

    const progress = el("div", "ultrate-progress");
    const dots = el("div", "ultrate-dots");
    for (let i = 0; i < CATEGORY_IDS.length; i++) {
      const dot = el("span", "ultrate-dot");
      this.#dots.push(dot);
      dots.appendChild(dot);
    }
    this.#countEl = el("span", "ultrate-progress-text");
    progress.append(dots, this.#countEl);

    const submit = el("button", "ultrate-submit", { type: "button" });
    submit.append(el("span", "ultrate-submit-label", {}, loc("ULTRATE.Rate.Submit")), icon("fa-solid fa-paper-plane ultrate-submit-icon"), icon("fa-solid fa-circle-notch ultrate-submit-spin"));
    submit.addEventListener("click", () => this.#submit());
    this.#submitEl = submit;

    footer.append(progress, submit);
    return footer;
  }

  #rated() {
    return CATEGORY_IDS.filter((id) => Number(this.values[id]) > 0).length;
  }

  #updateProgress() {
    const done = this.#rated();
    this.#dots.forEach((dot, i) => dot.classList.toggle("is-on", i < done));
    if (this.#countEl) {
      this.#countEl.textContent = done === CATEGORY_IDS.length
        ? loc("ULTRATE.Rate.AllRated")
        : fmt("ULTRATE.Rate.Progress", { done, total: CATEGORY_IDS.length });
    }
    if (this.#submitEl) {
      const ready = done === CATEGORY_IDS.length;
      this.#submitEl.classList.toggle("is-ready", ready);
      this.#submitEl.setAttribute("aria-disabled", String(!ready));
      this.#submitEl.title = ready ? "" : fmt("ULTRATE.Rate.Remaining", { count: CATEGORY_IDS.length - done });
    }
  }

  async #submit() {
    if (this.sending) return;
    if (this.#rated() < CATEGORY_IDS.length) {
      ui.notifications?.warn(fmt("ULTRATE.Rate.Remaining", { count: CATEGORY_IDS.length - this.#rated() }));
      this.#nudgeUnset();
      return;
    }

    this.sending = true;
    this.#submitEl?.classList.add("is-busy");

    const scores = {};
    for (const id of CATEGORY_IDS) scores[id] = Number(this.values[id]);

    const result = await submitVote({
      roundId: this.round.id,
      token: this.token,
      scores,
      good: this.round.notes ? this.good : "",
      bad: this.round.notes ? this.bad : ""
    });

    this.sending = false;
    this.#submitEl?.classList.remove("is-busy");

    if (!result.ok) {
      const key = `ULTRATE.Rate.Error.${result.reason}`;
      const text = game.i18n.has?.(key) ? loc(key) : loc("ULTRATE.Rate.Error.generic");
      ui.notifications?.error(text);
      return;
    }

    if (result.token) this.token = result.token;
    await saveMyVote(this.round.id, { token: this.token, scores, good: this.good, bad: this.bad });
    this.editing = false;
    this.mode = "thanks";
    this.render();
  }

  /** Shake the criteria that still have no value, so "why is it disabled" is obvious. */
  #nudgeUnset() {
    for (const id of CATEGORY_IDS) {
      if (Number(this.values[id]) > 0) continue;
      const card = this.element?.querySelector(`.ultrate-card[data-cat="${id}"]`);
      if (!card) continue;
      card.classList.remove("is-nudge");
      // Restart the animation.
      void card.offsetWidth;
      card.classList.add("is-nudge");
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Thank-you screen                                                   */
  /* ------------------------------------------------------------------ */

  #canEdit() {
    return this.round.allowEdit && (!this.round.anonymous || Boolean(this.token));
  }

  #buildThanks() {
    const root = el("div", "ultrate ultrate-rate ultrate-rate-thanks");
    root.appendChild(this.#buildHead());

    const box = el("div", "ultrate-thanks");

    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    mark.setAttribute("viewBox", "0 0 64 64");
    mark.setAttribute("class", "ultrate-check");
    mark.setAttribute("aria-hidden", "true");
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", "32");
    ring.setAttribute("cy", "32");
    ring.setAttribute("r", "28");
    ring.setAttribute("pathLength", "1");
    const tick = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tick.setAttribute("d", "M19 33.5 28 42.5 45.5 23");
    tick.setAttribute("pathLength", "1");
    mark.append(ring, tick);
    box.appendChild(mark);

    box.appendChild(el("h3", "ultrate-thanks-title", {}, loc("ULTRATE.Rate.Thanks")));
    box.appendChild(el("p", "ultrate-thanks-text", {}, loc(this.#canEdit() ? "ULTRATE.Rate.ThanksEditable" : "ULTRATE.Rate.ThanksFinal")));

    if (CATEGORY_IDS.every((id) => Number(this.values[id]) > 0)) {
      const recap = el("div", "ultrate-recap");
      for (const cat of resolveCategories(this.round.cats)) {
        const row = el("div", "ultrate-recap-item");
        row.append(el("span", "ultrate-recap-name", {}, cat.name), el("span", "ultrate-recap-value", {}, String(this.values[cat.id])));
        recap.appendChild(row);
      }
      box.appendChild(recap);
    }

    const actions = el("div", "ultrate-actions");
    if (this.#canEdit()) {
      const edit = button(loc("ULTRATE.Rate.Edit"), { icon: "fa-solid fa-pen", className: "ultrate-btn" });
      edit.addEventListener("click", () => {
        this.mode = "form";
        this.editing = true;
        this.render();
      });
      actions.appendChild(edit);
    }
    const close = button(loc("ULTRATE.Rate.Close"), { icon: "fa-solid fa-check", className: "ultrate-btn is-primary" });
    close.addEventListener("click", () => this.close());
    actions.appendChild(close);
    box.appendChild(actions);

    root.appendChild(box);
    return root;
  }
}
