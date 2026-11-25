/*
 * Mock coffee machine kit: the logic behind machine.html, with no DOM.
 *
 * A browser stand-in for the Wokwi kit, for demonstrations without internet.
 * It follows the kit as the paper and docs/api-contract.md describe it:
 * three hoppers on load cells, a reading from the median of five raw samples,
 * the firmware's status ranges, and one batch to POST /api/v1/readings every
 * 5 seconds. Every value it produces is simulated in this browser.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});
  const K = (V.kit = {});

  K.MACHINE_ID = "coffee-01";

  K.HOPPERS = [
    { code: "coffee", name: "Coffee", ingredient: "ground coffee", channel: 1 },
    { code: "milk", name: "Milk", ingredient: "milk powder", channel: 2 },
    { code: "chocolate", name: "Chocolate", ingredient: "cocoa drink powder", channel: 3 },
  ];

  // Hopper and sensor model (paper, System Design and Results).
  K.CAPACITY_G = 1000; // declared usable capacity of each hopper
  K.CONTAINER_G = 200; // simulated empty-container mass
  K.COUNTS_PER_G = 0.42; // raw counts per gram, so readings move in steps of about 2.38 g
  K.OFFSET_COUNTS = Math.round(K.CONTAINER_G * K.COUNTS_PER_G); // zero reference: the empty container
  K.NOISE_SD_G = 2; // modeled noise on each raw sample
  K.SAMPLES = 5; // the reading is the median of five samples
  K.CALIBRATION_VERSION = 1;
  K.REJECT_BELOW_G = -10;
  K.REJECT_ABOVE_G = 1050;

  // Timing
  K.SEND_EVERY_MS = 5000; // one batch every 5 seconds
  K.READ_EVERY_MS = 1000; // how often the page refreshes the load cell displays
  K.TIMEOUT_MS = 10000; // a batch without a reply by then counts as not delivered

  // Table 3, Ingredient Quantities per Beverage (g), recipe version R2. About 150 ml cups.
  // `assumed` lists the values the table marks as researcher-defined assumptions.
  K.RECIPE_VERSION = "R2";
  K.DRINKS = [
    { id: "espresso", name: "Espresso", grams: { coffee: 7, milk: 0, chocolate: 0 }, assumed: [], color: "#3b2418" },
    { id: "americano", name: "Americano", grams: { coffee: 7, milk: 0, chocolate: 0 }, assumed: [], color: "#4b2e1e" },
    {
      id: "americano-milk",
      name: "Americano with Milk",
      grams: { coffee: 7, milk: 6, chocolate: 0 },
      assumed: [],
      color: "#7a5236",
    },
    { id: "cortado", name: "Cortado", grams: { coffee: 7, milk: 6, chocolate: 0 }, assumed: ["milk"], color: "#8a5a3b" },
    { id: "cappuccino", name: "Cappuccino", grams: { coffee: 7, milk: 10, chocolate: 0 }, assumed: [], color: "#b0835c" },
    { id: "latte", name: "Latte", grams: { coffee: 7, milk: 12, chocolate: 0 }, assumed: [], color: "#c49c76" },
    { id: "cocoa", name: "Cocoa", grams: { coffee: 0, milk: 6, chocolate: 20 }, assumed: ["milk"], color: "#6b3f2a" },
    {
      id: "hot-chocolate",
      name: "Hot Chocolate",
      grams: { coffee: 0, milk: 8, chocolate: 20 },
      assumed: ["milk"],
      color: "#562d1d",
    },
  ];

  K.drink = function drink(id) {
    return K.DRINKS.find((d) => d.id === id) || null;
  };

  K.hopper = function hopper(code) {
    return K.HOPPERS.find((h) => h.code === code) || null;
  };

  /** "a Latte", "an Americano" */
  K.withArticle = function withArticle(name) {
    return (/^[AEIOU]/i.test(name) ? "an " : "a ") + name;
  };

  /** The hoppers a drink draws from, in hopper order: [{ code, grams, assumed }]. */
  K.uses = function uses(drink) {
    return K.HOPPERS.filter((h) => drink.grams[h.code] > 0).map((h) => ({
      code: h.code,
      grams: drink.grams[h.code],
      assumed: drink.assumed.indexOf(h.code) !== -1,
    }));
  };

  /** "7 g coffee and 12 g milk" */
  K.recipeText = function recipeText(drink) {
    const parts = K.uses(drink).map((u) => u.grams + " g " + u.code);
    return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] || "";
  };

  /** The first hopper that holds too little for the drink, or null. `mass` is grams by hopper code. */
  K.shortfall = function shortfall(drink, mass) {
    const short = K.uses(drink).find((u) => (mass[u.code] || 0) < u.grams);
    return short ? { code: short.code, need: short.grams, have: Math.max(0, mass[short.code] || 0) } : null;
  };

  // ---------------------------------------------------------------- sensing

  K.median = function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  /** Standard normal sample from a uniform source (Box-Muller). */
  K.gauss = function gauss(rand) {
    const u = 1 - rand();
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  const round1 = (x) => Math.round(x * 10) / 10;

  /**
   * The firmware's ranges, applied to converted grams:
   * below -10 g or above 1,050 g is rejected (value null), -10 g to 0 g is sent as 0,
   * above 1,000 g up to 1,050 g is kept but flagged.
   */
  K.classify = function classify(grams) {
    if (grams == null || !isFinite(grams)) return { value: null, status: "unavailable" };
    if (grams < K.REJECT_BELOW_G || grams > K.REJECT_ABOVE_G) return { value: null, status: "out_of_range" };
    if (grams < 0) return { value: 0, status: "corrected_zero" };
    if (grams > K.CAPACITY_G) return { value: round1(grams), status: "over_capacity" };
    return { value: round1(grams), status: "ok" };
  };

  /**
   * One reading of a hopper, as the kit takes it: five raw samples of container plus
   * ingredient, each with modeled noise, the median, then offset and scale to net grams.
   * `hopper` is { mass, connected }; `rand` returns a number in [0, 1).
   */
  K.read = function read(hopper, rand) {
    if (!hopper.connected) return { value: null, status: "unavailable", grams: null };
    const base = Math.round((K.CONTAINER_G + hopper.mass) * K.COUNTS_PER_G);
    const samples = [];
    for (let i = 0; i < K.SAMPLES; i++) {
      samples.push(base + Math.round(K.gauss(rand) * K.NOISE_SD_G * K.COUNTS_PER_G));
    }
    const grams = (K.median(samples) - K.OFFSET_COUNTS) / K.COUNTS_PER_G;
    const out = K.classify(grams);
    out.grams = round1(grams);
    return out;
  };

  // ---------------------------------------------------------------- batches

  /** A new session ID, as at every boot of the kit: 12 hex characters. */
  K.newSessionId = function newSessionId(randomBytes) {
    const bytes = randomBytes(6);
    return Array.from(bytes, (b) => ("0" + b.toString(16)).slice(-2)).join("");
  };

  /** ISO time without milliseconds, in UTC. */
  K.isoTime = function isoTime(date) {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  };

  /**
   * The next batch of a session. Takes the readings by hopper code and advances
   * the session's sequence by one, so a failed batch is never sent again.
   */
  K.buildBatch = function buildBatch(session, readings, now) {
    const batch = {
      machine_id: K.MACHINE_ID,
      session_id: session.id,
      sequence: session.sequence,
      device_time: K.isoTime(now),
      readings: K.HOPPERS.map((h) => ({
        compartment: h.code,
        value: readings[h.code].value,
        status: readings[h.code].status,
        calibration_version: K.CALIBRATION_VERSION,
      })),
    };
    session.sequence += 1;
    return batch;
  };

  /**
   * Where batches go. Like the public Wokwi project, the kit runs serial-only
   * (batches are logged, not sent) while the backend address is the placeholder
   * or the device key is empty.
   */
  K.target = function target(apiBase, deviceKey) {
    const base = String(apiBase == null ? "" : apiBase).trim().replace(/\/+$/, "");
    if (/^https?:\/\/[^/]*\.invalid(:\d+)?$/i.test(base)) return { serial: true, reason: "placeholder", base: base };
    if (!deviceKey) return { serial: true, reason: "no_key", base: base };
    return { serial: false, base: base, url: base + "/api/v1/readings" };
  };

  /** Sends one batch. Resolves (never rejects) with what happened. */
  K.post = function post(url, deviceKey, batch, fetchImpl, timeoutMs) {
    const started = Date.now();
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs || K.TIMEOUT_MS) : null;
    const done = (result) => {
      if (timer) clearTimeout(timer);
      result.ms = Date.now() - started;
      return result;
    };
    return fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Device-Key": deviceKey },
      body: JSON.stringify(batch),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(
      (res) =>
        res
          .json()
          .catch(() => null)
          .then((body) => {
            if (res.status === 201) {
              return done({
                outcome: "accepted",
                status: 201,
                batchId: body && body.batch_id,
                accepted: body && body.accepted,
                machineMode: body && body.machine_mode,
              });
            }
            return done({
              outcome: res.status >= 500 ? "server_error" : "rejected",
              status: res.status,
              detail: detailOf(body) || res.statusText || "",
            });
          }),
      (err) =>
        done({
          outcome: err && err.name === "AbortError" ? "timeout" : "failed",
          detail: err && err.message ? err.message : String(err),
        })
    );
  };

  function detailOf(body) {
    if (!body || body.detail == null) return "";
    if (typeof body.detail === "string") return body.detail;
    if (Array.isArray(body.detail) && body.detail.length) {
      const first = body.detail[0];
      return (first.loc ? first.loc.join(".") + ": " : "") + (first.msg || "");
    }
    return JSON.stringify(body.detail);
  }

  const REJECTED = {
    401: "missing or wrong device key",
    404: "unknown machine_id",
    409: "duplicate batch",
    422: "invalid batch",
  };

  /** One line for the log: { tone: "ok" | "warn" | "error" | "info", title, text } */
  K.describe = function describe(result, target) {
    if (!result) {
      return target.reason === "placeholder"
        ? { tone: "info", title: "Serial only", text: "Not sent: the backend address is the placeholder." }
        : { tone: "info", title: "Serial only", text: "Not sent: no device key entered." };
    }
    switch (result.outcome) {
      case "accepted": {
        const mode =
          result.machineMode === "replay"
            ? " The machine is in replay mode, so these readings are stored but do not drive urgency."
            : "";
        return {
          tone: "ok",
          title: "201 Accepted",
          text: "Stored " + result.accepted + " readings as batch " + result.batchId + "." + mode,
        };
      }
      case "rejected":
        return {
          tone: "error",
          title: result.status + " Rejected",
          text: result.detail || REJECTED[result.status] || "The backend refused the batch.",
        };
      case "server_error":
        return { tone: "error", title: result.status + " Server error", text: result.detail || "The backend failed." };
      case "timeout":
        return {
          tone: "warn",
          title: "Not delivered",
          text: "No reply within " + Math.round(K.TIMEOUT_MS / 1000) + " s. The next batch carries the newest state.",
        };
      default:
        return {
          tone: "warn",
          title: "Not delivered",
          text: "Could not reach the backend. The next batch carries the newest state.",
        };
    }
  };

  /** Words for each reading status, and the pill style the page gives it. */
  K.STATUS_TEXT = {
    ok: "OK",
    corrected_zero: "Corrected to 0 g",
    over_capacity: "Over capacity",
    unavailable: "Not ready",
    out_of_range: "Out of range",
  };
  K.STATUS_TONE = {
    ok: "low",
    corrected_zero: "neutral",
    over_capacity: "warn",
    unavailable: "high",
    out_of_range: "high",
  };
})(typeof window !== "undefined" ? window : globalThis);
