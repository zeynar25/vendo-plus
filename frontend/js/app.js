/*
 * The dashboard shell: hash routes, the header navigation, and the refresh loop.
 *   #/overview            ranked overview of the coffee machine
 *   #/compartment/<id>    compartment detail
 *   #/refills/<id>        refill mode and refill history
 * Each view registers itself in Vendo.views with load() and render().
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});
  V.views = V.views || {};
  V.state = V.state || { selectedId: null };

  const REFRESH_MS = 2000; // the dashboard asks for the latest status every 2 s

  const ROUTES = {
    overview: "Overview",
    compartment: "Compartment detail",
    refills: "Refill and history",
  };

  let current = null; // { name, id }
  let timer = null;
  let loading = false;
  let generation = 0;

  function parseHash() {
    const parts = (root.location.hash || "").replace(/^#\/?/, "").split("/");
    const name = ROUTES[parts[0]] ? parts[0] : "overview";
    const id = parts[1] ? Number(parts[1]) : null;
    return { name: name, id: Number.isFinite(id) ? id : null };
  }

  /** Points the detail and refill tabs at the selected compartment. */
  V.updateNav = function updateNav() {
    const sel = V.state.selectedId;
    document.querySelectorAll(".app-nav a").forEach(function (a) {
      const name = a.getAttribute("data-route");
      a.setAttribute("href", name === "overview" || sel == null ? "#/" + name : "#/" + name + "/" + sel);
      if (current && current.name === name) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  };

  function placeholder(name) {
    return (
      '<div class="page-head"><h1 class="page-title">' + V.esc(ROUTES[name]) + "</h1></div>" +
      '<div class="card"><p class="empty">This view is not built yet.</p></div>'
    );
  }

  /** Loads the current view's data and draws it. Skips a tick if a request is still running. */
  V.refresh = function refresh() {
    if (loading) return Promise.resolve();
    const view = V.views[current.name];
    const main = document.getElementById("view");
    if (!view) {
      V.patch(main, placeholder(current.name));
      return Promise.resolve();
    }
    loading = true;
    const gen = generation;
    return Promise.resolve(view.load(current))
      .then(function (data) {
        if (gen !== generation) return; // the route changed while loading
        V.patch(main, view.render(data, current));
        V.updateNav();
      })
      .catch(function (err) {
        if (gen !== generation) return;
        V.patch(main, V.renderError ? V.renderError(err, current) : placeholder(current.name));
      })
      .finally(function () {
        loading = false;
      });
  };

  function navigate() {
    generation += 1;
    loading = false;
    current = parseHash();
    if (current.id != null) V.state.selectedId = current.id;
    document.title = ROUTES[current.name] + " · Vendo+";
    V.updateNav();
    clearInterval(timer);
    V.refresh().then(function () {
      const main = document.getElementById("view");
      main.focus({ preventScroll: true });
    });
    timer = setInterval(V.refresh, REFRESH_MS);
  }

  /** Runs `handler` when an element with data-action="<name>" is clicked. */
  V.actions = V.actions || {};
  function onClick(event) {
    const el = event.target.closest("[data-action]");
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return;
    const handler = V.actions[el.getAttribute("data-action")];
    if (!handler) return;
    event.preventDefault();
    Promise.resolve(handler(el, current)).then(V.refresh);
  }

  V.start = function start() {
    root.addEventListener("hashchange", navigate);
    document.getElementById("view").addEventListener("click", onClick);
    navigate();
  };
})(typeof window !== "undefined" ? window : globalThis);
