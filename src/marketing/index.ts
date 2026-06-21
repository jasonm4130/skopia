/**
 * Stratus — marketing / landing surface.
 *
 * Implements GET "/" — a fully server-rendered landing page matching
 * design/Stratus Marketing.dc.html. The cost calculator and FAQ accordion
 * run as small inline client scripts; no external JS or CSS.
 *
 * Route contract: owns GET "/" only. Never shadows /app, /login, /public, /live.
 */

import { Hono } from "hono";
import type { AppEnv } from "../shared/security-headers";

export const marketing = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Inline client script (calculator + FAQ accordion).
// Kept minimal — no frameworks, no external deps.
// ---------------------------------------------------------------------------
const CLIENT_SCRIPT = `
(function(){
  // Stops cover key tier boundaries: free ceiling ~3M (100k/day WAE * 30), paid $5 up to 10M, overage above.
  var stops=[10000,100000,500000,1000000,3000000,5000000,10000000,50000000,100000000];
  function fmt(n){
    if(n>=1000000)return(n/1000000).toString().replace(/\\.0$/,'')+'M';
    if(n>=1000)return(n/1000)+'K';
    return String(n);
  }
  // Cost model per spec §9:
  //   ≤ 3M/mo  → $0 (Cloudflare free tier: 100k WAE writes/day + 100k Worker requests/day)
  //   3M–10M   → $5 (Workers Paid base plan; WAE 10M + Workers 10M included, no meaningful overage)
  //   > 10M    → $5 + (pv - 10M)/1M * 0.55  (WAE $0.25/M + Workers $0.30/M overage)
  //              yields ~$55 at 100M — within the spec's $50–60 anchor.
  function calcCost(pv){
    if(pv<=3000000)return 0;
    if(pv<=10000000)return 5;
    return Math.round(5+(pv-10000000)/1000000*0.55);
  }
  function updateCalc(idx){
    var pv=stops[idx];
    var cost=calcCost(pv);
    document.getElementById('calc-pv').textContent=fmt(pv);
    document.getElementById('calc-cost').textContent='$'+cost;
    document.getElementById('calc-note').textContent=cost===0
      ? "You're inside Cloudflare's free tier (up to ~3M events/mo) — $0/mo. Stratus is open source, so there's nothing else to pay."
      : cost===5
        ? "You're on the Workers Paid plan ($5/mo base). WAE and Workers capacity up to 10M events/mo are included — no meaningful overage."
        : "Roughly $"+cost+"/mo on Cloudflare Workers + Analytics Engine at this volume. Stratus stays free — you only pay Cloudflare for what you use.";
  }
  var slider=document.getElementById('calc-slider');
  if(slider){
    slider.addEventListener('input',function(){updateCalc(parseInt(this.value,10));});
    updateCalc(parseInt(slider.value,10));
  }

  // FAQ accordion — first item starts open (faqOpen=0 per design)
  document.querySelectorAll('.faq-item').forEach(function(item,i){
    var btn=item.querySelector('.faq-btn');
    var body=item.querySelector('.faq-body');
    var icon=item.querySelector('.faq-icon');
    if(!btn||!body||!icon)return;
    btn.addEventListener('click',function(){
      var open=body.style.display==='block';
      // Close all
      document.querySelectorAll('.faq-body').forEach(function(b){b.style.display='none';});
      document.querySelectorAll('.faq-icon').forEach(function(ic){ic.style.color='#6a7184';ic.style.transform='none';});
      if(!open){
        body.style.display='block';
        icon.style.color='#4d86ff';
        icon.style.transform='rotate(45deg)';
      }
    });
  });
})();
`;

// ---------------------------------------------------------------------------
// FAQ data
// ---------------------------------------------------------------------------
interface FaqItem {
  q: string;
  a: string;
}

const FAQ: FaqItem[] = [
  {
    q: "Where does my data live?",
    a: "In your own Cloudflare account, inside a D1 database you provision. Stratus has no central server and never sees your visitors — the data never leaves your infrastructure.",
  },
  {
    q: "Is it really compliant without a consent banner?",
    a: "Stratus sets no cookies, stores no personal data, and never tracks people across sites — so in most jurisdictions no consent banner is required. As always, confirm your specific obligations with counsel.",
  },
  {
    q: "What does it actually cost to run?",
    a: "The software is free and AGPL-3.0 licensed. You pay Cloudflare directly — $0 on the free tier (up to roughly 3M pageviews/mo), and around $5/mo once you pass that ceiling (the Workers Paid base plan covers up to ~10M pageviews/mo).",
  },
  {
    q: "How big is the tracking script?",
    a: "1.9 KB on the wire. It loads asynchronously, is cache-first, and never blocks rendering — your Lighthouse score won't notice it.",
  },
  {
    q: "Can I migrate from Google Analytics or Plausible?",
    a: "Yes. Import historical data from a CSV export and Stratus maps the common metrics — visitors, pageviews, sources and pages — into your new dashboard.",
  },
  {
    q: "Do I have to manage a database?",
    a: "No. `stratus deploy` provisions Cloudflare D1 for you. There's nothing to patch, scale, or back up — Cloudflare handles the infrastructure.",
  },
];

// ---------------------------------------------------------------------------
// HTML builder helpers
// ---------------------------------------------------------------------------
function faqItems(): string {
  return FAQ.map(
    ({ q, a }, i) => `
    <div class="faq-item" style="background:#12151d;border:1px solid #20252f;border-radius:12px;overflow:hidden;">
      <div class="faq-btn" style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px;cursor:pointer;user-select:none;">
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:500;font-size:16.5px;color:#fff;">${escHtml(q)}</span>
        <span class="faq-icon" style="font-family:'Space Grotesk',sans-serif;font-size:22px;${i === 0 ? "color:#4d86ff;transform:rotate(45deg);" : "color:#6a7184;"}transition:transform .2s,color .2s;line-height:1;">+</span>
      </div>
      <div class="faq-body" style="display:${i === 0 ? "block" : "none"};padding:0 24px 22px;font-size:14.5px;line-height:1.65;color:#9aa1b2;">${escHtml(a)}</div>
    </div>`,
  ).join("\n");
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Full landing page HTML
// ---------------------------------------------------------------------------
function landingPage(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stratus — Privacy-first analytics on Cloudflare</title>
<meta name="description" content="Open-source, cookieless web analytics that runs on your own Cloudflare account. One command to deploy.">
<style nonce="${nonce}">
*{box-sizing:border-box;}
html{scroll-behavior:smooth;}
html,body{margin:0;background:#0a0c11;}
a{text-decoration:none;color:inherit;}
@keyframes stratusPulse{0%,100%{opacity:1;}50%{opacity:.3;}}
input[type=range]{-webkit-appearance:none;appearance:none;height:6px;border-radius:4px;background:#20252f;outline:none;}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:20px;height:20px;border-radius:50%;background:#4d86ff;cursor:pointer;border:3px solid #0a0c11;box-shadow:0 0 0 1px #4d86ff;}
input[type=range]::-moz-range-thumb{width:20px;height:20px;border-radius:50%;background:#4d86ff;cursor:pointer;border:3px solid #0a0c11;}
::-webkit-scrollbar{width:11px;}
::-webkit-scrollbar-thumb{background:#232838;border-radius:6px;}
::-webkit-scrollbar-track{background:#0a0c11;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/space-grotesk-400-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/space-grotesk-400-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/space-grotesk-500-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/space-grotesk-500-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/space-grotesk-600-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/space-grotesk-600-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/space-grotesk-700-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Space Grotesk';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/space-grotesk-700-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/hanken-grotesk-400-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/hanken-grotesk-400-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/hanken-grotesk-500-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/hanken-grotesk-500-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/hanken-grotesk-600-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/hanken-grotesk-600-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/hanken-grotesk-700-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'Hanken Grotesk';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/hanken-grotesk-700-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/jetbrains-mono-400-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/jetbrains-mono-400-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/jetbrains-mono-500-latin-ext.woff2') format('woff2');unicode-range:U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF;}
@font-face{font-family:'JetBrains Mono';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/jetbrains-mono-500-latin.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD;}
</style>
</head>
<body style="background:#0a0c11;color:#e8eaef;font-family:'Hanken Grotesk',sans-serif;min-height:100vh;">

<!-- ===== NAV ===== -->
<div style="position:sticky;top:0;z-index:50;background:rgba(10,12,17,.78);backdrop-filter:blur(14px);border-bottom:1px solid #161a22;">
  <div style="max-width:1180px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:18px 32px;">
    <a href="/" style="display:flex;align-items:center;gap:11px;">
      <div style="display:flex;flex-direction:column;gap:2.5px;">
        <div style="width:18px;height:2.5px;border-radius:2px;background:#4d86ff;"></div>
        <div style="width:13px;height:2.5px;border-radius:2px;background:#4d86ff;opacity:.7;"></div>
        <div style="width:16px;height:2.5px;border-radius:2px;background:#4d86ff;opacity:.45;"></div>
      </div>
      <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:19px;letter-spacing:-.01em;color:#fff;">Stratus</span>
    </a>
    <div style="display:flex;align-items:center;gap:30px;font-size:14px;color:#9097a8;">
      <a href="#features" style="cursor:pointer;">Features</a>
      <a href="#how" style="cursor:pointer;">How it works</a>
      <a href="#pricing" style="cursor:pointer;">Pricing</a>
      <a href="#faq" style="cursor:pointer;">FAQ</a>
      <a href="#" style="display:flex;align-items:center;gap:7px;border:1px solid #262b38;padding:8px 13px;border-radius:8px;color:#cfd4e0;"><span style="color:#ffce4d;">&#9733;</span> GitHub</a>
      <a href="/login" style="background:#4d86ff;color:#fff;padding:10px 18px;border-radius:8px;font-weight:600;font-size:13.5px;cursor:pointer;">Deploy free</a>
    </div>
  </div>
</div>

<!-- ===== HERO ===== -->
<div style="max-width:1180px;margin:0 auto;display:flex;gap:60px;padding:96px 32px 84px;position:relative;">
  <div style="position:absolute;top:-120px;left:300px;width:640px;height:600px;background:radial-gradient(circle,rgba(77,134,255,.15),transparent 62%);pointer-events:none;"></div>
  <div style="flex:1;position:relative;padding-top:8px;">
    <div style="display:inline-flex;align-items:center;gap:8px;font-family:'JetBrains Mono',monospace;font-size:12px;color:#8fb0ff;background:rgba(77,134,255,.1);padding:7px 13px;border-radius:20px;margin-bottom:32px;">open source &middot; runs on your cloudflare</div>
    <h1 style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:64px;line-height:1.0;letter-spacing:-.035em;color:#fff;margin:0 0 26px;">Your analytics.<br>One command.<br><span style="color:#6a7184;">Zero ops.</span></h1>
    <p style="font-size:19px;line-height:1.6;color:#9aa1b2;max-width:452px;margin:0 0 38px;">Stratus deploys to your own Cloudflare account in one command &mdash; no database to babysit, no cookies, no consent banner. You own every row of data.</p>
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:46px;">
      <a href="/login" style="background:#4d86ff;color:#fff;padding:15px 26px;border-radius:10px;font-weight:600;font-size:16px;box-shadow:0 8px 26px rgba(77,134,255,.32);cursor:pointer;">Deploy to Cloudflare &#8594;</a>
      <a href="/app" style="display:flex;align-items:center;gap:8px;padding:15px 22px;border-radius:10px;font-weight:600;font-size:16px;color:#e8eaef;border:1px solid #2a3040;cursor:pointer;">Live demo</a>
    </div>
    <div style="display:flex;gap:30px;">
      <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:#9aa1b2;"><span style="color:#2bd888;font-weight:700;">&#10003;</span> Cookieless</span>
      <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:#9aa1b2;"><span style="color:#2bd888;font-weight:700;">&#10003;</span> No consent banner</span>
      <span style="display:flex;align-items:center;gap:8px;font-size:14px;color:#9aa1b2;"><span style="color:#2bd888;font-weight:700;">&#10003;</span> AGPL-3.0 licensed</span>
    </div>
  </div>
  <div style="flex:none;width:462px;align-self:center;position:relative;">
    <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;box-shadow:0 36px 80px -30px rgba(0,0,0,.85);overflow:hidden;">
      <div style="display:flex;align-items:center;gap:7px;padding:15px 18px;border-bottom:1px solid #20252f;">
        <span style="width:11px;height:11px;border-radius:50%;background:#2c313d;"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#2c313d;"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#2c313d;"></span>
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#6a7184;margin-left:8px;">~/my-site</span>
      </div>
      <div style="padding:24px 24px 28px;font-family:'JetBrains Mono',monospace;font-size:13.5px;line-height:2;">
        <div style="color:#6a7184;"># deploy to your own account</div>
        <div style="color:#e7e9ee;"><span style="color:#2bd888;">$</span> npx stratus deploy</div>
        <div style="color:#6a7184;margin-top:2px;">&nbsp;&nbsp;&#10003; Worker live</div>
        <div style="color:#6a7184;">&nbsp;&nbsp;&#10003; D1 database ready</div>
        <div style="color:#6a7184;">&nbsp;&nbsp;&#10003; done in <span style="color:#9fb4ff;">8.2s</span></div>
        <div style="color:#6a7184;margin-top:20px;"># drop in the snippet</div>
        <div style="color:#9fb4ff;word-break:break-all;">&lt;script src=<span style="color:#e7e9ee;">"https://you.dev/s.js"</span> defer&gt;&lt;/script&gt;</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:22px;padding-top:18px;border-top:1px solid #20252f;">
          <span style="color:#6a7184;">script size</span>
          <span style="color:#fff;background:#4d86ff;padding:4px 11px;border-radius:6px;font-weight:500;">1.9 KB</span>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ===== TRUST STRIP ===== -->
<div style="border-top:1px solid #161a22;border-bottom:1px solid #161a22;background:#0c0e14;">
  <div style="max-width:1180px;margin:0 auto;display:flex;align-items:center;gap:40px;padding:26px 32px;">
    <span style="font-family:'JetBrains Mono',monospace;font-size:11.5px;text-transform:uppercase;letter-spacing:.14em;color:#6a7184;white-space:nowrap;">Built on the Cloudflare stack</span>
    <div style="display:flex;gap:12px;flex-wrap:wrap;">
      <span style="font-size:13px;color:#9aa1b2;border:1px solid #20252f;padding:7px 14px;border-radius:8px;">Workers</span>
      <span style="font-size:13px;color:#9aa1b2;border:1px solid #20252f;padding:7px 14px;border-radius:8px;">D1</span>
      <span style="font-size:13px;color:#9aa1b2;border:1px solid #20252f;padding:7px 14px;border-radius:8px;">Pages</span>
      <span style="font-size:13px;color:#9aa1b2;border:1px solid #20252f;padding:7px 14px;border-radius:8px;">R2</span>
      <span style="font-size:13px;color:#9aa1b2;border:1px solid #20252f;padding:7px 14px;border-radius:8px;">KV</span>
    </div>
    <span style="margin-left:auto;font-size:13.5px;color:#8b92a4;white-space:nowrap;">Open source &middot; AGPL-3.0</span>
  </div>
</div>

<!-- ===== HOW IT WORKS ===== -->
<div id="how" style="max-width:1180px;margin:0 auto;padding:104px 32px;">
  <div style="font-family:'JetBrains Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:#6a7184;margin-bottom:14px;">Deploy in under a minute</div>
  <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:38px;letter-spacing:-.025em;color:#fff;margin:0 0 60px;max-width:600px;line-height:1.08;">No servers, no database, no maintenance window.</h2>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:52px;">
    <div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#4d86ff;margin-bottom:18px;">01</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:19px;color:#fff;margin-bottom:11px;">Run one command</div>
      <p style="font-size:15px;line-height:1.65;color:#8b92a4;margin:0;">Stratus provisions a Worker and a D1 database in your Cloudflare account. Nothing leaves your infrastructure.</p>
    </div>
    <div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#4d86ff;margin-bottom:18px;">02</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:19px;color:#fff;margin-bottom:11px;">Add the 1.9 KB snippet</div>
      <p style="font-size:15px;line-height:1.65;color:#8b92a4;margin:0;">One script tag, no cookies and no consent banner. It loads in the background and never blocks your page.</p>
    </div>
    <div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#4d86ff;margin-bottom:18px;">03</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:19px;color:#fff;margin-bottom:11px;">Watch it in realtime</div>
      <p style="font-size:15px;line-height:1.65;color:#8b92a4;margin:0;">Visitors appear the moment they land. Your data, your dashboard &mdash; free up to ~3M pageviews/mo, then ~$5/mo around 10M.</p>
    </div>
  </div>
</div>

<!-- ===== PRODUCT SHOT ===== -->
<div style="background:#0c0e14;border-top:1px solid #161a22;border-bottom:1px solid #161a22;">
  <div style="max-width:1180px;margin:0 auto;padding:90px 32px;">
    <div style="text-align:center;margin-bottom:48px;">
      <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:34px;letter-spacing:-.02em;color:#fff;margin:0 0 12px;">A dashboard that shows what matters.</h2>
      <p style="font-size:16px;color:#8b92a4;margin:0;">Nothing you don&apos;t. Realtime, top pages, sources and geography &mdash; clean and fast.</p>
    </div>
    <div style="border:1px solid #20252f;border-radius:14px;overflow:hidden;box-shadow:0 40px 90px -40px rgba(0,0,0,.9);background:#0a0c11;">
      <div style="display:flex;align-items:center;gap:7px;padding:13px 16px;background:#12151d;border-bottom:1px solid #20252f;">
        <span style="width:11px;height:11px;border-radius:50%;background:#2c313d;"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#2c313d;"></span>
        <span style="width:11px;height:11px;border-radius:50%;background:#2c313d;"></span>
        <span style="margin-left:14px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#6a7184;background:#0d1016;border:1px solid #20252f;padding:4px 12px;border-radius:6px;">app.you.dev/stratus</span>
      </div>
      <div style="padding:26px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:17px;color:#fff;">Overview</div>
          <span style="display:flex;align-items:center;gap:7px;font-size:12px;color:#2bd888;background:rgba(43,216,136,.1);padding:6px 12px;border-radius:8px;">
            <span style="width:7px;height:7px;border-radius:50%;background:#2bd888;animation:stratusPulse 1.6s infinite;"></span> 24 online
          </span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px;">
          <div style="background:#12151d;border:1px solid #20252f;border-radius:10px;padding:15px 17px;">
            <div style="font-size:12px;color:#8b92a4;margin-bottom:8px;">Visitors</div>
            <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:24px;color:#fff;">48.2K</div>
          </div>
          <div style="background:#12151d;border:1px solid #20252f;border-radius:10px;padding:15px 17px;">
            <div style="font-size:12px;color:#8b92a4;margin-bottom:8px;">Pageviews</div>
            <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:24px;color:#fff;">91.7K</div>
          </div>
          <div style="background:#12151d;border:1px solid #20252f;border-radius:10px;padding:15px 17px;">
            <div style="font-size:12px;color:#8b92a4;margin-bottom:8px;">Single-Page Visits</div>
            <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:24px;color:#fff;">38%</div>
          </div>
          <div style="background:#12151d;border:1px solid #20252f;border-radius:10px;padding:15px 17px;">
            <div style="font-size:12px;color:#8b92a4;margin-bottom:8px;">Avg. time</div>
            <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:24px;color:#fff;">2m14s</div>
          </div>
        </div>
        <div style="background:#12151d;border:1px solid #20252f;border-radius:10px;padding:20px;">
          <svg viewBox="0 0 1080 220" preserveAspectRatio="none" style="width:100%;height:200px;display:block;">
            <defs>
              <linearGradient id="shot" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stop-color="#4d86ff" stop-opacity=".3"/>
                <stop offset="1" stop-color="#4d86ff" stop-opacity="0"/>
              </linearGradient>
            </defs>
            <line x1="0" y1="50" x2="1080" y2="50" stroke="#1a1f2a"/>
            <line x1="0" y1="110" x2="1080" y2="110" stroke="#1a1f2a"/>
            <line x1="0" y1="170" x2="1080" y2="170" stroke="#1a1f2a"/>
            <path d="M0,150 L90,132 L180,162 L270,104 L360,128 L450,82 L540,114 L630,64 L720,98 L810,52 L900,86 L990,44 L1080,72 L1080,190 L0,190 Z" fill="url(#shot)"/>
            <path d="M0,150 L90,132 L180,162 L270,104 L360,128 L450,82 L540,114 L630,64 L720,98 L810,52 L900,86 L990,44 L1080,72" fill="none" stroke="#4d86ff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
          </svg>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ===== FEATURES (bento) ===== -->
<div id="features" style="max-width:1180px;margin:0 auto;padding:104px 32px;">
  <div style="font-family:'JetBrains Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:#6a7184;margin-bottom:14px;">Why Stratus</div>
  <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:38px;letter-spacing:-.025em;color:#fff;margin:0 0 52px;max-width:560px;line-height:1.08;">Yours to own. Effortless to run.</h2>
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;">
    <div style="grid-column:span 2;background:linear-gradient(135deg,#12151d,#141a26);border:1px solid #2a3550;border-radius:14px;padding:30px 32px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:-60px;right:-30px;width:240px;height:240px;background:radial-gradient(circle,rgba(77,134,255,.16),transparent 65%);"></div>
      <div style="width:32px;height:32px;border-radius:8px;background:#4d86ff;margin-bottom:20px;"></div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:20px;color:#fff;margin-bottom:10px;">Own every row of data</div>
      <p style="font-size:14.5px;line-height:1.6;color:#9aa1b2;margin:0;max-width:420px;">Your analytics live in your own Cloudflare D1 database &mdash; not on someone else&apos;s server. Export it, query it, or delete it whenever you like. No lock-in, ever.</p>
    </div>
    <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:28px;">
      <div style="width:30px;height:30px;border-radius:50%;border:6px solid #2bd888;margin-bottom:20px;"></div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:9px;">Open source</div>
      <p style="font-size:14px;line-height:1.6;color:#8b92a4;margin:0;">AGPL-3.0 licensed. Read it, fork it, audit it &mdash; every line is on GitHub.</p>
    </div>
    <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:28px;">
      <div style="width:30px;height:30px;border-radius:7px;border:2px solid #4d86ff;transform:rotate(45deg);margin-bottom:20px;"></div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:9px;">Cookieless by design</div>
      <p style="font-size:14px;line-height:1.6;color:#8b92a4;margin:0;">No cookies, no fingerprinting, no cross-site IDs &mdash; so no consent banner.</p>
    </div>
    <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:28px;">
      <div style="font-family:'JetBrains Mono',monospace;font-weight:500;font-size:15px;color:#9fb4ff;background:rgba(77,134,255,.1);display:inline-block;padding:6px 11px;border-radius:7px;margin-bottom:20px;">1.9 KB</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:9px;">Featherweight script</div>
      <p style="font-size:14px;line-height:1.6;color:#8b92a4;margin:0;">Async and cache-first. It never blocks paint or slows your Lighthouse score.</p>
    </div>
    <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:28px;">
      <div style="width:30px;height:30px;border-radius:7px;background:#0d1016;border:1px solid #2bd888;display:flex;align-items:center;justify-content:center;margin-bottom:20px;">
        <span style="width:8px;height:8px;border-radius:50%;background:#2bd888;animation:stratusPulse 1.6s infinite;"></span>
      </div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:9px;">Realtime</div>
      <p style="font-size:14px;line-height:1.6;color:#8b92a4;margin:0;">See visitors the second they land, streamed straight from the edge.</p>
    </div>
    <div style="background:#12151d;border:1px solid #20252f;border-radius:14px;padding:28px;">
      <div style="display:flex;flex-direction:column;gap:3px;margin-bottom:20px;">
        <div style="width:24px;height:3px;border-radius:2px;background:#7a5cff;"></div>
        <div style="width:17px;height:3px;border-radius:2px;background:#7a5cff;opacity:.7;"></div>
        <div style="width:21px;height:3px;border-radius:2px;background:#7a5cff;opacity:.45;"></div>
      </div>
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:18px;color:#fff;margin-bottom:9px;">Zero ops</div>
      <p style="font-size:14px;line-height:1.6;color:#8b92a4;margin:0;">No database to babysit, no servers to patch, no backups to schedule.</p>
    </div>
  </div>
</div>

<!-- ===== COMPARISON ===== -->
<div style="background:#0c0e14;border-top:1px solid #161a22;border-bottom:1px solid #161a22;">
  <div style="max-width:1180px;margin:0 auto;padding:96px 32px;">
    <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:34px;letter-spacing:-.02em;color:#fff;margin:0 0 40px;text-align:center;">The only one that&apos;s both yours and effortless.</h2>
    <div style="background:#12151d;border:1px solid #20252f;border-radius:16px;overflow:hidden;">
      <div style="display:grid;grid-template-columns:1.7fr 1fr 1fr 1fr;">
        <div style="padding:22px 28px;border-bottom:1px solid #20252f;"></div>
        <div style="padding:22px 16px;border-bottom:1px solid #20252f;border-left:1px solid #20252f;text-align:center;background:rgba(77,134,255,.07);">
          <div style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;color:#9fb4ff;">Stratus</div>
        </div>
        <div style="padding:22px 16px;border-bottom:1px solid #20252f;border-left:1px solid #20252f;text-align:center;">
          <div style="font-weight:600;font-size:14px;color:#9aa1b2;">Hosted SaaS</div>
        </div>
        <div style="padding:22px 16px;border-bottom:1px solid #20252f;border-left:1px solid #20252f;text-align:center;">
          <div style="font-weight:600;font-size:14px;color:#9aa1b2;">Other self-host</div>
        </div>

        <div style="padding:18px 28px;border-bottom:1px solid #161a22;font-size:14.5px;color:#cfd4e0;">You own the raw data</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;background:rgba(77,134,255,.04);color:#2bd888;font-weight:700;">&#10003;</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;color:#454b59;font-weight:700;">&#10007;</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;color:#2bd888;font-weight:700;">&#10003;</div>

        <div style="padding:18px 28px;border-bottom:1px solid #161a22;font-size:14.5px;color:#cfd4e0;">No database to run</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;background:rgba(77,134,255,.04);color:#2bd888;font-weight:700;">&#10003;</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;color:#2bd888;font-weight:700;">&#10003;</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;color:#454b59;font-weight:700;">&#10007;</div>

        <div style="padding:18px 28px;border-bottom:1px solid #161a22;font-size:14.5px;color:#cfd4e0;">Cookieless &middot; no consent banner</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;background:rgba(77,134,255,.04);color:#2bd888;font-weight:700;">&#10003;</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;color:#2bd888;font-weight:700;">&#10003;</div>
        <div style="padding:18px;border-bottom:1px solid #161a22;border-left:1px solid #20252f;text-align:center;color:#6a7184;font-weight:500;font-size:13px;">varies</div>

        <div style="padding:18px 28px;font-size:14.5px;color:#cfd4e0;">Cost at scale</div>
        <div style="padding:18px;border-left:1px solid #20252f;text-align:center;background:rgba(77,134,255,.04);font-family:'JetBrains Mono',monospace;font-size:13px;color:#fff;">~$5/mo</div>
        <div style="padding:18px;border-left:1px solid #20252f;text-align:center;font-family:'JetBrains Mono',monospace;font-size:13px;color:#9aa1b2;">$19&ndash;90</div>
        <div style="padding:18px;border-left:1px solid #20252f;text-align:center;font-family:'JetBrains Mono',monospace;font-size:13px;color:#9aa1b2;">server +</div>
      </div>
    </div>
  </div>
</div>

<!-- ===== PRICING / CALCULATOR ===== -->
<div id="pricing" style="max-width:1180px;margin:0 auto;padding:104px 32px;">
  <div style="text-align:center;margin-bottom:56px;">
    <div style="font-family:'JetBrains Mono',monospace;font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:#6a7184;margin-bottom:14px;">Pricing</div>
    <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:38px;letter-spacing:-.025em;color:#fff;margin:0 0 12px;">Stratus is free. You just pay Cloudflare.</h2>
    <p style="font-size:16px;color:#8b92a4;margin:0;">The software is AGPL-3.0 licensed and open source. Your only bill comes from Cloudflare &mdash; and it&apos;s tiny.</p>
  </div>
  <div style="display:flex;gap:18px;align-items:stretch;">
    <!-- self host card -->
    <div style="flex:1;background:#12151d;border:1px solid #2a3550;border-radius:16px;padding:34px;">
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:17px;color:#9fb4ff;margin-bottom:8px;">Self-host</div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:6px;">
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:46px;color:#fff;letter-spacing:-.02em;">$0</span>
        <span style="font-size:15px;color:#8b92a4;">+ your Cloudflare usage</span>
      </div>
      <p style="font-size:14px;color:#8b92a4;line-height:1.6;margin:0 0 24px;">Everything, forever. Deploy to your own account and own the whole stack.</p>
      <a href="/login" style="display:block;text-align:center;background:#4d86ff;color:#fff;padding:13px;border-radius:10px;font-weight:600;font-size:15px;cursor:pointer;margin-bottom:24px;">Deploy to Cloudflare &#8594;</a>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <span style="display:flex;align-items:center;gap:10px;font-size:14px;color:#cfd4e0;"><span style="color:#2bd888;font-weight:700;">&#10003;</span> Unlimited sites &amp; events</span>
        <span style="display:flex;align-items:center;gap:10px;font-size:14px;color:#cfd4e0;"><span style="color:#2bd888;font-weight:700;">&#10003;</span> Full data ownership &amp; export</span>
        <span style="display:flex;align-items:center;gap:10px;font-size:14px;color:#cfd4e0;"><span style="color:#2bd888;font-weight:700;">&#10003;</span> Realtime, geography, events</span>
        <span style="display:flex;align-items:center;gap:10px;font-size:14px;color:#cfd4e0;"><span style="color:#2bd888;font-weight:700;">&#10003;</span> Community support on GitHub</span>
      </div>
    </div>
    <!-- calculator card -->
    <div style="flex:1.15;background:linear-gradient(150deg,#0e1119,#101522);border:1px solid #20252f;border-radius:16px;padding:34px;">
      <div style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:17px;color:#fff;margin-bottom:6px;">Estimate your Cloudflare bill</div>
      <p style="font-size:13.5px;color:#8b92a4;margin:0 0 30px;">Drag to your monthly pageviews. Stratus itself stays $0.</p>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:24px;">
        <div>
          <div style="font-size:13px;color:#8b92a4;margin-bottom:6px;">Monthly pageviews</div>
          <div id="calc-pv" style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:30px;color:#fff;">1M</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;color:#8b92a4;margin-bottom:6px;">Est. Cloudflare / mo</div>
          <div id="calc-cost" style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:30px;color:#2bd888;">$0</div>
        </div>
      </div>
      <input id="calc-slider" type="range" min="0" max="8" step="1" value="3" style="width:100%;margin-bottom:14px;">
      <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:11px;color:#6a7184;margin-bottom:28px;">
        <span>10K</span><span>3M</span><span>100M</span>
      </div>
      <div id="calc-note" style="background:#0a0c11;border:1px solid #20252f;border-radius:11px;padding:18px 20px;font-size:13.5px;color:#9aa1b2;line-height:1.6;">
        You&apos;re comfortably inside Cloudflare&apos;s free tier &mdash; $0/mo. Stratus is open source, so there&apos;s nothing else to pay.
      </div>
    </div>
  </div>
</div>

<!-- ===== FAQ ===== -->
<div id="faq" style="background:#0c0e14;border-top:1px solid #161a22;">
  <div style="max-width:820px;margin:0 auto;padding:96px 32px;">
    <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:34px;letter-spacing:-.02em;color:#fff;margin:0 0 44px;text-align:center;">Questions, answered.</h2>
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${faqItems()}
    </div>
  </div>
</div>

<!-- ===== FINAL CTA ===== -->
<div style="max-width:1180px;margin:0 auto;padding:110px 32px;">
  <div style="background:linear-gradient(135deg,#101626,#0d1119);border:1px solid #2a3550;border-radius:20px;padding:72px 48px;text-align:center;position:relative;overflow:hidden;">
    <div style="position:absolute;top:-140px;left:50%;transform:translateX(-50%);width:640px;height:480px;background:radial-gradient(circle,rgba(77,134,255,.18),transparent 64%);pointer-events:none;"></div>
    <div style="position:relative;">
      <h2 style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:46px;letter-spacing:-.03em;color:#fff;margin:0 0 18px;line-height:1.05;">Own your analytics in 60 seconds.</h2>
      <p style="font-size:18px;color:#9aa1b2;margin:0 0 36px;">One command. Your Cloudflare. Zero ops.</p>
      <div style="display:flex;align-items:center;justify-content:center;gap:14px;">
        <a href="/login" style="background:#4d86ff;color:#fff;padding:15px 28px;border-radius:10px;font-weight:600;font-size:16px;box-shadow:0 8px 26px rgba(77,134,255,.34);cursor:pointer;">Deploy to Cloudflare &#8594;</a>
        <a href="/app" style="padding:15px 24px;border-radius:10px;font-weight:600;font-size:16px;color:#e8eaef;border:1px solid #2a3040;cursor:pointer;">See the live demo</a>
      </div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:13px;color:#6a7184;margin-top:30px;">$ npx stratus deploy</div>
    </div>
  </div>
</div>

<!-- ===== FOOTER ===== -->
<div style="border-top:1px solid #161a22;background:#0a0c11;">
  <div style="max-width:1180px;margin:0 auto;display:flex;justify-content:space-between;padding:44px 32px;flex-wrap:wrap;gap:32px;">
    <div style="max-width:280px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
        <div style="display:flex;flex-direction:column;gap:2px;">
          <div style="width:15px;height:2px;border-radius:2px;background:#4d86ff;"></div>
          <div style="width:11px;height:2px;border-radius:2px;background:#4d86ff;opacity:.7;"></div>
          <div style="width:13px;height:2px;border-radius:2px;background:#4d86ff;opacity:.45;"></div>
        </div>
        <span style="font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;color:#fff;">Stratus</span>
      </div>
      <p style="font-size:13.5px;color:#6a7184;line-height:1.6;margin:0;">Open-source, privacy-first web analytics that runs on your own Cloudflare account.</p>
    </div>
    <div style="display:flex;gap:64px;">
      <div style="display:flex;flex-direction:column;gap:11px;">
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#6a7184;margin-bottom:4px;">Product</span>
        <a href="#features" style="font-size:13.5px;color:#9aa1b2;">Features</a>
        <a href="#pricing" style="font-size:13.5px;color:#9aa1b2;">Pricing</a>
        <a href="/app" style="font-size:13.5px;color:#9aa1b2;">Live demo</a>
      </div>
      <div style="display:flex;flex-direction:column;gap:11px;">
        <span style="font-family:'JetBrains Mono',monospace;font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#6a7184;margin-bottom:4px;">Open source</span>
        <a href="#" style="font-size:13.5px;color:#9aa1b2;">GitHub</a>
        <a href="#" style="font-size:13.5px;color:#9aa1b2;">Documentation</a>
        <a href="#" style="font-size:13.5px;color:#9aa1b2;">Changelog</a>
      </div>
    </div>
  </div>
  <div style="border-top:1px solid #161a22;">
    <div style="max-width:1180px;margin:0 auto;display:flex;justify-content:space-between;padding:20px 32px;font-size:12.5px;color:#5a6072;">
      <span>&copy; 2026 Stratus &middot; AGPL-3.0 licensed</span>
      <span style="font-family:'JetBrains Mono',monospace;">cookieless &middot; no consent banner required</span>
    </div>
  </div>
</div>

<script nonce="${nonce}">${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Route: GET /
// ---------------------------------------------------------------------------
marketing.get("/", (c) => {
  const nonce = c.get("nonce");
  return c.html(landingPage(nonce), 200);
});
