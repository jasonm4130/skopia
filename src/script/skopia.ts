/**
 * Skopia tracking script.
 *
 * Budget: <2 KB gzipped (CI-enforced). No cookies, no localStorage,
 * no sessionStorage (CI-audited). Everything beyond pathname/referrer/title/
 * screen width is enriched server-side (spec §2).
 *
 * Transport: fetch with keepalive. Fires on visibilitychange===hidden +
 * pagehide fallback (not unload/beforeunload — unreliable on mobile).
 * SPA: monkey-patches history.pushState/replaceState + popstate listener.
 * Custom events: window.skopia('event', name, props) or skopia.track(name, props).
 */
(() => {
  var d = document;
  var s = d.currentScript as HTMLScriptElement | null;
  var site = s?.getAttribute("data-site");
  if (!site) return;
  var endpoint = s?.getAttribute("data-endpoint") || "/e";
  var lastPath = location.pathname;

  function send(
    type: "pv" | "event",
    name?: string,
    props?: Record<string, string | number | boolean>,
  ): void {
    var b: Record<string, unknown> = {
      t: type,
      s: site,
      p: location.pathname + location.search,
    };
    var ref = d.referrer;
    if (ref) b.r = ref;
    var ti = d.title;
    if (ti) b.ti = ti;
    var w = screen.width;
    if (w) b.w = w;
    if (name) {
      b.n = name;
      if (props) b.d = props;
    }
    try {
      fetch(endpoint, {
        method: "POST",
        body: JSON.stringify(b),
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      });
    } catch (_) {
      /* never throw */
    }
  }

  // SPA route change: fire pageview on each navigation
  function onRoute(): void {
    var p = location.pathname;
    if (p === lastPath) return;
    lastPath = p;
    Promise.resolve().then(() => {
      send("pv");
    });
  }

  // Monkey-patch history API
  var origPush = history.pushState.bind(history);
  var origReplace = history.replaceState.bind(history);
  history.pushState = (...a: Parameters<typeof history.pushState>) => {
    origPush(...a);
    onRoute();
  };
  history.replaceState = (...a: Parameters<typeof history.replaceState>) => {
    origReplace(...a);
    onRoute();
  };
  addEventListener("popstate", onRoute);

  // Initial pageview
  send("pv");

  // Public API
  type Props = Record<string, string | number | boolean>;
  type Api = { (cmd: string, n: string, p?: Props): void; track(n: string, p?: Props): void };

  // Fix #5 (MED): capture any pre-existing window.skopia (and its .q) BEFORE
  // overwriting it with the api object. After the overwrite, window.skopia has
  // no .q, so reading it post-assignment would always give undefined and lose
  // any events queued by the async-load snippet before the script loaded.
  var prev = (window as Window & { skopia?: Api & { q?: unknown[][] } }).skopia;
  var preQueue = prev?.q;

  var api = ((cmd: string, n: string, p?: Props): void => {
    if (cmd === "event") send("event", n, p);
  }) as Api;
  api.track = (n: string, p?: Props): void => {
    send("event", n, p);
  };

  (window as Window & { skopia?: Api }).skopia = api;

  // Drain pre-queued calls (async-load snippet pattern)
  if (preQueue) {
    for (let i = 0; i < preQueue.length; i++) {
      const call = preQueue[i];
      if (call) api(String(call[0] ?? ""), String(call[1] ?? ""), call[2] as Props | undefined);
    }
  }
})();
