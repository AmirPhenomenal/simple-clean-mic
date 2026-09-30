const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
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
let devices = null;

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
  radio:   { name: "Radio",   desc: "Big, polished podcast / streamer sound.", gains: [4, -3, 1, 4, 2.5] },
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

function renderPresets() {
  const box = $("presets");
  box.innerHTML = "";
  const keys = Object.keys(PRESETS);
  for (const key of keys) {
    const b = document.createElement("button");
    b.className = "chip" + (preset === key ? " active" : "");
    b.textContent = PRESETS[key].name;
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(preset === key));
    b.onclick = () => {
      preset = key;
      bands = bandsFor(key);
      eqChanged({ custom: false });
    };
    box.appendChild(b);
  }
  $("preset-desc").textContent =
    preset === "custom" ? "Custom: your own sound. Pick a style above to start over." : PRESETS[preset].desc;
}

const fmtDb = (g) => (g > 0 ? "+" : "") + (Math.round(g * 10) / 10) + " dB";

const TONE = [["t-bass", "o-bass"], ["t-mid", "o-mid"], ["t-treble", "o-treble"]];
function syncTone() {
  for (const [s, o] of TONE) {
    const i = Number($(s).dataset.band);
    $(s).value = bands[i].gain;
    $(o).textContent = fmtDb(bands[i].gain);
  }
}
for (const [s] of TONE) {
  $(s).addEventListener("input", (e) => {
    bands[Number(e.target.dataset.band)].gain = Number(e.target.value);
    eqChanged();
  });
  $(s).addEventListener("dblclick", (e) => {
    bands[Number(e.target.dataset.band)].gain = 0;
    eqChanged();
  });
}

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

function drawEq() {
  if (!W) return;
  const css = getComputedStyle(document.documentElement);
  const accent = css.getPropertyValue("--accent").trim();
  const line = css.getPropertyValue("--line").trim();
  const muted = css.getPropertyValue("--muted").trim();
  ctx.clearRect(0, 0, W, H);

  // grid
  ctx.lineWidth = 1;
  ctx.font = "10px Segoe UI, sans-serif";
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
    ctx.fillStyle = active ? accent : "#0b1016";
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
    i < 0 ? "" : `${BAND_NAMES[i]} · ${fmtHz(bands[i].freq)} · ${fmtDb(bands[i].gain)}` +
      (i > 0 && i < bands.length - 1 ? ` · width ${(1 / bands[i].q).toFixed(1)}` : "");
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

$("pro").addEventListener("toggle", () => {
  store.set("proOpen", $("pro").open);
  resizeCanvas();
});
window.addEventListener("resize", resizeCanvas);

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

// ======================================================================= engine

async function start() {
  const input = $("input").value;
  const output = $("output").value;
  const monitor = $("monitor").checked ? monitorDevice(devices) : null;
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
  $("power").classList.toggle("on", v);
  $("power").setAttribute("aria-pressed", String(v));
  $("power-label").textContent = v ? "ON" : "OFF";
}

function setStatus(text, cls = "") {
  const s = $("status");
  s.textContent = text;
  s.className = "status " + cls;
}

const toPct = (peak) => {
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
};

let inShow = 0, outShow = 0;
listen("meter", ({ payload: m }) => {
  // quick rise, slow fall so the bars feel smooth
  const inP = toPct(m.input), outP = toPct(m.output);
  inShow = inP > inShow ? inP : inShow * 0.85 + inP * 0.15;
  outShow = outP > outShow ? outP : outShow * 0.85 + outP * 0.15;
  $("m-in").style.width = inShow + "%";
  $("m-out").style.width = outShow + "%";
  $("power").style.setProperty("--glow", enabled ? (outShow / 100).toFixed(2) : 0);

  const desc = $("echo-desc");
  const paused = echo.checked && m.running && !m.echo_active;
  desc.classList.toggle("warn", paused);
  desc.textContent = !paused
    ? "Stops people from hearing themselves when you use speakers instead of headphones."
    : $("monitor").checked
      ? "Paused while \"Hear myself\" is on (it would remove your own voice)."
      : "Not available: couldn't listen to your speakers.";

  if (m.error) setStatus(m.error, "err");
  else if (!m.running) setStatus("Stopped");
  else if (!enabled) setStatus("Off: others hear your raw mic");
  else if (m.voice > 0.5) setStatus("Cleaning your voice", "live");
  else setStatus("Listening…", "live");
});

// ======================================================================= wiring

$("power").addEventListener("click", () => setEnabled(!enabled));

const strength = $("strength");
strength.value = store.get("strength", 70);
const sendStrength = () => invoke("set_strength", { strength: strength.value / 100 });
strength.addEventListener("input", () => {
  store.set("strength", Number(strength.value));
  sendStrength();
});

const loudness = $("loudness");
loudness.value = store.get("loudness", 50);
const sendLoudness = () => invoke("set_loudness", { loudness: loudness.value / 100 });
loudness.addEventListener("input", () => {
  store.set("loudness", Number(loudness.value));
  sendLoudness();
});

const echo = $("echo");
echo.checked = store.get("echo", true);
const sendEcho = () => invoke("set_echo", { enabled: echo.checked });
echo.addEventListener("change", () => {
  store.set("echo", echo.checked);
  sendEcho();
});

$("monitor").checked = false; // always start without monitoring, avoids surprise echo
$("monitor").addEventListener("change", start);

const compare = $("compare");
compare.addEventListener("pointerdown", () => invoke("set_enabled", { enabled: false }));
for (const ev of ["pointerup", "pointerleave"]) {
  compare.addEventListener(ev, () => invoke("set_enabled", { enabled }));
}

for (const id of ["input", "output"]) {
  $(id).addEventListener("change", () => {
    store.set(id, $(id).value);
    start();
  });
}

(async function init() {
  $("pro").open = store.get("proOpen", false);
  eqChanged({ custom: preset === "custom" });
  resizeCanvas();

  devices = await invoke("list_devices");
  fill($("input"), devices.inputs, pickInput(devices));
  fill($("output"), devices.outputs, pickOutput(devices));
  $("cable-hint").hidden = !!cableInput(devices);
  setEnabled(enabled);
  await sendStrength();
  await sendLoudness();
  await sendEcho();
  await start();
})();
