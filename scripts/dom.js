/**
 * ULT's Session Rating — small DOM helpers and the reusable controls.
 *
 * Everything is built with createElement and textContent, never innerHTML, so
 * user-typed text (titles, notes, category names) can never become markup.
 */

import { SCALE, getAppearance, valueColor, loc } from "./settings.js";

export function el(tag, className = null, attrs = {}, text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  if (text !== null) node.textContent = String(text);
  return node;
}

export function icon(classes) {
  return el("i", classes, { "aria-hidden": "true" });
}

export function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** A button with an icon and a label. */
export function button(label, { icon: iconClass = null, className = "ultrate-btn", title = null } = {}) {
  const b = el("button", className, { type: "button", title });
  if (iconClass) b.appendChild(icon(iconClass));
  if (label) b.appendChild(el("span", null, {}, label));
  return b;
}

/** Hand a text to the user as a downloaded file. */
export function downloadText(filename, text, mime = "application/json") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* -------------------------------------------------------------------------- */
/*  Rolling number                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A number that slides to its new value: a vertical strip of "–, 1 … 10"
 * inside a one-line window, moved with a CSS transition.
 */
export function createRoll() {
  const root = el("div", "ultrate-roll", { "aria-hidden": "true" });
  const strip = el("div", "ultrate-roll-strip");
  strip.appendChild(el("span", null, {}, "–"));
  for (let i = SCALE.min; i <= SCALE.max; i++) strip.appendChild(el("span", null, {}, String(i)));
  root.appendChild(strip);

  return {
    root,
    set(value) {
      const index = value >= SCALE.min ? value - SCALE.min + 1 : 0;
      strip.style.transform = `translateY(-${index}em)`;
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Slider                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The 1–10 slider. Integers only. It starts *unset* (value 0): the thumb sits
 * in the middle, dimmed and breathing, and the player has to choose — so an
 * untouched criterion can never be submitted by accident as a "5".
 *
 * Built from divs and pointer events instead of <input type="range"> so a click
 * on a stop always counts as a choice (a native range does not fire when the
 * value would not change) and so the thumb and fill can glide.
 */
export function createSlider({ label, value = 0, disabled = false, appearance = null, onChange = () => {} }) {
  const root = el("div", "ultrate-slider", {
    role: "slider",
    tabindex: disabled ? "-1" : "0",
    "aria-label": label,
    "aria-valuemin": SCALE.min,
    "aria-valuemax": SCALE.max
  });
  const track = el("div", "ultrate-track");
  const fill = el("div", "ultrate-fill");
  track.appendChild(fill);
  for (let i = SCALE.min; i <= SCALE.max; i++) {
    const tick = el("span", "ultrate-tick");
    tick.style.left = `${((i - SCALE.min) / (SCALE.max - SCALE.min)) * 100}%`;
    track.appendChild(tick);
  }
  const thumb = el("div", "ultrate-thumb");
  track.appendChild(thumb);
  root.appendChild(track);

  let current = value;
  let locked = disabled;
  let dragging = false;

  const paint = () => {
    const set = current >= SCALE.min;
    const t = set ? (current - SCALE.min) / (SCALE.max - SCALE.min) : 0.5;
    root.style.setProperty("--t", String(t));
    root.style.setProperty("--tf", set ? String(t) : "0");
    root.style.setProperty("--ur-fill", valueColor(t, appearance ?? getAppearance()));
    root.classList.toggle("is-unset", !set);
    root.classList.toggle("is-locked", locked);
    if (set) root.setAttribute("aria-valuenow", String(current));
    else root.removeAttribute("aria-valuenow");
  };

  const choose = (next, { silent = false } = {}) => {
    const v = clamp(Math.round(next), SCALE.min, SCALE.max);
    const changed = v !== current;
    const wasUnset = current < SCALE.min;
    current = v;
    paint();
    if (!silent && (changed || wasUnset)) onChange(v);
  };

  const fromPointer = (event) => {
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const t = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    choose(SCALE.min + t * (SCALE.max - SCALE.min));
  };

  root.addEventListener("pointerdown", (event) => {
    if (locked || (event.button !== undefined && event.button !== 0)) return;
    dragging = true;
    root.classList.add("is-dragging");
    try {
      root.setPointerCapture(event.pointerId);
    } catch (err) {
      /* capture is a nicety */
    }
    root.focus({ preventScroll: true });
    fromPointer(event);
    event.preventDefault();
  });
  root.addEventListener("pointermove", (event) => {
    if (dragging) fromPointer(event);
  });
  const stop = () => {
    dragging = false;
    root.classList.remove("is-dragging");
  };
  root.addEventListener("pointerup", stop);
  root.addEventListener("pointercancel", stop);
  root.addEventListener("lostpointercapture", stop);

  root.addEventListener("keydown", (event) => {
    if (locked) return;
    const base = current >= SCALE.min ? current : 5;
    let next = null;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp":
        next = current >= SCALE.min ? base + 1 : base;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next = current >= SCALE.min ? base - 1 : base;
        break;
      case "PageUp":
        next = base + 2;
        break;
      case "PageDown":
        next = base - 2;
        break;
      case "Home":
        next = SCALE.min;
        break;
      case "End":
        next = SCALE.max;
        break;
      default:
        if (/^[1-9]$/.test(event.key)) next = Number(event.key);
        else if (event.key === "0") next = SCALE.max;
    }
    if (next === null) return;
    event.preventDefault();
    choose(next);
  });

  paint();

  return {
    root,
    get value() {
      return current;
    },
    set(v, options) {
      choose(v, options);
    },
    repaint: paint,
    setLocked(flag) {
      locked = Boolean(flag);
      root.tabIndex = locked ? -1 : 0;
      paint();
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  Description popover                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One shared popover per window. An anchor shows it on hover or keyboard focus
 * and pins it on click (which is what makes it usable on a touch screen);
 * clicking anywhere else, or pressing Escape, lets it go.
 *
 * `container` must be `position: relative` and must not scroll: the popover is
 * placed inside it and kept within its edges.
 */
export function createPopover(container) {
  const tip = el("div", "ultrate-tip", { role: "tooltip" });
  container.appendChild(tip);

  let pinned = null;
  let shown = null;

  const place = (anchor) => {
    const box = container.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = clamp(a.left - box.left + a.width / 2 - w / 2, 10, Math.max(10, box.width - w - 10));
    let top = a.bottom - box.top + 10;
    if (top + h > box.height - 8) top = Math.max(8, a.top - box.top - h - 10);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    const arrow = clamp(a.left - box.left + a.width / 2 - left, 14, Math.max(14, w - 14));
    tip.style.setProperty("--arrow-x", `${arrow}px`);
  };

  const show = (anchor, data) => {
    shown = anchor;
    tip.replaceChildren(el("div", "ultrate-tip-title", {}, data.name), el("p", "ultrate-tip-desc", {}, data.desc));
    if (data.also?.length) {
      const also = el("div", "ultrate-tip-also");
      also.appendChild(el("span", "ultrate-tip-also-label", {}, loc("ULTRATE.Tip.Also")));
      const chips = el("div", "ultrate-chips");
      for (const item of data.also) chips.appendChild(el("span", "ultrate-chip", {}, item));
      also.appendChild(chips);
      tip.appendChild(also);
    }
    place(anchor);
    tip.classList.add("is-open");
  };

  const hide = () => {
    shown = null;
    pinned = null;
    tip.classList.remove("is-open");
    for (const node of container.querySelectorAll(".is-pinned")) node.classList.remove("is-pinned");
  };

  container.addEventListener("pointerdown", (event) => {
    if (pinned && !pinned.contains(event.target) && !tip.contains(event.target)) hide();
  });
  container.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && shown) {
      event.stopPropagation();
      hide();
    }
  });

  return {
    element: tip,
    bind(anchor, data) {
      anchor.addEventListener("mouseenter", () => {
        if (!pinned) show(anchor, data);
      });
      anchor.addEventListener("mouseleave", () => {
        if (!pinned) {
          shown = null;
          tip.classList.remove("is-open");
        }
      });
      anchor.addEventListener("focus", () => {
        if (!pinned) show(anchor, data);
      });
      anchor.addEventListener("blur", () => {
        if (!pinned) {
          shown = null;
          tip.classList.remove("is-open");
        }
      });
      anchor.addEventListener("click", (event) => {
        event.preventDefault();
        if (pinned === anchor) {
          hide();
          return;
        }
        hide();
        pinned = anchor;
        anchor.classList.add("is-pinned");
        show(anchor, data);
      });
    },
    hide
  };
}
