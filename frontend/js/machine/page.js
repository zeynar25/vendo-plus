/*
 * The mock coffee machine page (machine.html): drink buttons, brewing, the
 * pickup slot, the hoppers on their load cells, the kit's 5-second batches, and
 * the log. The kit logic it uses is in kit.js.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});
  const K = V.kit;

  const STORE_HOPPERS = "vendoplus.mockMachine.hoppers";
  const STORE_KEY = "vendoplus.mockMachine.deviceKey"; // one key per backend address: each database issues its own
  const DEFAULT_MASS = { coffee: 640, milk: 180, chocolate: 420 }; // arbitrary demo loads
  const LOAD_MAX_G = 1100; // the load control goes past capacity so the flagged states can be shown
  const DISPENSE_MS = 1500;
  const BREW_MS = 3000;
  const LOG_LIMIT = 200;
  const RISE_G = 20; // the backend's unrecorded-refill threshold

  // Hopper outline in the SVG: flat bottom at y = 146, capacity line at y = 24.
  const CANISTER = "M28 8 H92 Q100 8 100 16 V108 L80 146 H40 L20 108 V16 Q20 8 28 8 Z";
  const Y_EMPTY = 146;
  const Y_FULL = 24;

  const state = {
    mass: {},
    connected: {},
    readings: {},
    power: false,
    session: null,
    nextBatchIn: 0,
    inFlight: false,
    brewing: null,
    cup: null,
    deviceKey: "",
    dragFrom: {},
    counts: { sent: 0, accepted: 0, failed: 0, serial: 0 },
    tickTimer: null,
    brewTimer: null,
  };

  let doc;
  const $ = (id) => doc.getElementById(id);
  const g1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const g0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const grams = (x) => g1.format(x) + " g";

  // ------------------------------------------------------------ storage

  function store() {
    try {
      return root.localStorage || null;
    } catch (e) {
      return null; // storage can be blocked; the page still works without it
    }
  }

  function loadItem(key) {
    try {
      const s = store();
      return s ? s.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }

  function saveItem(key, value) {
    try {
      const s = store();
      if (!s) return;
      if (value == null) s.removeItem(key);
      else s.setItem(key, value);
    } catch (e) {
      /* ignore */
    }
  }

  /** Where the key for the current backend is kept: the online and local databases issue different keys. */
  function keyName() {
    return STORE_KEY + ":" + K.target(V.config.API_BASE_URL, "x").base;
  }

  function loadKey() {
    return loadItem(keyName()) || "";
  }

  function onBackendSwitch(e) {
    state.deviceKey = loadKey();
    const d = (e && e.detail) || {};
    const where = d.local || V.config.API_BASE_URL;
    const why = {
      offline: "This computer is offline, so batches",
      unreachable: "The online backend can’t be reached, so batches",
      button: "As chosen in the start-up window, batches",
      address: "As the address asks (backend=local), batches",
    }[d.reason] || "Batches";
    logEvent(
      "warn",
      "Kit",
      "Backend switched",
      why + " now go to the backend on this computer (" + where + "). " +
        (state.deviceKey ? "Using the device key saved for it." : "Enter the device key from this computer’s seed command.")
    );
    renderKit();
  }

  function saveHoppers() {
    saveItem(STORE_HOPPERS, JSON.stringify({ mass: state.mass }));
  }

  function randomBytes(n) {
    const bytes = new Uint8Array(n);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
  }

  // ------------------------------------------------------------ markup

  const yFor = (mass) => Y_EMPTY - (Math.max(0, mass) / K.CAPACITY_G) * (Y_EMPTY - Y_FULL);

  function hopperHtml(h) {
    const c = h.code;
    return (
      '<article class="hopper hopper--' + c + '" aria-labelledby="h-' + c + '">' +
      '<div class="hopper-head"><h3 class="hopper-name" id="h-' + c + '">' + V.esc(h.name) + "</h3>" +
      '<span class="hopper-ingredient">' + V.esc(h.ingredient) + "</span></div>" +
      '<svg class="hopper-art" viewBox="0 0 120 200" aria-hidden="true" focusable="false">' +
      '<defs><clipPath id="clip-' + c + '"><path d="' + CANISTER + '"/></clipPath></defs>' +
      '<path class="canister-glass" d="' + CANISTER + '"/>' +
      '<rect class="canister-fill" id="fill-' + c + '" x="0" y="' + Y_EMPTY + '" width="120" height="0" clip-path="url(#clip-' + c + ')"/>' +
      '<line class="canister-max" x1="20" x2="100" y1="' + Y_FULL + '" y2="' + Y_FULL + '"/>' +
      '<text class="canister-max-label" x="96" y="' + (Y_FULL + 9) + '" text-anchor="end">1 kg</text>' +
      '<path class="canister-edge" d="' + CANISTER + '"/>' +
      // load cell: plate, mounting blocks, bar with strain gauge, base
      '<rect class="lc-plate" x="18" y="148" width="84" height="6" rx="2"/>' +
      '<rect class="lc-block" x="26" y="154" width="12" height="5"/>' +
      '<rect class="lc-bar" x="22" y="159" width="76" height="14" rx="2"/>' +
      '<circle class="lc-hole" cx="31" cy="166" r="2.4"/><circle class="lc-hole" cx="89" cy="166" r="2.4"/>' +
      '<rect class="lc-gauge" x="53" y="161" width="14" height="10" rx="1"/>' +
      '<path class="lc-gauge-lines" d="M56 163 V169 M59 163 V169 M62 163 V169 M65 163 V169"/>' +
      '<rect class="lc-block" x="82" y="173" width="12" height="5"/>' +
      '<rect class="lc-base" x="12" y="178" width="96" height="5" rx="2"/>' +
      '<path class="wire wire--red" d="M98 162 C110 162 108 190 64 200"/>' +
      '<path class="wire wire--black" d="M98 165 C112 166 106 192 60 200"/>' +
      '<path class="wire wire--white" d="M98 168 C114 170 104 194 56 200"/>' +
      '<path class="wire wire--green" d="M98 171 C116 174 102 196 52 200"/>' +
      "</svg>" +
      '<div class="scale">' +
      '<div class="scale-head"><span>HX711</span><span>CH' + h.channel + "</span></div>" +
      '<div class="scale-display"><span class="scale-value" id="val-' + c + '">----</span><span class="scale-unit">g</span></div>' +
      '<span class="pill pill--small pill--neutral scale-status" id="st-' + c + '">Kit off</span>' +
      "</div>" +
      '<div class="hopper-controls">' +
      '<div class="load-head"><label class="label-text" for="load-' + c + '">Load<span class="visually-hidden"> control, ' + V.esc(h.name.toLowerCase()) + " hopper</span></label>" +
      '<span class="load-value" id="loadv-' + c + '"></span></div>' +
      '<input type="range" class="load" id="load-' + c + '" data-code="' + c + '" min="0" max="' + LOAD_MAX_G + '" step="1"/>' +
      '<button type="button" class="btn btn--outline btn--sm" data-action="fill" data-code="' + c + '">Fill to 1,000 g</button>' +
      '<label class="check"><input type="checkbox" class="plug" data-code="' + c + '" checked/> Sensor connected</label>' +
      "</div></article>"
    );
  }

  function drinkHtml(d) {
    const uses = K.uses(d);
    const recipe = uses
      .map((u) => u.grams + " g " + u.code + (u.assumed ? '<span class="star">*</span>' : ""))
      .join(" · ");
    const label = d.name + ": " + uses.map((u) => u.grams + " g " + u.code + (u.assumed ? " (assumed)" : "")).join(", ");
    return (
      '<button type="button" class="drink" data-action="brew" data-drink="' + d.id + '" style="--liquid:' + d.color + '"' +
      ' aria-label="' + V.esc(label) + '" aria-describedby="short-' + d.id + '">' +
      '<span class="drink-swatch" aria-hidden="true"></span>' +
      '<span class="drink-name">' + V.esc(d.name) + "</span>" +
      '<span class="drink-recipe" aria-hidden="true">' + recipe + "</span>" +
      '<span class="drink-short" id="short-' + d.id + '"></span>' +
      "</button>"
    );
  }

  // ------------------------------------------------------------ rendering

  function renderHopper(code) {
    const m = state.mass[code];
    const y = Math.max(4, yFor(m));
    const fill = $("fill-" + code);
    fill.setAttribute("y", y.toFixed(2));
    fill.setAttribute("height", (Y_EMPTY - y).toFixed(2));
    $("loadv-" + code).textContent = g0.format(m) + " g";
    const slider = $("load-" + code);
    if (doc.activeElement !== slider || !(code in state.dragFrom)) slider.value = String(Math.round(m));
    slider.setAttribute("aria-valuetext", g0.format(m) + " grams");
  }

  function renderReading(code) {
    const value = $("val-" + code);
    const pill = $("st-" + code);
    const r = state.readings[code];
    if (!state.power || !r) {
      value.textContent = "----";
      pill.className = "pill pill--small pill--neutral scale-status";
      pill.textContent = "Kit off";
      return;
    }
    value.textContent = r.value == null ? "----" : g1.format(r.value);
    pill.className = "pill pill--small pill--" + K.STATUS_TONE[r.status] + " scale-status";
    pill.textContent = K.STATUS_TEXT[r.status];
    pill.title = "Sent as status " + r.status;
  }

  function renderDrinks() {
    K.DRINKS.forEach((d) => {
      const btn = doc.querySelector('[data-drink="' + d.id + '"]');
      const short = K.shortfall(d, state.mass);
      const busy = Boolean(state.brewing || state.cup);
      btn.disabled = busy;
      btn.setAttribute("aria-disabled", short ? "true" : "false");
      btn.classList.toggle("is-making", Boolean(state.brewing && state.brewing.drink.id === d.id));
      $("short-" + d.id).textContent = short ? "Not enough " + short.code : "";
    });
  }

  function setScreen(text) {
    const el = $("screen");
    if (el.textContent !== text) el.textContent = text;
  }

  function announce(text) {
    $("announce").textContent = text;
  }

  function setProgress(fraction) {
    $("progress").style.width = (Math.max(0, Math.min(1, fraction)) * 100).toFixed(1) + "%";
  }

  function setCupLevel(fraction, color) {
    const top = 94 - Math.max(0, Math.min(1, fraction)) * 62; // full at y = 32
    const liquid = $("cup-liquid");
    liquid.setAttribute("y", top.toFixed(2));
    liquid.setAttribute("height", (94 - top).toFixed(2));
    if (color) liquid.setAttribute("fill", color);
  }

  function renderCup() {
    const cup = $("cup");
    const drink = state.cup || (state.brewing && state.brewing.drink);
    cup.hidden = !drink;
    cup.classList.toggle("is-ready", Boolean(state.cup));
    $("stream").classList.toggle("is-on", Boolean(state.brewing && state.brewing.phase === "brew"));
    $("stream").style.setProperty("--liquid", drink ? drink.color : "transparent");
    if (state.cup) {
      cup.disabled = false;
      cup.setAttribute("aria-label", "Take your " + state.cup.name);
      $("cup-label").textContent = state.cup.name;
    } else {
      cup.disabled = true;
      cup.removeAttribute("aria-label");
      $("cup-label").textContent = "";
    }
  }

  function modeInfo() {
    if (!state.power) return { tone: "neutral", text: "Off", note: "The kit is off: no readings, no batches." };
    const t = K.target(V.config.API_BASE_URL, state.deviceKey);
    if (t.serial && t.reason === "placeholder") {
      return {
        tone: "neutral",
        text: "Serial only",
        note: "The backend address in js/config.js is still the placeholder, so batches are only logged.",
      };
    }
    if (t.serial) return { tone: "neutral", text: "Serial only", note: "Enter the device key to send batches." };
    return { tone: "info", text: "Sending", note: "" };
  }

  function renderKit() {
    const m = modeInfo();
    $("kit-mode").innerHTML =
      '<span class="pill pill--small pill--' + m.tone + '">' + V.esc(m.text) + "</span>" +
      (m.note ? ' <span class="kit-note">' + V.esc(m.note) + "</span>" : "");
    const base = K.target(V.config.API_BASE_URL, "x").base;
    const onLocal = V.backend && V.backend.mode === "local";
    $("kit-target").textContent = (base || "(same address as this page)") + (onLocal ? " (this computer)" : "");
    $("kit-back").hidden = !onLocal;
    $("key-label").textContent = "Device key for coffee-01 on " + (base ? base.replace(/^https?:\/\//, "") : "this page’s address");
    $("kit-session").textContent = state.session && state.power ? state.session.id : "-";
    $("kit-next").textContent =
      state.power && state.session
        ? "#" + state.session.sequence + " in " + state.nextBatchIn + " s"
        : "-";
    const power = $("power");
    power.setAttribute("aria-checked", String(state.power));
    $("forget-key").hidden = !state.deviceKey;
    $("key-hint").textContent = state.deviceKey
      ? "A key for this backend is saved in this browser only. Never commit it to the repository or a public Wokwi project."
      : "Saved in this browser only, one per backend. Never commit a real key.";
  }

  function renderCounts() {
    const c = state.counts;
    const parts = [c.sent + " sent", c.accepted + " accepted", c.failed + " not accepted"];
    if (c.serial) parts.push(c.serial + " serial only");
    $("log-counts").textContent = "Batches: " + parts.join(" · ");
  }

  // ------------------------------------------------------------ log

  function clock(date) {
    const p = (n) => String(n).padStart(2, "0");
    return p(date.getHours()) + ":" + p(date.getMinutes()) + ":" + p(date.getSeconds());
  }

  function addEntry(kind, tone, tag, title, text) {
    const li = doc.createElement("li");
    li.className = "log-entry tone-" + tone;
    li.setAttribute("data-kind", kind);
    li.innerHTML =
      '<div class="log-line"><time>' + clock(new Date()) + '</time><span class="log-tag">' + V.esc(tag) +
      '</span><span class="log-result">' + V.esc(title) + "</span></div>" +
      '<p class="log-text">' + V.esc(text) + "</p>";
    const list = $("log");
    list.insertBefore(li, list.firstChild);
    while (list.children.length > LOG_LIMIT) list.removeChild(list.lastChild);
    return li;
  }

  function logEvent(tone, tag, title, text) {
    return addEntry("event", tone, tag, title, text);
  }

  function logBatch(batch, target) {
    const li = addEntry("batch", "pending", "Batch #" + batch.sequence, target.serial ? "Serial only" : "Sending…", "");
    const values = batch.readings
      .map(
        (r) =>
          "<li><b>" + V.esc(r.compartment) + "</b> " + (r.value == null ? "null" : V.esc(g1.format(r.value)) + " g") +
          " <code>" + V.esc(r.status) + "</code></li>"
      )
      .join("");
    li.insertAdjacentHTML(
      "beforeend",
      '<ul class="log-values">' + values + "</ul>" +
        '<details class="log-body"><summary>' + (target.serial ? "Batch printed (serial monitor)" : "JSON sent") +
        "</summary><pre>" + V.esc(JSON.stringify(batch, null, 2)) + "</pre></details>"
    );
    return li;
  }

  function settleBatch(li, result, target) {
    const d = K.describe(result, target);
    li.className = "log-entry tone-" + d.tone;
    li.querySelector(".log-result").textContent = d.title + (result && result.ms != null ? " · " + result.ms + " ms" : "");
    li.querySelector(".log-text").textContent = d.text;
  }

  // ------------------------------------------------------------ kit

  function readAll() {
    K.HOPPERS.forEach((h) => {
      state.readings[h.code] = K.read({ mass: state.mass[h.code], connected: state.connected[h.code] }, Math.random);
      renderReading(h.code);
    });
  }

  function tick() {
    if (!state.power) return;
    readAll();
    state.nextBatchIn -= 1;
    if (state.nextBatchIn <= 0) {
      state.nextBatchIn = Math.round(K.SEND_EVERY_MS / K.READ_EVERY_MS);
      sendBatch();
    }
    renderKit();
  }

  function sendBatch() {
    if (state.inFlight) {
      logEvent("warn", "Kit", "Skipped", "The previous batch is still waiting for a reply, so this cycle sends nothing.");
      return;
    }
    const target = K.target(V.config.API_BASE_URL, state.deviceKey);
    const batch = K.buildBatch(state.session, state.readings, new Date());
    const entry = logBatch(batch, target);
    if (target.serial) {
      state.counts.serial += 1;
      settleBatch(entry, null, target);
      renderCounts();
      return;
    }
    state.inFlight = true;
    state.counts.sent += 1;
    renderCounts();
    K.post(target.url, state.deviceKey, batch, root.fetch.bind(root), K.TIMEOUT_MS).then((result) => {
      state.inFlight = false;
      if (result.outcome === "accepted") state.counts.accepted += 1;
      else state.counts.failed += 1;
      settleBatch(entry, result, target);
      renderCounts();
    });
  }

  function boot() {
    state.power = true;
    state.session = { id: K.newSessionId(randomBytes), sequence: 0 };
    state.nextBatchIn = 1; // the first batch goes out right after boot
    const m = modeInfo();
    logEvent(
      "info",
      "Kit",
      "Booted",
      "New session " + state.session.id + ", sequence starts at 0. Mode: " + m.text.toLowerCase() + "." +
        (m.note ? " " + m.note : "")
    );
    state.tickTimer = root.setInterval(tick, K.READ_EVERY_MS);
    tick();
  }

  function shutdown() {
    state.power = false;
    root.clearInterval(state.tickTimer);
    state.readings = {};
    K.HOPPERS.forEach((h) => renderReading(h.code));
    logEvent("warn", "Kit", "Powered off", "No readings or batches until the kit is switched on again (a new session).");
    renderKit();
  }

  // ------------------------------------------------------------ machine

  function brew(id) {
    const d = K.drink(id);
    if (!d || state.brewing) return;
    if (state.cup) {
      setScreen("Take your " + state.cup.name + " from the pickup slot first.");
      return;
    }
    const short = K.shortfall(d, state.mass);
    if (short) {
      const h = K.hopper(short.code);
      const msg = "Not enough " + h.ingredient + " for " + K.withArticle(d.name) + ".";
      setScreen(msg);
      announce(msg);
      logEvent(
        "warn",
        "Machine",
        "Refused",
        d.name + " needs " + short.need + " g of " + h.ingredient + "; the " + h.code + " hopper holds " + grams(short.have) + "."
      );
      return;
    }
    state.brewing = { drink: d, started: Date.now(), phase: "dispense", dispensed: { coffee: 0, milk: 0, chocolate: 0 } };
    logEvent("info", "Machine", "Brewing", d.name + ": dispensing " + K.recipeText(d) + " from the hoppers.");
    announce("Making " + K.withArticle(d.name) + ".");
    setCupLevel(0, d.color);
    renderDrinks();
    renderCup();
    state.brewTimer = root.setInterval(stepBrew, 50);
    stepBrew();
  }

  function stepBrew() {
    const b = state.brewing;
    if (!b) return;
    const t = Date.now() - b.started;
    const total = DISPENSE_MS + BREW_MS;
    const f = Math.min(1, t / DISPENSE_MS);
    K.uses(b.drink).forEach((u) => {
      const due = u.grams * f;
      const delta = due - b.dispensed[u.code];
      if (delta > 0) {
        state.mass[u.code] = Math.max(0, state.mass[u.code] - delta);
        b.dispensed[u.code] = due;
        renderHopper(u.code);
      }
    });
    if (t < DISPENSE_MS) {
      setScreen("Dispensing " + K.recipeText(b.drink) + "…");
      setCupLevel(0.08 * f);
    } else {
      if (b.phase !== "brew") {
        b.phase = "brew";
        renderCup();
      }
      const left = Math.max(1, Math.ceil((total - t) / 1000));
      setScreen("Brewing " + K.withArticle(b.drink.name) + "… " + left + " s");
      setCupLevel(0.08 + 0.92 * Math.min(1, (t - DISPENSE_MS) / BREW_MS));
    }
    setProgress(t / total);
    if (t >= total) finishBrew();
  }

  function finishBrew() {
    root.clearInterval(state.brewTimer);
    const d = state.brewing.drink;
    K.uses(d).forEach((u) => renderHopper(u.code));
    state.brewing = null;
    state.cup = d;
    saveHoppers();
    setCupLevel(1, d.color);
    setProgress(1);
    setScreen("Your " + d.name + " is ready. Take it from the pickup slot.");
    announce("Your " + d.name + " is ready in the pickup slot.");
    logEvent("ok", "Machine", "Ready", d.name + " is in the pickup slot.");
    renderDrinks();
    renderCup();
  }

  function takeCup() {
    const d = state.cup;
    if (!d) return;
    const dialog = $("drink-alert");
    $("alert-title").textContent = "This is " + K.withArticle(d.name) + ".";
    $("alert-text").textContent =
      "Made with " + K.recipeText(d) + " from the hoppers (simulated, recipe version " + K.RECIPE_VERSION + ").";
    $("alert-swatch").style.setProperty("--liquid", d.color);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      // Very old browsers only. A native alert pauses the page's timers, so batches wait until it closes.
      root.alert("This is " + K.withArticle(d.name) + ".");
      cupTaken();
    }
  }

  function cupTaken() {
    const d = state.cup;
    if (!d) return;
    state.cup = null;
    setProgress(0);
    setScreen("Select a drink");
    logEvent("info", "Machine", "Taken", d.name + " taken from the pickup slot.");
    renderDrinks();
    renderCup();
    const btn = doc.querySelector('[data-drink="' + d.id + '"]');
    if (btn) btn.focus();
  }

  function riseNote(from, to) {
    return to - from > RISE_G
      ? " Unless refill mode is open on the dashboard, the backend records a rise of more than 20 g as an unrecorded refill."
      : "";
  }

  function fill(code) {
    const from = state.mass[code];
    state.mass[code] = K.CAPACITY_G;
    saveHoppers();
    renderHopper(code);
    renderDrinks();
    logEvent(
      "info",
      "Hopper",
      "Filled",
      K.hopper(code).name + " hopper filled from " + grams(from) + " to " + grams(K.CAPACITY_G) + "." + riseNote(from, K.CAPACITY_G)
    );
  }

  function onLoadInput(el) {
    const code = el.getAttribute("data-code");
    if (!(code in state.dragFrom)) state.dragFrom[code] = state.mass[code];
    state.mass[code] = Number(el.value);
    renderHopper(code);
    renderDrinks();
  }

  function onLoadChange(el) {
    const code = el.getAttribute("data-code");
    const from = code in state.dragFrom ? state.dragFrom[code] : state.mass[code];
    delete state.dragFrom[code];
    state.mass[code] = Number(el.value);
    saveHoppers();
    renderHopper(code);
    renderDrinks();
    logEvent(
      "info",
      "Hopper",
      "Load set",
      K.hopper(code).name + " load set from " + grams(from) + " to " + grams(state.mass[code]) + " with the load control." +
        riseNote(from, state.mass[code])
    );
  }

  function onPlug(el) {
    const code = el.getAttribute("data-code");
    state.connected[code] = el.checked;
    const name = K.hopper(code).name;
    logEvent(
      el.checked ? "info" : "warn",
      "Hopper",
      el.checked ? "Sensor connected" : "Sensor unplugged",
      el.checked
        ? name + " sensor connected again."
        : name + " sensor unplugged: the kit sends status unavailable with a null value."
    );
    if (state.power) readAll();
  }

  // ------------------------------------------------------------ setup

  function onClick(e) {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.getAttribute("data-action");
    if (action === "brew") brew(el.getAttribute("data-drink"));
    else if (action === "take") takeCup();
    else if (action === "fill") fill(el.getAttribute("data-code"));
    else if (action === "power") (state.power ? shutdown : boot)();
    else if (action === "forget-key") forgetKey();
    else if (action === "clear-log") $("log").innerHTML = "";
    else if (action === "filter") setFilter(el);
    else if (action === "backend-online" && V.startup) V.startup.goOnline();
  }

  function setFilter(el) {
    $("log").setAttribute("data-filter", el.getAttribute("data-filter"));
    doc.querySelectorAll('[data-action="filter"]').forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
  }

  function saveKey(e) {
    e.preventDefault();
    const input = $("device-key");
    const key = input.value.trim();
    if (!key) return;
    state.deviceKey = key;
    saveItem(keyName(), key);
    input.value = "";
    const m = modeInfo();
    logEvent("info", "Kit", "Key saved", "Device key saved in this browser. Mode: " + m.text.toLowerCase() + "." + (m.note ? " " + m.note : ""));
    renderKit();
  }

  function forgetKey() {
    state.deviceKey = "";
    saveItem(keyName(), null);
    logEvent("info", "Kit", "Key removed", "Device key removed from this browser. Batches are only logged now.");
    renderKit();
    $("device-key").focus();
  }

  V.machine = {
    start: function start() {
      doc = root.document;
      let saved = null;
      try {
        saved = JSON.parse(loadItem(STORE_HOPPERS) || "null");
      } catch (e) {
        saved = null;
      }
      K.HOPPERS.forEach((h) => {
        const m = saved && saved.mass ? saved.mass[h.code] : undefined;
        state.mass[h.code] =
          typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= LOAD_MAX_G ? m : DEFAULT_MASS[h.code];
        state.connected[h.code] = true;
      });
      const legacy = loadItem(STORE_KEY); // a key saved before keys were kept per backend
      if (legacy && !loadKey()) saveItem(keyName(), legacy);
      if (legacy) saveItem(STORE_KEY, null);
      state.deviceKey = loadKey();
      root.addEventListener("vendo:backend", onBackendSwitch);

      $("hoppers").innerHTML = K.HOPPERS.map(hopperHtml).join("");
      $("drinks").innerHTML = K.DRINKS.map(drinkHtml).join("");
      K.HOPPERS.forEach((h) => {
        renderHopper(h.code);
        renderReading(h.code);
      });
      renderDrinks();
      renderCup();
      renderCounts();

      doc.addEventListener("click", onClick);
      doc.addEventListener("input", (e) => {
        if (e.target.classList.contains("load")) onLoadInput(e.target);
      });
      doc.addEventListener("change", (e) => {
        if (e.target.classList.contains("load")) onLoadChange(e.target);
        else if (e.target.classList.contains("plug")) onPlug(e.target);
      });
      $("key-form").addEventListener("submit", saveKey);
      $("drink-alert").addEventListener("close", cupTaken);

      boot();
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
