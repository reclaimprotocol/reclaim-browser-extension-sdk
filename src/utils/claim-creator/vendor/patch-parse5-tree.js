/**
 * VENDORED — DO NOT "IMPROVE" THIS FILE.
 *
 * Verbatim port of attestor-core `src/providers/http/patch-parse5-tree.ts`
 * as of @reclaimprotocol/attestor-core@5.0.8 (identical in 5.0.5 through 5.1.1).
 *
 * These patches are required to make the `xpath` package work with a parse5
 * tree: `xpath` expects DOM-ish nodes (`nodeName`, `localName`,
 * `attributes.item()`), and domhandler nodes don't provide them.
 *
 * Any local edit here silently breaks cross-SDK xPath parity — the whole point
 * of vendoring is that a provider's xPath resolves identically in the attestor,
 * the InApp SDK and this extension. To re-sync, re-copy from upstream and run
 * `npm test` (see attestor-extraction.test.js).
 */

import { Element, Node } from "domhandler";

Element.prototype.toString = function () {
  throw new Error("Element.toString() is not supported");
};

Object.defineProperty(Node.prototype, "nodeName", {
  get: function () {
    return this.name;
  },
});

Object.defineProperty(Node.prototype, "localName", {
  get: function () {
    return this.name;
  },
});

const origAttributes = Object.getOwnPropertyDescriptor(Element.prototype, "attributes")?.get;

if (origAttributes) {
  Object.defineProperty(Element.prototype, "attributes", {
    get: function (...args) {
      const attrs = origAttributes.call(this, ...args);
      attrs.item = (idx) => {
        const el = attrs[idx];
        return { ...el, nodeType: 2, localName: el.name };
      };

      return attrs;
    },
  });
} else {
  console.warn("[WARN] Unable to patch DOM: Element.attributes property descriptor not found");
}
