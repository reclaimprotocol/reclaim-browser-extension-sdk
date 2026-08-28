/**
 * VENDORED — DO NOT "IMPROVE" THIS FILE.
 *
 * Verbatim port of the extraction half of attestor-core
 * `src/providers/http/utils.ts` as of @reclaimprotocol/attestor-core@5.0.8.
 * The extraction code is byte-identical across 5.0.5 → 5.1.1, and on the
 * current 5.1.1 pin that is no longer an assertion: attestor-parity.test.js
 * drives the installed package's own `./external-rpc` surface and diffs it
 * against this copy on every `npm test`.
 *
 * Why still vendored rather than imported now that 5.1.1 exports the
 * extractors (PR #92): `makeRegex` and the `processRedactionRequest` redaction
 * chain are still not in that export set, so local copies are needed either
 * way — and a half-imported, half-copied chain is harder to keep in lockstep
 * than a wholly copied one the parity test can check end to end.
 *
 * The point of this file is that a provider's `xPath` / `jsonPath` resolves
 * identically here, in the attestor, and in the InApp SDK. Editing it breaks
 * that. To re-sync: re-copy from upstream, keep the deviation noted on
 * `makeRegex` below, and run `npm test`.
 *
 * ONE DELIBERATE DEVIATION: `makeRegex` uses native RegExp rather than RE2.
 * That is what the attestor itself does in browsers — its esbuild browser
 * build aliases `re2` to `src/scripts/fallbacks/re2.ts`, which is
 * `new RegExp(pattern, flags.replace('u',''))`. RE2 is not an option here
 * anyway: webpack.config.js aliases `re2: false`.
 *
 * Omitted from the port (not needed by the extension, all TLS-transcript
 * concerns): buildHeaders, convertResponsePosToAbsolutePos,
 * getRedactionsForChunkHeaders, parseHttpResponse, matchRedactedStrings,
 * generateRequstAndResponseFromTranscript.
 */

import "./patch-parse5-tree.js";

import { JSONPath } from "jsonpath-plus";
import { parse } from "parse5";
import { adapter as htmlAdapter } from "parse5-htmlparser2-tree-adapter";
import xpath from "xpath";
import {
  ArrayExpression,
  ExpressionStatement,
  ObjectExpression,
  parseScript,
  Property,
  Syntax,
} from "esprima-next";

/**
 * Returns only first extracted element
 * @param {string} html
 * @param {string} xpathExpression
 * @param {boolean} contentsOnly
 * @returns {string}
 */
export function extractHTMLElement(html, xpathExpression, contentsOnly) {
  const { start, end } = extractHTMLElementIndex(html, xpathExpression, contentsOnly);
  return html.slice(start, end);
}

/**
 * Returns all extracted elements
 * @param {string} html
 * @param {string} xpathExpression
 * @param {boolean} contentsOnly
 * @returns {string[]}
 */
export function extractHTMLElements(html, xpathExpression, contentsOnly) {
  const indexes = extractHTMLElementsIndexes(html, xpathExpression, contentsOnly);
  const res = [];
  for (const { start, end } of indexes) {
    res.push(html.slice(start, end));
  }

  return res;
}

/**
 * returns a single index of extracted element
 * @param {string} html
 * @param {string} xpathExpression
 * @param {boolean} contentsOnly
 * @returns {{ start: number, end: number }}
 */
export function extractHTMLElementIndex(html, xpathExpression, contentsOnly) {
  return extractHTMLElementsIndexes(html, xpathExpression, contentsOnly)[0];
}

/**
 * Returns indexes of all extracted elements
 * @param {string} html
 * @param {string} xpathExpression
 * @param {boolean} contentsOnly indices of the start and end of the element's
 *  contents only, not the whole tag
 * @returns {{ start: number, end: number }[]}
 */
export function extractHTMLElementsIndexes(html, xpathExpression, contentsOnly) {
  return extractHTMLElementIndexesParse5(html, xpathExpression, contentsOnly);
}

function extractHTMLElementIndexesParse5(html, xpathExpression, contentsOnly) {
  const domLight = parse(html, { treeAdapter: htmlAdapter, sourceCodeLocationInfo: true });
  // lets xpath identify this as a node
  domLight["name"] = "root";

  const parsedPath = xpath.parse(xpathExpression);
  const nodes = parsedPath.select({
    node: domLight,
    allowAnyNamespaceForNoPrefix: true,
  });
  if (!nodes.length) {
    throw new Error(`Failed to find XPath: "${xpathExpression}"`);
  }

  return nodes.map((node) => getNodeRange(node, contentsOnly));
}

function getNodeRange(node, contentsOnly) {
  if (!contentsOnly) {
    return { start: node.startIndex, end: node.endIndex };
  }

  if (!("firstChild" in node) || !node.firstChild) {
    throw new Error(`Node "${node["name"]}" has no children`);
  }

  return {
    start: node.firstChild.startIndex,
    end: node.lastChild.endIndex,
  };
}

/**
 * @param {string} json
 * @param {string} jsonPath
 * @returns {{ start: number, end: number }}
 */
export function extractJSONValueIndex(json, jsonPath) {
  return extractJSONValueIndexes(json, jsonPath)[0];
}

/**
 * @param {string} json
 * @param {string} jsonPath
 * @returns {{ start: number, end: number }[]}
 */
export function extractJSONValueIndexes(json, jsonPath) {
  const pointers = JSONPath({
    path: jsonPath,
    json: JSON.parse(json),
    wrap: false,
    resultType: "pointer",
    eval: "safe",
    ignoreEvalErrors: true,
  });
  if (!pointers) {
    throw new Error("jsonPath not found");
  }

  //wrap in parentheses for esprima to parse
  const tree = parseScript("(" + json + ")", { range: true });
  if (
    tree.body[0] instanceof ExpressionStatement &&
    (tree.body[0].expression instanceof ObjectExpression ||
      tree.body[0].expression instanceof ArrayExpression)
  ) {
    const traversePointers = Array.isArray(pointers) ? pointers : [pointers];
    const res = [];
    for (const pointer of traversePointers) {
      const index = traverse(tree.body[0].expression, "", [pointer]);
      if (index) {
        res.push({
          start: index.start - 1, //account for '('
          end: index.end - 1,
        });
      }
    }

    return res;
  }

  throw new Error("jsonPath not found");
}

/**
 * recursively go through AST tree and build a JSON path while it's not equal to
 * the one we search for
 * @param {object} o - esprima expression for root object
 * @param {string} path - path that is being built
 * @param {string[]} pointers - JSON pointers to compare to
 * @returns {{ start: number, end: number } | null}
 */
function traverse(o, path, pointers) {
  if (o instanceof ObjectExpression) {
    for (const p of o.properties) {
      if (!(p instanceof Property)) {
        continue;
      }

      const localPath = p.key.type === Syntax.Literal ? path + "/" + p.key.value : path;

      if (pointers.includes(localPath) && "range" in p && Array.isArray(p.range)) {
        return {
          start: p.range[0],
          end: p.range[1],
        };
      }

      if (p.value instanceof ObjectExpression || p.value instanceof ArrayExpression) {
        const res = traverse(p.value, localPath, pointers);
        if (res) {
          return res;
        }
      }
    }
  }

  if (o instanceof ArrayExpression) {
    for (let i = 0; i < o.elements.length; i++) {
      const element = o.elements[i];
      if (!element) {
        continue;
      }

      const localPath = path + "/" + i;

      if (pointers.includes(localPath) && "range" in element && Array.isArray(element.range)) {
        return {
          start: element.range[0],
          end: element.range[1],
        };
      }

      if (element instanceof ObjectExpression) {
        const res = traverse(element, localPath, pointers);
        if (res) {
          return res;
        }
      }

      if (element instanceof ArrayExpression) {
        const res = traverse(element, localPath, pointers);
        if (res) {
          return res;
        }
      }
    }
  }

  return null;
}

// Upstream defines makeRegex in this file. It lives in ../make-regex.js here so
// the content script can share the attestor's regex flags without pulling the
// parsers above into a bundle injected on every page. Re-exported so this module
// still presents upstream's surface.
export { makeRegex } from "../make-regex.js";
