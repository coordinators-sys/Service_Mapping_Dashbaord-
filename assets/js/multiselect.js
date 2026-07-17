// Compact searchable multi-select — vanilla JS, no dependencies.
//
// Owns NO filter state of its own: `filters` (filters.js) stays the single
// source of truth. This component renders options, reports changes via
// onChange, and re-reads its selection from sync().
//
// Options are {value, label, group?} objects. `group` drives the district
// headings under catchments/sites; headings are suppressed automatically
// when only one group is present (no point repeating "Baidoa" 17 times when
// the District filter already pins it).

const MS_MAX_PANEL_HEIGHT = 320;

function createMultiSelect(config) {
  return new MultiSelect(config);
}

class MultiSelect {
  constructor({
    dimension,
    container,
    label,
    placeholder,
    searchPlaceholder,
    countNoun,
    groupBy = false,
    onChange = () => {},
  }) {
    this.dimension = dimension;
    this.label = label;
    this.placeholder = placeholder || "All";
    this.searchPlaceholder = searchPlaceholder || "Search…";
    this.countNoun = countNoun || "options";
    this.groupBy = groupBy;
    this.onChange = onChange;

    this.options = [];
    this.selected = new Set();
    this.search = "";
    this.activeIndex = -1; // keyboard cursor over visible options
    this.isOpen = false;

    this.root = typeof container === "string" ? document.getElementById(container) : container;
    this.panelId = `ms-panel-${dimension}`;
    this.render();
    MultiSelect.instances.push(this);
  }

  static instances = [];

  static closeAll(except) {
    MultiSelect.instances.forEach((ms) => {
      if (ms !== except) ms.close();
    });
  }

  // ---------- DOM ----------

  render() {
    this.root.classList.add("ms");
    this.root.innerHTML = `
      <button type="button" class="ms-trigger" aria-haspopup="listbox" aria-expanded="false" aria-controls="${this.panelId}">
        <span class="ms-value"></span>
        <span class="ms-trigger-icons">
          <span class="ms-clear-btn" role="button" tabindex="-1" hidden aria-label="Clear">×</span>
          <svg class="ms-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        </span>
      </button>
      <div class="ms-panel" id="${this.panelId}" hidden>
        <div class="ms-panel-head">
          <div class="ms-search-wrap">
            <svg class="ms-search-icon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M9.2 9.2L12.5 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            <input type="text" class="ms-search" autocomplete="off" spellcheck="false" />
            <button type="button" class="ms-search-clear" hidden aria-label="Clear search">×</button>
          </div>
          <div class="ms-actions">
            <button type="button" class="ms-select-visible"></button>
            <button type="button" class="ms-clear-all"></button>
          </div>
          <div class="ms-count" aria-live="polite"></div>
        </div>
        <div class="ms-options" role="listbox" aria-multiselectable="true" tabindex="-1"></div>
      </div>`;

    this.trigger = this.root.querySelector(".ms-trigger");
    this.valueEl = this.root.querySelector(".ms-value");
    this.clearBtn = this.root.querySelector(".ms-clear-btn");
    this.panel = this.root.querySelector(".ms-panel");
    this.searchInput = this.root.querySelector(".ms-search");
    this.searchClear = this.root.querySelector(".ms-search-clear");
    this.selectVisibleBtn = this.root.querySelector(".ms-select-visible");
    this.clearAllBtn = this.root.querySelector(".ms-clear-all");
    this.countEl = this.root.querySelector(".ms-count");
    this.list = this.root.querySelector(".ms-options");

    this.bindEvents();
    this.renderChrome();
  }

  bindEvents() {
    this.trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      this.isOpen ? this.close() : this.open();
    });

    this.clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clear();
    });

    this.panel.addEventListener("click", (e) => e.stopPropagation());

    // Search is debounced (list re-render only); selections apply immediately.
    this.searchInput.addEventListener("input", () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.search = this.searchInput.value.trim().toLowerCase();
        this.searchClear.hidden = !this.searchInput.value;
        this.activeIndex = -1;
        this.renderList();
      }, 120);
    });

    this.searchClear.addEventListener("click", () => {
      this.searchInput.value = "";
      this.search = "";
      this.searchClear.hidden = true;
      this.renderList();
      this.searchInput.focus();
    });

    this.selectVisibleBtn.addEventListener("click", () => this.selectAllVisible());
    this.clearAllBtn.addEventListener("click", () => this.clear());

    this.trigger.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.open();
      }
    });

    this.panel.addEventListener("keydown", (e) => this.onPanelKeydown(e));
  }

  onPanelKeydown(e) {
    const visible = this.visibleOptions();
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      this.trigger.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.activeIndex = Math.min(this.activeIndex + 1, visible.length - 1);
      this.highlightActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.activeIndex = Math.max(this.activeIndex - 1, 0);
      this.highlightActive();
    } else if ((e.key === " " || e.key === "Enter") && this.activeIndex >= 0) {
      e.preventDefault();
      this.toggleValue(visible[this.activeIndex].value);
    }
  }

  highlightActive() {
    const rows = Array.from(this.list.querySelectorAll(".ms-option"));
    rows.forEach((row, i) => row.classList.toggle("ms-active", i === this.activeIndex));
    const active = rows[this.activeIndex];
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  // Translatable chrome — re-applied on language change.
  renderChrome() {
    this.searchInput.placeholder = this.searchPlaceholder;
    this.selectVisibleBtn.textContent = t("ms_select_visible");
    this.clearAllBtn.textContent = t("ms_clear");
    this.renderTrigger();
  }

  // ---------- Data ----------

  // Returns true when the incoming option set invalidated existing
  // selections (cascade removed them) — filters.js uses this to notify.
  setOptions(options) {
    this.options = options;
    const valid = new Set(options.map((o) => o.value));
    const removed = [];
    this.selected.forEach((v) => {
      if (!valid.has(v)) {
        this.selected.delete(v);
        removed.push(v);
      }
    });
    this.renderTrigger();
    if (this.isOpen) this.renderList();
    return removed;
  }

  sync(values) {
    this.selected = new Set(values);
    this.renderTrigger();
    if (this.isOpen) this.renderList();
  }

  getSelected() {
    return Array.from(this.selected);
  }

  visibleOptions() {
    if (!this.search) return this.options;
    return this.options.filter((o) => {
      const haystack = `${o.label} ${o.group || ""}`.toLowerCase();
      return haystack.includes(this.search);
    });
  }

  labelFor(value) {
    const found = this.options.find((o) => o.value === value);
    if (!found) return value;
    return found.group && this.showGroups() ? `${found.group} · ${found.label}` : found.label;
  }

  // Group headings only earn their space when the OPTIONS actually span more
  // than one group — deliberately keyed off the data, not off "is exactly one
  // district selected". Those usually agree, but not always: a handful of
  // master-list sites carry a Baidoa district label with Mogadishu
  // coordinates, so "district = Baidoa" really does yield Kahda/Daynile
  // catchments. Suppressing headings on the district-count rule would render
  // two different "CA03" rows as indistinguishable duplicates; this rule
  // degrades safely and surfaces the anomaly instead.
  showGroups() {
    if (!this.groupBy) return false;
    const groups = new Set(this.options.map((o) => o.group).filter(Boolean));
    return groups.size > 1;
  }

  toggleValue(value) {
    if (this.selected.has(value)) this.selected.delete(value);
    else this.selected.add(value);
    this.renderTrigger();
    this.renderList();
    this.onChange(this.getSelected());
  }

  selectAllVisible() {
    this.visibleOptions().forEach((o) => this.selected.add(o.value));
    this.renderTrigger();
    this.renderList();
    this.onChange(this.getSelected());
  }

  clear() {
    if (!this.selected.size) return;
    this.selected.clear();
    this.renderTrigger();
    if (this.isOpen) this.renderList();
    this.onChange([]);
  }

  // ---------- Rendering ----------

  renderTrigger() {
    const n = this.selected.size;
    if (n === 0) {
      this.valueEl.textContent = this.placeholder;
      this.valueEl.classList.add("ms-value-empty");
    } else if (n === 1) {
      this.valueEl.textContent = this.labelFor(Array.from(this.selected)[0]);
      this.valueEl.classList.remove("ms-value-empty");
    } else {
      this.valueEl.textContent = t("ms_n_selected", { n });
      this.valueEl.classList.remove("ms-value-empty");
    }
    this.valueEl.title = n > 1 ? Array.from(this.selected).map((v) => this.labelFor(v)).join(", ") : "";
    this.clearBtn.hidden = n === 0;
    this.trigger.classList.toggle("ms-trigger-active", n > 0);
  }

  renderList() {
    const visible = this.visibleOptions();
    this.countEl.textContent = t("ms_count", {
      n: visible.length.toLocaleString(),
      noun: this.countNoun,
      selected: this.selected.size,
    });
    this.clearAllBtn.disabled = this.selected.size === 0;
    this.selectVisibleBtn.disabled = visible.length === 0;

    if (!visible.length) {
      this.list.innerHTML = `<div class="ms-empty">${t("ms_no_match", { noun: this.countNoun })}</div>`;
      return;
    }

    const useGroups = this.showGroups();
    let html = "";
    let lastGroup = null;
    visible.forEach((o, i) => {
      if (useGroups && o.group !== lastGroup) {
        html += `<div class="ms-group-head">${escapeHtml(o.group || "—")}</div>`;
        lastGroup = o.group;
      }
      const checked = this.selected.has(o.value);
      const full = o.group && useGroups ? `${o.group} · ${o.label}` : o.label;
      html += `
        <div class="ms-option${checked ? " ms-selected" : ""}" role="option" aria-selected="${checked}"
             data-value="${escapeHtml(o.value)}" data-index="${i}" title="${escapeHtml(full)}">
          <span class="ms-check" aria-hidden="true">${checked ? "✓" : ""}</span>
          <span class="ms-option-label">${escapeHtml(o.label)}</span>
        </div>`;
    });
    this.list.innerHTML = html;

    this.list.querySelectorAll(".ms-option").forEach((row) => {
      row.addEventListener("click", () => this.toggleValue(row.dataset.value));
    });
  }

  // ---------- Open / close / position ----------

  open() {
    if (this.isOpen) return;
    MultiSelect.closeAll(this);
    this.isOpen = true;
    this.panel.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    this.renderList();
    this.position();
    this.searchInput.focus();
    this._reposition = () => this.position();
    window.addEventListener("resize", this._reposition);
    window.addEventListener("scroll", this._reposition, true);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.panel.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    this.activeIndex = -1;
    if (this._reposition) {
      window.removeEventListener("resize", this._reposition);
      window.removeEventListener("scroll", this._reposition, true);
      this._reposition = null;
    }
  }

  // Flip upward when there isn't room below (sticky filter bar sits high on
  // the page, so downward is usually right — but not on short viewports).
  position() {
    if (!this.isOpen) return;
    this.panel.classList.remove("ms-panel-up");
    const rect = this.trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const needed = Math.min(MS_MAX_PANEL_HEIGHT, this.panel.scrollHeight) + 12;
    if (spaceBelow < needed && rect.top > spaceBelow) this.panel.classList.add("ms-panel-up");
  }

  destroy() {
    this.close();
    clearTimeout(this._searchTimer);
    this.root.innerHTML = "";
    MultiSelect.instances = MultiSelect.instances.filter((ms) => ms !== this);
  }
}

function escapeHtml(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

document.addEventListener("click", () => MultiSelect.closeAll());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") MultiSelect.closeAll();
});
