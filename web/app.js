/* Process Monitor Data Organizer — front end.
 * Talks to the Python backend exclusively through window.pywebview.api.
 */

// Node and shift start times are global settings that apply to every
// module, not per-module state — the defaults below match the form's
// static HTML values so the two stay in sync from the very first render.
const state = {
  modules: [],
  active: null,
  node: "1",
  dayStart: "07:00",
  eveningStart: "15:00",
  nightStart: "23:00",
  scanStatus: {},
  // Modules that failed the last time they were attempted (bulk export, or
  // duplicate resolution cancelled) and haven't been revisited since —
  // step_id -> {type: "duplicates" | "error", message}. Drives a persistent
  // sidebar badge so a failure is never silently forgotten once a modal
  // closes; cleared the moment the user opens that module again.
  needsAttention: new Map(),
  lastBulkResults: [],
};

const api = () => window.pywebview.api;
const $ = (id) => document.getElementById(id);
const basename = (p) => (p || "").split(/[\\/]/).pop();
const THEME_STORAGE_KEY = "process-monitor-theme";

// Every window.pywebview.api.<method>() call below can, in principle, reject
// — the JS-API bridge translates an unexpected Python-side exception into a
// rejected promise. Most backend methods already catch their own errors and
// return {ok: false, message: ...}-style results, but this is the last line
// of defense against anything that slips through (or a bridge-level failure
// itself, e.g. the native window vanishing mid-call). Extracting a readable
// message from whatever shape the rejection takes keeps every catch site
// below from needing its own guesswork.
function errorMessage(err) {
  if (!err) return "An unknown error occurred.";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Last-resort safety net: if something still throws or rejects without ever
// reaching a local try/catch (a bug in this file, not just a backend call),
// surface it as a toast instead of leaving the UI stuck silently — the
// failure mode this app has hit before (a spinner or disabled button that
// never recovers because the code that would re-enable it never ran).
window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  showToast(`Unexpected error: ${errorMessage(event.reason)}`, "error");
});
window.addEventListener("error", (event) => {
  console.error("Unhandled error:", event.error || event.message);
});

// pywebview can inject window.pywebview and fire "pywebviewready" before this
// script has run and attached its listener (a known race condition) — so check
// for an already-ready bridge first, and only fall back to the event if it's
// not there yet. Checking for the actual method (not just the api object)
// matters: pywebview can create window.pywebview.api as an empty object
// briefly before the bound methods land on it, so a truthy-object check can
// still fire too early. Poll as a last-resort backstop either way.
const bridgeReady = () =>
  window.pywebview && window.pywebview.api && typeof window.pywebview.api.list_modules === "function";

let initialized = false;

function showBridgeError(message) {
  $("connection-badge").innerHTML =
    '<span class="status-dot status-dot-red" aria-hidden="true"></span><span>Connection failed</span>';
  const main = document.querySelector("main");
  if (main) {
    main.innerHTML = `<div class="bridge-error">${message}</div>`;
  }
}

async function init() {
  if (initialized) return;
  initialized = true;

  $("connection-badge").innerHTML =
    '<span class="status-dot status-dot-emerald" aria-hidden="true"></span><span>Ready</span>';

  try {
    state.modules = await api().list_modules();
    renderSidebar();
    wireStaticHandlers();
    updateSidebarStatus();

    const firstImplemented = state.modules.find((m) => m.implemented) || state.modules[0];
    await selectModule(firstImplemented.step_id);
  } catch (err) {
    initialized = false;
    showBridgeError(`Failed to load process modules from the Python backend: ${err && err.message ? err.message : err}`);
  }
}

// Kick things off. This runs after init/showBridgeError/initialized are all
// defined above, so calling init() immediately here (the fast path, when the
// bridge is already up) can never race the variable/function declarations.
if (bridgeReady()) {
  init();
} else {
  window.addEventListener("pywebviewready", () => { if (bridgeReady()) init(); });
  const pollForApi = setInterval(() => {
    if (bridgeReady()) {
      clearInterval(pollForApi);
      init();
    }
  }, 200);
  // Stop polling eventually and surface a real error instead of hanging forever.
  setTimeout(() => {
    clearInterval(pollForApi);
    if (!initialized) showBridgeError("The app's Python backend never connected (window.pywebview.api was not available after 15s).");
  }, 15000);
}

// Purely client-side — doesn't need the Python bridge, so it's wired
// immediately rather than waiting for init(). Toasts can appear even before
// (or if) the bridge ever connects (see the unhandledrejection listener
// above), so its dismiss button has to work unconditionally too.
wireThemeToggle();
$("toast-close").addEventListener("click", hideToast);

// Escape closes whichever modal is currently open, via the exact same
// button a mouse click would use — so it's guaranteed to run the same
// cleanup/state logic (cancelling a pending duplicate selection, resolving
// the overwrite-confirmation promise as "cancel", etc.) rather than a
// second, separately-maintained code path that could drift out of sync.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("duplicate-modal").classList.contains("hidden")) {
    $("duplicate-cancel").click();
  } else if (!$("bulk-export-modal").classList.contains("hidden")) {
    $("bulk-export-close").click();
  } else if (!$("overwrite-modal").classList.contains("hidden")) {
    $("overwrite-cancel").click();
  }
});

function wireThemeToggle() {
  const toggle = $("theme-toggle");
  const iconDark = $("theme-icon-dark");
  const iconLight = $("theme-icon-light");

  // Remember an explicit choice across restarts — without this, the toggle
  // only ever affects the current session and silently reverts to the OS
  // preference the next time the app opens.
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "dark" || stored === "light") {
      document.documentElement.dataset.theme = stored;
    }
  } catch {
    // Storage unavailable (e.g. restricted webview) — toggle still works
    // for this session, it just won't persist.
  }

  function isDarkActive() {
    const explicit = document.documentElement.dataset.theme;
    if (explicit === "dark") return true;
    if (explicit === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function syncIcon() {
    const dark = isDarkActive();
    iconDark.classList.toggle("hidden", dark);
    iconLight.classList.toggle("hidden", !dark);
  }

  toggle.addEventListener("click", () => {
    const next = isDarkActive() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Same as above — non-fatal if storage isn't available.
    }
    syncIcon();
  });

  syncIcon();
}

// ---------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------

function renderSidebar() {
  const nav = $("module-list");
  nav.innerHTML = "";
  state.modules.forEach((mod) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "module-btn";
    btn.dataset.stepId = mod.step_id;

    const label = document.createElement("span");
    label.className = "module-btn-label";
    label.textContent = `${mod.step_id}  ${mod.name}`;
    // Falls back to the full name on hover if it's ever truncated by the
    // ellipsis — the status pill next to it already gets this treatment.
    label.title = `${mod.step_id}  ${mod.name}`;
    btn.appendChild(label);

    const pill = document.createElement("span");
    pill.className = "status-pill status-pill-hidden";
    pill.dataset.stepId = mod.step_id;
    btn.appendChild(pill);

    btn.addEventListener("click", () => selectModule(mod.step_id));
    nav.appendChild(btn);
  });
}

function highlightSidebar() {
  document.querySelectorAll(".module-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.stepId === state.active);
  });
}

// Scans whatever input is currently effective for every module (its own
// individual input, or the universal input as a fallback) and shows a live
// row-count status next to each one in the sidebar — this is what makes
// picking the universal input visibly "reach" every module instead of
// silently only mattering once you happen to click into one.
//
// Resolved one module at a time (not one batch call) so the sidebar fills
// in incrementally as each result comes back, instead of sitting empty and
// then suddenly showing every count at once. The underlying file is only
// actually parsed once regardless (cached in Api._read_source_cached), so
// this doesn't add real scan time — it spreads the same work across ~11
// quick round-trips so progress is visible.
async function updateSidebarStatus() {
  const implementedModules = state.modules.filter((m) => m.implemented);

  // Not-implemented modules are a static fact, not something to scan.
  state.modules
    .filter((m) => !m.implemented)
    .forEach((mod) => {
      const pill = document.querySelector(`.status-pill[data-step-id="${mod.step_id}"]`);
      if (pill) applyStatusPill(pill, mod, null);
    });

  implementedModules.forEach((mod) => {
    const pill = document.querySelector(`.status-pill[data-step-id="${mod.step_id}"]`);
    if (pill) {
      pill.textContent = "Scanning…";
      pill.className = "status-pill status-pill-scanning";
      pill.title = "";
    }
  });

  for (const mod of implementedModules) {
    const pill = document.querySelector(`.status-pill[data-step-id="${mod.step_id}"]`);
    let info;
    try {
      info = await api().scan_module_status(mod.step_id);
      state.scanStatus[mod.step_id] = info;
    } catch (err) {
      info = { status: "error", row_count: null, message: (err && err.message) || String(err) };
    }
    if (pill) applyStatusPill(pill, mod, info);
  }
}

// Looks up the sidebar pill + module definition for a step and re-applies
// its status, picking up the current state.needsAttention flag without
// waiting for a full updateSidebarStatus() rescan — used to make a badge
// appear/disappear immediately after a bulk export result or a duplicate
// resolution, not just on the next scan pass.
function refreshSidebarPill(stepId) {
  const pill = document.querySelector(`.status-pill[data-step-id="${stepId}"]`);
  const mod = state.modules.find((m) => m.step_id === stepId);
  if (pill && mod) applyStatusPill(pill, mod, state.scanStatus[stepId] || null);
}

function setNeedsAttention(stepId, info) {
  state.needsAttention.set(stepId, info);
  refreshSidebarPill(stepId);
}

function clearNeedsAttention(stepId) {
  if (state.needsAttention.delete(stepId)) refreshSidebarPill(stepId);
}

function applyStatusPill(pill, mod, info) {
  if (!mod.implemented) {
    pill.textContent = "Not defined";
    pill.className = "status-pill status-pill-muted";
    pill.title = "Output format not defined for this station yet.";
    return;
  }
  // A module that failed the last time it was attempted (bulk export, or a
  // cancelled duplicate resolution) stays flagged until the user actually
  // opens it again, regardless of what a fresh row-count scan would
  // otherwise show — the scan can't see "this needs a decision from you."
  const attention = state.needsAttention.get(mod.step_id);
  if (attention) {
    pill.textContent = attention.type === "duplicates" ? "Needs review" : "Export failed";
    pill.className = "status-pill status-pill-error";
    pill.title = attention.message || "";
    return;
  }
  if (!info || info.status === "no_input") {
    pill.textContent = "";
    pill.className = "status-pill status-pill-hidden";
    pill.title = "";
    return;
  }
  if (info.status === "ready") {
    pill.textContent = `${info.row_count} row${info.row_count === 1 ? "" : "s"}`;
    pill.className = "status-pill status-pill-ready";
    pill.title = info.message;
  } else if (info.status === "empty") {
    pill.textContent = "No data";
    pill.className = "status-pill status-pill-warning";
    pill.title = info.message;
  } else {
    pill.textContent = "Error";
    pill.className = "status-pill status-pill-error";
    pill.title = info.message;
  }
}

// ---------------------------------------------------------------------
// Module selection
// ---------------------------------------------------------------------

// A needs-attention badge means "this module still needs a decision from
// you" — it must stay visible until the underlying issue is actually
// fixed (a successful preview/export, a new input, resolved duplicates),
// not just clear because the module was opened. Opening it to look is not
// the same as fixing it.
async function selectModule(stepId) {
  state.active = stepId;
  highlightSidebar();
  const mod = state.modules.find((m) => m.step_id === stepId);
  $("module-title").textContent = `${mod.step_id}  ${mod.name}`;

  let ctx;
  try {
    ctx = await api().get_context(stepId);
  } catch (err) {
    showToast(`Could not load ${mod.name}: ${errorMessage(err)}`, "error");
    ctx = { universal_input: "", module_input: "", output_path: "", has_preview: false };
  }
  if (ctx.error) {
    showToast(`Could not fully load ${mod.name}: ${ctx.error}`, "error");
  }
  $("universal-input-path").value = ctx.universal_input || "";

  if (mod.implemented) {
    $("not-implemented-panel").classList.add("hidden");
    $("module-panel").classList.remove("hidden");
    $("module-panel").classList.add("flex");

    $("module-note").textContent = `Working module · Monitor work center: ${mod.work_centers}`;
    $("station-input-label").textContent = `Individual ${mod.name} input file`;
    $("module-input-path").value = ctx.module_input || "";
    $("output-path").value = ctx.output_path || "";
    $("preview-title").textContent = `${mod.name} output preview`;

    resetPreviewUI("Select the Monitor Excel export.");
  } else {
    $("module-panel").classList.add("hidden");
    $("module-panel").classList.remove("flex");
    $("not-implemented-panel").classList.remove("hidden");
    $("module-note").textContent = "";
    const source = mod.work_centers ? `Monitor work center: ${mod.work_centers}` : "No Monitor work center confirmed";
    $("not-implemented-message").textContent =
      `${source} · Output format not defined. This module cannot preview or export yet.`;
  }
}

// ---------------------------------------------------------------------
// Static (non-module-specific) handlers
// ---------------------------------------------------------------------

function wireStaticHandlers() {
  $("universal-browse").addEventListener("click", async () => {
    try {
      const res = await api().pick_input_file("universal", state.active);
      if (res.error) {
        showToast(`Could not open the file picker: ${res.error}`, "error");
      } else if (res.path) {
        $("universal-input-path").value = res.path;
        applyOutputSuggestion(res.suggested_output);
        resetPreviewUI("Select the Monitor Excel export.");
        updateSidebarStatus();
        // A badge from a previous failure refers to the file that's now
        // gone — a fresh file deserves a fresh attempt, not a stale flag.
        clearNeedsAttention(state.active);
      }
    } catch (err) {
      showToast(`Could not select the universal input file: ${errorMessage(err)}`, "error");
    }
  });

  $("universal-clear").addEventListener("click", async () => {
    try {
      await api().clear_input("universal");
      $("universal-input-path").value = "";
      resetPreviewUI("Select the Monitor Excel export.");
      updateSidebarStatus();
      clearNeedsAttention(state.active);
    } catch (err) {
      showToast(`Could not clear the universal input: ${errorMessage(err)}`, "error");
    }
  });

  $("module-browse").addEventListener("click", async () => {
    try {
      const res = await api().pick_input_file(state.active, state.active);
      if (res.error) {
        showToast(`Could not open the file picker: ${res.error}`, "error");
      } else if (res.path) {
        $("module-input-path").value = res.path;
        applyOutputSuggestion(res.suggested_output);
        resetPreviewUI("Select the Monitor Excel export.");
        updateSidebarStatus();
        // Same reasoning as the universal-input case: a new file means the
        // old failure no longer applies.
        clearNeedsAttention(state.active);
      }
    } catch (err) {
      showToast(`Could not select the input file: ${errorMessage(err)}`, "error");
    }
  });

  $("module-clear").addEventListener("click", async () => {
    try {
      await api().clear_input(state.active);
      $("module-input-path").value = "";
      // The backend already dropped the stored output suggestion (it was
      // derived from the input that's now gone) — reflect that here too,
      // instead of leaving a filename with nothing behind it.
      $("output-path").value = "";
      resetPreviewUI("Select the Monitor Excel export.");
      updateSidebarStatus();
      clearNeedsAttention(state.active);
    } catch (err) {
      showToast(`Could not clear the input: ${errorMessage(err)}`, "error");
    }
  });

  $("output-browse").addEventListener("click", async () => {
    try {
      const current = $("output-path").value.trim();
      const defaultName = current ? basename(current) : "organized.xlsx";
      const res = await api().pick_output_file(state.active, defaultName);
      if (res.error) {
        showToast(`Could not open the file picker: ${res.error}`, "error");
      } else if (res.path) {
        $("output-path").value = res.path;
      }
    } catch (err) {
      showToast(`Could not select the output file: ${errorMessage(err)}`, "error");
    }
  });

  $("node-input").addEventListener("input", (e) => (state.node = e.target.value));
  $("day-start").addEventListener("input", (e) => (state.dayStart = e.target.value));
  $("evening-start").addEventListener("input", (e) => (state.eveningStart = e.target.value));
  $("night-start").addEventListener("input", (e) => (state.nightStart = e.target.value));

  $("node-input").addEventListener("blur", validateNode);
  $("day-start").addEventListener("blur", validateShiftTimes);
  $("evening-start").addEventListener("blur", validateShiftTimes);
  $("night-start").addEventListener("blur", validateShiftTimes);

  $("preview-btn").addEventListener("click", runPreview);
  $("export-btn").addEventListener("click", runExport);

  $("redo-duplicates-btn").addEventListener("click", async () => {
    try {
      await api().clear_duplicate_selections(state.active);
    } catch (err) {
      showToast(`Could not clear the previous duplicate selections: ${errorMessage(err)}`, "error");
      return;
    }
    await runPreview();
  });

  $("issues-toggle").addEventListener("click", () => {
    const banner = $("issues-banner");
    const expanded = banner.classList.toggle("expanded");
    $("issues-list").classList.toggle("hidden", !expanded);
  });

  $("error-detail-toggle").addEventListener("click", () => {
    const detailEl = $("error-detail");
    const toggle = $("error-detail-toggle");
    const showing = detailEl.classList.toggle("hidden") === false;
    toggle.textContent = showing ? "Hide technical details" : "Show technical details";
  });

  $("export-all-btn").addEventListener("click", runExportAll);
  $("bulk-export-close").addEventListener("click", () => closeBulkExportModal());

  $("duplicate-cancel").addEventListener("click", async () => {
    closeDuplicateModal();
    try {
      await api().cancel_duplicate_selection(state.active);
      setStatus("Duplicate selection cancelled.");
    } catch (err) {
      showToast(`Could not cancel cleanly: ${errorMessage(err)}`, "error");
      setStatus("Duplicate selection cancelled (with a backend error).");
    }
    $("preview-btn").disabled = false;
    // Leaving this unresolved is a real pending state, not a dead end —
    // flag it the same way a bulk-export duplicate failure would be, so
    // it isn't forgotten the moment the user clicks elsewhere.
    setNeedsAttention(state.active, {
      type: "duplicates",
      message: "Duplicate measurements need to be resolved before export.",
    });
  });

  $("duplicate-apply").addEventListener("click", async () => {
    const records = Array.from(document.querySelectorAll(".duplicate-record"));
    const selections = {};
    let allAnswered = true;

    // Mirrors the Node/Shift-time pattern: don't just say "something's
    // unanswered" in a toast, mark exactly which record/field it is so the
    // user isn't left hunting for it themselves.
    records.forEach((box) => {
      let boxAnswered = true;
      if (box.dataset.mode === "record") {
        const selectedCard = box.querySelector(".candidate-card.selected");
        if (!selectedCard) {
          boxAnswered = false;
        } else {
          Object.assign(selections, JSON.parse(selectedCard.dataset.selections));
        }
      } else {
        const selects = Array.from(box.querySelectorAll("select"));
        selects.forEach((sel) => {
          if (!sel.value) {
            boxAnswered = false;
            sel.classList.add("input-invalid");
          } else {
            sel.classList.remove("input-invalid");
            selections[sel.dataset.key] = parseInt(sel.value, 10);
          }
        });
      }
      box.classList.toggle("duplicate-record-invalid", !boxAnswered);
      if (!boxAnswered) allAnswered = false;
    });

    if (!allAnswered) {
      showToast("Resolve every duplicated record before continuing.", "error");
      return;
    }

    // Don't close (and clear) the modal until the backend has actually
    // confirmed the selections were saved — closing it destroys the
    // candidate-card DOM state, so a failure here used to mean the user's
    // just-made choices were simply gone, with no way to retry without
    // redoing the whole resolution from scratch.
    const applyBtn = $("duplicate-apply");
    applyBtn.disabled = true;
    try {
      await api().submit_duplicate_selection(state.active, selections);
    } catch (err) {
      applyBtn.disabled = false;
      showToast(`Could not save your duplicate selections: ${errorMessage(err)}`, "error");
      $("preview-btn").disabled = false;
      return;
    }
    applyBtn.disabled = false;
    clearNeedsAttention(state.active);
    closeDuplicateModal();
    setStatus("Applying selected duplicate measurements…");
    await runPreview();
  });
}

function applyOutputSuggestion(path) {
  if (path) $("output-path").value = path;
}

// ---------------------------------------------------------------------
// Inline field validation
// ---------------------------------------------------------------------

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function validateNode() {
  const el = $("node-input");
  const errorEl = $("node-error");
  if (!el.value.trim()) {
    errorEl.textContent = "Node is required — it isn't present in the Monitor export.";
    errorEl.classList.remove("hidden");
    el.classList.add("input-invalid");
    return false;
  }
  errorEl.classList.add("hidden");
  el.classList.remove("input-invalid");
  return true;
}

function validateShiftTimes() {
  const inputs = [$("day-start"), $("evening-start"), $("night-start")];
  const [day, evening, night] = inputs.map((el) => el.value.trim());
  const errorEl = $("shift-error");

  let message = "";
  if (!day || !evening || !night) {
    message = "Enter all three shift start times.";
  } else if (![day, evening, night].every((v) => TIME_PATTERN.test(v))) {
    message = "Shift times must be in 24-hour HH:MM format.";
  } else if (!(day < evening && evening < night)) {
    message = "Shift starts must be in order: DAY, then EVENING, then NIGHT.";
  }

  inputs.forEach((el) => el.classList.toggle("input-invalid", Boolean(message)));
  errorEl.textContent = message;
  errorEl.classList.toggle("hidden", !message);
  return !message;
}

// ---------------------------------------------------------------------
// Busy-state helper (loading spinners on Load/Export buttons)
// ---------------------------------------------------------------------

function setBusy(btn, busy, busyLabel) {
  const spinner = btn.querySelector(".btn-spinner");
  const label = btn.querySelector(".btn-label");
  const icon = btn.querySelector(".btn-icon");
  if (spinner) spinner.classList.toggle("hidden", !busy);
  if (icon) icon.classList.toggle("hidden", busy);
  if (label) {
    if (busy) {
      if (!label.dataset.restore) label.dataset.restore = label.textContent;
      label.textContent = busyLabel;
    } else if (label.dataset.restore) {
      label.textContent = label.dataset.restore;
      delete label.dataset.restore;
    }
  }
}

// ---------------------------------------------------------------------
// Error banner (persistent, with expandable technical detail)
// ---------------------------------------------------------------------

function showErrorBanner(message, detail) {
  const banner = $("error-banner");
  banner.classList.remove("hidden");
  $("error-message").textContent = message;
  const toggle = $("error-detail-toggle");
  const detailEl = $("error-detail");
  if (detail) {
    toggle.classList.remove("hidden");
    toggle.textContent = "Show technical details";
    detailEl.textContent = detail;
    detailEl.classList.add("hidden");
  } else {
    toggle.classList.add("hidden");
    detailEl.classList.add("hidden");
  }
}

function hideErrorBanner() {
  $("error-banner").classList.add("hidden");
  $("error-detail").classList.add("hidden");
}

// ---------------------------------------------------------------------
// Preview / export
// ---------------------------------------------------------------------

async function runPreview() {
  const nodeOk = validateNode();
  const shiftOk = validateShiftTimes();
  if (!nodeOk || !shiftOk) {
    showToast("Fix the highlighted field(s) before loading a preview.", "error");
    return;
  }

  hideErrorBanner();
  // A previous successful preview's issue count must not linger if this
  // attempt fails — otherwise a stale "N validation issues" banner sits
  // next to a brand-new, unrelated failure message.
  renderIssues(0, []);
  $("preview-btn").disabled = true;
  $("export-btn").disabled = true;
  setBusy($("preview-btn"), true, "Loading…");
  setStatus("Reading input…");

  let result;
  try {
    result = await api().load_preview(
      state.active,
      state.node,
      state.dayStart,
      state.eveningStart,
      state.nightStart
    );
  } catch (err) {
    setBusy($("preview-btn"), false);
    $("preview-btn").disabled = false;
    setStatus("Could not organize the selected file.");
    showErrorBanner(`Could not reach the Python backend: ${errorMessage(err)}`);
    return;
  }

  setBusy($("preview-btn"), false);
  $("preview-btn").disabled = false;

  if (!result.ok) {
    if (result.error === "duplicates") {
      openDuplicateModal(result.clusters);
      return;
    }
    setStatus("Could not organize the selected file.");
    if (result.error === "exception" && result.detail) {
      showErrorBanner(result.message || "Something went wrong.", result.detail);
    } else {
      showToast(result.message || "Something went wrong.", "error");
    }
    return;
  }

  renderPreview(result);
  $("export-btn").disabled = false;
  $("redo-duplicates-btn").classList.toggle("hidden", !result.has_duplicate_selections);
  // A preview that actually succeeds is real evidence this module is no
  // longer in trouble, regardless of which path got it here.
  clearNeedsAttention(state.active);
  const issuesSuffix = result.issue_count ? `; ${result.issue_count} validation issue(s)` : "";
  setStatus(`Preview ready: ${result.row_count} row(s)${issuesSuffix}.`);
}

async function runExport() {
  const outputPath = $("output-path").value.trim();
  if (!outputPath) {
    showToast("Select the output Excel file.", "error");
    return;
  }

  let mode = "overwrite";
  try {
    const existsCheck = await api().check_output_exists(state.active);
    if (existsCheck.error) {
      showToast(`Could not check the output file: ${existsCheck.error}`, "error");
      return;
    }
    if (existsCheck.exists) {
      mode = await confirmOverwrite(existsCheck.path);
      if (mode === "cancel") return;
    }
  } catch (err) {
    showToast(`Could not check the output file: ${errorMessage(err)}`, "error");
    return;
  }

  setBusy($("export-btn"), true, "Exporting…");
  $("export-btn").disabled = true;
  let result;
  try {
    result = await api().export(state.active, mode);
  } catch (err) {
    setBusy($("export-btn"), false);
    $("export-btn").disabled = false;
    showToast(`Export failed: ${errorMessage(err)}`, "error");
    return;
  }
  setBusy($("export-btn"), false);
  $("export-btn").disabled = false;
  if (result.ok) {
    clearNeedsAttention(state.active);
    if (typeof result.appended_count === "number") {
      setStatus(`Export complete: ${result.appended_count} new row(s) added (${result.total_count} total).`);
      showToast(
        `${result.appended_count} new row(s) appended (${result.total_count} total).\n${result.path}`,
        "success"
      );
    } else {
      setStatus(`Export complete: ${basename(result.path)}`);
      showToast(`Organized data exported successfully.\n${result.path}`, "success");
    }
  } else {
    showToast(result.message || "Export failed.", "error");
  }
}

// Resolves to "overwrite", "append", or "cancel".
function confirmOverwrite(path) {
  return confirmOverwriteMessage(`"${basename(path)}" already exists. Replace it, or add only the new rows?`);
}

function confirmBulkOverwrite(existing) {
  const names = existing.map((e) => `${e.step_id} ${e.name} ("${basename(e.path)}")`).join(", ");
  const isPlural = existing.length !== 1;
  const noun = isPlural ? "files" : "file";
  const verb = isPlural ? "exist" : "exists";
  return confirmOverwriteMessage(
    `${existing.length} ${noun} already ${verb}: ${names}. Replace them, or add only the new rows to each?`
  );
}

function confirmOverwriteMessage(message) {
  return new Promise((resolve) => {
    $("overwrite-message").textContent = message;
    $("overwrite-modal").classList.remove("hidden");
    $("overwrite-modal").classList.add("flex");
    // Land keyboard focus on Cancel, the non-destructive option, so a
    // stray Enter press right after the modal appears can't trigger
    // Overwrite/Append by accident.
    $("overwrite-cancel").focus();

    const confirmBtn = $("overwrite-confirm");
    const appendBtn = $("overwrite-append");
    const cancelBtn = $("overwrite-cancel");
    const cleanup = (result) => {
      $("overwrite-modal").classList.add("hidden");
      $("overwrite-modal").classList.remove("flex");
      confirmBtn.removeEventListener("click", onOverwrite);
      appendBtn.removeEventListener("click", onAppend);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    };
    const onOverwrite = () => cleanup("overwrite");
    const onAppend = () => cleanup("append");
    const onCancel = () => cleanup("cancel");
    confirmBtn.addEventListener("click", onOverwrite);
    appendBtn.addEventListener("click", onAppend);
    cancelBtn.addEventListener("click", onCancel);
  });
}

function renderPreview(result) {
  const head = $("preview-head");
  const body = $("preview-body");
  head.innerHTML = "";
  body.innerHTML = "";

  const headRow = document.createElement("tr");
  result.columns.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col;
    headRow.appendChild(th);
  });
  head.appendChild(headRow);

  result.rows.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value === null || value === undefined ? "" : value;
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });

  $("preview-empty").classList.toggle("hidden", result.rows.length > 0);
  if (result.previewed_count < result.row_count) {
    $("preview-title").textContent = `Output preview (first ${result.previewed_count} of ${result.row_count} rows)`;
  }

  renderIssues(result.issue_count, result.issues);
}

function renderIssues(issueCount, issues) {
  const banner = $("issues-banner");
  if (!issueCount) {
    banner.classList.add("hidden");
    banner.classList.remove("expanded");
    $("issues-list").classList.add("hidden");
    $("issues-list").innerHTML = "";
    return;
  }
  banner.classList.remove("hidden");
  $("issues-summary-text").textContent =
    `${issueCount} validation issue(s) found — unrecognized or missing measurements. Click to see details.`;

  const list = $("issues-list");
  list.innerHTML = "";
  (issues || []).forEach((issue) => {
    const li = document.createElement("li");
    const detail = document.createElement("div");
    detail.className = "issue-detail";
    detail.textContent = `${issue.Issue}: ${issue.Details}`;
    li.appendChild(detail);
    if (issue["Measuring report number"] !== undefined && issue["Measuring report number"] !== null) {
      const meta = document.createElement("div");
      meta.className = "issue-meta";
      meta.textContent = `Measuring report number ${issue["Measuring report number"]}`;
      li.appendChild(meta);
    }
    list.appendChild(li);
  });
}

function resetPreviewUI(statusMessage) {
  $("preview-head").innerHTML = "";
  $("preview-body").innerHTML = "";
  $("preview-empty").classList.remove("hidden");
  $("preview-title").textContent = "Output preview";
  renderIssues(0, []);
  hideErrorBanner();
  $("redo-duplicates-btn").classList.add("hidden");
  $("export-btn").disabled = true;
  setStatus(statusMessage);
}

function setStatus(text) {
  $("status-text").textContent = text;
}

// ---------------------------------------------------------------------
// Duplicate resolution modal
// ---------------------------------------------------------------------

function openDuplicateModal(clusters) {
  const container = $("duplicate-groups");
  container.innerHTML = "";

  clusters.forEach((cluster) => {
    const box = document.createElement("div");
    box.className = "duplicate-record";
    box.dataset.mode = cluster.mode;

    const title = document.createElement("p");
    title.className = "duplicate-record-title";
    title.textContent = `Report ${cluster.report}`;
    box.appendChild(title);

    if (cluster.mode === "record") {
      renderRecordCandidates(box, cluster);
    } else {
      renderFieldFallback(box, cluster);
    }

    container.appendChild(box);
  });

  $("duplicate-modal").classList.remove("hidden");
  $("duplicate-modal").classList.add("flex");
  $("duplicate-cancel").focus();
}

// Whole record was entered twice (or more) as a block: every affected
// measurement moves together, so this shows one candidate per submission —
// click a card to pick that entire version, not one dropdown per field.
function renderRecordCandidates(box, cluster) {
  const subtitle = document.createElement("p");
  subtitle.className = "duplicate-record-subtitle";
  const n = cluster.measurements.length;
  subtitle.textContent = `${n} measurement${n === 1 ? "" : "s"} duplicated together — pick which submission is correct.`;
  box.appendChild(subtitle);

  const row = document.createElement("div");
  row.className = "candidate-row";

  cluster.candidates.forEach((candidate) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "candidate-card";
    card.dataset.selections = JSON.stringify(candidate.selections);

    const header = document.createElement("div");
    header.className = "candidate-card-header";
    header.textContent = `Source row ${candidate.source_row}`;
    card.appendChild(header);

    const list = document.createElement("dl");
    list.className = "candidate-value-list";
    Object.entries(candidate.values).forEach(([measurement, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = measurement;
      const dd = document.createElement("dd");
      dd.textContent = value === null || value === undefined || value === "" ? "—" : value;
      list.appendChild(dt);
      list.appendChild(dd);
    });
    card.appendChild(list);

    card.addEventListener("click", () => {
      row.querySelectorAll(".candidate-card").forEach((el) => el.classList.remove("selected"));
      card.classList.add("selected");
      box.classList.remove("duplicate-record-invalid");
    });

    row.appendChild(card);
  });

  box.appendChild(row);
}

// Rare fallback: this record's affected measurements don't share the same
// number of duplicate entries (only some fields were individually
// duplicated), so a single "pick the record" choice wouldn't make sense —
// resolve those specific fields one at a time instead.
function renderFieldFallback(box, cluster) {
  cluster.groups.forEach((group) => {
    const fieldBox = document.createElement("div");
    fieldBox.className = "duplicate-group";

    const title = document.createElement("p");
    title.className = "duplicate-group-title";
    title.textContent = group.measurement;
    fieldBox.appendChild(title);

    const select = document.createElement("select");
    select.className = "input";
    select.dataset.key = group.key;

    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Select a source row…";
    select.appendChild(blank);

    group.choices.forEach((choice) => {
      const opt = document.createElement("option");
      opt.value = choice.index;
      opt.textContent =
        `Source row ${choice.source_row}  |  Value: ${choice.value}  |  ` +
        `Date: ${choice.date}  |  Batch: ${choice.batch}`;
      select.appendChild(opt);
    });

    select.addEventListener("change", () => {
      if (select.value) {
        select.classList.remove("input-invalid");
        if (![...box.querySelectorAll("select")].some((s) => !s.value)) {
          box.classList.remove("duplicate-record-invalid");
        }
      }
    });

    fieldBox.appendChild(select);
    box.appendChild(fieldBox);
  });
}

function closeDuplicateModal() {
  $("duplicate-modal").classList.add("hidden");
  $("duplicate-modal").classList.remove("flex");
  $("duplicate-groups").innerHTML = "";
}

// ---------------------------------------------------------------------
// Bulk export ("Export all ready modules")
// ---------------------------------------------------------------------

const CHECK_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>';
const X_ICON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>';

async function runExportAll() {
  const nodeOk = validateNode();
  const shiftOk = validateShiftTimes();
  if (!nodeOk || !shiftOk) {
    showToast("Fix the highlighted Node/shift fields before bulk export.", "error");
    return;
  }

  let mode = "overwrite";
  try {
    const overwriteCheck = await api().check_bulk_overwrites();
    if (overwriteCheck.error) {
      showToast(`Could not check for existing files: ${overwriteCheck.error}`, "error");
      return;
    }
    if (overwriteCheck.existing.length > 0) {
      mode = await confirmBulkOverwrite(overwriteCheck.existing);
      if (mode === "cancel") return;
    }
  } catch (err) {
    showToast(`Could not check for existing files: ${errorMessage(err)}`, "error");
    return;
  }

  const btn = $("export-all-btn");
  btn.disabled = true;
  setBusy(btn, true, "Exporting…");
  let result;
  try {
    result = await api().export_all_ready(
      state.node,
      state.dayStart,
      state.eveningStart,
      state.nightStart,
      mode
    );
  } catch (err) {
    btn.disabled = false;
    setBusy(btn, false);
    showToast(`Bulk export failed: ${errorMessage(err)}`, "error");
    return;
  }
  btn.disabled = false;
  setBusy(btn, false);

  renderBulkResults(result.results);
  updateSidebarStatus();
  if (result.results.some((r) => r.step_id === state.active)) {
    // Refresh the already-open panel's own fields with the bulk-export
    // outcome (renderBulkResults already set/cleared its needs-attention
    // badge above, based on whether it actually succeeded).
    await selectModule(state.active);
  }
}

function renderBulkResults(results) {
  state.lastBulkResults = results;
  const container = $("bulk-export-results");
  container.innerHTML = "";

  if (results.length === 0) {
    // Same icon + centered-text empty-state pattern used everywhere else
    // in the app (#preview-empty, #not-implemented-panel), instead of a
    // one-off plain paragraph.
    const empty = document.createElement("div");
    empty.className = "empty-state empty-state-inline";
    empty.innerHTML =
      '<span class="empty-state-icon">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/>' +
      '<line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>' +
      "</span>" +
      '<p class="empty-state-text">No modules currently have matching data to export.</p>';
    container.appendChild(empty);
  }

  results.forEach((r) => {
    // A module that just succeeded shouldn't keep a stale badge from an
    // earlier attempt; a module that just failed gets flagged immediately —
    // visible in the sidebar even before this modal is closed, and still
    // visible after, which is the whole point.
    if (r.ok) {
      clearNeedsAttention(r.step_id);
    } else {
      setNeedsAttention(r.step_id, {
        type: r.reason === "duplicates" ? "duplicates" : "error",
        message: r.message,
      });
    }

    const row = document.createElement("div");
    row.className = `bulk-result ${r.ok ? "ok" : "fail"}`;

    const icon = document.createElement("span");
    icon.className = "bulk-result-icon";
    icon.innerHTML = r.ok ? CHECK_ICON : X_ICON;
    row.appendChild(icon);

    const text = document.createElement("div");
    const name = document.createElement("p");
    name.className = "bulk-result-name";
    name.textContent = `${r.step_id}  ${r.name}`;
    text.appendChild(name);

    const detail = document.createElement("p");
    detail.className = "bulk-result-detail";
    if (r.ok && typeof r.appended_count === "number") {
      detail.textContent = `${r.appended_count} new row(s) added (${r.total_count} total) — ${r.path}`;
    } else {
      detail.textContent = r.ok ? r.path : r.message;
    }
    text.appendChild(detail);
    row.appendChild(text);

    if (!r.ok) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "btn btn-outline bulk-result-action";
      action.textContent = r.reason === "duplicates" ? "Resolve duplicates →" : "Open module →";
      action.addEventListener("click", async () => {
        closeBulkExportModal(true);
        // Guarantees a stale "still needs attention" toast from an earlier
        // Close can't linger on screen while this new resolution flow opens.
        hideToast();
        await selectModule(r.step_id);
        await runPreview();
      });
      row.appendChild(action);
    }

    container.appendChild(row);
  });

  $("bulk-export-modal").classList.remove("hidden");
  $("bulk-export-modal").classList.add("flex");
  $("bulk-export-close").focus();
}

// silent skips the summary toast — used when a row action (e.g. "Resolve
// duplicates") closes this modal on its way to actually fixing something;
// telling the user "still needs attention" in the same instant they've
// chosen to go resolve it is confusing, not guiding.
function closeBulkExportModal(silent = false) {
  $("bulk-export-modal").classList.add("hidden");
  $("bulk-export-modal").classList.remove("flex");
  if (silent) return;

  // Closing shouldn't be a dead end: say what's actually left, since the
  // sidebar badges alone are easy to miss right after a modal closes.
  if (state.lastBulkResults.length === 0) return;
  if (state.needsAttention.size > 0) {
    const n = state.needsAttention.size;
    showToast(
      `${n} module${n === 1 ? "" : "s"} still need${n === 1 ? "s" : ""} attention — look for the flagged badge in the sidebar.`,
      "error"
    );
  } else {
    showToast("All ready modules exported successfully.", "success");
  }
}

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------

let toastTimer = null;

function showToast(message, kind) {
  const el = $("toast");
  $("toast-message").textContent = message;
  el.className = `toast ${kind === "error" ? "toast-error" : "toast-success"}`;
  clearTimeout(toastTimer);
  // Errors get longer on screen — they're usually longer messages (a file
  // path, a backend error) and more important not to miss than a routine
  // success confirmation.
  const duration = kind === "error" ? 9000 : 6000;
  toastTimer = setTimeout(() => el.classList.add("hidden"), duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  $("toast").classList.add("hidden");
}
