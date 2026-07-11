# Add Skopia to your site

This guide assumes you have already deployed Skopia to your own Cloudflare account
(see the [README](../README.md#deploy)) and created your owner password at
`/setup` on first dashboard load.

Throughout, replace `skopia.<your-subdomain>.workers.dev` with your Worker's actual
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

## 7. Public share links

Share read-only analytics views with anyone, logged-out, at an unguessable URL.

### Generate a share token

Share links are controlled via a **public token** — a unique, unguessable identifier
tied to a single site. Generate one with:

```sh
TOKEN="shr_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
echo $TOKEN
```

Then register it on your site:

```sh
wrangler d1 execute skopia --remote \
  --command "UPDATE sites SET public_token='$TOKEN' WHERE id='default';"
```

Replace `default` with your site's ID if you have multiple sites.

Once set, the share link is live immediately at `https://skopia.<your-subdomain>.workers.dev/share/$TOKEN`.
The link exposes six views (overview, top pages, traffic sources, devices, campaigns, custom events)
with read-only access — no authentication required.

### Rotate or revoke

**To rotate** (generate a new token and retire the old one in one command):

```sh
TOKEN="shr_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
wrangler d1 execute skopia --remote \
  --command "UPDATE sites SET public_token='$TOKEN' WHERE id='default';"
```

The old share URL stops working immediately at the query layer. However, cached pages
may serve for **up to 60 seconds** after revocation while the cache TTL expires — then
404s (see cache behavior below).

**To revoke entirely** (disable the share link):

```sh
wrangler d1 execute skopia --remote \
  --command "UPDATE sites SET public_token=NULL WHERE id='default';"
```

### How it works

- **Independence from collection.** Rotating or revoking a share token **never affects**
  event collection from your site. The collector authenticates by site ID + origin allowlist
  (see step 3); the share link uses a separate token. Collection keeps working regardless
  of share-link changes.

- **Independence from auth.** The share link does not use your dashboard login. You can
  revoke it without affecting your own dashboard access, and vice-versa.

- **Cache window.** Share pages are cached at Cloudflare's edge for **60 seconds** for
  performance under heavy load. A revoked or rotated token can therefore serve a cached
  page for up to 60 seconds after the revocation before 404ing. If you need instant
  revocation, there is no per-request cache-busting option; the operator knob is to
  redeploy the Worker.

### Optional: rate-limiting

The share route is open and read-only. If you want to add a rate-limiting rule to
`/share/*` to protect against request floods, use Cloudflare's WAF:

1. Log in to your Cloudflare account and go to **Security → WAF → Create rule**.
2. Set the **Expression** to match the path: `http.request.uri.path contains "/share/"`
3. Set the **Action** to **Rate limit** and choose your threshold (e.g., 100 requests per
   minute per IP).

This is optional; the default public surface is already protected by shape validation
(malformed tokens are rejected instantly) and the Cache API (well-formed tokens hit the
cache on repeat access).

## What the browser actually sends

Only: the path + query string, the referrer, the document title, the screen width,
and (for custom events) the event name and props. Everything else the dashboard
shows — country, device, browser, OS — is derived server-side from request
metadata and never leaves your Cloudflare account. See [privacy.md](./privacy.md)
for the full data inventory.
