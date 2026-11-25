/*
 * Where the dashboard finds the backend. Edit these two values; nothing else.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});

  V.config = {
    // PLACEHOLDER. The backend is not deployed yet, so this address does not
    // exist (.invalid never resolves). Replace it with the Render URL once the
    // backend is live, for example "https://vendoplus-backend.onrender.com".
    // Locally: "http://127.0.0.1:8000". If the backend serves this page itself,
    // use "" (same address as the page).
    API_BASE_URL: "https://vendoplus-backend.example.invalid",

    // Needed only when the backend's OPERATOR_KEY setting is not empty; then every
    // refill, acknowledge, and reconcile action sends it as X-Operator-Key.
    // Never commit a real key: type it here only on the machine that runs the demo.
    OPERATOR_KEY: "",
  };
})(typeof window !== "undefined" ? window : globalThis);
