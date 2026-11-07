#!/usr/bin/env node
/**
 * Procedural generator for the per-agent mascot sprite sheets.
 *
 *   node scripts/generate-agent-skins.mjs
 *
 * Writes webview-ui/public/assets/characters/agents/<skin>.png and a 4x preview
 * at docs/agent-skins-preview.png.
 *
 * Sheet format (identical to assets/characters/char_N.png):
 *   112x96 RGBA, 3 rows (0 = down, 1 = up, 2 = right; left = right mirrored at
 *   runtime) x 7 frames of 16x32: walk1, walk2, walk3, type1, type2, read1, read2.
 *   Walk is played as [0, 1, 2, 1] and frame 1 doubles as the idle pose.
 *   Type/read frames are drawn seated (the engine adds another 6px down shift).
 *
 * All skins, including "claude", are original procedural pixel art.
 * Brand-inspired fan art: colours and motifs evoke each product, no logos copied.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'webview-ui/public/assets/characters/agents');
const PREVIEW = path.join(ROOT, 'docs/agent-skins-preview.png');

const FW = 16;
const FH = 32;
const FRAMES = 7;
const DIRS = ['down', 'up', 'right'];

// ───────────────────────────── colour helpers ─────────────────────────────

function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex([r, g, b]) {
  return (
    '#' +
    [r, g, b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function mix(a, b, t) {
  const A = hex(a);
  const B = hex(b);
  return toHex(A.map((v, i) => v + (B[i] - v) * t));
}
const lighten = (c, t) => mix(c, '#ffffff', t);
const darken = (c, t) => mix(c, '#000000', t);
/** Sample a multi-stop gradient at t in [0,1]. */
function gradient(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const seg = (stops.length - 1) * t;
  const i = Math.min(stops.length - 2, Math.floor(seg));
  return mix(stops[i], stops[i + 1], seg - i);
}

// ───────────────────────────── frame + shapes ─────────────────────────────

class Frame {
  constructor() {
    this.px = new Array(FW * FH).fill(null);
  }
  get(x, y) {
    return x < 0 || y < 0 || x >= FW || y >= FH ? null : this.px[y * FW + x];
  }
  set(x, y, c) {
    if (c == null || x < 0 || y < 0 || x >= FW || y >= FH) return;
    this.px[y * FW + x] = c;
  }
  /** Draw [x, y, colour] triples. */
  dots(list) {
    for (const [x, y, c] of list) this.set(x, y, c);
  }
}

// Masks are predicates (x, y) => boolean.
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
function roundRect(x0, y0, x1, y1, r = 1) {
  const inner = rect(x0, y0, x1, y1);
  return (x, y) => {
    if (!inner(x, y)) return false;
    const dx = Math.min(x - x0, x1 - x);
    const dy = Math.min(y - y0, y1 - y);
    return dx + dy >= r; // r=1 trims the corner pixel, r=2 trims a 3-pixel corner
  };
}
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
/** ASCII-art mask: any non '.' / ' ' character is filled. */
function art(x0, y0, rows) {
  return (x, y) => {
    const r = rows[y - y0];
    if (!r) return false;
    const ch = r[x - x0];
    return ch !== undefined && ch !== '.' && ch !== ' ';
  };
}
const union =
  (...ms) =>
  (x, y) =>
    ms.some((m) => m(x, y));
const minus = (a, b) => (x, y) => a(x, y) && !b(x, y);
const move = (m, dx, dy) => (x, y) => m(x - dx, y - dy);

/**
 * Fill a mask and ring it with a 1px outline.
 * fill: colour or (x, y, edges) => colour, where edges = {t, b, l, r} flags
 * telling which neighbours are outside the mask (for rim light / shading).
 */
function shape(f, mask, fill, ol, { corners = false, overwrite = true, outline = true } = {}) {
  for (let y = -2; y < FH + 2; y++) {
    for (let x = -2; x < FW + 2; x++) {
      if (!mask(x, y)) continue;
      const e = { t: !mask(x, y - 1), b: !mask(x, y + 1), l: !mask(x - 1, y), r: !mask(x + 1, y) };
      f.set(x, y, typeof fill === 'function' ? fill(x, y, e) : fill);
    }
  }
  if (!outline) return;
  const n4 = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const n8 = [...n4, [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const nb = corners ? n8 : n4;
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      if (mask(x, y)) continue;
      if (!nb.some(([dx, dy]) => mask(x + dx, y + dy))) continue;
      if (overwrite || f.get(x, y) == null) f.set(x, y, ol);
    }
  }
}

/** Standard 3-tone fill: light rim top/left, shade bottom/right. */
const tones = (base, hl, sh) => (x, y, e) => (e.b || e.r ? sh : e.t || e.l ? hl : base);

// ───────────────────────────── shared body parts ─────────────────────────────
//
// Standing layout: body fill ends at row 24 (outline row 25), legs fill rows
// 25..28, outline / ground contact on row 29 (same baseline as the reference
// sheets). Seated frames move the body down 2px and show foreshortened legs.

const GROUND = 28; // last filled leg row

function legsStanding(f, S, c) {
  const top = 24 + c.oy;
  const leg = S.leg;
  const shoe = S.shoe ?? darken(S.leg, 0.25);
  const far = darken(leg, 0.3);
  const farShoe = darken(shoe, 0.3);
  const draw = (x0, lift, near = true) =>
    shape(
      f,
      rect(x0, top, x0 + 1, GROUND - lift),
      (x, y) => (y >= GROUND - lift ? (near ? shoe : farShoe) : near ? leg : far),
      S.ol,
    );
  if (c.dir === 'right') {
    // near leg = lighter; swaps front/back between walk1 and walk3
    if (c.frame === 1) {
      draw(5, 0, false);
      draw(8, 0, true);
    } else if (c.frame === 0) {
      draw(4, 0, false);
      draw(9, 1, true);
    } else {
      draw(9, 0, false);
      draw(4, 1, true);
    }
    return;
  }
  const liftL = c.frame === 0 ? 1 : 0;
  const liftR = c.frame === 2 ? 1 : 0;
  draw(5, liftL);
  draw(9, liftR);
}

function legsSeated(f, S, c) {
  const shoe = S.shoe ?? darken(S.leg, 0.25);
  if (c.dir === 'right') {
    // thigh pointing forward under the body (drawn behind it), foot at the front
    const x1 = S.sideR + 2;
    shape(f, rect(7, GROUND - 1, x1, GROUND), (x) => (x >= x1 - 1 ? shoe : S.leg), S.ol);
    return;
  }
  // knees toward / away from the viewer: only the feet peek out under the body
  shape(f, rect(5, GROUND, 6, GROUND), shoe, S.ol);
  shape(f, rect(9, GROUND, 10, GROUND), shoe, S.ol);
}

function armFill(S, handRow) {
  const base = S.arm;
  const hand = S.hand ?? S.arm;
  return (x, y, e) =>
    handRow != null && y >= handRow ? hand : e.b || e.r ? darken(base, 0.18) : base;
}

/** Arms for the down / up views. */
function armsFront(f, S, c) {
  const sy = S.sy + c.oy;
  const L = S.bl; // first filled body column (left)
  const R = S.br; // last filled body column (right)
  const ol = S.ol;
  if (c.pose === 'walk') {
    const dl = c.frame === 0 ? 1 : 0;
    const dr = c.frame === 2 ? 1 : 0;
    shape(f, rect(L - 2, sy + dl, L - 1, sy + 2 + dl), armFill(S, sy + 2 + dl), ol);
    shape(f, rect(R + 1, sy + dr, R + 2, sy + 2 + dr), armFill(S, sy + 2 + dr), ol);
    return;
  }
  if (c.dir === 'up') {
    // reaching forward (away from viewer): shoulders up, hands hidden
    const dl = c.pose === 'type' ? (c.phase === 0 ? -1 : 0) : -1;
    const dr = c.pose === 'type' ? (c.phase === 1 ? -1 : 0) : -1;
    shape(f, rect(L - 2, sy + dl, L - 1, sy + 1 + dl), armFill(S, null), ol);
    shape(f, rect(R + 1, sy + dr, R + 2, sy + 1 + dr), armFill(S, null), ol);
    return;
  }
  if (c.pose === 'type') {
    // forearms come in toward a keyboard in front of the belly; hands tap
    const hl = c.phase === 0 ? -1 : 0;
    const hr = c.phase === 1 ? -1 : 0;
    const left = union(
      rect(L - 2, sy, L - 1, sy + 2),
      rect(L - 1, sy + 3 + hl, L + 1, sy + 3 + hl),
      rect(L - 1, sy + 2, L - 1, sy + 3 + hl),
    );
    const right = union(
      rect(R + 1, sy, R + 2, sy + 2),
      rect(R - 1, sy + 3 + hr, R + 1, sy + 3 + hr),
      rect(R + 1, sy + 2, R + 1, sy + 3 + hr),
    );
    shape(f, left, (x, y) => (x >= L && y === sy + 3 + hl ? (S.hand ?? S.arm) : S.arm), ol);
    shape(f, right, (x, y) => (x <= R && y === sy + 3 + hr ? (S.hand ?? S.arm) : S.arm), ol);
    return;
  }
  // read: hold a sheet of paper in front of the body
  const py = sy + 1 + (c.phase === 1 ? 1 : 0);
  paperFront(f, py, ol);
  const left = union(rect(L - 2, sy, L - 1, sy + 2), rect(L - 1, py + 2, L + 1, py + 3));
  const right = union(rect(R + 1, sy, R + 2, sy + 2), rect(R - 1, py + 2, R + 1, py + 3));
  shape(f, left, (x, y) => (x >= L ? (S.hand ?? S.arm) : S.arm), ol);
  shape(f, right, (x, y) => (x <= R ? (S.hand ?? S.arm) : S.arm), ol);
}

function paperFront(f, py, ol) {
  shape(
    f,
    rect(5, py, 10, py + 5),
    (x, y, e) =>
      y === py + 1 && x >= 6 && x <= 9
        ? '#9aa3b5'
        : y === py + 3 && x >= 6 && x <= 8
          ? '#9aa3b5'
          : e.b || e.r
            ? '#d9dde6'
            : '#ffffff',
    ol,
  );
}

/** Single near arm for the side view. */
function armSide(f, S, c) {
  const sy = S.sy + c.oy;
  const ax = S.sideArmX;
  const ol = S.ol;
  const hand = S.hand ?? S.arm;
  if (c.pose === 'walk') {
    // thin arm swinging forward / back
    const sw = c.frame === 0 ? 1 : c.frame === 2 ? -1 : 0;
    // drawn without an outline (darker tone instead) so it reads as a limb, not a ring
    const armC = S.sideArm ?? darken(S.arm, 0.3);
    f.dots([
      [ax, sy, armC],
      [ax + sw, sy + 1, armC],
      [ax + sw, sy + 2, armC],
      [ax + sw, sy + 3, ol],
    ]);
    return;
  }
  const R = S.sideR;
  const armC = S.sideArm ?? darken(S.arm, 0.3);
  const path = (pts) => f.dots(pts.map(([x, y]) => [x, y, armC]));
  if (c.pose === 'type') {
    // upper arm down, forearm forward to the keyboard, fingertips tap
    const tap = c.phase === 0 ? 0 : 1;
    const pts = [
      [ax, sy],
      [ax, sy + 1],
      [ax, sy + 2],
    ];
    for (let x = ax + 1; x <= R; x++) pts.push([x, sy + 2]);
    path(pts);
    shape(f, rect(R + 1, sy + 2 - tap, R + 2, sy + 2 - tap), hand, ol);
    return;
  }
  // read: paper held up in front of the face
  const d = c.phase === 1 ? 1 : 0;
  shape(
    f,
    rect(R + 2, sy - 4 + d, R + 3, sy + 1 + d),
    (x, y) => (x === R + 3 ? '#d9dde6' : (y - sy) % 2 === 0 ? '#9aa3b5' : '#ffffff'),
    ol,
  );
  const pts = [
    [ax, sy],
    [ax, sy + 1],
  ];
  for (let x = ax + 1; x <= R; x++) pts.push([x, sy + 1]);
  path(pts);
  shape(f, rect(R + 1, sy + 1, R + 2, sy + 1), hand, ol);
}

// ───────────────────────────── skins ─────────────────────────────
//
// Each skin: palette + anchors + body(f, c). c = { dir, frame, pose, phase,
// seated, oy, fx, fy } where oy is the vertical body offset (bob / seat) and
// fx/fy the face offset (reading = looking down + scanning the page).

const SKINS = {};

// ── Claude: terracotta rounded block with a cream spark on the chest ──
SKINS.claude = {
  ol: '#3a1a10',
  leg: '#a8513a',
  shoe: '#5c2a1c',
  arm: '#d97757',
  hand: '#f0b49a',
  bl: 3,
  br: 12,
  sy: 18,
  sideR: 11,
  sideArmX: 6,
  body(f, c) {
    const BASE = '#d97757';
    const HL = '#ec9474';
    const SH = '#b85c40';
    const CREAM = '#f6e7d6';
    const EYE = '#2a120b';
    const side = c.dir === 'right';
    const body = side ? roundRect(4, 11, 11, 24, 2) : roundRect(2, 11, 13, 24, 2);
    shape(f, move(body, 0, c.oy), tones(BASE, HL, SH), this.ol);
    const y = (v) => v + c.oy;
    // small four-ray spark (pulses while typing)
    const spark = (cx, cy, big) => {
      const d = [
        [cx, cy, CREAM],
        [cx - 1, cy, CREAM],
        [cx + 1, cy, CREAM],
        [cx, cy - 1, CREAM],
        [cx, cy + 1, CREAM],
      ];
      // diagonal rays turn the plus into an asterisk-like spark
      d.push([cx - 1, cy - 1, CREAM], [cx + 1, cy - 1, CREAM], [cx - 1, cy + 1, CREAM]);
      d.push([cx + 1, cy + 1, CREAM]);
      if (big) {
        d.push([cx - 2, cy - 2, CREAM], [cx + 2, cy - 2, CREAM], [cx - 2, cy + 2, CREAM]);
        d.push([cx + 2, cy + 2, CREAM], [cx, cy - 2, CREAM], [cx, cy + 2, CREAM]);
      }
      // hollow centre so it reads as a star, not a solid block
      d.push([cx, cy, BASE]);
      return d;
    };
    const big = !(c.pose === 'type' && c.phase === 1);
    if (c.dir === 'up') {
      // back: a darker stripe across the shoulders
      f.dots([5, 6, 7, 8, 9, 10].map((x) => [x, y(14), SH]));
      return;
    }
    const fx = c.fx;
    const fy = c.fy;
    if (side) {
      f.dots([
        [9 + fx, y(14 + fy), EYE],
        [9 + fx, y(15 + fy), EYE],
      ]);
      f.dots(spark(9, y(20), false));
      return;
    }
    f.dots([
      [5 + fx, y(14 + fy), EYE],
      [5 + fx, y(15 + fy), EYE],
      [10 + fx, y(14 + fy), EYE],
      [10 + fx, y(15 + fy), EYE],
    ]);
    f.dots(spark(7, y(20), big));
  },
};

// ── Claude (classic): wide square terracotta block with dot eyes ──
SKINS['claude-classic'] = {
  ol: '#3a1a10',
  leg: '#b8613f',
  shoe: '#7a3a24',
  arm: '#d97757',
  hand: '#e98d6c',
  bl: 3,
  br: 12,
  sy: 19,
  sideR: 11,
  sideArmX: 6,
  body(f, c) {
    const BASE = '#d97757';
    const HL = '#e8906f';
    const SH = '#bd6243';
    const EYE = '#2a120b';
    const side = c.dir === 'right';
    const block = side ? rect(4, 13, 11, 23) : rect(1, 13, 14, 23);
    shape(f, move(block, 0, c.oy), tones(BASE, HL, SH), this.ol, { corners: true });
    const y = (v) => v + c.oy;
    if (c.dir === 'up') {
      f.dots([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((x) => [x, y(16), SH]));
      return;
    }
    const fx = c.fx;
    const fy = c.fy;
    // blink on the second typing frame
    const blink = c.pose === 'type' && c.phase === 1;
    const eye = (x) =>
      blink
        ? [[x + fx, y(18 + fy), EYE]]
        : [
            [x + fx, y(17 + fy), EYE],
            [x + fx, y(18 + fy), EYE],
          ];
    if (side) {
      f.dots(eye(9));
      return;
    }
    f.dots([...eye(5), ...eye(10)]);
  },
};

// ── Codex: white rounded terminal blob with a black screen face ">_" ──
SKINS.codex = {
  ol: '#101013',
  leg: '#3f3f46',
  shoe: '#232327',
  arm: '#e6e6ea',
  hand: '#cfcfd6',
  bl: 3,
  br: 12,
  sy: 18,
  sideR: 11,
  sideArmX: 6,
  body(f, c) {
    const W = '#f3f3f5';
    const HL = '#ffffff';
    const SH = '#c2c2cb';
    const TEAL = '#17c3b2';
    const side = c.dir === 'right';
    const body = side ? roundRect(4, 11, 11, 24, 2) : roundRect(3, 11, 12, 24, 2);
    shape(f, move(body, 0, c.oy), tones(W, HL, SH), this.ol);
    const y = (v) => v + c.oy;
    if (c.dir === 'up') {
      // back panel: vents + status LED
      f.dots([
        [6, y(15), SH],
        [7, y(15), SH],
        [8, y(15), SH],
        [9, y(15), SH],
        [6, y(17), SH],
        [7, y(17), SH],
        [8, y(17), SH],
        [9, y(17), SH],
        [7, y(13), TEAL],
        [8, y(13), TEAL],
      ]);
      return;
    }
    const cursorOn = !(c.pose === 'type' && c.phase === 1);
    const SCR = '#1a1a1f';
    const SCR_HL = '#2c2c34';
    const fx = c.fx;
    const fy = c.fy;
    if (side) {
      shape(
        f,
        move(roundRect(8, 13, 11, 19, 1), 0, c.oy),
        (x, yy, e) => (e.t ? SCR_HL : SCR),
        SCR,
        { outline: false },
      );
      f.dots([
        [9, y(15 + fy), '#ffffff'],
        [10, y(16 + fy), '#ffffff'],
        [9, y(17 + fy), '#ffffff'],
      ]);
      if (cursorOn)
        f.dots([
          [10, y(18), TEAL],
          [11, y(18), TEAL],
        ]);
      return;
    }
    // terminal screen face: ">_"
    shape(f, move(roundRect(4, 13, 11, 19, 1), 0, c.oy), (x, yy, e) => (e.t ? SCR_HL : SCR), SCR, {
      outline: false,
    });
    f.dots([
      [5 + fx, y(14 + fy), '#ffffff'],
      [6 + fx, y(15 + fy), '#ffffff'],
      [7 + fx, y(16 + fy), '#ffffff'],
      [6 + fx, y(17 + fy), '#ffffff'],
      [5 + fx, y(18 + fy), '#ffffff'],
    ]);
    if (cursorOn)
      f.dots([
        [8 + fx, y(18 + fy), TEAL],
        [9 + fx, y(18 + fy), TEAL],
      ]);
    // tiny teal status light on the chin
    f.dots([[10, y(22), TEAL]]);
  },
};

// ── OpenCode: tall charcoal slab with light-gray "{ }" brace eyes ──
SKINS.opencode = {
  ol: '#09090a',
  leg: '#3a3a3f',
  shoe: '#1d1d20',
  arm: '#34343a',
  hand: '#4a4a52',
  bl: 3,
  br: 12,
  sy: 17,
  sideR: 11,
  sideArmX: 6,
  body(f, c) {
    const BASE = '#2e2e33';
    const HL = '#4b4b53';
    const SH = '#1f1f23';
    const BR = '#d6d6dc';
    const side = c.dir === 'right';
    const m = side ? rect(4, 9, 11, 24) : rect(3, 9, 12, 24);
    shape(
      f,
      move(m, 0, c.oy),
      (x, y, e) => (e.t ? HL : e.l ? '#3a3a40' : e.b || e.r ? SH : BASE),
      this.ol,
      { corners: true },
    );
    const y = (v) => v + c.oy;
    if (c.dir === 'up') {
      f.dots([4, 5, 6, 7, 8, 9, 10, 11].map((x) => [x, y(13), '#26262a']));
      f.dots([
        [7, y(11), '#3a3a40'],
        [8, y(11), '#3a3a40'],
      ]);
      return;
    }
    const fx = c.fx;
    const fy = c.fy;
    const open = (x0, y0) => [
      [x0 + 1, y0, BR],
      [x0 + 2, y0, BR],
      [x0 + 1, y0 + 1, BR],
      [x0, y0 + 2, BR],
      [x0 + 1, y0 + 3, BR],
      [x0 + 1, y0 + 4, BR],
      [x0 + 2, y0 + 4, BR],
    ];
    const close = (x0, y0) => [
      [x0, y0, BR],
      [x0 + 1, y0, BR],
      [x0 + 1, y0 + 1, BR],
      [x0 + 2, y0 + 2, BR],
      [x0 + 1, y0 + 3, BR],
      [x0, y0 + 4, BR],
      [x0 + 1, y0 + 4, BR],
    ];
    if (side) {
      f.dots(close(8 + fx, y(12 + fy)));
      return;
    }
    f.dots(open(4 + fx, y(12 + fy)));
    f.dots(close(9 + fx, y(12 + fy)));
  },
};

// ── Kimi: deep navy egg with a crescent-moon antenna ──
SKINS.kimi = {
  ol: '#0a0f2c',
  leg: '#1c2866',
  shoe: '#10173f',
  arm: '#26388a',
  hand: '#3550b5',
  bl: 3,
  br: 12,
  sy: 18,
  sideR: 11,
  sideArmX: 6,
  body(f, c) {
    const BASE = '#22337c';
    const HL = '#3a55b8';
    const SH = '#17225a';
    const MOON = '#ffe38f';
    const MOON_SH = '#e9b54a';
    const side = c.dir === 'right';
    const y = (v) => v + c.oy;
    // antenna + crescent (drawn first so the head outline sits on top)
    const ax = side ? 7 : 8;
    shape(f, move(rect(ax, 9, ax, 11), 0, c.oy), '#3a55b8', this.ol);
    const moon = art(ax - 3, 3, ['.###.', '##...', '#....', '#....', '##...', '.###.']);
    shape(
      f,
      move(moon, 0, c.oy),
      (x, yy, e) => (e.b || (e.r && yy > 5 + c.oy) ? MOON_SH : MOON),
      this.ol,
    );
    const body = side ? ellipse(7.5, 18, 4.4, 6.6) : ellipse(7.5, 18, 5, 6.6);
    shape(f, move(body, 0, c.oy), tones(BASE, HL, SH), this.ol);
    if (c.dir === 'up') {
      f.dots([
        [7, y(20), SH],
        [8, y(20), SH],
        [6, y(21), SH],
        [9, y(21), SH],
      ]);
      return;
    }
    const fx = c.fx;
    const fy = c.fy;
    const EYE = '#ffffff';
    const BLUSH = '#5f77e6';
    if (side) {
      f.dots([
        [10 + fx, y(16 + fy), EYE],
        [10 + fx, y(17 + fy), EYE],
        [11, y(19), BLUSH],
        [9, y(19 + fy), this.ol],
      ]);
      return;
    }
    f.dots([
      [5 + fx, y(16 + fy), EYE],
      [5 + fx, y(17 + fy), EYE],
      [10 + fx, y(16 + fy), EYE],
      [10 + fx, y(17 + fy), EYE],
      [7 + fx, y(19 + fy), this.ol],
      [8 + fx, y(19 + fy), this.ol],
      [4, y(19), BLUSH],
      [11, y(19), BLUSH],
    ]);
  },
};

// ── Gemini: blue→purple→rose gradient droplet with a floating 4-point sparkle ──
const GEM_STOPS = ['#4b8df5', '#7a74dc', '#a76bc0', '#d0698f'];
SKINS.gemini = {
  ol: '#191340',
  leg: '#5b4aa8',
  shoe: '#33286b',
  arm: '#8a6fd0',
  hand: '#a985e0',
  bl: 3,
  br: 12,
  sy: 18,
  sideR: 11,
  sideArmX: 6,
  body(f, c) {
    const side = c.dir === 'right';
    const y = (v) => v + c.oy;
    const body = side ? ellipse(7.5, 19, 4.4, 5.9) : ellipse(7.5, 19, 5, 5.9);
    shape(
      f,
      move(body, 0, c.oy),
      (x, yy, e) => {
        const g = gradient(GEM_STOPS, (yy - c.oy - 13) / 11);
        return e.b || e.r ? darken(g, 0.22) : e.t || e.l ? lighten(g, 0.3) : g;
      },
      this.ol,
    );
    // floating sparkle; twinkles (shrinks) on the second type/read frame
    const twinkle = c.seated && c.phase === 1;
    const star = twinkle
      ? art(5, 4, ['..##..', '..##..', '######', '######', '..##..', '..##..'])
      : art(4, 3, [
          '...##...',
          '...##...',
          '..####..',
          '########',
          '########',
          '..####..',
          '...##...',
          '...##...',
        ]);
    const sy = twinkle ? 1 : 0;
    shape(
      f,
      move(star, 0, c.oy + sy),
      (x, yy) => {
        const cx = Math.abs(x - 7.5);
        const cy = Math.abs(yy - c.oy - sy - 6.5);
        if (cx < 1 && cy < 1.5) return '#ffffff';
        if (cx < 2 && cy < 2) return '#d6e4ff';
        return gradient(['#8fb6ff', '#b79cff'], (x - 4) / 7);
      },
      this.ol,
    );
    if (c.dir === 'up') return;
    const fx = c.fx;
    const fy = c.fy;
    const D = this.ol;
    const W = '#ffffff';
    const PINK = '#f3a3c0';
    if (side) {
      f.dots([
        [10 + fx, y(17 + fy), W],
        [10 + fx, y(18 + fy), D],
        [11, y(20), PINK],
      ]);
      return;
    }
    f.dots([
      [5 + fx, y(17 + fy), W],
      [6 + fx, y(17 + fy), D],
      [5 + fx, y(18 + fy), D],
      [6 + fx, y(18 + fy), D],
      [9 + fx, y(17 + fy), W],
      [10 + fx, y(17 + fy), D],
      [9 + fx, y(18 + fy), D],
      [10 + fx, y(18 + fy), D],
      [7 + fx, y(20 + fy), D],
      [8 + fx, y(20 + fy), D],
      [4, y(20), PINK],
      [11, y(20), PINK],
    ]);
  },
};

// ── Qwen: bold faceted hexagon head on a small purple body ──
SKINS.qwen = {
  ol: '#150e3a',
  leg: '#3b2a8f',
  shoe: '#23185e',
  arm: '#6a4fe0',
  hand: '#8b74f0',
  bl: 4,
  br: 11,
  sy: 19,
  sideR: 10,
  sideArmX: 6,
  body(f, c) {
    const side = c.dir === 'right';
    const y = (v) => v + c.oy;
    const torso = side ? roundRect(5, 17, 10, 24, 1) : roundRect(4, 17, 11, 24, 1);
    shape(f, move(torso, 0, c.oy), tones('#7a3fe8', '#9a6af5', '#5a24b5'), this.ol);
    // pointy-top hexagon: 2:1 roof slopes, straight sides
    const hexRows = side
      ? [
          '......####......',
          '....########....',
          '...##########...',
          '...##########...',
          '...##########...',
          '...##########...',
          '...##########...',
          '...##########...',
          '....########....',
          '......####......',
        ]
      : [
          '......####......',
          '....########....',
          '..############..',
          '..############..',
          '..############..',
          '..############..',
          '..############..',
          '..############..',
          '....########....',
          '......####......',
        ];
    const hex = art(0, 7, hexRows);
    shape(
      f,
      move(hex, 0, c.oy),
      (x, yy, e) => {
        const r = yy - c.oy;
        if (r <= 8) return e.t ? '#a29cff' : '#857eff'; // top facet
        if (r >= 15) return '#3a31b8'; // bottom facet
        if (e.l) return '#6d65f5';
        if (e.r) return '#463dcc';
        return '#5b52ea';
      },
      this.ol,
    );
    if (c.dir === 'up') return;
    const fx = c.fx;
    const fy = c.fy;
    const W = '#ffffff';
    const P = this.ol;
    if (side) {
      f.dots([
        [10 + fx, y(11 + fy), W],
        [11 + fx, y(11 + fy), W],
        [10 + fx, y(12 + fy), W],
        [11 + fx, y(12 + fy), P],
        [11, y(14), '#b7b1ff'],
      ]);
      return;
    }
    f.dots([
      [5 + fx, y(11 + fy), W],
      [6 + fx, y(11 + fy), W],
      [5 + fx, y(12 + fy), W],
      [6 + fx, y(12 + fy), P],
      [9 + fx, y(11 + fy), W],
      [10 + fx, y(11 + fy), W],
      [9 + fx, y(12 + fy), P],
      [10 + fx, y(12 + fy), W],
      [7 + fx, y(14 + fy), P],
      [8 + fx, y(14 + fy), P],
    ]);
  },
};

// ── Copilot: little pilot, white helmet + big goggles, purple scarf, green glints ──
SKINS.copilot = {
  ol: '#15151c',
  leg: '#4a4f5c',
  shoe: '#2a2d35',
  arm: '#9aa1ae',
  hand: '#d7dbe3',
  bl: 4,
  br: 11,
  sy: 20,
  sideR: 10,
  sideArmX: 6,
  body(f, c) {
    const side = c.dir === 'right';
    const y = (v) => v + c.oy;
    const SUIT = '#a3aab7';
    const torso = side ? roundRect(5, 18, 10, 24, 1) : roundRect(4, 18, 11, 24, 1);
    shape(f, move(torso, 0, c.oy), tones(SUIT, '#c3c9d3', '#7d8594'), this.ol);
    // purple scarf with a fluttering tail
    const SC = '#8957e5';
    const SC_D = '#6339b8';
    const flutter = c.pose === 'walk' ? c.frame : 1;
    f.dots((side ? [5, 6, 7, 8, 9, 10] : [4, 5, 6, 7, 8, 9, 10, 11]).map((x) => [x, y(19), SC]));
    if (c.dir === 'up') {
      const tail =
        flutter === 1
          ? [
              [6, 20],
              [6, 21],
              [7, 20],
            ]
          : flutter === 0
            ? [
                [6, 20],
                [5, 21],
                [7, 20],
              ]
            : [
                [6, 20],
                [7, 21],
                [7, 20],
              ];
      f.dots(tail.map(([x, yy]) => [x, y(yy), SC_D]));
    } else if (side) {
      const tail =
        flutter === 1
          ? [
              [4, 19],
              [4, 20],
            ]
          : flutter === 0
            ? [
                [4, 19],
                [3, 19],
              ]
            : [
                [4, 19],
                [3, 20],
              ];
      shape(f, (x, yy) => tail.some(([tx, ty]) => tx === x && ty + c.oy === yy), SC_D, this.ol, {
        overwrite: false,
      });
    } else {
      f.dots([
        [9, y(20), SC_D],
        [10, y(20), SC_D],
      ]);
    }
    // aviator helmet with ear flaps (flaps are part of the silhouette)
    const FLAP = '#9399a6';
    const dome = side ? ellipse(7.5, 13, 4.6, 5) : ellipse(7.5, 13, 5.2, 5);
    const flaps = side ? rect(5, 14, 6, 17) : union(rect(2, 14, 3, 17), rect(12, 14, 13, 17));
    const helmet = union(dome, flaps);
    shape(
      f,
      move(helmet, 0, c.oy),
      (x, yy, e) =>
        flaps(x, yy - c.oy) && !dome(x, yy - c.oy)
          ? FLAP
          : e.b || e.r
            ? '#c9cdd6'
            : e.t || e.l
              ? '#ffffff'
              : '#eef0f5',
      this.ol,
    );
    if (side)
      f.dots([
        [5, y(14), FLAP],
        [6, y(14), FLAP],
        [5, y(15), FLAP],
        [6, y(15), FLAP],
        [5, y(16), FLAP],
        [6, y(16), FLAP],
      ]);
    else
      f.dots([
        [3, y(15), FLAP],
        [3, y(16), FLAP],
        [12, y(15), FLAP],
        [12, y(16), FLAP],
      ]);
    // purple centre stripe over the dome
    const stripeX = side ? [7, 8] : [7, 8];
    f.dots(
      stripeX.flatMap((x) => [
        [x, y(8), '#a371f7'],
        [x, y(9), '#8957e5'],
      ]),
    );
    const STRAP = '#2b2d38';
    if (c.dir === 'up') {
      // goggle strap across the back of the helmet
      f.dots([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((x) => [x, y(12), STRAP]));
      f.dots([
        [7, y(12), '#3fb950'],
        [8, y(12), '#3fb950'],
      ]);
      return;
    }
    const fx = c.fx;
    const fy = c.fy;
    const LENS = '#2f3a5c';
    const G = '#7ee787';
    const P = '#c4a4ff';
    if (side) {
      // goggle seen from the side: strap + one big lens at the front
      f.dots([5, 6, 7, 8].map((x) => [x, y(12), STRAP]));
      shape(f, move(roundRect(9, 10, 12, 13, 1), 0, c.oy), LENS, STRAP);
      f.dots([
        [10, y(11), G],
        [11, y(12), P],
        [10, y(15 + fy), this.ol],
        [11, y(15 + fy), this.ol],
      ]);
      return;
    }
    // big pilot goggles: two lenses joined by a bridge, wider than the head
    shape(
      f,
      move(union(roundRect(3, 10, 6, 13, 1), roundRect(9, 10, 12, 13, 1)), 0, c.oy),
      LENS,
      STRAP,
    );
    f.dots([
      [7, y(11), STRAP],
      [8, y(11), STRAP],
    ]);
    // glints (move with the gaze when reading)
    f.dots([
      [4 + fx, y(11 + fy), G],
      [5 + fx, y(12), P],
      [10 + fx, y(11 + fy), G],
      [11 + fx, y(12), P],
    ]);
    // smile
    f.dots([
      [6, y(15), this.ol],
      [7, y(16), this.ol],
      [8, y(16), this.ol],
      [9, y(15), this.ol],
    ]);
  },
};

// ── Cursor: dark isometric cube with a white arrow pointer clicking on its head ──
SKINS.cursor = {
  ol: '#040406',
  leg: '#2c2c33',
  shoe: '#141418',
  arm: '#2a2a31',
  hand: '#3c3c46',
  bl: 3,
  br: 12,
  sy: 18,
  sideR: 11,
  sideArmX: 6,
  body(f, c) {
    const side = c.dir === 'right';
    const y = (v) => v + c.oy;
    const x0 = side ? 4 : 3;
    const x1 = side ? 11 : 12;
    shape(
      f,
      move(rect(x0, 13, x1, 24), 0, c.oy),
      (x, yy) => {
        const r = yy - c.oy;
        if (r <= 15) {
          // top face: lighter, slanted edge toward the right
          if (r === 13) return '#7a7a88';
          return x >= x1 - (15 - r) ? '#4a4a55' : '#5d5d6a';
        }
        if (!side && x >= x1 - 1) return '#121216'; // right side face (shadow)
        if (side && x <= x0 + 1) return '#121216';
        if (r === 16) return '#34343d';
        return '#1f1f25';
      },
      this.ol,
      { corners: true },
    );
    // arrow pointer: tip up-left, tail touching the cube's top face
    const arrow = art(side ? 6 : 6, 3, [
      '#.....',
      '##....',
      '###...',
      '####..',
      '#####.',
      '######',
      '###...',
      '#.##..',
      '..##..',
    ]);
    shape(
      f,
      move(arrow, 0, c.oy),
      (x, yy, e) => (e.r && e.b ? '#c9c9d4' : e.r || e.b ? '#e4e4ec' : '#ffffff'),
      this.ol,
    );
    if (c.dir === 'up') {
      f.dots([
        [5, y(19), '#2a2a31'],
        [6, y(19), '#2a2a31'],
        [7, y(19), '#2a2a31'],
        [8, y(19), '#2a2a31'],
      ]);
      return;
    }
    const fx = c.fx;
    const fy = c.fy;
    const W = '#f4f4f8';
    if (side) {
      f.dots([
        [10 + fx, y(18 + fy), W],
        [10 + fx, y(19 + fy), W],
      ]);
      return;
    }
    f.dots([
      [5 + fx, y(18 + fy), W],
      [5 + fx, y(19 + fy), W],
      [8 + fx, y(18 + fy), W],
      [8 + fx, y(19 + fy), W],
      [6 + fx, y(21 + fy), '#6b6b78'],
      [7 + fx, y(21 + fy), '#6b6b78'],
    ]);
  },
};

// ───────────────────────────── frame assembly ─────────────────────────────

const POSES = ['walk', 'walk', 'walk', 'type', 'type', 'read', 'read'];

function drawFrame(S, dir, frame) {
  const f = new Frame();
  const pose = POSES[frame];
  const seated = pose !== 'walk';
  const phase = seated ? (frame - 3) % 2 : 0;
  const oy = seated ? 2 : frame === 1 ? 0 : -1;
  const reading = pose === 'read';
  const c = {
    dir,
    frame,
    pose,
    phase,
    seated,
    oy,
    fx: reading ? (phase === 1 ? 1 : 0) : 0,
    fy: reading ? 1 : 0,
  };
  if (!seated) legsStanding(f, S, c);
  if (seated && dir === 'right') legsSeated(f, S, c); // thighs tucked under the body
  S.body(f, c);
  if (dir === 'right') armSide(f, S, c);
  else armsFront(f, S, c);
  if (seated && dir !== 'right') legsSeated(f, S, c); // feet peek out in front
  return f;
}

function renderSheet(S) {
  const png = new PNG({ width: FW * FRAMES, height: FH * DIRS.length });
  png.data.fill(0);
  DIRS.forEach((dir, row) => {
    for (let frame = 0; frame < FRAMES; frame++) {
      const f = drawFrame(S, dir, frame);
      for (let y = 0; y < FH; y++) {
        for (let x = 0; x < FW; x++) {
          const col = f.get(x, y);
          if (!col) continue;
          const [r, g, b] = hex(col);
          const i = ((row * FH + y) * png.width + frame * FW + x) * 4;
          png.data[i] = r;
          png.data[i + 1] = g;
          png.data[i + 2] = b;
          png.data[i + 3] = 255;
        }
      }
    }
  });
  return png;
}

// ───────────────────────────── preview ─────────────────────────────

const FONT = {
  A: ['010', '101', '111', '101', '101'],
  C: ['011', '100', '100', '100', '011'],
  D: ['110', '101', '101', '101', '110'],
  E: ['111', '100', '110', '100', '111'],
  G: ['011', '100', '101', '101', '011'],
  I: ['111', '010', '010', '010', '111'],
  K: ['101', '101', '110', '101', '101'],
  L: ['100', '100', '100', '100', '111'],
  M: ['101', '111', '111', '101', '101'],
  N: ['101', '111', '111', '111', '101'],
  O: ['010', '101', '101', '101', '010'],
  P: ['110', '101', '110', '100', '100'],
  Q: ['010', '101', '101', '111', '011'],
  R: ['110', '101', '110', '101', '101'],
  S: ['011', '100', '010', '001', '110'],
  T: ['111', '010', '010', '010', '010'],
  U: ['101', '101', '101', '101', '111'],
  W: ['101', '101', '111', '111', '101'],
  X: ['101', '101', '010', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  ' ': ['000', '000', '000', '000', '000'],
};

function buildPreview(sheets) {
  const SC = 4;
  const GAP = 6;
  const LABEL_W = 150;
  const PAD = 16;
  const cellW = FW * SC;
  const cellH = FH * SC;
  const rowH = cellH + 18;
  const groupGap = 14;
  const width =
    PAD * 2 + LABEL_W + FRAMES * DIRS.length * (cellW + GAP) + (DIRS.length - 1) * groupGap;
  const height = PAD * 2 + sheets.length * rowH;
  const png = new PNG({ width, height });
  const put = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  };
  const BG = [128, 128, 132];
  const CELL = [140, 140, 145];
  const GROUND_LINE = [112, 112, 118];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, BG);
  const text = (str, x0, y0, s, col) => {
    let x = x0;
    for (const ch of str.toUpperCase()) {
      const g = FONT[ch] ?? FONT[' '];
      g.forEach((row, gy) =>
        [...row].forEach((bit, gx) => {
          if (bit === '1')
            for (let yy = 0; yy < s; yy++)
              for (let xx = 0; xx < s; xx++) put(x + gx * s + xx, y0 + gy * s + yy, col);
        }),
      );
      x += 4 * s;
    }
  };
  sheets.forEach(({ name, png: sheet }, si) => {
    const top = PAD + si * rowH;
    text(name, PAD, top + cellH / 2 - 8, 4, [24, 24, 28]);
    DIRS.forEach((_, row) => {
      for (let frame = 0; frame < FRAMES; frame++) {
        const cx =
          PAD + LABEL_W + row * (FRAMES * (cellW + GAP) + groupGap) + frame * (cellW + GAP);
        for (let y = 0; y < cellH; y++) for (let x = 0; x < cellW; x++) put(cx + x, top + y, CELL);
        for (let x = 0; x < cellW; x++) put(cx + x, top + 30 * SC, GROUND_LINE);
        for (let y = 0; y < FH; y++) {
          for (let x = 0; x < FW; x++) {
            const i = ((row * FH + y) * sheet.width + frame * FW + x) * 4;
            if (sheet.data[i + 3] < 128) continue;
            const col = [sheet.data[i], sheet.data[i + 1], sheet.data[i + 2]];
            for (let yy = 0; yy < SC; yy++)
              for (let xx = 0; xx < SC; xx++) put(cx + x * SC + xx, top + y * SC + yy, col);
          }
        }
      }
    });
  });
  return png;
}

// ───────────────────────────── main ─────────────────────────────

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PREVIEW), { recursive: true });

const sheets = [];
for (const [name, S] of Object.entries(SKINS)) {
  const png = renderSheet(S);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), PNG.sync.write(png));
  sheets.push({ name, png });
  console.log(`[agent-skins] wrote ${name}.png`);
}
fs.writeFileSync(PREVIEW, PNG.sync.write(buildPreview(sheets)));
console.log(`[agent-skins] wrote ${path.relative(ROOT, PREVIEW)}`);
