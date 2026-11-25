/*
 * Where the dashboard finds the backend. Edit these two values; nothing else.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});

  V.config = {
    // The deployed backend on Render (no trailing slash).
    // For a demo without internet, run the backend on this computer and use
    // "http://127.0.0.1:8000" instead (frontend/README.md, mock coffee machine).
    API_BASE_URL: "https://vendoplus-backend.onrender.com",

    // Needed only when the backend's OPERATOR_KEY setting is not empty; then every
    // refill, acknowledge, and reconcile action sends it as X-Operator-Key.
    // Never commit a real key: type it here only on the machine that runs the demo.
    OPERATOR_KEY: "",
  };
})(typeof window !== "undefined" ? window : globalThis);
