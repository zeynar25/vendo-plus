// Loads the dashboard's plain scripts into one shared context for the tests.
// Run all tests from the repository root with: node --test "frontend/tests/*.test.js"
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(files, extra) {
  const context = Object.assign({ console, setTimeout, clearTimeout, Intl, URLSearchParams, Promise }, extra || {});
  context.globalThis = context;
  vm.createContext(context);
  for (const file of files) {
    const code = fs.readFileSync(path.join(__dirname, "..", "js", file), "utf8");
    vm.runInContext(code, context, { filename: file });
  }
  return context.Vendo;
}

module.exports = { load };
