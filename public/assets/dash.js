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

  // ---- chart readout: pointer, touch and arrow keys. The visible line
  // follows the pointer; screen readers hear a day only when it is chosen with
  // the keyboard (via #plot-say), so hovering never floods them.
  var plot = d.querySelector(".plot[data-days]");
  if (plot) {
    var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var fmt = function (x) {
      return Number(x).toLocaleString("en-US");
    };
    var word = function (x, a, b) {
      return x === 1 ? a : b;
    };
    var days = plot.getAttribute("data-days").split(",");
    var P = plot.getAttribute("data-p").split(",").map(Number);
    var V = plot.getAttribute("data-v").split(",").map(Number);
    var N = days.length;
    var line = d.querySelector(".readline");
    var say = d.getElementById("plot-say");
    var guide = plot.querySelector(".guide");
    var cur = -1;
    var cols = {};
    plot.querySelectorAll(".col").forEach(function (c) {
      cols[c.getAttribute("data-i")] = c;
    });
    var label = function (i) {
      var t = new Date(days[i] + "T00:00:00Z");
      return (
        DOW[t.getUTCDay()] +
        " " +
        t.getUTCDate() +
        " " +
        MON[t.getUTCMonth()] +
        (i === N - 1 ? ", today so far" : "")
      );
    };
    // textContent-only DOM building: no markup from data ever hits innerHTML.
    var setLine = function (i) {
      line.textContent = "";
      var rd = d.createElement("span");
      rd.className = "rd";
      rd.textContent = label(i);
      line.appendChild(rd);
      [
        [P[i], "pageview", "pageviews"],
        [V[i], "visitor", "visitors"],
      ].forEach(function (m) {
        line.appendChild(d.createTextNode(" "));
        var b = d.createElement("b");
        b.textContent = fmt(m[0]);
        line.appendChild(b);
        line.appendChild(d.createTextNode(" " + word(m[0], m[1], m[2])));
      });
    };
    var show = function (i, speak) {
      if (i === cur) return;
      if (cols[cur]) cols[cur].classList.remove("on");
      cur = i;
      if (i < 0) {
        plot.classList.remove("hover");
        setLine(N - 1);
        return;
      }
      guide.style.transform = "translateX(" + ((i + 0.5) / N) * plot.clientWidth + "px)";
      plot.classList.add("hover");
      if (cols[i]) cols[i].classList.add("on");
      setLine(i);
      if (speak && say) {
        say.textContent =
          label(i) +
          ": " +
          fmt(P[i]) +
          " " +
          word(P[i], "pageview", "pageviews") +
          ", " +
          fmt(V[i]) +
          " " +
          word(V[i], "visitor", "visitors");
      }
    };
    var at = function (e) {
      var r = plot.getBoundingClientRect();
      return Math.max(0, Math.min(N - 1, Math.floor(((e.clientX - r.left) / r.width) * N)));
    };
    plot.addEventListener("pointermove", function (e) {
      show(at(e));
    });
    plot.addEventListener("pointerdown", function (e) {
      show(at(e));
    });
    plot.addEventListener("pointerleave", function (e) {
      if (e.pointerType === "mouse") show(-1);
    });
    plot.addEventListener("blur", function () {
      show(-1);
    });
    plot.addEventListener("keydown", function (e) {
      var k = e.key;
      var i = cur < 0 ? N - 1 : cur;
      if (k === "ArrowLeft") i = cur < 0 ? N - 1 : Math.max(0, i - 1);
      else if (k === "ArrowRight") i = cur < 0 ? N - 1 : Math.min(N - 1, i + 1);
      else if (k === "Home") i = 0;
      else if (k === "End") i = N - 1;
      else if (k === "Escape") i = -1;
      else return;
      e.preventDefault();
      show(i, true);
    });
  }

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
