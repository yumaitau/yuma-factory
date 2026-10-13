import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Palette = Record<string, string>;

/** Reads the light tokens from `:root` and the dark ones from its nested `@variant dark` block. */
function palettes(css: string): { light: Palette; dark: Palette } {
  const start = css.indexOf(':root {');
  assert.ok(start >= 0, 'globals.css has a :root block');
  const light: Palette = {};
  const dark: Palette = {};
  let depth = 0;
  let inDark = false;
  for (const line of css.slice(start).split('\n')) {
    if (line.includes('@variant dark {')) inDark = true;
    const token = line.match(/^\s*--([\w-]+):\s*(#[0-9a-f]{6})\s*;/i);
    if (token) (inDark ? dark : light)[token[1]] = token[2].toLowerCase();
    depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
    if (inDark && depth === 1) inDark = false;
    if (depth === 0) break;
  }
  return { light, dark };
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex).map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG 2.2 contrast ratio. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `color` at `alpha` over `base`, as Tailwind's `bg-x/5` paints it. */
const over = (color: string, alpha: number, base: string) =>
  '#' + rgb(color).map((c, i) => Math.round((c * alpha + rgb(base)[i] * (1 - alpha)) * 255).toString(16).padStart(2, '0')).join('');
/** Distance in OKLab: about 0.02 is barely noticeable. */
const distance = (a: string, b: string) => {
  const lab = (hex: string) => {
    const [r, g, b] = rgb(hex).map(linear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
  };
  const [x, y] = [lab(a), lab(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};

const themes = palettes(readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8'));
const TEXT = ['foreground', 'muted-foreground', 'primary', 'status-attention', 'status-running', 'status-waiting', 'status-review', 'status-done'];
const STATES = ['status-attention', 'status-running', 'status-waiting', 'status-review', 'status-done'];

test('light and dark define the same tokens', () => {
  assert.ok(Object.keys(themes.light).length >= 18);
  assert.deepEqual(Object.keys(themes.dark).sort(), Object.keys(themes.light).sort());
});

for (const [name, t] of Object.entries(themes)) {
  // Board lanes are bg-muted/50 on the page; Needs attention is bg-status-attention/5.
  const surfaces = { background: t.background, card: t.card, muted: t.muted, lane: over(t.muted, 0.5, t.background) };

  test(`${name}: body and metadata text tokens meet WCAG AA 4.5:1 on every surface`, () => {
    for (const token of TEXT) for (const [surface, color] of Object.entries(surfaces)) {
      const ratio = contrast(t[token], color);
      assert.ok(ratio >= 4.5, `${name} ${token} ${t[token]} on ${surface} ${color}: ${ratio.toFixed(2)}`);
    }
  });

  test(`${name}: state text stays readable on its own tinted lane or panel`, () => {
    for (const token of STATES) for (const base of [t.background, t.card]) {
      const tint = over(t[token], 0.1, base);
      assert.ok(contrast(t[token], tint) >= 4.5, `${name} ${token} on its 10% tint`);
      assert.ok(contrast(t.foreground, tint) >= 4.5, `${name} foreground on ${token} 10% tint`);
    }
  });

  test(`${name}: primary button text meets AA at rest and on hover`, () => {
    assert.ok(contrast(t['primary-foreground'], t.primary) >= 4.5, `${name} on primary: ${contrast(t['primary-foreground'], t.primary).toFixed(2)}`);
    assert.ok(contrast(t['primary-foreground'], t['accent-dark']) >= 4.5, `${name} on hover`);
  });

  test(`${name}: focus ring meets 3:1 against the page and cards`, () => {
    for (const surface of [t.background, t.card, t.muted]) assert.ok(contrast(t.ring, surface) >= 3, `${name} ring on ${surface}`);
  });

  test(`${name}: brand orange is not a state colour, and states differ from each other`, () => {
    for (const state of ['status-waiting', 'status-attention']) {
      assert.ok(distance(t.primary, t[state]) >= 0.08, `${name} primary vs ${state}: ${distance(t.primary, t[state]).toFixed(3)}`);
    }
    for (const [i, a] of STATES.entries()) for (const b of STATES.slice(i + 1)) {
      assert.ok(distance(t[a], t[b]) >= 0.08, `${name} ${a} vs ${b}: ${distance(t[a], t[b]).toFixed(3)}`);
    }
  });
}
