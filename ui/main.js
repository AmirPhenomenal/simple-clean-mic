const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
// Skips the DOM write when nothing changed (the meter calls this 25x a second).
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const VIRTUAL = /cable|voicemod|voicemeeter|virtual/i;

const store = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
};

let enabled = store.get("enabled", true);
let monitorOn = false; // always start without "Hear myself", avoids surprise echo
let devices = null;

// ======================================================================= title bar

const appWindow = window.__TAURI__.window.getCurrentWindow();
$("win-min").addEventListener("click", () => appWindow.minimize());
$("win-max").addEventListener("click", () => appWindow.toggleMaximize());
$("win-close").addEventListener("click", () => appWindow.hide()); // keeps running in the tray

async function syncMaximized() {
  const max = await appWindow.isMaximized();
  document.body.classList.toggle("maximized", max);
  $("win-max").title = max ? "Restore" : "Maximize";
  $("win-max").setAttribute("aria-label", $("win-max").title);
}
appWindow.onResized(syncMaximized);
syncMaximized();

// ======================================================================= tabs

const tabs = [...document.querySelectorAll(".tabs button")];
function showTab(name) {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    $("tab-" + t.dataset.tab).hidden = !on;
  }
  store.set("tab", name);
  if (name === "tune") resizeCanvas();
}
tabs.forEach((t, i) => {
  t.addEventListener("click", () => showTab(t.dataset.tab));
  t.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    const next = tabs[(i + step + tabs.length) % tabs.length];
    next.focus();
    showTab(next.dataset.tab);
  });
});

// ======================================================================= bar sliders

// A full-width bar you click or drag anywhere on; the value box sits on the right.
// Arrow keys nudge it, double-click resets it.
function makeBar(parent, { label, icon, value, reset, center = false, onInput }) {
  const bar = document.createElement("div");
  bar.className = "bar" + (center ? " center" : "");
  bar.tabIndex = 0;
  bar.setAttribute("role", "slider");
  bar.setAttribute("aria-label", label);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.innerHTML =
    `<div class="track"><div class="fill"></div><div class="label">` +
    (icon ? `<svg><use href="#${icon}" /></svg>` : "") +
    `<span></span></div></div><div class="value"></div>`;
  bar.querySelector(".label span").textContent = label;
  parent.appendChild(bar);

  const track = bar.querySelector(".track");
  const fill = bar.querySelector(".fill");
  const out = bar.querySelector(".value");
  let v = value;

  function show(n) {
    v = Math.round(Math.max(0, Math.min(100, n)));
    fill.style.width = v + "%";
    out.textContent = v;
    bar.setAttribute("aria-valuenow", String(v));
  }
  function change(n) {
    const before = v;
    show(n);
    if (v !== before) onInput(v);
  }
  const fromX = (x) => {
    const r = track.getBoundingClientRect();
    return ((x - r.left) / r.width) * 100;
  };

  bar.addEventListener("pointerdown", (e) => {
    bar.setPointerCapture(e.pointerId);
    bar.classList.add("dragging");
    change(fromX(e.clientX));
  });
  bar.addEventListener("pointermove", (e) => {
    if (bar.hasPointerCapture(e.pointerId)) change(fromX(e.clientX));
  });
  bar.addEventListener("pointerup", () => bar.classList.remove("dragging"));
  bar.addEventListener("dblclick", () => change(reset));
  bar.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step }[e.key];
    if (d) { e.preventDefault(); change(v + d); }
    else if (e.key === "Home") change(0);
    else if (e.key === "End") change(100);
  });

  show(v);
  return { set: show };
}

// ======================================================================= voice style / EQ

// Band 0 = low shelf, band 4 = high shelf, the rest are bells. Must match dsp.rs.
const BAND_NAMES = ["Bass", "Warmth", "Mid", "Presence", "Treble"];
const BASE = [
  { freq: 100, q: 0.7 },
  { freq: 300, q: 1.0 },
  { freq: 1000, q: 1.0 },
  { freq: 3500, q: 0.8 },
  { freq: 8000, q: 0.7 },
];

const PRESETS = {
  natural: { name: "Natural", desc: "Your voice, just cleaner. A good start for everyone.", gains: [0, -2, 0, 2.5, 1.5] },
  warm:    { name: "Warm",    desc: "Fuller and softer. Nice for chatting and late-night calls.", gains: [3, 0.5, -1, 1, -1] },
  crisp:   { name: "Crisp",   desc: "Bright and very clear. Great for meetings and cheap mics.", gains: [-1.5, -3, 0, 4, 4] },
  radio:   { name: "Radio",   desc: "Big, polished podcast and streamer sound.", gains: [4, -3, 1, 4, 2.5] },
  deep:    { name: "Deep",    desc: "More bass and weight in your voice.", gains: [6, 1.5, -1, 1, 0] },
  flat:    { name: "Flat",    desc: "No tone change at all, only cleaning.", gains: [0, 0, 0, 0, 0] },
};

let preset = store.get("preset", "natural");
let bands = store.get("bands", null) ?? bandsFor("natural");

function bandsFor(key) {
  return BASE.map((b, i) => ({ ...b, gain: PRESETS[key].gains[i] }));
}

let sendQueued = false;
function eqChanged({ custom = true } = {}) {
  if (custom) preset = "custom";
  store.set("preset", preset);
  store.set("bands", bands);
  renderPresets();
  syncTone();
  drawEq();
  if (!sendQueued) {
    sendQueued = true;
    requestAnimationFrame(() => {
      sendQueued = false;
      invoke("set_eq", { bands });
    });
  }
}

// The chips are built once; dragging the EQ re-renders on every move, so this only updates them.
const presetChips = Object.keys(PRESETS).map((key) => {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = PRESETS[key].name;
  b.setAttribute("role", "radio");
  b.onclick = () => {
    preset = key;
    bands = bandsFor(key);
    eqChanged({ custom: false });
  };
  $("presets").appendChild(b);
  return [key, b];
});

function renderPresets() {
  for (const [key, b] of presetChips) b.setAttribute("aria-checked", String(preset === key));
  setText($("preset-desc"),
    preset === "custom" ? "Your own sound. Pick a style to start over." : PRESETS[preset].desc);
}

const fmtDb = (g) => (g > 0 ? "+" : "") + (Math.round(g * 10) / 10) + " dB";

// Bass / Mid / Treble bars: 0..100 with 50 = no change, mapped to -12..+12 dB.
const toBar = (gain) => 50 + (gain / 12) * 50;
const toGain = (v) => Math.round(((v - 50) / 50) * 12 * 2) / 2;

const voiceBars = $("voice-bars");
makeBar(voiceBars, {
  label: "Voice volume",
  icon: "i-volume",
  value: store.get("loudness", 50),
  reset: 50,
  onInput: (v) => {
    store.set("loudness", v);
    sendLoudness(v);
  },
});
const TONE = [["Bass", 0], ["Mid", 2], ["Treble", 4]].map(([label, band]) => ({
  band,
  bar: makeBar(voiceBars, {
    label,
    value: toBar(bands[band].gain),
    reset: 50,
    center: true,
    onInput: (v) => {
      bands[band].gain = toGain(v);
      eqChanged();
    },
  }),
}));

function syncTone() {
  for (const t of TONE) t.bar.set(toBar(bands[t.band].gain));
}

$("eq-reset").addEventListener("click", () => {
  if (preset === "custom") preset = "natural";
  bands = bandsFor(preset);
  eqChanged({ custom: false });
});

// ---------- EQ curve (same RBJ formulas as the Rust side)

const FS = 48000;
function coefs(i, b) {
  const w = (2 * Math.PI * b.freq) / FS, s = Math.sin(w), c = Math.cos(w);
  const A = Math.pow(10, b.gain / 40);
  if (i === 0 || i === bands.length - 1) {
    const alpha = (s / 2) * Math.SQRT2, sa = 2 * Math.sqrt(A) * alpha;
    const sign = i === 0 ? -1 : 1; // low shelf flips the (A-1)cos terms
    const b0 = A * ((A + 1) + sign * (A - 1) * c + sa);
    const b1 = -sign * 2 * A * ((A - 1) + sign * (A + 1) * c);
    const b2 = A * ((A + 1) + sign * (A - 1) * c - sa);
    const a0 = (A + 1) - sign * (A - 1) * c + sa;
    const a1 = sign * 2 * ((A - 1) - sign * (A + 1) * c);
    const a2 = (A + 1) - sign * (A - 1) * c - sa;
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  const alpha = s / (2 * b.q);
  const a0 = 1 + alpha / A;
  return [(1 + alpha * A) / a0, (-2 * c) / a0, (1 - alpha * A) / a0, (-2 * c) / a0, (1 - alpha / A) / a0];
}

function magDb([b0, b1, b2, a1, a2], f) {
  const w = (2 * Math.PI * f) / FS, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
  const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

const canvas = $("eq");
const ctx = canvas.getContext("2d");
const FMIN = 20, FMAX = 20000, DBR = 15;
let W = 0, H = 0, dragging = -1, hover = -1;

const xOf = (f) => (Math.log10(f / FMIN) / Math.log10(FMAX / FMIN)) * W;
const fOf = (x) => FMIN * Math.pow(FMAX / FMIN, Math.min(Math.max(x / W, 0), 1));
const yOf = (db) => H / 2 - (db / DBR) * (H / 2 - 10);
const dbOf = (y) => ((H / 2 - y) / (H / 2 - 10)) * DBR;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  if (!W) return;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawEq();
}

// Theme colors are fixed, so read them once instead of forcing a style recalc on every redraw.
let colors = null;
function themeColors() {
  if (!colors) {
    const css = getComputedStyle(document.documentElement);
    const v = (n) => css.getPropertyValue(n).trim();
    colors = { accent: v("--accent"), line: v("--line"), muted: v("--muted"), bg: v("--bg") };
  }
  return colors;
}

function drawEq() {
  if (!W) return;
  const { accent, line, muted, bg } = themeColors();
  ctx.clearRect(0, 0, W, H);

  // grid
  ctx.lineWidth = 1;
  ctx.font = "600 10px Manrope, Segoe UI, sans-serif";
  ctx.fillStyle = muted;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(f >= 1000 ? f / 1000 + "k" : f, x + 3, H - 4);
  }
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = Math.round(yOf(db)) + 0.5;
    ctx.strokeStyle = db === 0 ? muted : line;
    ctx.globalAlpha = db === 0 ? 0.5 : 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.globalAlpha = 1;
    if (db) ctx.fillText((db > 0 ? "+" : "") + db, 3, y - 3);
  }

  // response curve
  const cs = bands.map((b, i) => coefs(i, b));
  ctx.beginPath();
  for (let x = 0; x <= W; x += 2) {
    const f = fOf(x);
    const db = cs.reduce((sum, c) => sum + magDb(c, f), 0);
    x === 0 ? ctx.moveTo(x, yOf(db)) : ctx.lineTo(x, yOf(db));
  }
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(W, yOf(0)); ctx.lineTo(0, yOf(0)); ctx.closePath();
  ctx.fillStyle = accent;
  ctx.globalAlpha = 0.08; ctx.fill(); ctx.globalAlpha = 1;

  // band dots
  bands.forEach((b, i) => {
    const x = xOf(b.freq), y = yOf(b.gain), active = i === dragging || i === hover;
    ctx.beginPath();
    ctx.arc(x, y, active ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = active ? accent : bg;
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

function bandAt(e) {
  const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  let best = -1, bestD = 14 * 14;
  bands.forEach((b, i) => {
    const d = (xOf(b.freq) - mx) ** 2 + (yOf(b.gain) - my) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + " kHz" : Math.round(f) + " Hz");
function showInfo(i) {
  $("band-info").textContent =
    i < 0 ? "" : `${BAND_NAMES[i]}, ${fmtHz(bands[i].freq)}, ${fmtDb(bands[i].gain)}` +
      (i > 0 && i < bands.length - 1 ? `, width ${(1 / bands[i].q).toFixed(1)}` : "");
}

canvas.addEventListener("pointerdown", (e) => {
  dragging = bandAt(e);
  if (dragging >= 0) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  if (dragging >= 0) {
    const b = bands[dragging];
    b.freq = Math.round(fOf(e.clientX - r.left));
    b.gain = Math.round(Math.max(-12, Math.min(12, dbOf(e.clientY - r.top))) * 2) / 2;
    showInfo(dragging);
    eqChanged();
  } else {
    const h = bandAt(e);
    if (h !== hover) { hover = h; drawEq(); showInfo(h); }
  }
});
canvas.addEventListener("pointerup", () => { dragging = -1; drawEq(); });
canvas.addEventListener("pointerleave", () => { if (dragging < 0) { hover = -1; drawEq(); showInfo(-1); } });
canvas.addEventListener("wheel", (e) => {
  const i = bandAt(e);
  if (i <= 0 || i >= bands.length - 1) return; // shelves have no width
  e.preventDefault();
  const q = bands[i].q * (e.deltaY < 0 ? 1.12 : 1 / 1.12);
  bands[i].q = Math.round(Math.max(0.3, Math.min(6, q)) * 100) / 100;
  showInfo(i);
  eqChanged();
}, { passive: false });
canvas.addEventListener("dblclick", (e) => {
  const i = bandAt(e);
  if (i < 0) return;
  bands[i] = { ...BASE[i], gain: 0 };
  showInfo(i);
  eqChanged();
});

window.addEventListener("resize", resizeCanvas);

// ======================================================================= cleaning

const sendStrength = (v) => invoke("set_strength", { strength: v / 100 });
const sendLoudness = (v) => invoke("set_loudness", { loudness: v / 100 });

makeBar($("clean-bars"), {
  label: "Noise removal",
  icon: "i-noise",
  value: store.get("strength", 70),
  reset: 70,
  onInput: (v) => {
    store.set("strength", v);
    sendStrength(v);
  },
});

const echo = $("echo");
echo.checked = store.get("echo", true);
const sendEcho = () => invoke("set_echo", { enabled: echo.checked });
echo.addEventListener("change", () => {
  store.set("echo", echo.checked);
  sendEcho();
});

// ======================================================================= devices

function fill(select, names, chosen) {
  select.innerHTML = "";
  for (const n of names) {
    const o = document.createElement("option");
    o.value = o.textContent = n;
    select.appendChild(o);
  }
  select.value = chosen;
}

function pickInput(d) {
  const saved = store.get("input", null);
  if (saved && d.inputs.includes(saved)) return saved;
  if (d.default_input && !VIRTUAL.test(d.default_input)) return d.default_input;
  return d.inputs.find((n) => !VIRTUAL.test(n)) ?? d.inputs[0];
}

function cableInput(d) {
  return d.outputs.find((n) => /^CABLE Input/i.test(n)) ?? d.outputs.find((n) => /CABLE Input/i.test(n));
}

function pickOutput(d) {
  const saved = store.get("output", null);
  if (saved && d.outputs.includes(saved)) return saved;
  return cableInput(d) ?? d.default_output ?? d.outputs[0];
}

// Headphones/speakers for "Hear myself": the default output, unless that's a virtual cable.
function monitorDevice(d) {
  const out = $("output").value;
  const ok = (n) => n && n !== out && !VIRTUAL.test(n);
  if (ok(d.default_output)) return d.default_output;
  return d.outputs.find(ok) ?? null;
}

// Re-reads the device list. Returns true if anything was plugged in or removed.
let deviceKey = "";
async function refreshDevices() {
  const d = await invoke("list_devices");
  const key = JSON.stringify(d);
  if (key === deviceKey) return false;
  deviceKey = key;
  devices = d;
  fill($("input"), d.inputs, pickInput(d));
  fill($("output"), d.outputs, pickOutput(d));
  $("cable-hint").hidden = !!cableInput(d);
  return true;
}

// Watch for devices coming and going (mic unplugged, VB-CABLE just installed, ...) and
// restart the audio when the chosen devices change or the current ones stopped working.
let engineError = false;
let watching = false;
setInterval(async () => {
  if (watching || !devices) return;
  watching = true;
  try {
    const before = $("input").value + "\n" + $("output").value;
    const changed = await refreshDevices();
    const after = $("input").value + "\n" + $("output").value;
    if (engineError || (changed && before !== after)) await start();
  } finally {
    watching = false;
  }
}, 2000);

for (const id of ["input", "output"]) {
  $(id).addEventListener("change", () => {
    store.set(id, $(id).value);
    start();
  });
}

// ======================================================================= engine & dock

async function start() {
  const input = $("input").value;
  const output = $("output").value;
  const monitor = monitorOn ? monitorDevice(devices) : null;
  try {
    await invoke("start", { input, output, monitor });
  } catch (e) {
    setStatus(String(e), "err");
  }
  $("use-hint").hidden = !/CABLE Input/i.test(output);
}

function setEnabled(v) {
  enabled = v;
  store.set("enabled", v);
  invoke("set_enabled", { enabled: v });
  $("mic").setAttribute("aria-pressed", String(v));
}

function setMonitor(v, restart = true) {
  monitorOn = v;
  $("monitor").setAttribute("aria-pressed", String(v));
  $("monitor").title = v ? "Stop hearing myself" : "Hear myself";
  if (restart) start();
}

function setStatus(text, cls = "") {
  setText($("status-text"), text);
  const c = "status " + cls;
  if ($("status").className !== c) $("status").className = c;
}

$("mic").addEventListener("click", () => setEnabled(!enabled));
$("monitor").addEventListener("click", () => setMonitor(!monitorOn));
listen("enabled", ({ payload }) => setEnabled(payload)); // toggled from the tray menu

// ---------- microphone picker (left dock button)

const inputBtn = $("input-btn");
const inputMenu = $("input-menu");

function chooseInput(name) {
  closeInputMenu();
  if (name === $("input").value) return;
  $("input").value = name;
  store.set("input", name);
  start();
}

function openInputMenu() {
  inputMenu.innerHTML = "";
  const head = document.createElement("p");
  head.className = "menu-head";
  head.textContent = "Microphone";
  inputMenu.appendChild(head);
  const current = $("input").value;
  for (const name of devices?.inputs ?? []) {
    const item = document.createElement("button");
    item.className = "menu-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(name === current));
    item.innerHTML = `<span></span><svg><use href="#i-check" /></svg>`;
    item.querySelector("span").textContent = name;
    item.title = name;
    item.addEventListener("click", () => chooseInput(name));
    inputMenu.appendChild(item);
  }
  inputMenu.hidden = false;
  inputBtn.setAttribute("aria-expanded", "true");
  (inputMenu.querySelector('[aria-selected="true"]') ?? inputMenu.querySelector(".menu-item"))?.focus();
}

function closeInputMenu() {
  if (inputMenu.hidden) return;
  inputMenu.hidden = true;
  inputBtn.setAttribute("aria-expanded", "false");
}

inputBtn.addEventListener("click", () => (inputMenu.hidden ? openInputMenu() : closeInputMenu()));
document.addEventListener("pointerdown", (e) => {
  if (!inputMenu.contains(e.target) && !inputBtn.contains(e.target)) closeInputMenu();
});
inputMenu.addEventListener("keydown", (e) => {
  const items = [...inputMenu.querySelectorAll(".menu-item")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    closeInputMenu();
    inputBtn.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(i + step + items.length) % items.length]?.focus();
  }
});

const toPct = (peak) => {
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
};

let inShow = 0, outShow = 0;
const mIn = $("m-in"), mOut = $("m-out"), micBtn = $("mic"), echoDesc = $("echo-desc");
listen("meter", ({ payload: m }) => {
  // quick rise, slow fall so the bars feel smooth
  const inP = toPct(m.input), outP = toPct(m.output);
  inShow = inP > inShow ? inP : inShow * 0.85 + inP * 0.15;
  outShow = outP > outShow ? outP : outShow * 0.85 + outP * 0.15;
  mIn.style.width = inShow + "%";
  mOut.style.width = outShow + "%";
  micBtn.style.setProperty("--level", enabled ? (outShow / 100).toFixed(2) : 0);

  const paused = echo.checked && m.running && !m.echo_active;
  echoDesc.classList.toggle("warn", paused);
  setText(echoDesc, !paused
    ? "Stops people hearing themselves when you use speakers instead of headphones."
    : monitorOn
      ? "Paused while Hear myself is on, because it would remove your own voice."
      : "Not available: Clean Mic can't listen to your speakers.");

  engineError = !!m.error;
  if (m.error) setStatus(m.error + ", retrying…", "err");
  else if (!m.running) setStatus("Stopped");
  else if (!enabled) setStatus("Off: others hear your raw mic");
  else if (m.voice > 0.5) setStatus("Cleaning your voice", "live");
  else setStatus("Listening", "live");
});

// ======================================================================= start with Windows

async function initAutostart() {
  const box = $("autostart");
  box.checked = await invoke("get_autostart");
  box.addEventListener("change", async () => {
    try {
      await invoke("set_autostart", { enabled: box.checked });
    } catch (e) {
      setStatus(String(e), "err");
    }
    box.checked = await invoke("get_autostart");
  });
}

// ======================================================================= updates

async function checkForUpdate() {
  try {
    const version = await invoke("check_update");
    if (!version) return;
    $("update-text").textContent = `Clean Mic ${version} is ready to install.`;
    $("update").hidden = false;
  } catch {
    // offline or no release yet: try again later
  }
}

$("update-btn").addEventListener("click", async () => {
  const btn = $("update-btn");
  btn.disabled = true;
  btn.textContent = "Updating…";
  try {
    await invoke("install_update"); // the app closes and reopens on the new version
  } catch (e) {
    $("update-text").textContent = "Update failed: " + e;
    btn.disabled = false;
    btn.textContent = "Try again";
  }
});

// ======================================================================= VB-CABLE

$("cable-btn").addEventListener("click", async () => {
  const btn = $("cable-btn");
  btn.disabled = true;
  btn.textContent = "Installing…";
  try {
    await invoke("install_cable");
    btn.textContent = "Installed";
    setStatus("VB-CABLE installed. If it doesn't show up soon, restart your PC.");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Install VB-CABLE";
    setStatus(String(e), "err");
  }
});

// ======================================================================= start up

(async function init() {
  showTab(store.get("tab", "voice"));
  eqChanged({ custom: preset === "custom" });
  try {
    $("version").textContent = "Version " + (await window.__TAURI__.app.getVersion());
  } catch {}

  await refreshDevices();
  setEnabled(enabled);
  setMonitor(false, false);
  await sendStrength(store.get("strength", 70));
  await sendLoudness(store.get("loudness", 50));
  await sendEcho();
  await start();
  await initAutostart();
  checkForUpdate();
  setInterval(checkForUpdate, 6 * 60 * 60 * 1000);
})();
