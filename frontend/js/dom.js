/*
 * Small DOM helpers shared by every view.
 * Scripts are plain (no modules, no build step) so the dashboard also opens
 * straight from the file system. Everything hangs off one global: Vendo.
 */
(function (root) {
  "use strict";
  const V = (root.Vendo = root.Vendo || {});

  /** Escapes text for use inside HTML. */
  V.esc = function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  /**
   * Updates `target` so its content matches `html`, changing only what differs.
   * The overview refreshes every 2 s; patching instead of replacing keeps
   * keyboard focus and hover state on buttons between refreshes.
   * Elements with different data-key values are replaced, not reused.
   */
  V.patch = function patch(target, html) {
    const tpl = target.ownerDocument.createElement("template");
    tpl.innerHTML = html;
    morphChildren(target, tpl.content);
  };

  function sameKind(a, b) {
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
    if (a.nodeType !== 1) return true;
    return a.getAttribute("data-key") === b.getAttribute("data-key");
  }

  function morphChildren(oldParent, newParent) {
    const oldNodes = Array.from(oldParent.childNodes);
    const newNodes = Array.from(newParent.childNodes);
    newNodes.forEach(function (next, i) {
      const prev = oldNodes[i];
      if (!prev) {
        oldParent.appendChild(next.cloneNode(true));
      } else if (!sameKind(prev, next)) {
        oldParent.replaceChild(next.cloneNode(true), prev);
      } else if (prev.nodeType === 1) {
        syncAttributes(prev, next);
        morphChildren(prev, next);
      } else if (prev.nodeValue !== next.nodeValue) {
        prev.nodeValue = next.nodeValue;
      }
    });
    for (let i = oldNodes.length - 1; i >= newNodes.length; i--) {
      oldParent.removeChild(oldNodes[i]);
    }
  }

  function syncAttributes(prev, next) {
    Array.from(prev.attributes).forEach(function (a) {
      if (!next.hasAttribute(a.name)) prev.removeAttribute(a.name);
    });
    Array.from(next.attributes).forEach(function (a) {
      if (prev.getAttribute(a.name) !== a.value) prev.setAttribute(a.name, a.value);
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
