/* Process Monitor Data Organizer — front end.
 * Talks to the Python backend exclusively through window.pywebview.api.
 */

const state = {
  modules: [],
  active: null,
  node: "",
  dayStart: "",
  eveningStart: "",
  nightStart: "",
  scanStatus: {},
};

const api = () => window.pywebview.api;
const $ = (id) => document.getElementById(id);
const basename = (p) => (p || "").split(/[\\/]/).pop();

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
    '<span class="status-dot status-dot-red"></span><span>Connection failed</span>';
  const main = document.querySelector("main");
  if (main) {
    main.innerHTML = `<div class="bridge-error">${message}</div>`;
  }
}

async function init() {
  if (initialized) return;
  initialized = true;

  $("connection-badge").innerHTML =
    '<span class="status-dot status-dot-emerald"></span><span>Ready</span>';

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
async function updateSidebarStatus() {
  let status;
  try {
    status = await api().scan_status();
  } catch (err) {
    return; // Non-critical: leave existing pills as-is if the scan itself fails.
  }
  state.scanStatus = status;
  state.modules.forEach((mod) => {
    const pill = document.querySelector(`.status-pill[data-step-id="${mod.step_id}"]`);
    if (!pill) return;
    applyStatusPill(pill, mod, status[mod.step_id]);
  });
}

function applyStatusPill(pill, mod, info) {
  if (!mod.implemented) {
    pill.textContent = "Not defined";
    pill.className = "status-pill status-pill-muted";
    pill.title = "Output format not defined for this station yet.";
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

async function selectModule(stepId) {
  state.active = stepId;
  highlightSidebar();
  const mod = state.modules.find((m) => m.step_id === stepId);
  $("module-title").textContent = `${mod.step_id}  ${mod.name}`;

  const ctx = await api().get_context(stepId);
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

    $("node-input").value = state.node;
    $("day-start").value = state.dayStart;
    $("evening-start").value = state.eveningStart;
    $("night-start").value = state.nightStart;

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
    const res = await api().pick_input_file("universal", state.active);
    if (res.path) {
      $("universal-input-path").value = res.path;
      applyOutputSuggestion(res.suggested_output);
      resetPreviewUI("Select the Monitor Excel export.");
      updateSidebarStatus();
    }
  });

  $("universal-clear").addEventListener("click", async () => {
    await api().clear_input("universal");
    $("universal-input-path").value = "";
    resetPreviewUI("Select the Monitor Excel export.");
    updateSidebarStatus();
  });

  $("module-browse").addEventListener("click", async () => {
    const res = await api().pick_input_file(state.active, state.active);
    if (res.path) {
      $("module-input-path").value = res.path;
      applyOutputSuggestion(res.suggested_output);
      resetPreviewUI("Select the Monitor Excel export.");
      updateSidebarStatus();
    }
  });

  $("module-clear").addEventListener("click", async () => {
    await api().clear_input(state.active);
    $("module-input-path").value = "";
    resetPreviewUI("Select the Monitor Excel export.");
    updateSidebarStatus();
  });

  $("output-browse").addEventListener("click", async () => {
    const current = $("output-path").value.trim();
    const defaultName = current ? basename(current) : "organized.xlsx";
    const res = await api().pick_output_file(state.active, defaultName);
    if (res.path) $("output-path").value = res.path;
  });

  $("node-input").addEventListener("input", (e) => (state.node = e.target.value));
  $("day-start").addEventListener("input", (e) => (state.dayStart = e.target.value));
  $("evening-start").addEventListener("input", (e) => (state.eveningStart = e.target.value));
  $("night-start").addEventListener("input", (e) => (state.nightStart = e.target.value));

  $("preview-btn").addEventListener("click", runPreview);
  $("export-btn").addEventListener("click", runExport);

  $("duplicate-cancel").addEventListener("click", async () => {
    closeDuplicateModal();
    await api().cancel_duplicate_selection(state.active);
    setStatus("Duplicate selection cancelled.");
    $("preview-btn").disabled = false;
  });

  $("duplicate-apply").addEventListener("click", async () => {
    const selects = Array.from(document.querySelectorAll("#duplicate-groups select"));
    if (selects.some((sel) => !sel.value)) {
      showToast("Select one source row for every duplicate measurement.", "error");
      return;
    }
    const selections = {};
    selects.forEach((sel) => (selections[sel.dataset.key] = parseInt(sel.value, 10)));
    closeDuplicateModal();
    await api().submit_duplicate_selection(state.active, selections);
    setStatus("Applying selected duplicate measurements…");
    await runPreview();
  });
}

function applyOutputSuggestion(path) {
  if (path) $("output-path").value = path;
}

// ---------------------------------------------------------------------
// Preview / export
// ---------------------------------------------------------------------

async function runPreview() {
  $("preview-btn").disabled = true;
  $("export-btn").disabled = true;
  setStatus("Reading input…");

  const result = await api().load_preview(
    state.active,
    state.node,
    state.dayStart,
    state.eveningStart,
    state.nightStart
  );

  $("preview-btn").disabled = false;

  if (!result.ok) {
    if (result.error === "duplicates") {
      openDuplicateModal(result.groups);
      return;
    }
    setStatus("Could not organize the selected file.");
    showToast(result.message || "Something went wrong.", "error");
    return;
  }

  renderPreview(result);
  $("export-btn").disabled = false;
  const issuesSuffix = result.issue_count ? `; ${result.issue_count} validation issue(s)` : "";
  setStatus(`Preview ready: ${result.row_count} row(s)${issuesSuffix}.`);
}

async function runExport() {
  const outputPath = $("output-path").value.trim();
  if (!outputPath) {
    showToast("Select the output Excel file.", "error");
    return;
  }
  $("export-btn").disabled = true;
  const result = await api().export(state.active);
  $("export-btn").disabled = false;
  if (result.ok) {
    setStatus(`Export complete: ${basename(result.path)}`);
    showToast(`Organized data exported successfully.\n${result.path}`, "success");
  } else {
    showToast(result.message || "Export failed.", "error");
  }
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

  if (result.issue_count) {
    $("issues-banner").classList.remove("hidden");
    $("issues-banner").textContent =
      `${result.issue_count} validation issue(s) found — unrecognized or missing measurements. ` +
      `They will be written to the Validation_Issues sheet on export.`;
  } else {
    $("issues-banner").classList.add("hidden");
  }
}

function resetPreviewUI(statusMessage) {
  $("preview-head").innerHTML = "";
  $("preview-body").innerHTML = "";
  $("preview-empty").classList.remove("hidden");
  $("preview-title").textContent = "Output preview";
  $("issues-banner").classList.add("hidden");
  $("export-btn").disabled = true;
  setStatus(statusMessage);
}

function setStatus(text) {
  $("status-text").textContent = text;
}

// ---------------------------------------------------------------------
// Duplicate resolution modal
// ---------------------------------------------------------------------

function openDuplicateModal(groups) {
  const container = $("duplicate-groups");
  container.innerHTML = "";
  groups.forEach((group) => {
    const box = document.createElement("div");
    box.className = "duplicate-group";

    const title = document.createElement("p");
    title.className = "duplicate-group-title";
    title.textContent = `Report ${group.report} — ${group.measurement}`;
    box.appendChild(title);

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

    box.appendChild(select);
    container.appendChild(box);
  });

  $("duplicate-modal").classList.remove("hidden");
  $("duplicate-modal").classList.add("flex");
}

function closeDuplicateModal() {
  $("duplicate-modal").classList.add("hidden");
  $("duplicate-modal").classList.remove("flex");
  $("duplicate-groups").innerHTML = "";
}

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------

let toastTimer = null;

function showToast(message, kind) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind === "error" ? "toast-error" : "toast-success"}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 6000);
}
