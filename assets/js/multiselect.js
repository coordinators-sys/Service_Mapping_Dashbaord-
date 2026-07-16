// Searchable multi-select dropdown — vanilla JS, no library. One instance
// per filter dimension; filters.js owns the instances and syncs them with
// the central `filters` Sets.
//
// Features: search box, Select all (of the currently-searched subset),
// Clear, checkbox option list, "N selected" summary on the trigger button.

class MultiSelect {
  constructor(containerId, { label, onChange }) {
    this.container = document.getElementById(containerId);
    this.onChange = onChange;
    this.options = []; // [[value, label]]
    this.selected = new Set();
    this.search = "";

    this.container.classList.add("ms-wrap");
    this.container.innerHTML = `
      <button type="button" class="ms-btn" aria-haspopup="listbox" aria-expanded="false">
        <span class="ms-btn-label"></span>
        <span class="ms-caret">▾</span>
      </button>
      <div class="ms-panel hidden">
        <input type="text" class="ms-search" />
        <div class="ms-actions">
          <button type="button" class="ms-select-all"></button>
          <button type="button" class="ms-clear"></button>
        </div>
        <div class="ms-list" role="listbox" aria-multiselectable="true"></div>
      </div>`;

    this.btn = this.container.querySelector(".ms-btn");
    this.btnLabel = this.container.querySelector(".ms-btn-label");
    this.panel = this.container.querySelector(".ms-panel");
    this.searchInput = this.container.querySelector(".ms-search");
    this.list = this.container.querySelector(".ms-list");
    this.selectAllBtn = this.container.querySelector(".ms-select-all");
    this.clearBtn = this.container.querySelector(".ms-clear");

    this.btn.addEventListener("click", (e) => {
      e.stopPropagation();
      MultiSelect.closeAllExcept(this);
      this.panel.classList.toggle("hidden");
      this.btn.setAttribute("aria-expanded", String(!this.panel.classList.contains("hidden")));
      if (!this.panel.classList.contains("hidden")) this.searchInput.focus();
    });
    this.panel.addEventListener("click", (e) => e.stopPropagation());
    this.searchInput.addEventListener("input", () => {
      this.search = this.searchInput.value.toLowerCase().trim();
      this.renderList();
    });
    this.selectAllBtn.addEventListener("click", () => {
      this.visibleOptions().forEach(([v]) => this.selected.add(v));
      this.renderList();
      this.renderButton();
      this.onChange(Array.from(this.selected));
    });
    this.clearBtn.addEventListener("click", () => {
      this.selected.clear();
      this.renderList();
      this.renderButton();
      this.onChange([]);
    });

    MultiSelect.instances.push(this);
    this.renderChrome();
    this.renderButton();
  }

  static instances = [];

  static closeAll() {
    MultiSelect.instances.forEach((ms) => {
      ms.panel.classList.add("hidden");
      ms.btn.setAttribute("aria-expanded", "false");
    });
  }

  static closeAllExcept(keep) {
    MultiSelect.instances.forEach((ms) => {
      if (ms !== keep) {
        ms.panel.classList.add("hidden");
        ms.btn.setAttribute("aria-expanded", "false");
      }
    });
  }

  // Re-apply translatable chrome (placeholder/buttons/summary) — called on
  // construction and again whenever the interface language changes.
  renderChrome() {
    this.searchInput.placeholder = t("ms_search");
    this.selectAllBtn.textContent = t("ms_select_all");
    this.clearBtn.textContent = t("ms_clear");
    this.renderButton();
  }

  visibleOptions() {
    if (!this.search) return this.options;
    return this.options.filter(([, label]) => String(label).toLowerCase().includes(this.search));
  }

  setOptions(options) {
    this.options = options;
    // Drop selections whose value no longer exists (cascading narrowed them away).
    const valid = new Set(options.map(([v]) => v));
    let changed = false;
    Array.from(this.selected).forEach((v) => {
      if (!valid.has(v)) {
        this.selected.delete(v);
        changed = true;
      }
    });
    this.renderList();
    this.renderButton();
    return changed;
  }

  setSelected(values) {
    this.selected = new Set(values);
    this.renderList();
    this.renderButton();
  }

  getSelected() {
    return Array.from(this.selected);
  }

  renderButton() {
    const n = this.selected.size;
    if (n === 0) this.btnLabel.textContent = t("ms_all");
    else if (n === 1) this.btnLabel.textContent = this.labelFor(Array.from(this.selected)[0]);
    else this.btnLabel.textContent = t("ms_n_selected", { n });
    this.btn.classList.toggle("ms-btn-active", n > 0);
  }

  labelFor(value) {
    const found = this.options.find(([v]) => v === value);
    return found ? found[1] : value;
  }

  renderList() {
    const visible = this.visibleOptions();
    this.list.innerHTML = visible.length
      ? visible
          .map(
            ([value, label]) => `
        <label class="ms-option" role="option" aria-selected="${this.selected.has(value)}">
          <input type="checkbox" value="${String(value).replace(/"/g, "&quot;")}" ${this.selected.has(value) ? "checked" : ""} />
          <span>${label}</span>
        </label>`
          )
          .join("")
      : `<div class="ms-empty">${t("ms_no_options")}</div>`;

    this.list.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) this.selected.add(cb.value);
        else this.selected.delete(cb.value);
        this.renderButton();
        this.onChange(Array.from(this.selected));
      });
    });
  }
}

document.addEventListener("click", () => MultiSelect.closeAll());
