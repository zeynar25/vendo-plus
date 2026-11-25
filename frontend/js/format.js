/*
 * Number, time, and wording helpers. Every word the dashboard shows for an API
 * value is defined here, so all three views use the same words.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});

  // The machine's local time zone (the backend's TIMEZONE setting).
  V.TIME_ZONE = "Asia/Manila";

  const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
  const dayTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: V.TIME_ZONE, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const fullTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: V.TIME_ZONE, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23",
  });

  V.fmt = {
    /** 512.4 -> "512 g"; null -> "—". Every number carries its unit. */
    amount: function (value, unit) {
      return value == null ? "—" : num.format(value) + " " + (unit || "g");
    },
    /** 840 -> "+840 g" (refill amounts are never below 0). */
    added: function (value, unit) {
      return value == null ? "—" : "+" + num.format(value) + " " + (unit || "g");
    },
    /** 4.8 -> "4.8 %" */
    percent: function (value) {
      return value == null ? "—" : value.toFixed(1) + " %";
    },
    /** 1000 -> "1,000 g" */
    capacity: function (value, unit) {
      return num.format(value) + " " + (unit || "g");
    },
    /** Reading age in whole seconds: 3.4 -> "3 s". */
    age: function (seconds) {
      return seconds == null ? "—" : Math.round(seconds) + " s";
    },
    /** ISO time -> "14 Nov, 08:02" in the machine's time zone. */
    dayTime: function (iso) {
      return iso ? dayTime.format(new Date(iso)) : "—";
    },
    /** ISO time -> "14 Jan 2025, 09:30" (used for replay source time). */
    fullTime: function (iso) {
      return iso ? fullTime.format(new Date(iso)) : "—";
    },
    /** Consumption rate: 36.2 -> "36 g/h"; null -> "— g/h". */
    rate: function (value, unit) {
      return (value == null ? "—" : num.format(value)) + " " + (unit || "g") + "/h";
    },
  };

  /** Urgency is always a word, an icon, and a color. */
  V.URGENCY = {
    High: { icon: "▲", css: "high" },
    Medium: { icon: "◆", css: "medium" },
    Low: { icon: "●", css: "low" },
  };

  /** Why the basic stock warning is used instead of the model. */
  V.BASIC_REASON = {
    history_short: "Stock-based warning while 24 hours of history builds.",
    history_gap: "Stock-based warning: some recent readings are missing.",
    history_reset: "Stock-based warning: history restarted after a calibration change or an unrecorded refill.",
    refill_in_window: "Stock-based warning: a recent refill is still inside the history window.",
    model_unavailable: "Stock-based warning: the model is unavailable.",
    coil_row: "Stock-based warning: coil rows are counted, not predicted.",
  };

  V.MODEL_NOTE = "Estimated by the model from 24 h of history.";

  /** Why a compartment shows no urgency at all. */
  V.NO_LABEL_REASON = {
    no_reading: "No reading yet.",
    invalid_reading: "No valid reading, so no urgency.",
    refill_open: "Refill in progress. Urgency returns after the refill ends.",
  };

  /** The sensor status in words, for readings that cannot drive urgency. */
  V.SENSOR_STATUS = {
    unavailable: "Sensor not ready",
    out_of_range: "Reading rejected: outside −10 g to 1,050 g",
    over_capacity: "Above the 1,000 g capacity; not used for urgency",
  };

  /** Short text for what an urgency is based on. */
  V.basisText = function basisText(method, reason) {
    if (method === "model") return V.MODEL_NOTE;
    return V.BASIC_REASON[reason] || "Stock-based warning.";
  };
})(typeof window !== "undefined" ? window : globalThis);
