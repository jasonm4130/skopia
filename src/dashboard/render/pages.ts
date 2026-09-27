/** Skopia — standalone pages: login, setup, not-configured, "no sites", and first run. */

import type { SiteRow } from "../../shared/types";
import { esc } from "./html";
import { htmlDoc, INSTALL_GUIDE_URL, MARK } from "./layout";

/**
 * Signed in, but no site is registered yet. Sites are added out-of-band with
 * wrangler (there is no add-site UI), so the page says exactly how.
 */
export function noSitesPage(nonce: string): string {
  const cmd = `wrangler d1 execute skopia --remote --command "INSERT INTO sites (id,name,domain) VALUES ('my-site','My Site','example.com')"`;
  return htmlDoc(
    "No sites",
    `<a class="skip" href="#main">Skip to content</a>
<header class="bar"><div class="wrap bar-in">
  <a class="brand" href="/app">${MARK}Skopia</a>
  <div class="bar-end"><a class="hide-s" href="${INSTALL_GUIDE_URL}">Install guide</a><a href="/logout">Sign out</a></div>
</div></header>
<main id="main" class="wrap">
  <div class="first">
    <section aria-labelledby="first-h">
      <h1 id="first-h">No sites tracked yet. Register one and it shows up here.</h1>
      <p class="say">Skopia is deployed and you are signed in. Sites are added from the command line; there is no add-site screen.</p>
      <ol class="steps">
        <li><h2>Register a site in D1</h2>
          <p>Pick an id; the snippet on your site refers to it as <code>data-site</code>.</p>
          <div class="snip"><pre id="snippet"><code>${esc(cmd)}</code></pre>
          <button class="btn btn-quiet js-only" type="button" data-copy="snippet">Copy</button></div>
        </li>
        <li><h2>Reload this page</h2>
          <p>The new site opens with the snippet to paste into its pages.</p></li>
      </ol>
      <p class="trouble">The <a href="${INSTALL_GUIDE_URL}">install guide</a> covers the whole setup, including share links.</p>
    </section>
  </div>
</main>
<footer class="foot"><div class="wrap foot-in"><span><b>Running on your Worker.</b> Your data stays in your Cloudflare account.</span><span>Times are UTC.</span></div></footer>`,
    nonce,
  );
}

// ---------------------------------------------------------------------------
// First run: a site with no pageviews yet
// ---------------------------------------------------------------------------

/**
 * The Overview body for a site with no pageviews in the last 90 days: the
 * snippet (pointed at this Worker's own origin) and a static "Listening"
 * glass. dash-live.js updates the count and reveals the "arrived" link when
 * the first visitor shows up. No blinking cursor, no animation.
 */
export function firstRunContent(site: SiteRow, origin: string, visitors: number): string {
  const snippet = `&lt;script defer
  <span class="at">src=</span>"${esc(origin)}/skopia.js"
  <span class="at">data-site=</span>"${esc(site.id)}"
  <span class="at">data-endpoint=</span>"${esc(origin)}/e"&gt;&lt;/script&gt;`;
  const zero = visitors === 0;
  return `<div class="first">
    <section aria-labelledby="first-h">
      <h1 id="first-h">No pageviews yet. Add the snippet and the first one shows up here.</h1>
      <p class="say">Skopia is deployed and listening on this Worker. It needs one line on your site to start counting.</p>
      <ol class="steps">
        <li><h2>Paste this into your site&rsquo;s &lt;head&gt;</h2>
          <p>On every page you want counted. It is under 2&nbsp;KB and sets no cookies.</p>
          <div class="snip"><pre id="snippet"><code>${snippet}</code></pre>
          <button class="btn btn-quiet js-only" type="button" data-copy="snippet">Copy</button></div>
        </li>
        <li><h2>Deploy your site, then open one of its pages</h2>
          <p>A normal browser window is fine. Your own visit is enough to test it.</p></li>
        <li><h2>Watch the display on this page</h2>
          <p>Online now counts you within a few seconds. Daily totals follow shortly after; reload and this page turns into your overview.</p></li>
      </ol>
      <p class="trouble">Nothing after a minute? Check that <code>data-endpoint</code> points at this Worker, not at your own site; without it the snippet sends to <code>/e</code> on the page&rsquo;s own domain. The <a href="${INSTALL_GUIDE_URL}">install guide</a> covers the other causes.</p>
    </section>
    <section class="glass listen" id="live" aria-labelledby="live-h">
      <h2 id="live-h"><span class="beacon" aria-hidden="true"></span>Listening${site.domain ? ` <span class="dom">${esc(site.domain)}</span>` : ""}</h2>
      <p class="big num"><span class="odo${zero ? " zero" : ""}" data-odo aria-hidden="true">${visitors}</span></p>
      <p class="sr-only" role="status" id="live-say">${visitors} ${visitors === 1 ? "visitor" : "visitors"} online now</p>
      <p class="wait">Online now, last 5 minutes. <b class="js-status">Count at page load.</b></p>
      <p class="arrived" id="arrived" hidden>First pageview received. <a class="more" href="/app?site=${encodeURIComponent(site.id)}">Open your overview <span aria-hidden="true">&rarr;</span></a></p>
    </section>
  </div>`;
}

// ---------------------------------------------------------------------------
// Login / setup / not-configured: the bare casing, no nav
// ---------------------------------------------------------------------------

/** The standalone casing: brand top line, the page, a footer plate. */
function standalone(title: string, main: string, nonce: string, solo = false): string {
  return htmlDoc(
    title,
    `<div class="login">
  <header class="wrap login-top"><span class="brand">${MARK}Skopia</span></header>
  <main id="main" class="wrap login-main${solo ? " solo" : ""}">
${main}
  </main>
  <footer class="foot"><div class="wrap foot-in"><span>Self-hosted Skopia. Times on the dashboard are UTC.</span><span><a href="https://skopia.dev">skopia.dev</a></span></div></footer>
</div>`,
    nonce,
  );
}

/** What this deploy keeps — each line is true of the code, not aspirational. */
const PROMISE = `<aside class="glass promise" aria-labelledby="promise-h">
      <h2 id="promise-h">What this instance keeps</h2>
      <ul>
        <li><b>Everything stays in your Cloudflare account.</b><span>The Worker, D1 database and Analytics Engine dataset behind this page belong to this deploy. Nobody else, including the Skopia project, can read them.</span></li>
        <li><b>No cookies and no stored IP addresses.</b><span>A visitor is a keyed hash of IP and browser with a salt that changes every day, so nobody can be followed from one day to the next.</span></li>
        <li><b>Raw events expire after 90 days.</b><span>Cloudflare caps raw Analytics Engine data at 90 days. The dashboard reads daily totals built from them.</span></li>
        <li><b>Shared views need no sign-in.</b><span>Anyone with a share link sees a read-only copy with no controls.</span></li>
      </ul>
    </aside>`;

export function loginPage(nonce: string, error?: string, email?: string): string {
  const errorHtml = error ? `<p class="err" id="login-error" role="alert">${esc(error)}</p>` : "";
  // On a failed POST, mark the fields invalid and point them at the error
  // banner (WCAG 3.3.1), and keep the entered email so it isn't retyped.
  const invalid = error ? ` aria-invalid="true" aria-describedby="login-error"` : "";
  const emailVal = email ? ` value="${esc(email)}"` : "";
  return standalone(
    "Sign in",
    `    <form class="login-form" method="post" action="/login">
      <h1>Sign in</h1>
      <p class="sub">This dashboard belongs to the one owner account on this deploy.</p>
      ${errorHtml}
      <div class="field"><label for="login-email">Email</label><input id="login-email" name="email" type="email" autocomplete="email" required${emailVal}${invalid}></div>
      <div class="field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required${invalid}></div>
      <button class="btn btn-ink" type="submit"><span class="key-glyph" aria-hidden="true"></span>Sign in</button>
      <p class="login-meta">The owner account is created once, on first run.</p>
    </form>
    ${PROMISE}`,
    nonce,
  );
}

/**
 * Fail-closed "not configured" page (HTTP 500). Shown when a required deploy
 * secret is unset, instead of signing a cookie with `undefined`.
 */
export function notConfiguredPage(nonce: string, missing: string[]): string {
  const names = missing.map((m) => `<code>${esc(m)}</code>`).join(", ");
  return standalone(
    "Not configured",
    `    <section class="login-form" aria-labelledby="nc-h">
      <h1 id="nc-h">Not configured</h1>
      <p class="sub">This Skopia instance is missing required secret${missing.length > 1 ? "s" : ""}: ${names}. Sessions cannot be signed safely until ${missing.length > 1 ? "they are" : "it is"} set.</p>
      <p class="login-meta">Generate a key with <code>openssl rand -hex 32</code> and set it as an encrypted secret, then redeploy. See the deploy docs (README).</p>
    </section>`,
    nonce,
    true,
  );
}

export function setupPage(
  nonce: string,
  error?: string,
  email?: string,
  invalidFields: readonly string[] = [],
): string {
  const errorHtml = error ? `<p class="err" id="setup-error" role="alert">${esc(error)}</p>` : "";
  // Only the field(s) that actually failed get aria-invalid — marking a valid
  // field invalid misleads assistive tech (e.g. the email on a password mismatch).
  const invalidAttr = (field: string): string =>
    invalidFields.includes(field) ? ` aria-invalid="true" aria-describedby="setup-error"` : "";
  const emailVal = email ? ` value="${esc(email)}"` : "";
  return standalone(
    "Setup",
    `    <form class="login-form" method="post" action="/setup">
      <h1>Welcome to Skopia</h1>
      <p class="sub">Create your owner account to get started. This deploy has exactly one.</p>
      ${errorHtml}
      <div class="field"><label for="setup-email">Email</label><input id="setup-email" name="email" type="email" autocomplete="email" required${emailVal}${invalidAttr("email")}></div>
      <div class="field"><label for="setup-password">Password</label><input id="setup-password" name="password" type="password" autocomplete="new-password" minlength="8" required${invalidAttr("password")}><span class="hint">At least 8 characters.</span></div>
      <div class="field"><label for="setup-confirm">Confirm password</label><input id="setup-confirm" name="confirm" type="password" autocomplete="new-password" required${invalidAttr("confirm")}></div>
      <button class="btn btn-ink" type="submit"><span class="key-glyph" aria-hidden="true"></span>Create account</button>
    </form>`,
    nonce,
    true,
  );
}
