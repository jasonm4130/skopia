/**
 * Skopia — the dashboard stylesheet ("instrument panel", same system as
 * skopia.dev). Shipped inline in every page's nonced <style>: the CSP allows
 * stylesheets only by nonce or 'self', and inlining keeps each rendered page
 * (including a KV-cached /share page) self-consistent with the markup that
 * produced it — no asset-version skew across a deploy.
 *
 * Design rules:
 * - The app chrome is the enamel casing (--paper / --ink). Anything that is a
 *   readout of data sits on graphite display glass (.glass) set into it.
 * - Lime (--live) appears on displays only, and only for LIVE data (online
 *   now, active pages) — and only while that count is above zero. Historical
 *   charts are drawn in display ink, never lime.
 * - Hatching means "not exact": today's partial day, and sampled estimates.
 *
 * Color tokens mirror src/shared/tokens.css (ADR-0009 source of truth).
 */

// Self-hosted @font-face — vendored woff2 served from /fonts by the Workers
// Static Assets layer. Zero third-party requests: no Google Fonts. One
// @font-face per weight/subset; unicode-range lets the browser fetch only the
// latin or latin-ext file it needs. font-display:swap avoids FOIT.
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

function fontFaces(family: string, prefix: string, weights: number[]): string {
  return weights
    .flatMap((w) =>
      (
        [
          ["latin", LATIN],
          ["latin-ext", LATIN_EXT],
        ] as const
      ).map(
        ([subset, range]) =>
          `@font-face{font-family:'${family}';font-style:normal;font-weight:${w};font-display:swap;src:url('/fonts/${prefix}-${w}-${subset}.woff2') format('woff2');unicode-range:${range}}`,
      ),
    )
    .join("\n");
}

const FONT_FACES = [
  fontFaces("Hanken Grotesk", "hanken-grotesk", [400, 500, 600, 700]),
  fontFaces("JetBrains Mono", "jetbrains-mono", [400, 500]),
].join("\n");

export const DASH_CSS = `${FONT_FACES}
:root{
  --paper:#e3e5df;--paper-hi:#eef0eb;--paper-lo:#d7dad3;
  --ink:#121512;--ink-2:#3b413b;--ink-3:#555c55;
  --rule:#c6cbc2;--rule-2:#abb1a8;--bar:#cdd1c8;--bar-hi:#bfc4b9;
  --disp:#111412;--disp-2:#181c19;--disp-rule:#272d29;
  --disp-ink:#e9eee6;--disp-ink-2:#a9b2a8;--disp-ink-3:#8a9389;--disp-col:#4a544c;
  --live:#c8f25a;--bad:#8a2a1c;
  --sans:'Hanken Grotesk',ui-sans-serif,system-ui,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --ease:cubic-bezier(.2,.7,.2,1);
  --gut:clamp(16px,3.2vw,40px);--max:1320px;
  --bezel:0 0 0 1px #000,0 0 0 6px #1b1f1c,0 0 0 7px #0a0b0a,0 30px 50px -34px rgba(0,0,0,.5);
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--paper);color:var(--ink);font:400 16px/1.55 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
body>main{flex:1 0 auto;width:100%}
a{color:inherit}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.02em}
p{margin:0}
ul,ol{margin:0;padding:0;list-style:none}
dl,dd{margin:0}
table{border-collapse:collapse}
button,input,select{font:inherit;color:inherit}
code{font-family:var(--mono);font-size:.9em}
.num{font-variant-numeric:tabular-nums lining-nums}
::selection{background:var(--ink);color:var(--paper)}
/* Visually hidden but exposed to assistive tech. */
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* Keyboard focus (WCAG 2.4.7): ink ring on the casing, lime on glass. */
:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:3px}
.glass :focus-visible{outline-color:var(--live)}
.skip{position:absolute;left:12px;top:-60px;background:var(--ink);color:var(--paper);padding:10px 14px;z-index:30;text-decoration:none}
.skip:focus{top:12px}
.wrap{max-width:var(--max);margin:0 auto;padding:0 var(--gut)}
sup.fn{font-size:.62em;font-weight:500;vertical-align:top;position:relative;top:-.2em;margin-left:1px}
sup.fn a{text-decoration:none;color:var(--ink-3);padding:0 2px}
sup.fn a:hover{color:var(--ink)}
.srt{display:inline-block;margin-right:4px;font-weight:600;color:var(--ink)}

/* ---------- casing bar ---------- */
.bar{border-bottom:1px solid var(--rule)}
.bar-in{display:flex;align-items:center;gap:20px;height:60px}
.brand{display:inline-flex;align-items:center;gap:10px;font-weight:700;font-size:18px;letter-spacing:-.02em;text-decoration:none}
.mark{display:inline-flex;align-items:flex-end;gap:2.5px;height:16px;padding-bottom:1px;box-shadow:inset 0 -1.5px 0 var(--ink)}
.mark i{display:block;width:3.5px;border-radius:1px 1px 0 0;background:var(--ink)}
.mark i:nth-child(1){height:7px}.mark i:nth-child(2){height:14px}.mark i:nth-child(3){height:10px}
.bar-sep{width:1px;height:24px;background:var(--rule-2)}
.site-nm{font-weight:600;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-end{margin-left:auto;display:flex;align-items:center;gap:20px;font-size:14.5px;white-space:nowrap}
.bar-end a{color:var(--ink-2);text-decoration:none}
.bar-end a:hover{color:var(--ink);text-decoration:underline}
/* Site switcher: a disclosure of real links, works with no JS. */
.switch{position:relative;min-width:0}
.switch summary{list-style:none;cursor:pointer;display:inline-flex;align-items:center;gap:10px;height:36px;padding:0 12px;border-radius:7px;box-shadow:inset 0 0 0 1px var(--rule-2);font-weight:600;font-size:15px;max-width:100%}
.switch summary::-webkit-details-marker{display:none}
.switch summary:hover{box-shadow:inset 0 0 0 1px var(--ink-3)}
.switch .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dom{font:400 13px var(--mono);color:var(--ink-3)}
.chev{flex:none;width:8px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);transition:transform .25s var(--ease)}
.switch[open] .chev{transform:translateY(1px) rotate(-135deg)}
.menu{position:absolute;left:0;top:44px;z-index:25;min-width:260px;max-width:calc(100vw - 32px);background:var(--paper-hi);border-radius:8px;box-shadow:0 0 0 1px var(--rule-2),0 18px 30px -18px rgba(0,0,0,.35);padding:6px}
.menu a{display:flex;justify-content:space-between;gap:16px;padding:9px 10px;border-radius:5px;text-decoration:none;font-size:14.5px}
.menu a:hover{background:var(--paper-lo)}
.menu a[aria-current]{font-weight:600}
.menu a[aria-current]::after{content:"";width:6px;height:6px;border-radius:50%;background:var(--ink);align-self:center}
.menu .dom{font-size:12.5px}
.menu-note{padding:8px 10px 4px;margin-top:4px;border-top:1px solid var(--rule);font-size:13px;color:var(--ink-3);line-height:1.45}
.plate{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:5px;box-shadow:inset 0 0 0 1px var(--ink-2);font-size:13px;font-weight:500;color:var(--ink-2);white-space:nowrap}
.plate .lock{width:9px;height:7px;border-radius:1.5px;background:currentColor;position:relative;margin-top:3px}
.plate .lock::before{content:"";position:absolute;left:1.5px;top:-5px;width:6px;height:6px;border:1.5px solid currentColor;border-bottom:0;border-radius:3px 3px 0 0;box-sizing:border-box}

/* ---------- views + range keys ---------- */
.views{border-bottom:1px solid var(--rule)}
.views-in{display:flex;align-items:center;justify-content:space-between;gap:0 24px;min-height:56px}
.tabs{display:flex;flex-wrap:wrap;gap:0 26px;margin-bottom:-1px}
.tabs a{display:block;padding:17px 0 15px;font-size:15px;color:var(--ink-2);text-decoration:none;white-space:nowrap;border-bottom:2px solid transparent}
.tabs a:hover{color:var(--ink)}
.tabs a[aria-current]{color:var(--ink);font-weight:600;border-bottom-color:var(--ink)}
.keys{display:flex;flex:none;padding:3px;border-radius:9px;background:var(--paper-lo);box-shadow:inset 0 1px 2px rgba(0,0,0,.12),inset 0 0 0 1px var(--rule)}
.keys>a{display:inline-flex;align-items:center;justify-content:center;height:32px;padding:0 12px;border-radius:6px;font-size:14px;font-weight:500;color:var(--ink-2);text-decoration:none;white-space:nowrap;transition:transform .15s var(--ease)}
.keys>a:hover{color:var(--ink)}
.keys>a:active{transform:translateY(1px)}
.keys>a[aria-current]{background:var(--ink);color:var(--paper-hi);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 2px 0 #000}

/* ---------- mobile tab bar (<=640px replaces the top tabs) ---------- */
.tabbar{display:none}
.tabbar summary::-webkit-details-marker{display:none}

/* ---------- keys (buttons) ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:42px;padding:0 18px;border-radius:8px;font:600 14.5px/1 var(--sans);text-decoration:none;cursor:pointer;border:0;transition:transform .15s var(--ease),box-shadow .15s var(--ease)}
.btn-ink{background:var(--ink);color:var(--paper-hi);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 3px 0 #000,0 10px 18px -10px rgba(0,0,0,.5)}
.btn-ink:hover{background:#1d211d}
.btn-ink:active{transform:translateY(3px);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),0 0 0 #000}
.btn-quiet{background:var(--paper-hi);color:var(--ink);box-shadow:inset 0 0 0 1px var(--rule-2),0 2px 0 var(--rule-2)}
.btn-quiet:active{transform:translateY(2px);box-shadow:inset 0 0 0 1px var(--rule-2),0 0 0 var(--rule-2)}
.key-glyph{width:13px;height:13px;border-radius:3px;box-shadow:inset 0 0 0 1.5px currentColor;position:relative}
.key-glyph::after{content:"";position:absolute;left:3px;top:3px;width:7px;height:7px;border-radius:1.5px;background:currentColor;transform:scale(.55);transition:transform .25s var(--ease)}
.btn:hover .key-glyph::after{transform:scale(1)}
.more{font-size:14px;font-weight:600;text-decoration:none;display:inline-flex;gap:6px;align-items:center;padding:6px 0;white-space:nowrap;background:linear-gradient(currentColor,currentColor) 0 calc(100% - 3px)/100% 1.5px no-repeat}
.more span{display:inline-block;transition:transform .3s var(--ease)}
.more:hover span{transform:translateX(3px)}

/* ---------- notice (sampled) ---------- */
.notice{display:flex;gap:14px;align-items:flex-start;margin-top:24px;padding:12px 16px 12px 0;border-top:1px solid var(--ink);border-bottom:1px solid var(--rule-2);font-size:14.5px;color:var(--ink-2)}
.notice strong{color:var(--ink)}
.hatch{flex:none;width:34px;align-self:stretch;min-height:22px;background:repeating-linear-gradient(135deg,var(--ink-2) 0 1.5px,transparent 1.5px 5px)}

/* ---------- page heads + headline readout ---------- */
.head,.page-h{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:10px 48px;align-items:end;padding:36px 0 22px}
.page-h{padding-bottom:28px}
.head h1,.page-h h1{font-size:30px;letter-spacing:-.03em;line-height:1.1}
.period{margin-top:6px;font-size:14.5px;color:var(--ink-3)}
.say{font-size:17px;line-height:1.45;color:var(--ink-2);text-wrap:pretty}
.say b{color:var(--ink);font-weight:600}
.head .say,.page-h .say{justify-self:end;text-align:right}
.live-chip{display:none}
.readout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.1fr);border-top:2px solid var(--ink);border-bottom:1px solid var(--rule-2)}
.ro{padding:18px 24px 20px 0;min-width:0}
.ro+.ro{padding-left:24px;border-left:1px solid var(--rule-2)}
.ro dt{font-size:15px;font-weight:500;color:var(--ink-2)}
.ro-t dt{display:flex;align-items:center;gap:8px}
.ro dd.num{font-weight:500;font-size:clamp(52px,6.4vw,84px);line-height:1;letter-spacing:-.055em;margin-top:10px;white-space:nowrap}
.ro dd.num.long{font-size:clamp(40px,5.2vw,76px)}
.ro-sub{margin-top:12px;font-size:15px;color:var(--ink-2)}
.ro-sub b{font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums}
.ro-t{background:linear-gradient(90deg,var(--paper-lo),transparent 85%)}
.ro-t dd.num{font-size:clamp(44px,4.6vw,64px)}
.ro-t .u{font-size:17px;letter-spacing:-.01em;font-weight:500;color:var(--ink-2);margin-left:.15em}
.hx{width:12px;height:14px;border-radius:2px;background:repeating-linear-gradient(135deg,var(--ink-2) 0 1.4px,transparent 1.4px 4px);box-shadow:inset 0 0 0 1px var(--ink-3)}
.est{font-weight:400;color:var(--ink-3);margin-right:.04em}

/* ---------- display glass ---------- */
.glass{background:var(--disp);color:var(--disp-ink);border-radius:12px;box-shadow:var(--bezel);margin:7px}
.console{display:grid;grid-template-columns:minmax(0,1fr) 320px;margin-top:30px;overflow:hidden}
.console.idle,.console.nolive{grid-template-columns:minmax(0,1fr)}
.scope{padding:20px 24px 16px;min-width:0}
.scope-top{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px 24px}
.scope-top h2{font-size:16px;letter-spacing:-.01em}
.key{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:13.5px;color:var(--disp-ink-2)}
.key span{display:inline-flex;align-items:center;gap:7px}
.key i{display:inline-block;border-radius:1px}
.sw-col{width:10px;height:13px;background:var(--disp-col)}
.sw-vis{width:4px;height:13px;background:var(--disp-ink-2)}
.sw-today{width:10px;height:13px;background:repeating-linear-gradient(135deg,#99a297 0 1.2px,#434c45 1.2px 3.6px)}
.sw-brk{width:10px;height:13px;background:linear-gradient(var(--disp-col) 0 4px,transparent 4px 6px,var(--disp-col) 6px 7px,transparent 7px 8.5px,var(--disp-col) 8.5px)}
.readline{margin-top:14px;font-size:16px;color:var(--disp-ink-2);min-height:1.5em;font-variant-numeric:tabular-nums}
.readline b{font-weight:600;color:var(--disp-ink);margin-left:.5em}
.readline b+b{margin-left:.9em}
.readline .rd{color:var(--disp-ink)}
.plot{position:relative;margin:30px 44px 0 0;height:230px;outline:none;touch-action:pan-y}
.plot.sparse{margin-right:0}
.plot:focus-visible{outline:2px solid var(--live);outline-offset:6px}
.plot svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.gl{position:absolute;left:0;right:0;border-top:1px solid var(--disp-rule)}
.gl span{position:absolute;right:-44px;top:-9px;width:36px;font:400 12px var(--mono);color:var(--disp-ink-3)}
.gl.base{border-top-color:var(--disp-ink-3)}
.col{fill:var(--disp-col)}
.col.today{fill:url(#hatch)}
.vis{fill:var(--disp-ink-2);pointer-events:none}
.brk{fill:var(--disp)}
.plot .col.on{fill:#66716a}
.plot .col.today.on{fill:url(#hatch-on)}
.vl{position:absolute;transform:translateX(-50%);font:500 13px var(--sans);color:var(--disp-ink-2);pointer-events:none;white-space:nowrap;font-variant-numeric:tabular-nums}
.vl.pk{color:var(--disp-ink);font-weight:600}
.guide{position:absolute;top:-10px;bottom:0;left:0;width:1px;background:var(--disp-ink-2);opacity:0;pointer-events:none;transition:transform .22s var(--ease),opacity .2s}
.plot.hover .guide{opacity:1}
.xax{position:relative;height:30px;margin-right:44px;font-size:13px;color:var(--disp-ink-3)}
.plot.sparse+.xax{margin-right:0}
.xax span{position:absolute;top:9px;transform:translateX(-50%);white-space:nowrap}
.xax .x0{transform:none}
.xax .now{color:var(--disp-ink);font-weight:500;transform:translateX(-80%)}
.plot-empty{margin-top:30px;padding:60px 0;text-align:center;color:var(--disp-ink-2);border-top:1px solid var(--disp-ink-3)}
/* "Every day as a table": the visible accessible fallback for the chart. */
.days{margin-top:6px;border-top:1px solid var(--disp-rule);font-size:14px}
.days summary{cursor:pointer;padding:10px 0 2px;color:var(--disp-ink-2);list-style:none;display:inline-flex;align-items:center;gap:8px}
.days summary::-webkit-details-marker{display:none}
.days summary::before{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);transition:transform .2s var(--ease)}
.days[open] summary::before{transform:rotate(45deg)}
.days summary:hover{color:var(--disp-ink)}
.days-wrap{max-height:320px;overflow:auto;margin-top:10px}
.days table{width:100%;font-variant-numeric:tabular-nums}
.days th,.days td{padding:6px 0 6px 18px;text-align:right;border-bottom:1px solid var(--disp-rule);font-weight:400;color:var(--disp-ink-2)}
.days thead th{position:sticky;top:0;background:var(--disp);color:var(--disp-ink);font-weight:500}
.days th:first-child{text-align:left;padding-left:0}
.days tbody th{color:var(--disp-ink)}

/* ---------- live compartment ---------- */
.live{border-left:1px solid var(--disp-rule);padding:20px 22px 18px;display:flex;flex-direction:column;min-width:0;background:var(--disp-2)}
.live h2,.listen h2{font-size:15px;font-weight:500;color:var(--disp-ink-2);letter-spacing:0;display:flex;align-items:center;gap:9px}
.ldot{position:relative;width:8px;height:8px;border-radius:50%;background:var(--live);flex:none}
.ldot.zero{background:none;box-shadow:inset 0 0 0 1.5px var(--disp-ink-3)}
.ldot::after{content:"";position:absolute;inset:-1px;border-radius:50%;border:1.5px solid var(--live);opacity:0}
.ldot.ping::after{animation:ping 1.6s var(--ease) both}
@keyframes ping{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3.4)}}
.live-n{display:flex;align-items:baseline;gap:12px;margin-top:8px}
.live-n .odo{font-size:68px;font-weight:500;letter-spacing:-.05em;line-height:1}
.live-n small{font-size:14px;color:var(--disp-ink-2);line-height:1.35;max-width:10em}
/* Online-now ink: lime only while someone is online; display grey at 0. */
.odo{color:var(--live);font-variant-numeric:tabular-nums}
.zero .odo,.odo.zero{color:var(--disp-ink-2)}
/* Odometer: one column per digit, each a strip of [blank,0-9]; a blank
   leading column lets 9 -> 10 roll a new digit in instead of jumping. */
.odo{display:inline-flex;overflow:hidden;height:1.05em;line-height:1.05;vertical-align:bottom}
.odo-c{display:inline-block;height:1.05em;overflow:hidden;width:.62em;transition:width .5s var(--ease)}
.odo-c.b{width:0}
.odo-s{display:block;transition:transform .55s var(--ease)}
.odo-s>span{display:block;height:1.05em;text-align:center}
.live h3{margin-top:22px;padding-bottom:8px;border-bottom:1px solid var(--disp-rule);font-size:13.5px;font-weight:500;color:var(--disp-ink-2);letter-spacing:0;display:flex;justify-content:space-between}
.apages{position:relative}
.apages li{position:relative;display:flex;justify-content:space-between;gap:12px;padding:8px 0 8px 12px;border-bottom:1px solid var(--disp-rule);font-size:14px}
.apages li::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:2px;background:var(--disp-rule)}
.apages .bar-l{position:absolute;left:12px;right:0;bottom:-1px;height:2px;background:var(--live);opacity:.55;transform-origin:left;transform:scaleX(var(--s,0));transition:transform .5s var(--ease)}
.apages .p{font-family:var(--mono);font-size:13px;color:var(--disp-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.apages .c{color:var(--live);font-weight:500;font-variant-numeric:tabular-nums}
.apages .none{padding:12px 0;font-size:14px;color:var(--disp-ink-2);line-height:1.5;border:0}
.apages .none::before{display:none}
.live-foot{margin-top:auto;padding-top:16px;font-size:13px;color:var(--disp-ink-3);line-height:1.45}
.live-foot b{font-weight:500;color:var(--disp-ink-2)}
/* Nobody online: the compartment collapses to a one-line glass strip. */
.live-strip{display:none}
.live.is-zero{border-left:0;border-top:1px solid var(--disp-rule);padding:12px 24px}
.live.is-zero>.live-full{display:none}
.live.is-zero>.live-strip{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;font-size:14.5px;color:var(--disp-ink-2)}
.live-strip .odo{font-size:20px;font-weight:600;letter-spacing:-.02em}
.live-strip .sep{color:var(--disp-ink-3)}
.live-strip .st{margin-left:auto;font-size:13px;color:var(--disp-ink-3)}
.live-full{display:flex;flex-direction:column;flex:1;min-height:0}

/* ---------- footnotes ---------- */
.notes{margin-top:18px;padding:0 4px;font-size:13.5px;line-height:1.5;color:var(--ink-3);max-width:920px}
.notes li{display:grid;grid-template-columns:16px minmax(0,1fr)}
.notes li+li{margin-top:6px}
.notes li:target{color:var(--ink)}

/* ---------- ruled breakdowns ---------- */
.sec{margin-top:56px}
.sec-h{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:12px}
.sec-h h2{font-size:21px;letter-spacing:-.025em}
.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px clamp(32px,4vw,64px)}
.tbl-wrap{overflow-x:auto}
.bd{width:100%;font-size:15px}
.bd th,.bd td{padding:0;text-align:right;font-weight:400}
.bd thead th{font-size:14px;font-weight:500;color:var(--ink-2);padding:0 0 9px 18px;border-bottom:2px solid var(--ink);white-space:nowrap;vertical-align:bottom}
.bd thead th:first-child{text-align:left;padding-left:0}
.bd thead th[aria-sort]{color:var(--ink)}
.bd tbody th{text-align:left;font-weight:400;position:relative;width:100%;max-width:0}
.bd tbody td{padding:0 0 0 18px;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--ink-2)}
.bd td.v{color:var(--ink);font-weight:500}
.bd tbody tr>*{height:42px;border-bottom:1px solid var(--rule)}
.bd .lbl{position:relative;display:block;padding:0 10px;line-height:42px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;z-index:0}
.bd .lbl::before{content:"";position:absolute;left:0;top:7px;bottom:7px;width:100%;background:var(--bar);border-radius:2px;transform:scaleX(var(--s,0));transform-origin:left;z-index:-1}
.bd tbody tr:hover .lbl::before{background:var(--bar-hi)}
.bd .path{font-family:var(--mono);font-size:13.5px}
.devtag{display:inline-block;margin-left:8px;padding:0 6px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--rule-2);font:500 12.5px/20px var(--sans);color:var(--ink-2);vertical-align:1px}
.bd tfoot th,.bd tfoot td{padding:11px 0 0 18px;font-size:14px;color:var(--ink-3);text-align:right;font-weight:400;font-variant-numeric:tabular-nums;vertical-align:top;white-space:nowrap}
.bd tfoot th{text-align:left;padding-left:0}
.bd tfoot td.v{color:var(--ink-2);font-weight:500}
.bd tfoot tr+tr>*{padding-top:4px}
.bd-none{padding:22px 0;border-top:2px solid var(--ink);color:var(--ink-3);font-size:14.5px;line-height:1.55}
.bd-none code{color:var(--ink)}
.bd-note{margin-top:10px;font-size:13.5px;line-height:1.5;color:var(--ink-3)}
.bd-note a{color:var(--ink-2)}
.legend{margin-top:14px;font-size:13.5px;color:var(--ink-3)}

/* ---------- countries display ---------- */
.atlas{display:grid;grid-template-columns:minmax(0,1fr) 300px;overflow:hidden}
.atlas-map{padding:20px 24px 16px;min-width:0}
.atlas-h{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 24px;margin-bottom:14px}
.atlas-h h2{font-size:16px;letter-spacing:-.01em}
.atlas-h p{font-size:13.5px;color:var(--disp-ink-3)}
.mapbox{position:relative;max-width:700px;margin:0 auto}
.mapbox img{display:block;width:100%;height:auto}
.mapbox svg{position:absolute;inset:0;width:100%;height:100%}
.m-c{fill:none;stroke-width:4;stroke-linecap:round}
.m-1{stroke:#7a857b}.m-2{stroke:#bcc5b9}.m-3{stroke:#f4f8f0}
.m-legend{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-top:10px;font-size:13.5px;color:var(--disp-ink-3);font-variant-numeric:tabular-nums}
.m-legend span{display:inline-flex;align-items:center;gap:6px;color:var(--disp-ink-2)}
.m-k{width:8px;height:8px;border-radius:50%}
.m-k1{background:#7a857b}.m-k2{background:#bcc5b9}.m-k3{background:#f4f8f0}
.atlas-list{border-left:1px solid var(--disp-rule);padding:20px 22px 16px;background:var(--disp-2);min-width:0}
.atlas-list h3{font-size:14px;font-weight:500;color:var(--disp-ink-2);letter-spacing:0;padding-bottom:8px;border-bottom:1px solid var(--disp-rule);display:flex;justify-content:space-between}
.atlas-list h3 .srt{color:var(--disp-ink)}
.atlas-list li{position:relative;display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid var(--disp-rule);font-size:14.5px}
.atlas-list li::after{content:"";position:absolute;left:0;bottom:-1px;height:2px;width:100%;background:var(--disp-ink-3);transform:scaleX(var(--s));transform-origin:left}
.atlas-list .cc{font:500 12.5px var(--mono);color:var(--disp-ink)}
.atlas-list .nm{color:var(--disp-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.atlas-list .n{font-weight:500;font-variant-numeric:tabular-nums}
.atlas-list .more{margin-top:12px;color:var(--disp-ink);font-size:14px}
.atlas-list .none{padding:12px 0;color:var(--disp-ink-2);font-size:14px}

/* ---------- devices / mini tables ---------- */
.dgrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:32px clamp(28px,3.4vw,56px)}
.dcol{min-width:0}
.dcol .bd tbody tr>*{height:38px}
.dcol .bd .lbl{line-height:38px}

/* ---------- footer plate ---------- */
.foot{margin-top:72px;border-top:1px solid var(--ink)}
.foot-in{padding-top:18px;padding-bottom:28px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 32px;font-size:14px;color:var(--ink-3)}
.foot b{font-weight:500;color:var(--ink-2)}

/* ---------- full breakdown pages ---------- */
.full .bd{font-size:15.5px}
.full .bd tbody tr>*{height:46px}
.full .bd .lbl{line-height:46px}
.basis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px 40px;margin-top:28px;padding-top:16px;border-top:1px solid var(--rule-2);font-size:14px;color:var(--ink-2);line-height:1.5}
.basis strong{display:block;color:var(--ink);font-weight:600;margin-bottom:2px}
.basis p:target{background:var(--paper-lo);box-shadow:0 0 0 8px var(--paper-lo)}
.aside{margin-top:24px;font-size:14px;color:var(--ink-3);line-height:1.55;max-width:60em}
.aside code{color:var(--ink)}
.pct{display:inline-flex;align-items:center;gap:12px;justify-content:flex-end}
.pct i{display:block;width:clamp(80px,16vw,220px);height:10px;background:var(--bar);border-radius:2px;position:relative;overflow:hidden}
.pct i::after{content:"";position:absolute;inset:0;background:var(--ink);transform:scaleX(var(--s));transform-origin:left}

/* ---------- first run / no sites ---------- */
.first{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:40px clamp(32px,5vw,80px);padding:44px 0 0;align-items:start}
.first h1{font-size:clamp(30px,3.4vw,44px);letter-spacing:-.04em;line-height:1.05;max-width:13em}
.first .say{margin-top:14px}
.steps{margin-top:32px;border-top:2px solid var(--ink);counter-reset:s}
.steps>li{display:grid;grid-template-columns:40px minmax(0,1fr);gap:4px 12px;padding:20px 0;border-bottom:1px solid var(--rule-2);counter-increment:s}
.steps>li::before{content:counter(s);font:500 14px var(--mono);color:var(--ink);width:26px;height:26px;border-radius:5px;box-shadow:inset 0 0 0 1.5px var(--ink);display:grid;place-items:center}
.steps h2{font-size:17px;letter-spacing:-.015em;line-height:26px}
.steps p{grid-column:2;font-size:15px;color:var(--ink-2);max-width:36em}
.snip{grid-column:2;margin-top:12px;position:relative;min-width:0}
.snip pre{margin:0;padding:16px 18px;padding-right:96px;background:var(--paper-hi);box-shadow:inset 0 0 0 1px var(--rule-2);border-radius:8px;font:400 13px/1.7 var(--mono);overflow-x:auto;color:var(--ink)}
.snip pre .at{color:var(--ink-3)}
.snip .btn{position:absolute;right:10px;top:10px;height:34px;padding:0 12px;font-size:13.5px}
.trouble{margin-top:18px;font-size:14px;color:var(--ink-3);line-height:1.55}
.trouble code{color:var(--ink)}
.listen{padding:22px 24px;position:sticky;top:24px}
.listen .dom{margin-left:auto;color:var(--disp-ink-3);font-size:12.5px}
.listen .big{font-size:96px;font-weight:500;letter-spacing:-.05em;line-height:1;margin-top:14px}
.listen .wait{margin-top:18px;padding-top:14px;border-top:1px solid var(--disp-rule);font-size:15px;color:var(--disp-ink-2);line-height:1.5}
.listen .wait b{color:var(--disp-ink);font-weight:500}
.listen .arrived{margin-top:12px;font-size:15px;color:var(--disp-ink)}
.listen .arrived .more{margin-left:6px;color:var(--live)}
/* Static hollow beacon: "listening", deliberately not animated. */
.beacon{display:inline-grid;place-items:center;width:14px;height:14px;border-radius:50%;box-shadow:inset 0 0 0 1.5px var(--disp-ink-2)}
.beacon::after{content:"";width:4px;height:4px;border-radius:50%;background:var(--disp-ink-3)}

/* ---------- auth pages ---------- */
.login{flex:1 0 auto;display:flex;flex-direction:column;width:100%}
.login-top{display:flex;align-items:center;justify-content:space-between;height:60px;width:100%}
.host{font:400 13px var(--mono);color:var(--ink-3)}
.login-main{flex:1 0 auto;display:grid;grid-template-columns:minmax(0,380px) minmax(0,500px);justify-content:space-between;align-items:start;gap:48px;padding-top:clamp(40px,10vh,120px);width:100%;max-width:1040px}
.login-main.solo{grid-template-columns:minmax(0,480px);justify-content:start}
.login-form h1{font-size:34px;letter-spacing:-.04em;line-height:1.05}
.login-form .sub{margin-top:10px;color:var(--ink-2);font-size:15.5px}
.login-form code{color:var(--ink)}
.field{display:grid;gap:6px;margin-top:22px}
.field label{font-size:14px;font-weight:500}
.field input{height:46px;padding:0 14px;border:0;border-radius:7px;background:var(--paper-hi);box-shadow:inset 0 0 0 1px var(--rule-2),inset 0 1px 2px rgba(0,0,0,.06);font-size:15.5px;width:100%}
.field input:hover{box-shadow:inset 0 0 0 1px var(--ink-3)}
.field input:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.field input[aria-invalid="true"]{box-shadow:inset 0 0 0 1.5px var(--bad)}
.field .hint{font-size:13px;color:var(--ink-3)}
.login-form .btn{width:100%;height:48px;margin-top:28px}
.err{margin-top:18px;padding:10px 0 10px 14px;border-left:3px solid var(--bad);color:var(--bad);font-size:14.5px;font-weight:500}
.login-meta{margin-top:16px;font-size:14px;color:var(--ink-3)}
.promise{padding:24px 26px 10px;margin-top:4px}
.promise h2{font-size:15px;font-weight:500;color:var(--disp-ink-2);letter-spacing:0;padding-bottom:12px;border-bottom:1px solid var(--disp-rule)}
.promise li{display:grid;gap:4px;padding:14px 0;border-bottom:1px solid var(--disp-rule);font-size:14.5px;line-height:1.5;color:var(--disp-ink-2)}
.promise li:last-child{border-bottom:0}
.promise b{font-weight:600;color:var(--disp-ink);font-size:15.5px;letter-spacing:-.01em}

/* ---------- responsive ---------- */
@media (max-width:1100px){
  .console{grid-template-columns:minmax(0,1fr)}
  .live{order:-1;border-left:0;border-bottom:1px solid var(--disp-rule)}
  .live.is-zero{order:0;border-bottom:0}
  .live-full{display:grid;grid-template-columns:minmax(0,auto) minmax(0,1fr);gap:0 32px;align-items:start}
  .live-full>h2,.live-full>.live-n{grid-column:1}
  .live-full>h3,.live-full>.apages,.live-full>.live-foot{grid-column:2}
  .live-full>h3{grid-row:1;margin-top:0}
  .live-full>.apages{grid-row:2 / span 2}
  .live-full>.live-foot{grid-row:4;padding-top:10px}
  .live-full.solo>.live-foot{grid-column:1;grid-row:auto}
  .atlas{grid-template-columns:minmax(0,1fr) 260px}
}
@media (max-width:860px){
  .head,.page-h,.first,.login-main{grid-template-columns:minmax(0,1fr)}
  .head{gap:12px}
  .head .say,.page-h .say{justify-self:start;text-align:left}
  .readout{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
  .ro-t{grid-column:1/-1;border-left:0!important;border-top:1px solid var(--rule-2);padding-left:0!important;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:4px 16px;background:none}
  .ro-t dt{grid-column:1}
  .ro-t dd.num{grid-column:2;grid-row:1 / span 2;margin:0;font-size:48px}
  .ro-t .ro-sub{grid-column:1;margin-top:0}
  .pair,.dgrid{grid-template-columns:minmax(0,1fr)}
  .basis{grid-template-columns:minmax(0,1fr)}
  .views-in{flex-direction:column;align-items:stretch;gap:0}
  .keys{margin:10px 0 12px}
  .keys>a{flex:1;padding:0 6px}
  .atlas{grid-template-columns:minmax(0,1fr)}
  .atlas-list{border-left:0;border-top:1px solid var(--disp-rule)}
  .listen{position:static}
  .promise{order:2}
}
@media (max-width:640px){
  body{font-size:15.5px;padding-bottom:calc(env(safe-area-inset-bottom,0px) + 64px)}
  html{scroll-padding-bottom:84px}
  .bar-in{gap:12px}
  .bar-sep,.switch .dom,.hide-s{display:none}
  .views .tabs{display:none}
  .tabbar{display:block;position:fixed;left:0;right:0;bottom:0;z-index:40;background:var(--paper-hi);border-top:1px solid var(--ink);padding:0 4px env(safe-area-inset-bottom,0px)}
  .tabbar>ul{display:flex}
  .tabbar>ul>li{flex:1;display:flex;min-width:0}
  .tabbar a,.tabbar summary{flex:1;display:flex;align-items:center;justify-content:center;height:56px;padding:0 2px;font-size:13.5px;color:var(--ink-2);text-decoration:none;border-top:2px solid transparent;margin-top:-1px;cursor:pointer;list-style:none;white-space:nowrap}
  .tabbar a[aria-current]{color:var(--ink);font-weight:600;border-top-color:var(--ink)}
  .tabbar details{flex:1;display:flex}
  .tabbar details[open]>summary{color:var(--ink);font-weight:600}
  .tabbar .sheet{position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 57px);background:var(--paper-hi);border-top:1px solid var(--rule-2);padding:6px 16px 10px;box-shadow:0 -18px 30px -18px rgba(0,0,0,.35)}
  .tabbar .sheet a{justify-content:flex-start;height:48px;border-top:0;border-bottom:1px solid var(--rule);font-size:15px;margin:0}
  .tabbar .sheet li:last-child a{border-bottom:0}
  .head,.page-h{padding-top:24px}
  .live-chip{display:inline-flex;align-items:center;gap:8px;justify-self:start;height:34px;padding:0 12px 0 10px;border-radius:17px;background:var(--disp);color:var(--disp-ink-2);font-size:14px;text-decoration:none;box-shadow:0 0 0 1px #000}
  .live-chip b{color:var(--live);font-weight:600;font-variant-numeric:tabular-nums}
  .live-chip.zero b{color:var(--disp-ink-2)}
  .ro{padding-right:14px}
  .ro+.ro{padding-left:16px}
  .ro dd.num,.ro dd.num.long{font-size:clamp(34px,11vw,52px)}
  .ro-sub{font-size:14px}
  .glass{margin:7px 0}
  .scope{padding:16px 14px 12px}
  .live{padding:16px 14px}
  .live.is-zero{padding:10px 14px}
  .live-full{display:flex}
  .readline{font-size:15px}
  .plot{height:190px;margin-right:32px}
  .plot.sparse{margin-right:0}
  .gl span{right:-32px;width:28px}
  .xax{margin-right:32px}
  .xax .opt{display:none}
  .vl{font-size:12px}
  .plot.sparse .vl:not(.pk){display:none}
  .live h3{margin-top:18px}
  .atlas-map{padding:16px 14px 14px}
  .atlas-list{padding:16px 14px}
  .mapbox,.m-legend{display:none}
  .atlas-h{margin-bottom:0}
  .foot{margin-top:48px}
  .foot-in{flex-direction:column}
  .snip pre{padding-right:18px;padding-top:54px}
  .listen .big{font-size:72px}
  .full .pct i{width:64px}
  /* Full breakdown: each row becomes a two-line record, so nothing scrolls sideways. */
  .full .bd,.full .bd thead,.full .bd tbody,.full .bd tfoot{display:block}
  .full .bd tr{display:grid;grid-template-columns:repeat(var(--nc,3),minmax(0,1fr));column-gap:12px;border-bottom:1px solid var(--rule)}
  .full .bd tr>*{height:auto!important;border:0!important;padding:0!important}
  .full .bd thead tr{border-bottom:2px solid var(--ink);padding-bottom:8px}
  .full .bd thead th{white-space:normal}
  .full .bd thead th:first-child,.full .bd tbody th,.full .bd tfoot th{grid-column:1/-1}
  .full .bd tbody th{max-width:none;width:auto}
  .full .bd tbody tr{padding:10px 0}
  .full .bd .lbl{line-height:1.4;padding:0 0 6px;white-space:normal;overflow-wrap:anywhere}
  .full .bd .lbl::before{top:0;bottom:6px}
  .full .bd tfoot tr{padding-top:10px;border:0}
  .full .bd tfoot th{padding-bottom:2px!important}
}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none!important;transition:none!important}
}
html:not(.js) .js-only{display:none}
`;
