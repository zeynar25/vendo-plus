/*
 * Refill and history (GET /api/v1/compartments/{id}/refills and the refill
 * actions): start, end, or cancel refill mode, the stable readings before and
 * after, past refills, and detected unrecorded refills waiting to be reconciled.
 *
 * Refill mode needs a stable reading (three valid reports within 5 g). Until the
 * backend has one it answers 409 "not stable"; the page then shows "Waiting for a
 * stable reading" and retries every few seconds.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});
  V.views = V.views || {};
  const esc = V.esc;
  const fmt = V.fmt;
  const RETRY_MS = 3000;

  // Per compartment: { phase: "waiting-start" | "waiting-end" | "recorded", result, timer }
  const flows = {};

  function flow(id) {
    return flows[id] || (flows[id] = { phase: null, result: null, timer: null });
  }

  function stop(id) {
    const f = flow(id);
    clearTimeout(f.timer);
    f.timer = null;
  }

  function isNotStable(err) {
    return err && err.status === 409 && err.detail === "not stable";
  }

  /** Calls start or end; on "not stable" keeps waiting and retries every few seconds. */
  function tryStep(id, step) {
    const f = flow(id);
    const call = step === "start" ? V.api.startRefill : V.api.endRefill;
    return call(id)
      .then(function (result) {
        stop(id);
        f.phase = step === "start" ? null : "recorded";
        f.result = step === "start" ? null : result;
      })
      .catch(function (err) {
        if (!isNotStable(err)) {
          stop(id);
          f.phase = null;
          V.showActionError(err);
          return;
        }
        f.phase = step === "start" ? "waiting-start" : "waiting-end";
        stop(id);
        f.timer = setTimeout(function () {
          tryStep(id, step).then(V.refresh);
        }, RETRY_MS);
      });
  }

  V.actions = V.actions || {};
  V.actions["start-refill"] = function (el) {
    const id = Number(el.getAttribute("data-id"));
    V.state.actionError = null;
    flow(id).result = null;
    return tryStep(id, "start");
  };
  V.actions["end-refill"] = function (el) {
    const id = Number(el.getAttribute("data-id"));
    V.state.actionError = null;
    return tryStep(id, "end");
  };
  V.actions["cancel-refill"] = function (el) {
    const id = Number(el.getAttribute("data-id"));
    const f = flow(id);
    V.state.actionError = null;
    stop(id);
    const wasWaitingToStart = f.phase === "waiting-start";
    f.phase = null;
    f.result = null;
    // Nothing is open while waiting to start, so there is nothing to cancel on the backend.
    if (wasWaitingToStart) return null;
    return V.api.cancelRefill(id).catch(V.showActionError);
  };

  // ---- Rendering ---------------------------------------------------------

  /** Works out which state of the refill flow to show (Figma frames 3 to 3e). */
  function phaseOf(c, machine, history) {
    const f = flow(c.id);
    if (machine.mode === "replay") return "replay";
    const open = history.refills.find(function (r) {
      return r.status === "open";
    });
    if (open) return f.phase === "waiting-end" ? "waiting-end" : "open";
    if (f.phase === "waiting-start") return "waiting-start";
    if (f.phase === "recorded" && f.result) return "recorded";
    return "idle";
  }

  function btn(action, id, label, cls, disabled) {
    return (
      '<button type="button" class="btn ' + cls + '" data-action="' + action + '" data-id="' + esc(id) + '"' +
      (disabled ? " disabled" : "") + ">" + label + "</button>"
    );
  }

  function modeCard(c, phase) {
    const id = c.id;
    const parts = {
      idle: [
        '<span class="pill pill--small pill--neutral">Not in refill mode</span>',
        "Start refill just before you refill. The backend first needs a stable reading: three valid reports within 5 g.",
        btn("start-refill", id, "Start refill", "btn--primary"),
      ],
      "waiting-start": [
        '<span class="pill pill--small pill--warn">Waiting for a stable reading</span>',
        "The backend answered 409 “not stable”. Retrying every few seconds. Three valid reports within 5 g are needed.",
        '<span class="progress" aria-hidden="true"><span></span></span>' + btn("cancel-refill", id, "Cancel", "btn--outline"),
      ],
      open: [
        '<span class="pill pill--small pill--info">Refill in progress</span>',
        esc(c.name) + " shows refill in progress with no urgency. Refill it, then end refill mode.",
        '<span class="btn-row">' + btn("end-refill", id, "End refill", "btn--primary") +
          btn("cancel-refill", id, "Cancel", "btn--outline") + "</span>" +
          '<p class="fine">Cancel leaves refill mode without recording anything.</p>',
      ],
      "waiting-end": [
        '<span class="pill pill--small pill--info">Waiting for a stable reading</span>',
        "End refill was sent. The backend answered 409 “not stable” and retries every few seconds until the reading " +
          "after the refill settles: three valid reports within 5 g.",
        '<span class="btn-row">' + btn("end-refill", id, "End refill", "btn--primary", true) +
          btn("cancel-refill", id, "Cancel", "btn--outline") + "</span>" +
          '<p class="fine">Cancel leaves refill mode without recording anything.</p>',
      ],
      recorded: [
        '<span class="pill pill--small pill--low">Refill recorded</span>',
        "The stable readings before and after, and the amount added, were saved. The refill is in the history.",
        btn("start-refill", id, "Start refill", "btn--primary"),
      ],
      replay: [
        '<span class="pill pill--small pill--neutral">Not available during replay</span>',
        "Refill mode works only in live mode. During a replay run the backend answers 409, because replayed readings " +
          "are not real stock. It returns when the machine is back in live mode.",
        btn("start-refill", id, "Start refill", "btn--primary", true),
      ],
    }[phase];
    return (
      '<section class="card refill-card" aria-live="polite"><h2 class="card-title">Refill mode</h2>' + parts[0] +
      '<p class="refill-text">' + parts[1] + "</p>" + parts[2] + "</section>"
    );
  }

  function tile(name, value, caption, muted) {
    return (
      '<div class="tile"><span class="tile-name">' + name + '</span><strong class="tile-value">' + esc(value) +
      '</strong><span class="tile-caption' + (muted ? " is-muted" : "") + '">' + caption + "</span></div>"
    );
  }

  function stableCard(c, phase, history) {
    const open = history.refills.find(function (r) {
      return r.status === "open";
    });
    const result = flow(c.id).result;
    const stable = "3 reports within 5 g";
    let tiles;
    if (phase === "recorded") {
      tiles = [
        tile("Before", fmt.amount(result.before_value, c.unit), stable),
        tile("After", fmt.amount(result.after_value, c.unit), stable),
        tile("Amount added", fmt.added(result.added, c.unit), "After minus before; never below 0 g"),
      ];
    } else if (phase === "open" || phase === "waiting-end") {
      tiles = [
        tile("Before", fmt.amount(open.before_value, c.unit), stable),
        tile("After", "—", phase === "open" ? "Waiting for the refill to end" : "Waiting for a stable reading"),
        tile("Amount added", "—", "Not available"),
      ];
    } else if (phase === "waiting-start") {
      tiles = [tile("Before", "—", "Waiting for a stable reading"), tile("After", "—", "Not available"),
        tile("Amount added", "—", "Not available")];
    } else {
      const muted = phase === "replay";
      tiles = [tile("Before", "—", "No reading yet", muted), tile("After", "—", "No reading yet", muted),
        tile("Amount added", "—", "Not available", muted)];
    }
    return '<section class="card refill-section"><h2 class="card-title">Stable readings</h2><div class="tiles">' +
      tiles.join("") + "</div></section>";
  }

  function statusPill(r) {
    if (r.status === "open") return '<span class="pill pill--small pill--info">In progress</span>';
    if (r.status === "cancelled") return '<span class="pill pill--small pill--neutral">Cancelled</span>';
    if (r.kind === "reconciled") return '<span class="pill pill--small pill--info">Reconciled</span>';
    return '<span class="pill pill--small pill--low">Recorded</span>';
  }

  function historyCard(c, history) {
    const rows = history.refills
      .map(function (r) {
        return (
          '<tr data-key="r-' + esc(r.id) + '"><td>' + statusPill(r) + "</td><td>" + esc(fmt.dayTime(r.started_at)) +
          "</td><td>" + esc(r.ended_at ? fmt.dayTime(r.ended_at) : "—") + "</td><td>" + esc(fmt.amount(r.before_value, c.unit)) +
          "</td><td>" + esc(fmt.amount(r.after_value, c.unit)) + '</td><td class="added">' +
          esc(r.added == null ? "—" : fmt.added(r.added, c.unit)) + "</td></tr>"
        );
      })
      .join("");
    return (
      '<section class="card refill-section"><h2 class="card-title">Past refills</h2>' +
      (rows
        ? '<table class="plain-table refills-table"><thead><tr><th scope="col">Status</th><th scope="col">Start</th>' +
          '<th scope="col">End</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Added</th></tr>' +
          "</thead><tbody>" + rows + "</tbody></table>"
        : '<p class="empty">No refills recorded yet.</p>') +
      "</section>"
    );
  }

  function unrecordedCard(c, history) {
    const list = history.unrecorded_refills || [];
    const items = list
      .map(function (u) {
        return (
          '<div class="unrecorded" data-key="u-' + esc(u.history_reset_id) + '"><span>' + esc(fmt.dayTime(u.at)) +
          " · jump of " + esc(fmt.added(u.jump, c.unit)) + "</span>" +
          '<button type="button" class="btn btn--outline" data-action="reconcile" data-reset="' + esc(u.history_reset_id) +
          '">Reconcile refill</button></div>'
        );
      })
      .join("");
    return (
      '<section class="card refill-section"><h2 class="card-title">Unrecorded refills waiting to be reconciled</h2>' +
      (items
        ? items + '<p class="fine">Until it is reconciled, the consumption history is invalid and the model falls back to ' +
          "the basic stock warning.</p>"
        : '<p class="empty">No unrecorded refills.</p>') +
      "</section>"
    );
  }

  V.views.refills = {
    load: function (route) {
      return V.loadWithCompartment(route, V.api.getRefills);
    },
    render: function (data) {
      if (!data.entry) return V.hopperChooser(data.status, "refills", data.missingId);
      const m = data.entry.machine;
      const c = data.entry.compartment;
      const history = data.one;
      const phase = phaseOf(c, m, history);
      const context = m.id + " · " + c.name + " (" + c.code + ") · " + (m.mode === "replay" ? "Replay mode" : "Live mode");
      return (
        '<div class="page-head title-row"><h1 class="page-title">Refill and history</h1>' +
        '<span class="pill pill--small pill--neutral">' + esc(context) + "</span>" +
        V.hopperSwitch(data.status, "refills", c.id) + "</div>" + V.actionErrorHtml() +
        '<div class="refill-grid"><div>' + modeCard(c, phase) + "</div>" +
        '<div class="refill-main">' + stableCard(c, phase, history) + historyCard(c, history) + unrecordedCard(c, history) +
        "</div></div>"
      );
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
