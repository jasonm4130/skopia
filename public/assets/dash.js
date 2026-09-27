// Skopia dashboard — progressive enhancement only. Every number is already in
// the server-rendered HTML; this file adds disclosure closing, copy buttons and
// the chart's day readout. Loaded with the request nonce (CSP strict-dynamic),
// never via inline handlers.
(function () {
  var d = document;
  d.documentElement.classList.add("js");

  // ---- disclosures (site switcher, More sheet): close on outside click and
  // on Escape, returning focus to the summary (WCAG 2.1.2, no keyboard trap).
  d.addEventListener("click", function (e) {
    d.querySelectorAll("details[open]:not(.days)").forEach(function (x) {
      if (!x.contains(e.target)) x.open = false;
    });
  });
  d.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    d.querySelectorAll("details[open]:not(.days)").forEach(function (x) {
      x.open = false;
      var s = x.querySelector("summary");
      if (s) s.focus();
    });
  });

  // ---- copy buttons: data-copy names the element whose text is copied.
  d.querySelectorAll("[data-copy]").forEach(function (b) {
    b.addEventListener("click", function () {
      var src = d.getElementById(b.getAttribute("data-copy"));
      if (!src) return;
      var done = function (label) {
        b.textContent = label;
        setTimeout(function () {
          b.textContent = "Copy";
        }, 2000);
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(src.textContent).then(
          function () {
            done("Copied");
          },
          function () {
            done("Select and copy");
          },
        );
      } else done("Select and copy");
    });
  });
})();
