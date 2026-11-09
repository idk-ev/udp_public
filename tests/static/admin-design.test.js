/*
 * SPDX-License-Identifier: EUPL-1.2
 * © 2024–2026 Thomas Kieß and contributors
 */

/* The admin panel keeps its design decisions in one file
   (platform/admin/src/lib/design/tokens.css). This keeps them there: outside of
   it, styles may only use the tokens. Without such a check, one hex value per
   feature is how a theme ends up scattered - and this app is meant to be the
   template if the other sites move to SvelteKit. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "..", "platform", "admin", "src");
const TOKENS = path.join(SRC, "lib", "design", "tokens.css");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const FILES = walk(SRC).filter(f => /\.(svelte|css)$/.test(f));

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/* The CSS of a file: the file itself, or the <style> blocks of a component. */
function cssOf(file) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".css")) return stripComments(text);
  return stripComments([...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join("\n"));
}

function declarations(css) {
  return [...css.matchAll(/(?:^|[;{\s])([a-z-]+)\s*:\s*([^;{}]+);/g)].map(m => ({ name: m[1], value: m[2].trim() }));
}

const rel = f => path.relative(path.join(SRC, ".."), f).replace(/\\/g, "/");
const NAMED_COLOURS = /(^|[\s(])(white|black|red|green|blue|gray|grey|orange|yellow|purple|pink|brown|silver|navy|teal)($|[\s),])/i;
const SIZE_VALUE = /^(0|auto|inherit|var\(--[\w-]+\))$/;

exports["admin panel: the design files exist"] = () => {
  assert(fs.existsSync(TOKENS), "tokens.css is missing");
  assert(FILES.length > 5, "no components found");
};

exports["admin panel: no raw colours outside tokens.css"] = () => {
  const found = [];
  for (const file of FILES) {
    if (file === TOKENS) continue;
    const css = cssOf(file);
    for (const pattern of [/#[0-9a-f]{3,8}\b/gi, /\b(rgb|rgba|hsl|hsla|oklch|lab|lch|hwb)\(/gi]) {
      for (const match of css.matchAll(pattern)) found.push(`${rel(file)}: ${match[0]}`);
    }
    for (const { name, value } of declarations(css)) {
      if (NAMED_COLOURS.test(value)) found.push(`${rel(file)}: ${name}: ${value}`);
    }
  }
  assert.deepStrictEqual(found, [], "use a token from tokens.css");
};

exports["admin panel: type, spacing, radii and shadows come from tokens"] = () => {
  const found = [];
  const singleValue = new Set(["font-size", "font-family", "font-weight", "line-height", "border-radius", "box-shadow"]);
  const spacing = /^(margin|padding|gap|row-gap|column-gap)(-|$)/;
  for (const file of FILES) {
    if (file === TOKENS) continue;
    for (const { name, value } of declarations(cssOf(file))) {
      const parts = spacing.test(name) ? value.split(/\s+/) : singleValue.has(name) ? [value] : [];
      for (const part of parts) {
        if (!SIZE_VALUE.test(part)) found.push(`${rel(file)}: ${name}: ${value}`);
      }
    }
  }
  assert.deepStrictEqual(found, [], "use a token from tokens.css");
};

exports["admin panel: no inline styles in markup"] = () => {
  const found = [];
  for (const file of FILES.filter(f => f.endsWith(".svelte"))) {
    const markup = fs.readFileSync(file, "utf8").replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
    if (/\sstyle(:[\w-]+)?=/.test(markup)) found.push(rel(file));
  }
  assert.deepStrictEqual(found, [], "style attributes bypass the tokens");
};

exports["admin panel: tokens cover the colour names of the public theme"] = () => {
  const tokens = fs.readFileSync(TOKENS, "utf8");
  for (const name of ["--accent", "--surface-0", "--surface-1", "--border", "--text-primary", "--text-secondary"]) {
    const uses = tokens.split(`${name}:`).length - 1;
    assert.strictEqual(uses, 2, `${name} needs a light and a dark value`);
  }
};

/* A bare meta refresh keeps its timer after a client-side navigation has removed the
   tag: it reloads the earlier address over whatever is being typed by then. */
exports["admin panel: no meta refresh outside <noscript>"] = () => {
  const found = [];
  const files = walk(SRC).filter(f => /\.(svelte|html)$/.test(f));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const outside = text.replace(/<noscript[\s\S]*?<\/noscript>/g, "");
    if (/http-equiv\s*=\s*["'{]?\s*["']?refresh/i.test(outside)) found.push(rel(file));
  }
  assert.deepStrictEqual(found, [], "use lib/recheck.ts in an $effect instead");
};

exports["admin panel: the guard against a meta refresh notices one"] = () => {
  const bare = '<svelte:head>{#if x}<meta http-equiv="refresh" content="15" />{/if}</svelte:head>';
  assert(/http-equiv\s*=\s*["'{]?\s*["']?refresh/i.test(bare.replace(/<noscript[\s\S]*?<\/noscript>/g, "")));
  const inside = '<noscript><meta http-equiv="refresh" content="15" /></noscript>';
  assert(!/http-equiv\s*=\s*["'{]?\s*["']?refresh/i.test(inside.replace(/<noscript[\s\S]*?<\/noscript>/g, "")));
};
