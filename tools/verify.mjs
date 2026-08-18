#!/usr/bin/env node
/**
 * Regression harness for index.html.
 *
 * This is NOT a proof of correctness. It is a set of checks that each caught a
 * real defect in this project at least once, kept so the same defect cannot come
 * back silently. A green run means "none of the known ways to break this page
 * are currently broken", nothing stronger. Looking at the page is still the
 * final check.
 *
 * Zero dependencies. It needs Node 18+ (for the global WebSocket, which is what
 * lets it speak the Chrome DevTools Protocol without an npm package) and a
 * `google-chrome` on PATH. It starts its own static server and its own headless
 * browser, and writes no files anywhere.
 *
 *   node tools/verify.mjs            run everything
 *   node tools/verify.mjs rail grid  run only the named checks
 *   node tools/verify.mjs --list     list check names
 *
 * Exit code is 0 only if every check passed.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROW = 24;          /* --row, in px. The only vertical unit on the page. */
const MIN_RING = 3;      /* WCAG 1.4.11 non-text contrast */

/* ------------------------------------------------------------------ server */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.pdf': 'application/pdf',
  '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml',
};

async function startServer() {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

/* ------------------------------------------------------------------ chrome */

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launchChrome() {
  const bin = process.env.CHROME || 'google-chrome';
  const profile = await mkdtemp(path.join(tmpdir(), 'verify-chrome-'));
  const proc = spawn(bin, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-features=Translate,MediaRouter',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', d => { stderr += d; });
  proc.on('error', e => { stderr += e.message; });

  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 200; i++) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) {
        const { webSocketDebuggerUrl } =
          await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        return {
          wsUrl: webSocketDebuggerUrl,
          async close() {
            const dead = new Promise(r => proc.once('exit', r));
            proc.kill();
            await Promise.race([dead, sleep(3000)]);
            /* Chrome flushes its profile on the way out; a stray write races
               the rmdir and surfaces as ENOTEMPTY. Retry, then give up quietly
               rather than fail a green run over a temp directory. */
            for (let i = 0; i < 5; i++) {
              try { await rm(profile, { recursive: true, force: true }); return; }
              catch { await sleep(120); }
            }
          },
        };
      }
    }
    if (proc.exitCode !== null) break;
    await sleep(50);
  }
  proc.kill();
  await rm(profile, { recursive: true, force: true });
  throw new Error(`could not start ${bin}\n${stderr.trim().slice(0, 800)}`);
}

/* --------------------------------------------------------------------- cdp */

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(`${m.error.message}${m.error.data ? ': ' + m.error.data : ''}`))
                : p.res(m.result);
      } else {
        for (const fn of this.handlers.get((m.sessionId || '') + ':' + m.method) || []) fn(m.params);
      }
    });
  }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP websocket failed')), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
  once(method, sessionId) {
    const key = (sessionId || '') + ':' + method;
    return new Promise(res => {
      const fn = p => {
        const list = this.handlers.get(key);
        list.splice(list.indexOf(fn), 1);
        res(p);
      };
      if (!this.handlers.has(key)) this.handlers.set(key, []);
      this.handlers.get(key).push(fn);
    });
  }
}

/** A single page, with the handful of operations the checks actually need. */
class Page {
  constructor(cdp, sessionId) { this.cdp = cdp; this.sid = sessionId; }

  static async open(cdp) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    /* Deliberately NOT emulating prefers-reduced-motion, tempting as it is for
       determinism. The page's reduced-motion block is the common reset:
           *,*::before,*::after{ transition-duration:.01ms !important }
       `transition-property` is left at its initial `all`, so that declaration
       does not shorten existing transitions -- it CREATES one on every
       property, outline included. In a real browser it finishes in .01ms and
       nobody sees it. Headless produces no frames while idle, so the
       transition never advances and getComputedStyle returns the START value:
       `currentColor solid medium`, offset 0. Every focus ring then reads as
       unstyled and the focus check reports failures that do not exist.
       Nothing here needs the emulation: the animations are opacity-only and
       the spinners swap same-width glyphs, so layout is stable either way. */
    return page;
  }

  send(method, params) { return this.cdp.send(method, params, this.sid); }

  async goto(url) {
    const loaded = this.cdp.once('Page.loadEventFired', this.sid);
    await this.send('Page.navigate', { url });
    await loaded;
    /* Web fonts land after load; every metric check depends on them. */
    await this.eval('document.fonts.ready.then(() => true)');
  }

  /** Set the viewport. Chrome clamps a real window to ~500px wide, which
      silently turns every "320px" test into a 500px one; the metrics override
      does not. */
  setWidth(width, height = 900) {
    return this.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    }
    return result.value;
  }

  async tab() {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent',
        { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    }
  }
}

/* ------------------------------------------------------------------ checks */

/** Page-side helpers, injected as a prelude to any expression that needs them.
    `var`, not `const`: the same prelude is re-evaluated in the same execution
    context on every Tab step, and a repeated `const` throws. */
const HELPERS = `
var __vis = el => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
};
var __rgb = s => {
  const m = /rgba?\\(([^)]+)\\)/.exec(s);
  if (!m) return null;
  const p = m[1].split(/[,\\/]/).map(v => parseFloat(v));
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
};
var __lum = c => {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
var __contrast = (a, b) => {
  const [x, y] = [__lum(a), __lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/* The ring paints outside the border box, so what sits behind it is the
   nearest ANCESTOR with a painted background -- not the element's own. */
var __backdrop = el => {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const c = __rgb(getComputedStyle(n).backgroundColor);
    if (c && c.a > 0) return c;
  }
  return __rgb(getComputedStyle(document.documentElement).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
};
var __label = el => {
  const t = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34);
  return el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(/\\s+/)[0] : '') +
    (t ? ' "' + t + '"' : '');
};
`;

const WIDTHS_RAIL = [320, 375, 390, 414, 430, 480, 768, 820, 1024, 1180, 1440, 1920, 2560];
const WIDTHS_FLOW = [300, 320, 375, 390, 414, 430, 480, 640, 768, 820, 1024, 1180, 1280, 1440, 1920, 2560];
const MODES = ['stdout', 'tui'];

const checks = [];
const check = (name, blurb, fn) => checks.push({ name, blurb, fn });

/* --- one left edge ------------------------------------------------------ */
check('rail', 'every .wrap shares one left edge, both modes, 320-2560px',
  async ({ page, origin, fail }) => {
    for (const mode of MODES) {
      for (const w of WIDTHS_RAIL) {
        await page.setWidth(w);
        await page.goto(`${origin}/?mode=${mode}`);
        const edges = await page.eval(`${HELPERS}
          (() => {
            const out = {};
            for (const el of document.querySelectorAll('.wrap')) {
              if (!__vis(el)) continue;
              const left = Math.round(el.getBoundingClientRect().left * 100) / 100;
              (out[left] ||= []).push(__label(el));
            }
            return out;
          })()`);
        const keys = Object.keys(edges);
        if (keys.length > 1) {
          fail(`${mode} @${w}px: ${keys.length} left edges - ` +
            keys.map(k => `${k}px (${edges[k][0]})`).join(', '));
        }
      }
    }
  });

/* --- nothing pushes the page sideways ----------------------------------- */
check('overflow', 'no horizontal overflow, 300-2560px, both modes',
  async ({ page, origin, fail }) => {
    for (const mode of MODES) {
      for (const w of WIDTHS_FLOW) {
        await page.setWidth(w);
        await page.goto(`${origin}/?mode=${mode}`);
        const over = await page.eval(`${HELPERS}
          (() => {
            const doc = document.documentElement;
            if (doc.scrollWidth <= doc.clientWidth + 0.5) return null;
            let worst = null, max = doc.clientWidth;
            for (const el of document.querySelectorAll('*')) {
              if (!__vis(el)) continue;
              const r = el.getBoundingClientRect().right;
              if (r > max + 0.5) { max = r; worst = __label(el); }
            }
            return { scrollWidth: doc.scrollWidth, client: doc.clientWidth, worst };
          })()`);
        if (over) {
          fail(`${mode} @${w}px: scrollWidth ${over.scrollWidth} > ${over.client}` +
            (over.worst ? ` - widest visible box is ${over.worst}` : ''));
        }
      }
    }
  });

/* --- focus rings, checked against what is actually behind them ----------- */
check('focus', 'every tab stop shows a ring with >=3:1 against its real backdrop',
  async ({ page, origin, fail, note }) => {
    const stops = [];
    for (const mode of MODES) {
      for (const w of [375, 1024]) {
        await page.setWidth(w);
        await page.goto(`${origin}/?mode=${mode}`);
        await page.eval('document.activeElement && document.activeElement.blur(); true');
        /* Stamp every element so a repeat visit is detected by identity, not by
           label -- several controls share a label ("github" appears 8 times) and
           deduping on text would end the walk early and silently skip the rest. */
        await page.eval(`document.querySelectorAll('a[href],button,[tabindex]').forEach(
          (el, i) => el.dataset.vf = i); true`);
        const seen = new Set();
        for (let i = 0; i < 120; i++) {
          await page.tab();
          const info = await page.eval(`${HELPERS}
            (() => {
              const el = document.activeElement;
              if (!el || el === document.body || el === document.documentElement) return null;
              const cs = getComputedStyle(el);
              const ring = __rgb(cs.outlineColor);
              const r = el.getBoundingClientRect();
              return {
                id: el.dataset.vf,
                label: __label(el),
                style: cs.outlineStyle,
                width: parseFloat(cs.outlineWidth) || 0,
                box: r.width > 0 && r.height > 0,
                ratio: ring ? Math.round(__contrast(ring, __backdrop(el)) * 100) / 100 : 0,
              };
            })()`);
          if (!info) break;
          if (seen.has(info.id)) break;        /* wrapped back around */
          seen.add(info.id);
          const where = `${mode} @${w}px: ${info.label}`;
          if (!info.box) fail(`${where} is focusable but has a 0x0 box - no ring can paint`);
          else if (info.style === 'none' || info.width === 0) fail(`${where} has no outline`);
          else if (info.ratio < MIN_RING) fail(`${where} ring is ${info.ratio}:1 against its backdrop (need ${MIN_RING})`);
        }
        if (seen.size === 0) fail(`${mode} @${w}px: Tab reached nothing focusable`);
        else stops.push(`${mode} @${w}px: ${seen.size}`);
      }
    }
    note(`tab stops walked - ${stops.join(', ')}`);
  });

/* --- the reading measure survives a wider shell -------------------------- */
check('measure', 'no run of text exceeds the 80ch measure, however wide the rail',
  async ({ page, origin, fail }) => {
    /* The whole point of widening --page is that the SHELL grows and the reading
       measure does not. Every text block caps itself at --measure independently
       of the rail, so a block that forgets to is invisible until you hit a
       112-character line. */
    for (const mode of MODES) {
      for (const w of [1088, 1440, 1920, 2560]) {
        await page.setWidth(w);
        await page.goto(`${origin}/?mode=${mode}`);
        const over = await page.eval(`${HELPERS}
          (() => {
            /* Measure 1ch rather than deriving it: --fs is 0.9375rem and the
               advance is 0.6em, and getting either constant wrong silently
               rescales every result. */
            const probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;width:100ch';
            document.body.appendChild(probe);
            const ch = probe.getBoundingClientRect().width / 100;
            probe.remove();

            /* Measure the INK of each rendered LINE, not the box it sits in.
               Ranging over an element is wrong: it returns border boxes for any
               block-level child, so a full-width <a> holding 40 characters reads
               as 113 columns. Range each text node instead, then union the rects
               that share a top edge -- that is one visual line. */
            const lineWidths = el => {
              const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              const lines = new Map();
              for (let n = w.nextNode(); n; n = w.nextNode()) {
                if (!n.nodeValue.trim()) continue;
                const r = document.createRange(); r.selectNodeContents(n);
                for (const b of r.getClientRects()) {
                  if (!b.width) continue;
                  const key = Math.round(b.top);
                  const cur = lines.get(key);
                  if (cur) { cur.l = Math.min(cur.l, b.left); cur.r = Math.max(cur.r, b.right); }
                  else lines.set(key, { l: b.left, r: b.right });
                }
              }
              return [...lines.values()].map(v => v.r - v.l);
            };

            const out = [];
            for (const el of document.querySelectorAll('p,li,dd,dt,blockquote')) {
              if (!__vis(el)) continue;
              const cs = getComputedStyle(el);
              if (el.closest('.art') || cs.whiteSpace.startsWith('pre')) continue;
              if (el.querySelector('p,li,ul,ol')) continue;      /* measure the leaf */
              const widths = lineWidths(el);
              const widest = widths.length ? Math.max(...widths) : 0;
              if (widest > 80 * ch + 1) out.push({ label: __label(el), cols: Math.round(widest / ch) });
            }
            return out;
          })()`);
        for (const o of over) fail(`${mode} @${w}px: ${o.label} runs to ${o.cols} columns (max 80)`);
      }
    }
  });


/* --- the hero is one terminal grid, not two images ----------------------- */
check('hero', 'both hero art blocks resolve to the same cell size and fill their tracks',
  async ({ page, origin, fail }) => {
    /* 69fr/44fr tracks against 69 and 44 columns means both blocks land on the
       same font-size -- unless one hits its cap first, which is exactly what
       widening --page past ~997px does to the portrait. */
    for (const w of [784, 820, 1024, 1088, 1440, 1920, 2560]) {
      await page.setWidth(w);
      await page.goto(`${origin}/?mode=stdout`);
      const h = await page.eval(`
        (() => {
          const name = document.querySelector('.art--name pre');
          const port = document.querySelector('.art--port pre');
          if (!name || !port) return null;
          const nameTrack = name.closest('.art').getBoundingClientRect().width;
          const portTrack = port.closest('.art').getBoundingClientRect().width;
          const fs = el => Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100;
          const ink = el => {
            const r = document.createRange(); r.selectNodeContents(el);
            const w = [...r.getClientRects()].map(b => b.width);
            return w.length ? Math.round(Math.max(...w) * 10) / 10 : 0;
          };
          return {
            stacked: Math.abs(nameTrack - portTrack) < 1,   /* one column: equal widths */
            nameFs: fs(name), portFs: fs(port),
            nameTrack: Math.round(nameTrack * 10) / 10, portTrack: Math.round(portTrack * 10) / 10,
            nameInk: ink(name), portInk: ink(port),
          };
        })()`);
      if (!h) { fail(`@${w}px: hero art missing`); continue; }
      if (h.stacked) continue;                 /* single column: no shared grid to hold */
      if (h.nameFs !== h.portFs) {
        fail(`@${w}px: hero art sizes diverged - name ${h.nameFs}px vs portrait ${h.portFs}px ` +
          `(one hit its font-size cap; in two columns they must share one)`);
      }
      for (const [k, ink, track] of [['name', h.nameInk, h.nameTrack], ['portrait', h.portInk, h.portTrack]]) {
        if (ink < track - 2) fail(`@${w}px: ${k} art fills ${ink}px of a ${track}px track - ${Math.round(track - ink)}px of cap-induced dead space`);
      }
    }
  });


/* --- the browse-mode fetch lockup ---------------------------------------- */
check('fetch', 'the scene and the summary card line up, and only one art block shows',
  async ({ page, origin, fail }) => {
    /* The lockup only reads as one object if the scene's lines sit on the same
       baselines as the table beside it. The scene is 15 rows, so height is
       18 x font-size and lands on the 24px grid only when the size is a multiple
       of 4/3. Also asserted here: exactly ONE art block is visible per mode --
       the portrait in read, the scene in browse, never both and never neither. */
    for (const w of [390, 820, 896, 1088, 1440, 1920]) {
      await page.setWidth(w);
      await page.goto(`${origin}/?mode=tui`);
      const f = await page.eval(`${HELPERS}
        (() => {
          const pre = document.querySelector('.art--scene pre');
          const dl  = document.querySelector('.fetch');
          const port = document.querySelector('.art--port');
          const scene = document.querySelector('.art--scene');
          if (!pre || !dl || !port || !scene) return null;
          const cs = getComputedStyle(pre);
          const pr = pre.getBoundingClientRect(), dr = dl.getBoundingClientRect();
          const dt = dl.querySelector('dt');
          return {
            visible: __vis(pre) && __vis(dl),
            fontSize: Math.round(parseFloat(cs.fontSize) * 1000) / 1000,
            lineHeight: Math.round(parseFloat(cs.lineHeight) * 100) / 100,
            /* fromCharCode(10), not a '\n' literal: this whole expression is
               inside a template literal, where the escape resolves before the page
               ever sees it and leaves an unterminated regex. */
            lines: pre.textContent.trimEnd().split(String.fromCharCode(10)).length,
            portShown: __vis(port), sceneShown: __vis(scene),
            sideBySide: Math.abs(pr.top - dr.top) < 2 && pr.right <= dr.left + 1,
            portTop: Math.round(pr.top * 100) / 100,
            rowTop: dt ? Math.round(dt.getBoundingClientRect().top * 100) / 100 : null,
            overlap: Math.round((pr.right - dr.left) * 100) / 100,
          };
        })()`);
      if (!f) { fail(`@${w}px: the scene or the summary card is missing in browse mode`); continue; }
      if (!f.visible) { fail(`@${w}px: browse mode is hiding the scene or the summary card`); continue; }
      if (f.portShown) fail(`@${w}px: the portrait is showing in browse mode - the two art blocks must swap, not stack`);
      if (!f.sceneShown) fail(`@${w}px: the scene is hidden in browse mode`);
      if (f.lines !== 15) fail(`@${w}px: scene is ${f.lines} lines, expected 15 - the size ladder assumes it`);
      /* multiple of 4/3, so 15 rows x 1.2 x size is a whole number of 24px rows */
      if (Math.abs(f.fontSize * 3 / 4 - Math.round(f.fontSize * 3 / 4)) > 0.001) {
        fail(`@${w}px: scene font-size is ${f.fontSize}px, not a multiple of 4/3px - its height cannot be whole rows`);
      }
      if (Math.abs(f.lineHeight - f.fontSize * 1.2) > 0.1) {
        fail(`@${w}px: scene line-height is ${f.lineHeight}px, not 1.2 x ${f.fontSize}px - braille dots stop being square`);
      }
      /* Only meaningful side by side; stacked, the two share a column on purpose. */
      if (f.sideBySide && f.overlap > 1) fail(`@${w}px: the scene overlaps the summary card by ${f.overlap}px`);
      /* Above the split, the two must start on the same line, not be centred
         against each other -- align-items:center is the failure mode here. */
      if (w >= 896 && !f.sideBySide) {
        fail(`@${w}px: scene and summary card are not aligned side by side (top ${f.portTop} vs row ${f.rowTop})`);
      }
    }
  });


/* --- the 24px row grid -------------------------------------------------- */
check('grid', 'tui controls stay on the 24px row grid when they wrap',
  async ({ page, origin, fail }) => {
    for (const w of [320, 375, 390, 480, 768, 820, 896, 1024, 1440, 1920]) {
      await page.setWidth(w);
      await page.goto(`${origin}/?mode=tui`);
      const g = await page.eval(`${HELPERS}
        (() => {
          const bar = document.querySelector('.modebar-wrap');
          const tops = [...new Set([...document.querySelectorAll('.cmdindex a')]
            .map(a => Math.round(a.getBoundingClientRect().top * 100) / 100))].sort((a, b) => a - b);
          const heights = [...new Set([...document.querySelectorAll('.cmdindex a')]
            .map(a => Math.round(a.getBoundingClientRect().height * 100) / 100))];
          /* Every boxed control in browse mode, not just the nav. All of these
             derive 48px the same way -- 1px border + 11px padding + the 24px
             inherited line box -- and a change to any one of them drifts
             everything below it. */
          const boxes = [];
          for (const sel of ['.title', '.btn', '#projects .entry-head', '.trow', '.art--scene pre']) {
            for (const el of document.querySelectorAll(sel)) {
              if (!__vis(el)) continue;
              boxes.push({ sel, h: Math.round(el.getBoundingClientRect().height * 100) / 100 });
            }
          }
          /* Section headings carry their rule as a box-shadow precisely because a
             border would add 1px of layout. Measuring the box alone would not
             notice -- what has to stay on the grid is the heading's whole
             footprint, box plus margin. */
          const heads = [...document.querySelectorAll('.cmd')].filter(__vis).map(el => {
            const cs = getComputedStyle(el);
            return Math.round((el.getBoundingClientRect().height
                             + parseFloat(cs.marginBottom || 0)) * 100) / 100;
          });
          return { bar: bar ? Math.round(bar.getBoundingClientRect().height * 100) / 100 : null,
                   tops, heights, boxes, heads: [...new Set(heads)] };
        })()`);
      for (const h of g.heads) {
        if (Math.abs(h - Math.round(h / ROW) * ROW) > 0.75) {
          fail(`@${w}px: a section heading occupies ${h}px including its margin, not a whole number of ${ROW}px rows`);
        }
      }
      for (const b of g.boxes) {
        /* Tolerance, not equality. Chrome resolves line-height in 1/64px
           LayoutUnits, so a 25-line block at line-height 1.2 lands up to half a
           pixel short of its arithmetic height (16px -> 479.69, not 480). That is
           quantization, not drift, and it does not accumulate down the page. A
           stray 1px border still exceeds 0.75 and still fails. */
        if (Math.abs(b.h - Math.round(b.h / ROW) * ROW) > 0.75) {
          fail(`@${w}px: ${b.sel} is ${b.h}px tall, not a whole number of ${ROW}px rows`);
        }
      }
      if (g.bar === null) fail(`@${w}px: no .modebar-wrap in tui`);
      else if (g.bar % ROW !== 0) fail(`@${w}px: mode bar is ${g.bar}px, not a whole number of ${ROW}px rows`);
      for (const h of g.heights) {
        if (h % ROW !== 0) fail(`@${w}px: nav button is ${h}px tall, not a whole number of rows`);
      }
      for (let i = 1; i < g.tops.length; i++) {
        const d = Math.round((g.tops[i] - g.tops[i - 1]) * 100) / 100;
        if (d % ROW !== 0) fail(`@${w}px: wrapped nav rows are ${d}px apart, not a multiple of ${ROW}px`);
      }
    }
  });

/* --- how the mode is decided -------------------------------------------- */
check('mode', 'URL param beats stored preference, unknown values fall back to stdout',
  async ({ page, origin, fail }) => {
    const cases = [
      ['fresh visit',                    null,     '/',                'stdout'],
      ['?mode=tui',                      null,     '/?mode=tui',       'tui'],
      ['?mode=TUI is case-insensitive',  null,     '/?mode=TUI',       'tui'],
      ['?mode=stdout',                   null,     '/?mode=stdout',    'stdout'],
      ['?mode=banana falls back',        null,     '/?mode=banana',    'stdout'],
      ['stored tui is honoured',         'tui',    '/',                'tui'],
      ['?mode=stdout beats stored tui',  'tui',    '/?mode=stdout',    'stdout'],
      ['stored garbage falls back',      'banana', '/',                'stdout'],
    ];
    await page.setWidth(1024);
    for (const [label, stored, url, want] of cases) {
      await page.goto(`${origin}/`);
      await page.eval(stored === null
        ? 'localStorage.clear(); true'
        : `localStorage.setItem('mode', ${JSON.stringify(stored)}); true`);
      await page.goto(origin + url);
      const got = await page.eval(
        `document.documentElement.classList.contains('tui') ? 'tui'
         : document.documentElement.classList.contains('stdout') ? 'stdout' : '(none)'`);
      if (got !== want) fail(`${label}: expected ${want}, got ${got}`);
    }
    /* Documented, deliberate, and surprising enough to be worth pinning: the
       mode is persisted on the initial sync, so merely opening a shared
       ?mode=tui link switches that visitor to tui for good. */
    await page.goto(`${origin}/`);
    await page.eval('localStorage.clear(); true');
    await page.goto(`${origin}/?mode=tui`);
    await page.goto(`${origin}/`);
    const sticky = await page.eval(`document.documentElement.classList.contains('tui')`);
    if (!sticky) fail('opening ?mode=tui no longer persists the mode (README documents that it does)');
  });

/* --- the whole reason a font subset is embedded -------------------------- */
check('font', 'every embedded glyph has the same advance as the body font',
  async ({ page, origin, fail, note }) => {
    await page.setWidth(1024);
    await page.goto(`${origin}/`);
    const m = await page.eval(`
      (() => {
        const measure = (ch, stack) => {
          const s = document.createElement('span');
          s.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px;line-height:1;font-family:' + stack;
          s.textContent = ch.repeat(20);
          document.body.appendChild(s);
          const w = s.getBoundingClientRect().width;
          s.remove();
          return Math.round(w * 100) / 100;
        };
        const cs = getComputedStyle(document.documentElement);
        const art = cs.getPropertyValue('--font-art').trim();
        const body = cs.getPropertyValue('--font').trim();
        const glyphs = { braille: '\\u28FF', block: '\\u2588', space: ' ', rule: '\\u2500', check: '\\u2713', arrow: '\\u2192' };
        const out = {};
        for (const k in glyphs) out[k] = measure(glyphs[k], art);
        return { art: out, bodyM: measure('M', body), subsetLoaded: document.fonts.check('100px "Terminal Glyphs"') };
      })()`);
    if (!m.subsetLoaded) { fail('the embedded Terminal Glyphs subset did not load'); return; }
    const widths = Object.entries(m.art);
    const [, base] = widths[0];
    for (const [k, w] of widths) {
      if (w !== base) fail(`--font-art advance differs: ${widths[0][0]} is ${base}px but ${k} is ${w}px`);
    }
    if (m.bodyM !== base) {
      /* Only meaningful when JetBrains Mono actually arrived from the network. */
      note(`body font advance is ${m.bodyM}px vs art ${base}px - JetBrains Mono may not have loaded (offline?)`);
    }
  });

/* --- spinner frames ----------------------------------------------------- */
check('spinners', 'frames close, none blank, no two in a row identical',
  async ({ fail }) => {
    const src = await readFile(path.join(ROOT, 'index.html'), 'utf8');
    const from = src.indexOf('var TAU = Math.PI * 2;');
    const to = src.indexOf('/* ---- instances ---- */');
    if (from < 0 || to < 0 || to <= from) {
      fail('could not find the spinner block in index.html (markers moved?)');
      return;
    }
    /* Evaluate the shipped source, not a copy of it. The block from TAU up to
       the instance loop touches no DOM, so it runs as-is under Node. */
    const SPINNERS = new Function(`${src.slice(from, to)}\nreturn { SPINNERS, encode };`)();
    const { SPINNERS: defs, encode } = SPINNERS;
    const BLANK = '⠀';
    for (const [name, s] of Object.entries(defs)) {
      const f = s.frames;
      if (!f || !f.length) { fail(`${name}: no frames`); continue; }
      if (!s.lit && f.length !== s.f) fail(`${name}: ${f.length} frames precomputed but f is ${s.f}`);
      const cols = s.cols;
      for (let i = 0; i < f.length; i++) {
        if ([...f[i]].length !== cols) fail(`${name}: frame ${i} is ${[...f[i]].length} chars, expected ${cols}`);
        if ([...f[i]].every(c => c === BLANK)) fail(`${name}: frame ${i} is blank - the spinner vanishes`);
        const prev = f[(i - 1 + f.length) % f.length];
        if (f[i] === prev) fail(`${name}: frames ${(i - 1 + f.length) % f.length} and ${i} are identical - it stalls`);
      }
      /* Frames are indexed % f, so the frame after the last must be the first
         one again or the loop visibly jumps at the wrap. */
      if (!s.lit && encode(s.fn, cols, f.length) !== f[0]) {
        fail(`${name}: does not close - frame ${f.length} differs from frame 0`);
      }
    }
  });

/* --- spinner instances must not march in lockstep ----------------------- */
check('stagger', 'no two instances of one spinner start on the same frame',
  async ({ page, origin, fail, note }) => {
    /* The engine offsets each instance's start index by n*(f-1) mod f. That is
       coprime with f for every f, so N<=f instances of one spinner are all on
       different frames. A multiplier that shares a factor with f collapses them
       into groups -- n*5 with f=10 gives every instance either frame 0 or 5. */
    for (const mode of MODES) {
      await page.setWidth(1440);
      await page.goto(`${origin}/?mode=${mode}`);
      const groups = await page.eval(`${HELPERS}
        (() => {
          const by = {};
          for (const el of document.querySelectorAll('[data-spinner]')) {
            if (!__vis(el)) continue;
            (by[el.dataset.spinner] ||= []).push(el.textContent);
          }
          return by;
        })()`);
      for (const [name, frames] of Object.entries(groups)) {
        const distinct = new Set(frames).size;
        const want = Math.min(frames.length, 64);
        if (distinct < want) {
          fail(`${mode}: ${frames.length} "${name}" instances start on only ${distinct} distinct frames`);
        }
      }
      note(`${mode}: ${Object.entries(groups).map(([k, v]) => k + '\u00d7' + v.length).join(' ')}`);
    }
  });


/* --- each fact has one home per mode ------------------------------------ */
check('once', 'summaries that a mode restates elsewhere stay hidden in that mode',
  async ({ page, origin, fail }) => {
    /* The page carries the same summary twice by design and hides one copy per
       mode: read mode has no card, so #about's `now` list is its only summary of
       current work; browse mode has the card, so the list would be a second copy
       one screen below it. Same contract as .meta, which the card also restates.
       Getting this backwards is invisible in a screenshot and doubles the text. */
    const PAIRS = [
      { sel: '.now',   showIn: 'stdout', why: "#about's `now` list vs the card's `now` rows" },
      { sel: '.meta',  showIn: 'stdout', why: '.meta vs the card\'s `based` and `email` rows' },
      { sel: '.fetch', showIn: 'tui',    why: 'the summary card itself' },
    ];
    await page.setWidth(1440);
    for (const mode of MODES) {
      await page.goto(`${origin}/?mode=${mode}`);
      const seen = await page.eval(`${HELPERS}
        (() => {
          const out = {};
          for (const sel of ${JSON.stringify(PAIRS.map(p => p.sel))}) {
            const el = document.querySelector(sel);
            out[sel] = el ? __vis(el) : null;
          }
          return out;
        })()`);
      for (const p of PAIRS) {
        if (seen[p.sel] === null) { fail(`${mode}: ${p.sel} is missing from the markup`); continue; }
        const want = p.showIn === mode;
        if (seen[p.sel] !== want) {
          fail(`${mode}: ${p.sel} is ${seen[p.sel] ? 'visible' : 'hidden'} but should be ` +
               `${want ? 'visible' : 'hidden'} - ${p.why}`);
        }
      }
    }
  });


/* --- the page without JavaScript ---------------------------------------- */
check('nojs', 'content renders and the toggle stays hidden with scripts off',
  async ({ cdp, origin, fail }) => {
    /* A fresh target: script execution is disabled for the whole session, and
       Runtime.evaluate stops working with it, so every assertion here reads
       through the DOM and CSS domains instead. */
    const page = await Page.open(cdp);
    try {
      await page.setWidth(1024);
      await page.send('Emulation.setScriptExecutionDisabled', { value: true });
      await page.send('DOM.enable');
      await page.send('CSS.enable');
      await page.goto(`${origin}/?mode=tui`);

      const { root } = await page.send('DOM.getDocument', { depth: -1 });
      const q = async sel => (await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel })).nodeId;
      const attrs = async nodeId => {
        const { attributes } = await page.send('DOM.getAttributes', { nodeId });
        const o = {};
        for (let i = 0; i < attributes.length; i += 2) o[attributes[i]] = attributes[i + 1];
        return o;
      };
      const styleOf = async (nodeId, prop) => {
        const { computedStyle } = await page.send('CSS.getComputedStyleForNode', { nodeId });
        return computedStyle.find(p => p.name === prop)?.value;
      };

      const htmlClass = (await attrs(await q('html'))).class || '';
      if (/\b(tui|stdout)\b/.test(htmlClass)) {
        fail(`<html> got a mode class with scripts off (class="${htmlClass}") - the head script should not have run`);
      }
      const bodyClass = (await attrs(await q('body'))).class || '';
      if (!/\bno-js\b/.test(bodyClass)) fail(`<body> lost its no-js class (class="${bodyClass}")`);
      if (/\bready\b/.test(bodyClass)) fail('<body> is .ready with scripts off - the reveal must not need JS');

      for (const sel of ['#about', '#experience', '#projects', '#skills', '#contact', '.art--name']) {
        if (!(await q(sel))) fail(`${sel} is missing with scripts off`);
      }
      const bar = await q('.modebar-wrap');
      if (!bar) fail('.modebar-wrap is missing from the markup');
      else if (await styleOf(bar, 'display') !== 'none') {
        fail('the mode toggle is visible with scripts off - it cannot work there');
      }
      const li = await q('.boot li');
      if (li && parseFloat(await styleOf(li, 'opacity')) !== 1) {
        fail('the boot log is transparent with scripts off - it would never appear');
      }
    } finally {
      await page.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {});
      await page.send('Page.close').catch(() => {});
    }
  });

/* -------------------------------------------------------------------- main */

const argv = process.argv.slice(2);
if (argv.includes('--list') || argv.includes('-l')) {
  for (const c of checks) console.log(`${c.name.padEnd(10)} ${c.blurb}`);
  process.exit(0);
}
const wanted = argv.filter(a => !a.startsWith('-'));
const unknown = wanted.filter(w => !checks.some(c => c.name === w));
if (unknown.length) {
  console.error(`unknown check: ${unknown.join(', ')}\nknown: ${checks.map(c => c.name).join(', ')}`);
  process.exit(2);
}
const selected = wanted.length ? checks.filter(c => wanted.includes(c.name)) : checks;

const server = await startServer();
const chrome = await launchChrome();
const cdp = await CDP.connect(chrome.wsUrl);
const page = await Page.open(cdp);

let failures = 0, notes = 0;
for (const c of selected) {
  const problems = [], remarks = [];
  const ctx = {
    page, cdp, origin: server.origin,
    fail: m => problems.push(m),
    note: m => remarks.push(m),
  };
  const t0 = Date.now();
  try {
    await c.fn(ctx);
  } catch (e) {
    problems.push(`threw: ${e.message}`);
  }
  const ms = String(Date.now() - t0).padStart(5);
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${c.name.padEnd(10)}${ms}ms  ${c.blurb}`);
  for (const p of problems) console.log(`       ${p}`);
  for (const r of remarks) console.log(`  note ${r}`);
  failures += problems.length;
  notes += remarks.length;
}

await chrome.close();
server.close();

console.log(failures
  ? `\n${failures} failure${failures === 1 ? '' : 's'}.`
  : `\nAll ${selected.length} checks passed${notes ? ` (${notes} note${notes === 1 ? '' : 's'})` : ''}. This is a regression harness, not a proof - look at the page too.`);
process.exit(failures ? 1 : 0);
