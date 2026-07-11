# Deploy and use Skopia

## One-click deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jasonm4130/skopia)

The button clones this repo into your account and provisions the following automatically
from `wrangler.jsonc`:

| Resource | How it's provisioned |
|----------|----------------------|
| D1 database | Auto-provisioned by the button |
| KV namespaces (cache + salt) | Auto-provisioned by the button |
| Durable Object (SiteLive) | Provisioned via DO migration |
| Workers Analytics Engine dataset | Created on first write — nothing to do |
| Static assets (fonts + vendor JS) | Shipped with the Worker — nothing to provision |

**The button will prompt you for four secrets** (declared in `package.json`
`cloudflare.bindings`). Generate them before you click:

### Generating your secrets

**`AUTH_COOKIE_SECRET`** — signs the dashboard session cookie.

```sh
openssl rand -hex 32
```

Paste the output when the Deploy wizard prompts for it.

**`IDENTITY_HMAC_SECRET`** — hashes visitor identities for cookieless analytics. No two
sites' hashes are comparable even if hosted by the same operator.

```sh
openssl rand -hex 32
```

**`CF_ACCOUNT_ID`** — your Cloudflare account ID, needed for Analytics Engine queries.

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages**.
2. Your Account ID appears in the right-hand sidebar.

**`WAE_API_TOKEN`** — lets the dashboard query your Analytics Engine data. This is the one
secret you cannot generate with `openssl` — it must be minted in the Cloudflare API-token
UI:

1. Go to **My Profile → API Tokens → Create Token**.
2. Choose **Create Custom Token**.
3. Under *Permissions*, add: **Account → Account Analytics → Read**.
4. Under *Account Resources*, select your account.
5. Click **Continue to summary → Create Token**.
6. Copy the token — it is shown only once.

## CLI / advanced deploy

```sh
pnpm install
pnpm build
wrangler deploy
```

`pnpm build` regenerates the embedded files — `src/shared/schema-embed.ts`
(cold-account D1 DDL) and `src/shared/skopia-embed.ts` (the minified tracking
script) — so `wrangler deploy` never ships stale embedded content after a fresh
clone or a migration change.

### Generating your secrets (for CLI deploy)

Before running `wrangler deploy`, set the four secrets as environment variables or in
your local `.dev.vars` file (do not commit `.dev.vars`):

**`AUTH_COOKIE_SECRET`** — signs the dashboard session cookie.

```sh
openssl rand -hex 32
```

**`IDENTITY_HMAC_SECRET`** — hashes visitor identities for cookieless analytics.

```sh
openssl rand -hex 32
```

**`CF_ACCOUNT_ID`** — your Cloudflare account ID.

1. Go to the [Cloudflare dashboard](https://dash.cloudflare.com) → **Workers & Pages**.
2. Your Account ID appears in the right-hand sidebar.

**`WAE_API_TOKEN`** — lets the dashboard query your Analytics Engine data.

1. Go to **My Profile → API Tokens → Create Token**.
2. Choose **Create Custom Token**.
3. Under *Permissions*, add: **Account → Account Analytics → Read**.
4. Under *Account Resources*, select your account.
5. Click **Continue to summary → Create Token**.
6. Copy the token — it is shown only once.

### Local development

Copy `.dev.vars.example` to `.dev.vars` and fill in the four secret values, then:

```sh
pnpm install
pnpm dev
```

`wrangler dev` reads `.dev.vars` automatically.

## After deploy

- **Dashboard shows data** once `WAE_API_TOKEN` is set — it's what powers the Analytics
  Engine queries behind every chart.
- **Ingest works** once `IDENTITY_HMAC_SECRET` is set — without it the collector returns
  `503` rather than signing with an undefined key.
- On first dashboard load, a setup screen prompts you to create your owner password. This
  is the only manual step after the Deploy wizard.

## Add Skopia to your site

Now that Skopia is deployed to your Cloudflare account, add the tracking snippet to your
site. Replace `skopia.<your-subdomain>.workers.dev` with your Worker's actual
URL (or your custom domain if you bound one).

## 1. Drop in the snippet

Add this to the `<head>` (or before `</body>`) of every page you want to track:

```html
<script defer
        src="https://skopia.<your-subdomain>.workers.dev/skopia.js"
        data-site="default"
        data-endpoint="https://skopia.<your-subdomain>.workers.dev/e"></script>
```

| Attribute | Required | Meaning |
|-----------|----------|---------|
| `src` | yes | The tracking script, served by your Worker at `/skopia.js`. |
| `data-site` | yes | The site ID. A fresh deploy seeds one site with ID `default`. If this attribute is missing, the script does nothing. |
| `data-endpoint` | usually | Where pageview/event beacons are sent. **Defaults to `/e` relative to the page**, so you almost always need to set it explicitly — see the gotcha below. |

### The `data-endpoint` gotcha (read this)

The beacon is `POST`ed to `data-endpoint`. If you omit it, it defaults to `/e`
**relative to the page being viewed**, not to the Worker. So a page on
`https://example.com` would post to `https://example.com/e` — which does not exist.

- **Your site is on a different origin than the Worker** (the common case): set
  `data-endpoint` to the Worker's absolute `/e` URL, as shown above. You must also
  allow that origin (see step 3) if you lock down the allowlist.
- **Your site is served *through* the same Worker / zone**: the relative default
  `/e` is correct and you can drop the attribute.

## 2. Verify it works

1. Load a tracked page in your browser.
2. Open DevTools → **Network**, filter for `e`. You should see a `POST` to your
   endpoint returning **204 No Content**.
3. Open `https://skopia.<your-subdomain>.workers.dev/live` — your visit should show
   up within a second or two.
4. The aggregated dashboard at `/app` fills in as the cron rollup runs (every 5
   minutes); the first finalized numbers appear shortly after.

If the `POST` returns:

- **404** — the `data-site` ID does not exist in the database (see step 4).
- **403** — the site has an origin allowlist that does not include your page's
  origin (see step 3).
- **503** — the collector has no `IDENTITY_HMAC_SECRET` set; set it and redeploy.

## 3. Lock down which origins can send data (optional)

The seeded `default` site has an **empty allowlist**, which means it is *open* — it
accepts beacons from any origin. That is convenient for getting started. To
restrict collection to your own domain(s), set the origin allowlist directly in D1
(there is no site-management UI in the MVP):

```sh
wrangler d1 execute skopia --remote \
  --command "UPDATE sites SET origin_allowlist = 'https://example.com,https://www.example.com' WHERE id = 'default';"
```

Origins are comma-separated and must match exactly what the browser sends as the
`Origin` header (scheme + host, no path, no trailing slash). Once the allowlist is
non-empty, requests from other origins — and requests with no `Origin` header — are
rejected with 403.

## 4. Track more than one site

The MVP ships with a single seeded site. To add another, insert a row into D1 and
use its ID as `data-site`:

```sh
wrangler d1 execute skopia --remote \
  --command "INSERT INTO sites (id, name, domain) VALUES ('blog', 'My Blog', 'blog.example.com');"
```

Then embed the snippet with `data-site="blog"`. Each site gets its own counts, its
own live view, and its own origin allowlist.

## 5. Single-page apps

SPA navigations are handled automatically. The script patches
`history.pushState`/`replaceState` and listens for `popstate`, firing a pageview on
each client-side route change. No configuration needed.

## 6. Custom events

Track conversions or interactions with the global `skopia` function once the script
has loaded:

```html
<button onclick="skopia('event', 'signup', { plan: 'pro' })">Sign up</button>
```

Equivalent forms:

```js
skopia('event', 'signup', { plan: 'pro' }); // command form
skopia.track('signup', { plan: 'pro' });    // shorthand
```

- The event **name** is required.
- **Props** are optional; the serialized props JSON is capped at 512 bytes
  (larger payloads are dropped, not truncated).
- **Do not put personal data in props.** Props are stored as-is. Keep them to
  low-cardinality, non-identifying values (`plan`, `variant`, `tier`). See
  [privacy.md](./privacy.md).

### Queue events before the script loads (advanced)

Because the script is `defer`-loaded, very early calls can be lost. If you need to
fire events before the script is ready, install a tiny stub *before* the snippet;
the script drains the queue when it loads:

```html
<script>
  window.skopia = window.skopia || function () {
    (window.skopia.q = window.skopia.q || []).push(arguments);
  };
</script>
```

## What the browser actually sends

Only: the path + query string, the referrer, the document title, the screen width,
and (for custom events) the event name and props. Everything else the dashboard
shows — country, device, browser, OS — is derived server-side from request
metadata and never leaves your Cloudflare account. See [privacy.md](./privacy.md)
for the full data inventory.
