/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* The NGSI-LD vocabulary contract (docs/api.md, "Vokabular").

   gui/public/ngsi-ld/udp-context.json maps every entity type and attribute
   name the connector service writes to the URI it is stored under in Orion-LD
   and TRoE. The connectors send only the core context, so every name the core
   context does not define expands via its @vocab to
   https://uri.etsi.org/ngsi-ld/default-context/<name>. The published context
   freezes exactly that expansion: a consumer using it gets the same URIs.

   What is checked:
     - the shape of the context (core context first, then the term mappings),
       and that the core context is the one the connectors send;
     - every mapping is the default-context URI of its own name — "fixing" a
       URI would orphan the stored data and its TRoE history;
     - no mapping shadows a term of the core context;
     - every entity type and attribute the connector source writes is listed
       (a new name must be added to the context and to docs/api.md on purpose);
     - every term is listed in docs/api.md.

   The connector source is scanned, not run, so the check works without a
   build (the static suite runs on a fresh clone). Two scans: the entity
   interfaces (`interface … extends NgsiEntity`, also through a local base
   interface), and attribute keys in object literals whose value is an NGSI-LD
   attribute (`{ type: "Property" … }` or a call of a function that returns
   one). NgsiEntity has an index signature, so an attribute missing from its
   interface still compiles — the second scan catches that case. Attribute
   names computed at run time (a Record<string, Property> filled in a loop)
   are read from their source tables in DYNAMIC below; a new such place fails
   the test until it is listed there. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CONTEXT_FILE = path.join(ROOT, "gui", "public", "ngsi-ld", "udp-context.json");
const API_DOC = path.join(ROOT, "docs", "api.md");
const SRC = path.join(ROOT, "platform", "connectors", "src");
const CONNECTORS = path.join(SRC, "connectors");
const DEFAULT_CONTEXT = "https://uri.etsi.org/ngsi-ld/default-context/";

/* Attribute names the connectors write that the core context v1.6 defines
   itself: they expand to ngsi-ld:… URIs, not to the default context, and must
   therefore NOT be redefined in the published context. */
const CORE_TERMS = new Set(["location", "totalCount"]);

/* NGSI-LD attribute value types: never entity types. */
const ATTRIBUTE_TYPES = new Set(["Property", "GeoProperty", "Relationship", "LanguageProperty"]);

const read = p => fs.readFileSync(p, "utf8");

/* ---------- a minimal TypeScript lexer ---------- */

/* Returns two copies of `src` with identical offsets:
     code   — comments blanked, strings kept;
     masked — comments blanked and string contents blanked (quotes kept),
   so brace matching and splitting can work on `masked` while string literals
   are read from `code` at the same positions. Regex literals are recognised
   by the token before the slash, which is enough for this code base. */
function lex(src) {
  let code = "";
  let masked = "";
  const blank = s => s.replace(/[^\n]/g, " ");
  let i = 0;
  let prev = "";
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i) < 0 ? src.length : src.indexOf("\n", i);
      code += blank(src.slice(i, end));
      masked += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const close = src.indexOf("*/", i + 2);
      const end = close < 0 ? src.length : close + 2;
      code += blank(src.slice(i, end));
      masked += blank(src.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`" || (c === "/" && /^$|[(,=:[!&|?{};]$/.test(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === "\\") { j += 2; continue; }
        if (c === "/" && src[j] === "[") inClass = true;
        else if (c === "/" && src[j] === "]") inClass = false;
        else if (src[j] === c && !inClass) break;
        j++;
      }
      const literal = src.slice(i, j + 1);
      code += literal;
      masked += c + blank(src.slice(i + 1, j)) + (j < src.length ? c : "");
      i = j + 1;
      prev = c;
      continue;
    }
    code += c;
    masked += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { code, masked };
}

/* Offset of the brace that closes the one at `open` (masked text). */
function closing(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}" && --depth === 0) return i;
  }
  throw new Error(`unbalanced brace at offset ${open}`);
}

/* Members of a type body at its top level: [start, end) ranges split on `;`. */
function members(masked, from, to) {
  const out = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    const c = masked[i];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  if (masked.slice(start, to).trim()) out.push([start, to]);
  return out;
}

const literals = text => [...text.matchAll(/"([^"]*)"/g)].map(m => m[1]);

/* ---------- scan 1: entity interfaces ---------- */

function scanInterfaces(file, { code, masked }) {
  const interfaces = new Map();
  for (const m of masked.matchAll(/\binterface\s+(\w+)(?:<[^{]*?>)?\s+extends\s+([^{]+)\{/g)) {
    const open = m.index + m[0].length - 1;
    interfaces.set(m[1], { bases: m[2].match(/\w+/g) || [], open, close: closing(masked, open) });
  }
  const isEntity = (name, seen = new Set()) => {
    if (name === "NgsiEntity") return true;
    const iface = interfaces.get(name);
    if (!iface || seen.has(name)) return false;
    seen.add(name);
    return iface.bases.some(b => isEntity(b, seen));
  };
  const alias = name => {
    const m = masked.match(new RegExp(`\\btype\\s+${name}\\s*=([^;]+);`));
    return m ? literals(code.slice(m.index, m.index + m[0].length)) : [];
  };
  const types = new Set();
  const attrs = new Set();
  let entityInterfaces = 0;
  for (const [name, { open, close }] of interfaces) {
    if (!isEntity(name)) continue;
    entityInterfaces++;
    for (const [s, e] of members(masked, open + 1, close)) {
      const m = /^\s*readonly\s+("\s*[^"]*"|[\w$]+)\??\s*:/.exec(masked.slice(s, e));
      if (!m) continue;
      const key = m[1].startsWith('"') ? literals(code.slice(s, s + m[0].length))[0] : m[1];
      const valueType = code.slice(s + m[0].length, e);
      if (key === "id" || key === "@context") continue;
      if (key === "type") {
        const named = literals(valueType);
        const resolved = named.length ? named : (valueType.match(/\w+/g) || []).flatMap(alias);
        assert(resolved.length, `${file}: entity type of interface ${name} is neither a literal nor a local alias`);
        resolved.forEach(t => types.add(t));
        continue;
      }
      attrs.add(key);
    }
  }
  return { types, attrs, entityInterfaces };
}

/* ---------- scan 2: attribute keys in object literals ---------- */

/* Functions (declared in this file) whose return type mentions an NGSI-LD
   attribute, directly or through a local type alias; plus the kernel helpers. */
function attributeFactories({ code, masked }) {
  const attributeAliases = new Set(["Property", "GeoProperty", "Relationship", "NgsiAttribute"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of masked.matchAll(/\btype\s+(\w+)(?:<[^=]*>)?\s*=([^;]+);/g)) {
      const body = code.slice(m.index, m.index + m[0].length);
      if (!attributeAliases.has(m[1]) && [...attributeAliases].some(a => new RegExp(`\\b${a}\\b`).test(body.slice(body.indexOf("=") + 1)))) {
        attributeAliases.add(m[1]);
        grew = true;
      }
    }
  }
  const factories = new Set(["observed", "dateObserved"]);
  for (const m of masked.matchAll(/\bfunction\s+(\w+)(?:<[^(]*>)?\s*\(/g)) {
    // Return type: between the closing parenthesis of the parameters and the body.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")" && --depth === 0) break;
    }
    const body = masked.indexOf("{", i);
    const ret = code.slice(i + 1, body);
    if (/^\s*:/.test(ret) && [...attributeAliases].some(a => new RegExp(`\\b${a}\\b`).test(ret))) factories.add(m[1]);
  }
  for (const m of masked.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:<[^>]*>)?\([^)]*\)\s*(?::\s*([^=]+))?=>/g)) {
    if (m[2] && [...attributeAliases].some(a => new RegExp(`\\b${a}\\b`).test(code.slice(m.index, m.index + m[0].length)))) factories.add(m[1]);
  }
  return factories;
}

function scanLiterals(file, lexed) {
  const { code } = lexed;
  const factories = attributeFactories(lexed);
  const attrs = new Set();
  const call = [...factories].join("|");
  const re = new RegExp(
    `(?:^|[{,\\s])("[\\w@]+"|[A-Za-z_$][\\w$]*)\\s*:\\s*(?:\\{\\s*type:\\s*"(?:${[...ATTRIBUTE_TYPES].join("|")})"|(?:${call})\\s*\\()`,
    "g",
  );
  for (const m of code.matchAll(re)) {
    const key = m[1].replace(/"/g, "");
    if (key === "value" || key === "type") continue; // a nested value, not an attribute key
    attrs.add(key);
  }
  return attrs;
}

/* ---------- names computed at run time ---------- */

const DYNAMIC = {
  // `components[name] = observed(…)` for every UBA component in COMPONENTS.
  "uba-bw.ts": code => {
    const m = /const COMPONENTS[^=]*=\s*new Map\(\[([\s\S]*?)\]\);/.exec(code);
    assert(m, "uba-bw.ts: COMPONENTS table not found");
    return [...m[1].matchAll(/\[\s*"[^"]*"\s*,\s*"(\w+)"\s*\]/g)].map(x => x[1]);
  },
  // `measuredValues[attribute] = …` over the [attribute, value, unit] tuples.
  "wetter-dwd-station.ts": code => {
    const m = /const values:[\s\S]*?=\s*\[([\s\S]*?)\];/.exec(code);
    assert(m, "wetter-dwd-station.ts: measured value table not found");
    return [...m[1].matchAll(/\[\s*"(\w+)"\s*,/g)].map(x => x[1]);
  },
};

/* ---------- the whole connector source ---------- */

function scanConnectors() {
  const types = new Set();
  const attrs = new Map(); // name -> files
  const add = (name, file) => attrs.set(name, (attrs.get(name) || new Set()).add(file));
  for (const file of fs.readdirSync(CONNECTORS).filter(f => f.endsWith(".ts")).sort()) {
    const lexed = lex(read(path.join(CONNECTORS, file)));
    const writes = /\bNGSI_CONTEXT\b/.test(lexed.code);
    const fromInterfaces = scanInterfaces(file, lexed);
    if (writes) {
      assert(fromInterfaces.entityInterfaces > 0,
        `${file} writes entities (NGSI_CONTEXT) but declares no interface extending NgsiEntity — the scan cannot see its vocabulary`);
    }
    fromInterfaces.types.forEach(t => types.add(t));
    fromInterfaces.attrs.forEach(a => add(a, file));
    if (writes) scanLiterals(file, lexed).forEach(a => add(a, file));
    if (/Record<string,\s*(?:Property|NgsiAttribute|Measured)/.test(lexed.code)) {
      assert(DYNAMIC[file], `${file} builds attribute names at run time (Record<string, Property>); list its name table in DYNAMIC`);
    }
    if (DYNAMIC[file]) DYNAMIC[file](lexed.code).forEach(a => add(a, file));
  }
  return { types, attrs };
}

function loadContext() {
  const doc = JSON.parse(read(CONTEXT_FILE));
  assert(Array.isArray(doc["@context"]) && doc["@context"].length === 2,
    "udp-context.json: @context must be [<core context URL>, {term mappings}]");
  const [core, terms] = doc["@context"];
  return { core, terms };
}

/* ---------- tests ---------- */

exports["vocabulary context: core context first, the one the connectors send"] = () => {
  const { core, terms } = loadContext();
  const sent = /export const NGSI_CONTEXT\s*=\s*"([^"]+)"/.exec(read(path.join(SRC, "kernel", "types.ts")));
  assert(sent, "NGSI_CONTEXT not found in platform/connectors/src/kernel/types.ts");
  assert.strictEqual(core, sent[1], "the published context must start with the core context the connectors send");
  assert(terms && typeof terms === "object" && !Array.isArray(terms), "second element must be the term object");
};

exports["vocabulary context: every term maps to its default-context URI (stored form)"] = () => {
  const { terms } = loadContext();
  for (const [term, uri] of Object.entries(terms)) {
    assert(!term.startsWith("@"), `keyword ${term} in the term object — not part of the frozen mapping`);
    assert.strictEqual(uri, DEFAULT_CONTEXT + term,
      `${term}: stored under ${DEFAULT_CONTEXT}${term}; a different URI would orphan the existing data and its history`);
    assert(!CORE_TERMS.has(term), `${term} is defined by the core context and must not be redefined`);
  }
};

exports["vocabulary context: lists every entity type and attribute the connectors write"] = () => {
  const { terms } = loadContext();
  const { types, attrs } = scanConnectors();
  // Guard against a scanner that silently finds nothing after a refactoring.
  assert(types.size >= 25, `only ${types.size} entity types found in the connector source — scanner broken?`);
  assert(attrs.size >= 100, `only ${attrs.size} attribute names found in the connector source — scanner broken?`);
  const missingTypes = [...types].filter(t => !(t in terms)).sort();
  const missingAttrs = [...attrs.keys()].filter(a => !(a in terms) && !CORE_TERMS.has(a)).sort()
    .map(a => `${a} (${[...attrs.get(a)].join(", ")})`);
  assert.deepStrictEqual(missingTypes, [],
    `entity types not in gui/public/ngsi-ld/udp-context.json: ${missingTypes.join(", ")} — add them there and to docs/api.md`);
  assert.deepStrictEqual(missingAttrs, [],
    `attributes not in gui/public/ngsi-ld/udp-context.json: ${missingAttrs.join(", ")} — add them there and to docs/api.md (names are frozen once written)`);
  for (const t of types) assert(!ATTRIBUTE_TYPES.has(t), `${t} taken for an entity type`);
};

exports["vocabulary context: every term is documented in docs/api.md"] = () => {
  const { terms } = loadContext();
  const doc = read(API_DOC);
  const missing = [...Object.keys(terms), ...CORE_TERMS].filter(t => !doc.includes(`\`${t}\``));
  assert.deepStrictEqual(missing, [], `terms missing from docs/api.md: ${missing.join(", ")}`);
};
