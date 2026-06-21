/**
 * Stratus tracking script — FOUNDATION STUB.
 *
 * Budget: <2 KB gzipped (CI-enforced). No cookies, no localStorage,
 * no sessionStorage (CI-audited). Everything beyond pathname/referrer/title/
 * screen width is enriched server-side (spec §2).
 *
 * This is a deliberately minimal skeleton: it resolves the script tag's config
 * and exposes the `send()` seam, but does NOT yet emit beacons or wire SPA /
 * visibilitychange listeners — that is the SCRIPT agent's job. It must remain
 * runtime-safe (it ships to every visitor), so it never throws.
 */
(function () {
  var d = document;
  var s = d.currentScript as HTMLScriptElement | null;
  var site = s && s.getAttribute("data-site");
  if (!site) return;
  var endpoint = (s && s.getAttribute("data-endpoint")) || "/e";

  // The single transport seam. The script agent fills the beacon body + the
  // load / SPA (pushState/replaceState/popstate) / visibilitychange wiring.
  function send(): void {
    void endpoint;
    void site;
    // not implemented — beacon emission is the SCRIPT agent's deliverable.
  }

  void send;
})();
