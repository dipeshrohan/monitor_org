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
    '<span class="h-2 w-2 rounded-full bg-red-700"></span><span>Connection failed</span>';
  const main = document.querySelector("main");
  if (main) {
    main.innerHTML = `<div class="rounded-lg border border-red-200 bg-red-50 p-6 text-red-700 text-sm">${message}</div>`;
  }
}

async function init() {
  if (initialized) return;
  initialized = true;

  $("connection-badge").innerHTML =
    '<span class="h-2 w-2 rounded-full bg-emerald-500"></span><span>Ready</span>';

  try {
    state.modules = await api().list_modules();
    renderSidebar();
    wireStaticHandlers();

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
    btn.innerHTML =
      `<span>${mod.step_id}&nbsp;&nbsp;${mod.name}</span>` +
      (!mod.implemented ? '<span class="badge">Not defined</span>' : "");
    btn.addEventListener("click", () => selectModule(mod.step_id));
    nav.appendChild(btn);
  });
}

function highlightSidebar() {
  document.querySelectorAll(".module-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.stepId === state.active);
  });
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

    $("module-note").className = "mt-1 text-sm text-emerald-700";
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
    const res = await api().pick_input_file("universal");
    if (res.path) {
      $("universal-input-path").value = res.path;
      applyOutputSuggestion(res.suggested_output);
      resetPreviewUI("Select the Monitor Excel export.");
    }
  });

  $("universal-clear").addEventListener("click", async () => {
    await api().clear_input("universal");
    $("universal-input-path").value = "";
    resetPreviewUI("Select the Monitor Excel export.");
  });

  $("module-browse").addEventListener("click", async () => {
    const res = await api().pick_input_file(state.active);
    if (res.path) {
      $("module-input-path").value = res.path;
      applyOutputSuggestion(res.suggested_output);
      resetPreviewUI("Select the Monitor Excel export.");
    }
  });

  $("module-clear").addEventListener("click", async () => {
    await api().clear_input(state.active);
    $("module-input-path").value = "";
    resetPreviewUI("Select the Monitor Excel export.");
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
    box.className = "rounded-lg border border-slate-200 p-4";

    const title = document.createElement("p");
    title.className = "mb-2 text-sm font-semibold text-slate-700";
    title.textContent = `Report ${group.report} — ${group.measurement}`;
    box.appendChild(title);

    const select = document.createElement("select");
    select.className = "w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm";
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
  el.classList.remove("hidden");
  el.style.whiteSpace = "pre-line";
  const palette =
    kind === "error"
      ? "bg-red-50 border-red-200 text-red-700"
      : "bg-emerald-50 border-emerald-200 text-emerald-700";
  el.className = `fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-lg ${palette}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 6000);
}
