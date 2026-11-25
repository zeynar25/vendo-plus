/*
 * Reads from and writes to the backend over HTTP (docs/api-contract.md).
 * Same functions and results as the sample data in sample-data.js, so the views
 * do not know which one they use.
 *
 * The backend is used by default. Add ?data=sample to the address to use the
 * sample data instead (for example while the backend is not deployed).
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});

  const WAKING_AFTER_MS = 3000; // a slower answer means Render is waking the service
  const TIMEOUT_MS = 75000; // Render's free tier takes about a minute to wake
  const RETRY_UNREACHABLE_MS = 10000; // after a failed connection, try again every 10 s

  /** What the page knows about the connection: ok, waking, or unreachable. */
  V.connection = { state: "ok", url: "", lastFailure: 0, error: null };

  function baseUrl() {
    return String((V.config && V.config.API_BASE_URL) || "").replace(/\/+$/, "");
  }

  function setConnection(state, error) {
    // While the start-up check (startup.js) is still waiting for a sleeping server to
    // wake, a failed request is part of waking up, not a sign that the server is gone.
    if (state === "unreachable" && V.startup && V.startup.isWaking && V.startup.isWaking()) state = "waking";
    const changed = V.connection.state !== state;
    V.connection.state = state;
    V.connection.url = baseUrl();
    V.connection.error = error || null;
    if (state === "unreachable") V.connection.lastFailure = Date.now();
    if (changed && V.renderConnection) V.renderConnection();
  }

  function parseError(res) {
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        const detail = typeof body.detail === "string" ? body.detail : res.statusText || "request failed";
        throw new V.ApiError(res.status, detail);
      });
  }

  function request(method, path) {
    const conn = V.connection;
    if (conn.state === "unreachable" && Date.now() - conn.lastFailure < RETRY_UNREACHABLE_MS) {
      return Promise.reject(new V.ApiError(0, conn.error || "backend unreachable"));
    }
    const headers = { Accept: "application/json" };
    const key = V.config && V.config.OPERATOR_KEY;
    if (method === "POST" && key) headers["X-Operator-Key"] = key;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const waking = setTimeout(function () {
      setConnection("waking");
    }, WAKING_AFTER_MS);
    const timeout = setTimeout(function () {
      if (controller) controller.abort();
    }, TIMEOUT_MS);
    return root
      .fetch(baseUrl() + path, { method: method, headers: headers, signal: controller ? controller.signal : undefined })
      .then(
        function (res) {
          setConnection("ok");
          return res.ok ? res.json() : parseError(res);
        },
        function (err) {
          const detail = err && err.name === "AbortError" ? "no answer within 75 s" : "could not connect";
          setConnection("unreachable", detail);
          throw new V.ApiError(0, detail);
        }
      )
      .finally(function () {
        clearTimeout(waking);
        clearTimeout(timeout);
      });
  }

  V.httpApi = {
    source: "api",
    getStatus: function () {
      return request("GET", "/api/v1/status");
    },
    getCompartment: function (id) {
      return request("GET", "/api/v1/compartments/" + encodeURIComponent(id));
    },
    getRefills: function (id) {
      return request("GET", "/api/v1/compartments/" + encodeURIComponent(id) + "/refills");
    },
    acknowledge: function (id) {
      return request("POST", "/api/v1/compartments/" + encodeURIComponent(id) + "/acknowledge");
    },
    startRefill: function (id) {
      return request("POST", "/api/v1/compartments/" + encodeURIComponent(id) + "/refill/start");
    },
    endRefill: function (id) {
      return request("POST", "/api/v1/compartments/" + encodeURIComponent(id) + "/refill/end");
    },
    cancelRefill: function (id) {
      return request("POST", "/api/v1/compartments/" + encodeURIComponent(id) + "/refill/cancel");
    },
    reconcile: function (resetId) {
      return request("POST", "/api/v1/history-resets/" + encodeURIComponent(resetId) + "/reconcile");
    },
  };

  function wantsSample() {
    const search = root.location && root.location.search ? root.location.search : "";
    return new URLSearchParams(search).get("data") === "sample";
  }

  V.api = wantsSample() ? V.sampleApi : V.httpApi;

  // ---- What the page shows about the connection ----------------------------
  const esc = V.esc;

  function sampleLink() {
    const params = new URLSearchParams(root.location ? root.location.search : "");
    params.set("data", "sample");
    return "?" + params.toString() + (root.location ? root.location.hash : "");
  }

  /** A line above the page: sample data in use, backend waking, or backend unreachable. */
  V.renderConnection = function renderConnection() {
    const el = root.document && root.document.getElementById("connection");
    if (!el) return;
    let html = "";
    if (V.api === V.sampleApi) {
      html =
        '<div class="conn conn--info">Showing sample data, not the backend. Remove <code>data=sample</code> from the ' +
        "address to use the backend.</div>";
    } else if (V.backend && V.backend.mode === "local" && V.connection.state !== "unreachable") {
      const why = { offline: "No internet: u", unreachable: "The online backend can’t be reached: u" }[V.backend.reason] || "U";
      html =
        '<div class="conn conn--info">' + why + "sing the backend on this computer (<code>" + esc(V.backend.local) +
        "</code>). Its data is separate from the online backend’s. " +
        '<button type="button" class="linklike" data-action="backend-online">Go back to the online backend</button></div>';
    } else if (V.connection.state === "waking") {
      html =
        '<div class="conn conn--info"><span class="spinner" aria-hidden="true"></span>Waking the backend. ' +
        "After 15 idle minutes the free Render service sleeps; the first answer can take up to about a minute.</div>";
    } else if (V.connection.state === "unreachable") {
      html =
        '<div class="conn conn--error">Can’t reach the backend at <code>' + esc(V.connection.url || "(this page’s address)") +
        "</code> (" + esc(V.connection.error) + "). Retrying every 10 s. Set <code>API_BASE_URL</code> in " +
        '<code>js/config.js</code>, or <a href="' + esc(sampleLink()) + '">open the dashboard with sample data</a>.</div>';
    }
    V.patch(el, html);
  };

  if (root.document) root.document.addEventListener("DOMContentLoaded", V.renderConnection);

  /** Shown in place of a view when its data could not be loaded. */
  const TITLES = { overview: "Overview", compartment: "Compartment detail", refills: "Refill and history" };

  V.renderError = function renderError(err, route) {
    const head =
      '<div class="page-head"><h1 class="page-title">' + esc(TITLES[route && route.name] || "Vendo+") + "</h1></div>";
    if (err && err.status === 0) {
      return head + '<div class="card"><p class="empty">No data yet: the backend did not answer.</p></div>';
    }
    return (
      head + '<div class="card"><p class="empty">The backend answered ' + esc(err && err.status) + ": " +
      esc((err && err.detail) || "an error") + ".</p></div>"
    );
  };
})(typeof window !== "undefined" ? window : globalThis);
