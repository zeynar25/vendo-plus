/*
 * Start-up check. When a page opens, make sure the backend is awake before the
 * operator starts reading the dashboard.
 *
 * The backend runs on Render's free plan, which puts it to sleep after 15 minutes
 * without traffic and takes about a minute to wake it on the next request. During
 * that minute, requests wait or fail. This window explains the wait in plain words,
 * keeps asking the backend, and closes by itself once the backend answers and its
 * database and model are ready. If the backend answers quickly, it never appears.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});

  const S = (V.startup = {
    SHOW_AFTER_MS: 800, // a quicker answer means the server was already awake: no window
    RETRY_MS: 3000, // after a failed or unusable answer, ask again 3 s later
    REQUEST_TIMEOUT_MS: 75000, // a waking server can hold a request for about a minute
    TYPICAL_MS: 60000, // Render: waking takes about a minute
    SLOW_AFTER_MS: 150000, // after 2.5 minutes, say that it is taking longer than usual
    CLOSE_AFTER_READY_MS: 1200,
  });

  // ------------------------------------------------------------------ logic

  S.baseUrl = function baseUrl(config) {
    return String((config && config.API_BASE_URL) || "").trim().replace(/\/+$/, "");
  };

  /** The placeholder address in config.js (".invalid" never resolves). */
  S.isPlaceholder = function isPlaceholder(base) {
    return /^https?:\/\/[^/]*\.invalid(:\d+)?$/i.test(base);
  };

  /** "vendoplus-backend.onrender.com" from "https://vendoplus-backend.onrender.com" */
  S.hostOf = function hostOf(base) {
    const m = /^https?:\/\/([^/]+)/i.exec(base);
    return m ? m[1] : base || "this page's address";
  };

  /** 83 000 ms -> "1:23" */
  S.formatElapsed = function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };

  function getJson(url, fetchImpl, timeoutMs) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    // Only an Accept header: a "simple" request, so the browser sends no CORS preflight.
    return fetchImpl(url, { headers: { Accept: "application/json" }, signal: ctrl ? ctrl.signal : undefined })
      .then((res) =>
        res
          .json()
          .catch(() => null)
          .then((body) => ({ status: res.status, ok: res.ok, body: body }))
      )
      .finally(() => {
        if (timer) clearTimeout(timer);
      });
  }

  /**
   * One attempt. Resolves (never rejects) with { awake: false, reason } while the
   * server is asleep or waking, or { awake: true, check } once /healthz answers with
   * JSON. A waking Render service may send a loading page instead of JSON, or no
   * CORS headers, which the browser reports as a failed request; both count as
   * "not awake yet".
   */
  S.probe = function probe(base, fetchImpl, timeoutMs) {
    const t = timeoutMs || S.REQUEST_TIMEOUT_MS;
    return getJson(base + "/healthz", fetchImpl, t).then(
      (health) => {
        if (!health.ok || !health.body || health.body.status !== "ok") {
          return { awake: false, reason: health.ok ? "not_ready" : "status_" + health.status };
        }
        return getJson(base + "/api/v1/system/check", fetchImpl, t).then(
          (check) => ({ awake: true, check: check.ok ? check.body : null }),
          () => ({ awake: true, check: null })
        );
      },
      (err) => ({ awake: false, reason: err && err.name === "AbortError" ? "timeout" : "no_answer" })
    );
  };

  /** What the system check says, in the window's terms. A missing check counts as ready. */
  S.summarize = function summarize(check) {
    if (!check) return { ready: true, known: false };
    const db = check.database || {};
    const model = check.model || {};
    return {
      ready: Boolean(check.ready),
      known: true,
      database: { ok: Boolean(db.ok), error: db.error || "" },
      model: {
        loaded: Boolean(model.loaded),
        error: model.error || "",
        algorithm: model.algorithm || "",
        sha: model.sha256 ? String(model.sha256).slice(0, 8) : "",
      },
    };
  };

  // ------------------------------------------------------------------ window

  let doc = null;
  let dlg = null;
  let opts = {};
  let base = "";
  let state = "checking";
  let shown = false;
  let hidden = false; // closed by the operator while still waiting
  let closed = false;
  let started = false;
  let awake = false;
  let startedAt = 0;
  let ticker = null;
  let retryTimer = null;
  let attemptId = 0;
  let summary = null;

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** The little server in the picture: asleep, waking, awake, worried, or puzzled. */
  function server(kind, x, active) {
    const eyes = {
      sleep: '<path class="su-line" d="M31 36 q5 4 10 0 M49 36 q5 4 10 0"/>',
      wake: '<ellipse class="su-ink" cx="36" cy="36" rx="4" ry="1.6"/><ellipse class="su-ink" cx="54" cy="36" rx="4" ry="1.6"/>',
      awake: '<circle class="su-ink" cx="36" cy="35" r="3.6"/><circle class="su-ink" cx="54" cy="35" r="3.6"/>',
      warn: '<circle class="su-ink" cx="36" cy="35" r="3.6"/><circle class="su-ink" cx="54" cy="35" r="3.6"/>',
      unknown: '<circle class="su-ink" cx="36" cy="35" r="3.6"/><circle class="su-ink" cx="54" cy="35" r="3.6"/>',
    }[kind];
    const mouth = {
      sleep: '<path class="su-line" d="M41 47 h8"/>',
      wake: '<ellipse class="su-ink" cx="45" cy="47" rx="3" ry="3.4"/>',
      awake: '<path class="su-line" d="M37 45 q8 7 16 0"/>',
      warn: '<path class="su-line" d="M38 48 q7 -5 14 0"/>',
      unknown: '<path class="su-line" d="M39 47 h12"/>',
    }[kind];
    const extra = {
      sleep: '<g class="su-zz"><text x="70" y="14">z</text><text x="78" y="6">Z</text></g>',
      wake: '<g class="su-shake"><path class="su-line su-thin" d="M2 26 h-6 M2 36 h-8 M2 46 h-6 M88 26 h6 M88 36 h8 M88 46 h6"/></g>',
      awake: '<g><circle class="su-ok" cx="82" cy="10" r="9"/><path class="su-tick" d="M78 10 l3 3 l6 -6"/></g>',
      warn: '<g><path class="su-warn" d="M82 1 l10 17 h-20 z"/><path class="su-tick" d="M82 7 v5 M82 15 v0.5"/></g>',
      unknown: '<g><circle class="su-q" cx="82" cy="10" r="9"/><text class="su-qmark" x="82" y="14.5" text-anchor="middle">?</text></g>',
    }[kind];
    return (
      '<g transform="translate(' + x + ',14)" class="su-server su-server--' + kind + (active ? " is-active" : "") + '">' +
      '<rect class="su-body" x="0" y="8" width="90" height="72" rx="14"/>' +
      eyes + mouth +
      '<path class="su-slot" d="M14 62 h48 M14 70 h48"/>' +
      '<circle class="su-led" cx="74" cy="66" r="4"/>' +
      extra +
      "</g>"
    );
  }

  function art() {
    if (state === "waking" || state === "slow" || state === "ready" || state === "checking") {
      const stage = state === "ready" ? 2 : 1;
      const panel = (i, kind, line1, line2) =>
        server(kind, 18 + i * 172, stage === i) +
        '<text class="su-cap' + (stage === i ? " is-active" : "") + '" x="' + (63 + i * 172) + '" y="118" text-anchor="middle">' +
        esc(line1) + '</text><text class="su-cap' + (stage === i ? " is-active" : "") + '" x="' + (63 + i * 172) +
        '" y="134" text-anchor="middle">' + esc(line2) + "</text>";
      return (
        '<svg class="su-art" viewBox="0 0 470 146" aria-hidden="true" focusable="false">' +
        '<path class="su-arrow" d="M124 56 h28 m-6 -5 l6 5 l-6 5 M296 56 h28 m-6 -5 l6 5 l-6 5"/>' +
        panel(0, "sleep", "Free plan: it sleeps", "after 15 idle minutes") +
        panel(1, "wake", "Opening the page", "wakes it up") +
        panel(2, "awake", "Ready in about", "a minute") +
        "</svg>"
      );
    }
    const kind = state === "problem" ? "warn" : "unknown";
    return (
      '<svg class="su-art su-art--single" viewBox="0 0 130 104" aria-hidden="true" focusable="false">' +
      server(kind, 20, true) +
      "</svg>"
    );
  }

  function step(status, text) {
    const icon = { done: "✓", now: "", todo: "", fail: "!" }[status];
    return (
      '<li class="su-step su-step--' + status + '"><span class="su-dot" aria-hidden="true">' + icon + "</span>" +
      "<span>" + text + '<span class="visually-hidden"> (' + { done: "done", now: "in progress", todo: "waiting", fail: "problem" }[status] +
      ")</span></span></li>"
    );
  }

  function steps() {
    const host = "<b>" + esc(S.hostOf(base)) + "</b>";
    const awake = state === "ready" || state === "problem";
    const db = summary && summary.known ? summary.database.ok && summary.model.loaded : true;
    return (
      '<ol class="su-steps">' +
      step("done", "Asked " + host + " to wake up") +
      step(awake ? "done" : "now", "Server starting on Render’s free plan") +
      step(!awake ? "todo" : db ? "done" : "fail", "Database and prediction model checked") +
      "</ol>"
    );
  }

  function sampleHref() {
    const loc = root.location || {};
    const params = new URLSearchParams(loc.search || "");
    params.set("data", "sample");
    return "?" + params.toString() + (loc.hash || "");
  }

  function sampleButton(primary) {
    if (!opts.sampleData) return "";
    return '<a class="btn ' + (primary ? "btn--primary" : "btn--outline") + '" href="' + esc(sampleHref()) +
      '">Use sample data instead</a>';
  }

  const CONTENT = {
    checking: () => ({ title: "Checking the server", lead: "One moment…" }),
    waking: () => ({
      title: "Waking up the server",
      lead: "Please wait a moment. This usually takes about a minute.",
      body:
        "<p>The Vendo+ backend runs on <b>Render’s free plan</b>. When nobody has used it for 15 minutes, Render puts " +
        "it to sleep, and the next visit wakes it up. This window closes by itself as soon as the server answers.</p>",
      timer: true,
      steps: true,
      actions: '<button type="button" class="btn btn--outline" data-su="close">Close and wait in the ' +
        esc(opts.pageName) + "</button>" + sampleButton(false),
    }),
    slow: () => ({
      title: "Still waking up the server",
      lead: "This is taking longer than usual.",
      body:
        '<div class="su-note">The server may still be starting, or it may be down. This window keeps asking every few ' +
        "seconds. If you are presenting, you can carry on with sample data and come back later.</div>",
      timer: true,
      steps: true,
      actions: sampleButton(true) + '<button type="button" class="btn btn--outline" data-su="close">Close and wait in the ' +
        esc(opts.pageName) + "</button>",
    }),
    ready: () => ({
      title: "The server is awake",
      lead: "Opening the " + esc(opts.pageName) + "…",
      steps: true,
    }),
    problem: () => {
      const s = summary;
      const dbLine = s.database.ok ? "Database: connected." : "Database: can’t connect (" + esc(s.database.error || "no details") + ").";
      const modelLine = s.model.loaded
        ? "Prediction model: loaded (" + esc(s.model.algorithm) + (s.model.sha ? ", " + esc(s.model.sha) : "") + ")."
        : "Prediction model: not loaded, so urgency falls back to the basic stock warning" +
          (s.model.error ? " (" + esc(s.model.error) + ")" : "") + ".";
      return {
        title: "The server is awake, but not ready",
        lead: "It answered, but its own check found a problem:",
        body: '<ul class="su-list"><li>' + dbLine + "</li><li>" + modelLine + "</li></ul>" +
          "<p>Check <code>DATABASE_URL</code> and the logs in the Render dashboard, then check again.</p>",
        steps: true,
        actions: '<button type="button" class="btn btn--primary" data-su="retry">Check again</button>' +
          '<button type="button" class="btn btn--outline" data-su="close">Open the ' + esc(opts.pageName) + " anyway</button>",
      };
    },
    offline: () => ({
      title: "You’re offline",
      lead: "This computer isn’t connected to the internet, so it can’t reach " + esc(S.hostOf(base)) + ".",
      body: "<p>This window checks again as soon as the connection is back. Without internet, run the backend on this " +
        "computer (see <code>frontend/README.md</code>)" + (opts.sampleData ? " or use sample data" : "") + ".</p>",
      actions: sampleButton(true) + '<button type="button" class="btn btn--outline" data-su="close">Close</button>',
    }),
    placeholder: () => ({
      title: "The backend address isn’t set",
      lead: "<code>js/config.js</code> still has the placeholder address, so there is no server to talk to.",
      body: "<p>Set <code>API_BASE_URL</code> in <code>js/config.js</code> to the backend’s address, for example " +
        "<code>https://vendoplus-backend.onrender.com</code>." + (opts.sampleData ? " Until then, you can look around with sample data." : "") + "</p>",
      actions: sampleButton(true) + '<button type="button" class="btn btn--outline" data-su="close">Close</button>',
    }),
  };

  function render() {
    if (!dlg) return;
    const c = CONTENT[state]();
    dlg.className = "startup startup--" + state;
    dlg.querySelector(".su-content").innerHTML =
      '<div class="su-art-wrap">' + art() + "</div>" +
      '<h2 class="su-title" id="startup-title">' + c.title + "</h2>" +
      '<p class="su-lead" id="startup-lead">' + c.lead + "</p>" +
      (c.body || "") +
      (c.timer ? '<div class="su-progress" aria-hidden="true"><span></span></div><p class="su-time" aria-hidden="true"></p>' : "") +
      (c.steps ? steps() : "") +
      (c.actions ? '<div class="su-actions">' + c.actions + "</div>" : "");
    dlg.querySelector("#startup-status").textContent = c.title + ". " + c.lead.replace(/<[^>]+>/g, "");
    updateTimer();
  }

  function updateTimer() {
    if (!dlg) return;
    const elapsed = Date.now() - startedAt;
    if (shown && state === "waking" && elapsed >= S.SLOW_AFTER_MS) {
      setState("slow");
      return;
    }
    const time = dlg.querySelector(".su-time");
    const bar = dlg.querySelector(".su-progress");
    if (time) {
      time.textContent = "Waiting " + S.formatElapsed(elapsed) +
        (elapsed < S.TYPICAL_MS ? " · usually about a minute" : " · a little longer than usual, still trying");
    }
    if (bar) {
      bar.classList.toggle("is-indeterminate", elapsed >= S.TYPICAL_MS);
      bar.firstChild.style.width = Math.min(92, (elapsed / S.TYPICAL_MS) * 92).toFixed(1) + "%";
    }
  }

  function setState(next) {
    state = next;
    if (shown) render();
  }

  function show() {
    if (shown || closed || hidden) return;
    shown = true;
    render();
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
    ticker = setInterval(updateTimer, 1000);
  }

  function hideWindow() {
    clearInterval(ticker);
    if (dlg && dlg.open && typeof dlg.close === "function") dlg.close();
    else if (dlg) dlg.removeAttribute("open");
  }

  /** The operator closed the window: hide it, but keep checking so the page recovers by itself. */
  function dismiss() {
    if (closed) return;
    hidden = true;
    hideWindow();
  }

  /** Stop everything: the server answered, or there is nothing to check. */
  function close() {
    if (closed) return;
    closed = true;
    attemptId += 1;
    clearTimeout(retryTimer);
    hideWindow();
  }

  /** True while the server is being woken up (used by api.js to word its banner). */
  S.isWaking = function isWaking() {
    return started && !closed && !awake && (state === "checking" || state === "waking" || state === "slow");
  };

  /** The backend is awake: let the page ask it again straight away. */
  function backendReady() {
    if (V.connection) {
      V.connection.state = "ok";
      V.connection.lastFailure = 0;
      V.connection.error = null;
      if (V.renderConnection) V.renderConnection();
    }
    if (typeof V.refresh === "function") V.refresh();
    if (typeof opts.onReady === "function") opts.onReady();
  }

  function attempt() {
    if (closed) return;
    const id = ++attemptId;
    if (root.navigator && root.navigator.onLine === false) {
      state = "offline";
      show();
      if (shown) render();
      return;
    }
    S.probe(base, root.fetch.bind(root), S.REQUEST_TIMEOUT_MS).then((result) => {
      if (closed || id !== attemptId) return;
      if (!result.awake) {
        if (state === "offline" || state === "checking" || state === "problem") setState(shown ? "waking" : "checking");
        retryTimer = setTimeout(attempt, S.RETRY_MS);
        return;
      }
      summary = S.summarize(result.check);
      awake = true;
      backendReady();
      if (hidden) {
        close(); // the operator already closed the window; the page has refreshed
        return;
      }
      if (!summary.ready) {
        state = "problem";
        show();
        if (shown) render();
        return;
      }
      if (!shown) {
        close(); // answered quickly: the server was already awake
        return;
      }
      setState("ready");
      retryTimer = setTimeout(close, S.CLOSE_AFTER_READY_MS);
    });
  }

  function build() {
    dlg = doc.createElement("dialog");
    dlg.id = "startup";
    dlg.className = "startup";
    dlg.setAttribute("aria-labelledby", "startup-title");
    dlg.setAttribute("aria-describedby", "startup-lead");
    dlg.innerHTML =
      '<div class="su-content"></div><p class="visually-hidden" role="status" aria-live="polite" id="startup-status"></p>';
    dlg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-su]");
      if (!btn) return;
      if (btn.getAttribute("data-su") === "close") (awake || state === "placeholder" ? close : dismiss)();
      if (btn.getAttribute("data-su") === "retry") {
        awake = false;
        state = "waking";
        render();
        attempt();
      }
    });
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault(); // Esc closes it the same way as the close button
      (awake || state === "placeholder" ? close : dismiss)();
    });
    doc.body.appendChild(dlg);
  }

  /**
   * Starts the check. Options: pageName ("dashboard"), sampleData (offer ?data=sample),
   * onReady (called once the backend answers).
   */
  S.start = function start(options) {
    doc = root.document;
    opts = Object.assign({ pageName: "dashboard", sampleData: false }, options || {});
    if (V.sampleApi && V.api === V.sampleApi) return; // sample data: no server to wake
    base = S.baseUrl(V.config);
    startedAt = Date.now();
    started = true;
    build();
    if (S.isPlaceholder(base)) {
      state = "placeholder";
      show();
      return;
    }
    root.addEventListener("online", () => {
      if (!closed && state === "offline") {
        state = "waking";
        render();
        attempt();
      }
    });
    setTimeout(() => {
      if (!closed && state === "checking") {
        state = "waking";
        show();
      }
    }, S.SHOW_AFTER_MS);
    attempt();
  };
})(typeof window !== "undefined" ? window : globalThis);
