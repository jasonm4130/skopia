// Skopia dashboard — the online-now display on the authed Overview (and the
// first-run page). The server renders the initial state; this file keeps it
// current over the /live WebSocket. The protocol is unchanged: the client
// sends 'ping' every 15 s (eviction is lazy server-side, so without it a count
// goes stale once a visitor leaves) and receives snapshots shaped
// {visitors, topPages: [{label, visitors}]}.
//
// Paths are visitor-controlled input, so every row is built with
// createElement/textContent, never innerHTML.
(function () {
  var d = document;
  var site = d.body.getAttribute("data-live-site");
  if (!site || !/^https?:$/.test(location.protocol)) return;

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var box = d.getElementById("live");
  var list = d.getElementById("live-pages");
  var say = d.getElementById("live-say");
  var arrived = d.getElementById("arrived");
  var count = Number((d.querySelector("[data-odo]") || {}).textContent) || 0;

  function word(n, one, many) {
    return n === 1 ? one : many;
  }
  function fmt(n) {
    return n.toLocaleString("en-US");
  }

  // ---- odometer: one column per digit, each a strip of [blank, 0..9]. A spare
  // blank column leads, so 9 -> 10 rolls a "1" into view instead of jumping.
  var ROW = 1.05; // em; matches .odo-s>span height
  function column() {
    var c = d.createElement("span");
    c.className = "odo-c b";
    var s = d.createElement("span");
    s.className = "odo-s";
    for (var i = -1; i < 10; i++) {
      var g = d.createElement("span");
      g.textContent = i < 0 ? "\u00a0" : String(i);
      s.appendChild(g);
    }
    c.appendChild(s);
    return c;
  }
  function odoSet(el, v) {
    var s = String(v);
    var cols = el.querySelectorAll(".odo-c");
    if (!cols.length) el.textContent = "";
    for (var k = cols.length; k < s.length + 1; k++) el.insertBefore(column(), el.firstChild);
    cols = el.querySelectorAll(".odo-c");
    var pad = cols.length - s.length;
    for (var i = 0; i < cols.length; i++) {
      var ch = i < pad ? "" : s.charAt(i - pad);
      var idx = ch === "" ? 0 : Number(ch) + 1;
      cols[i].classList.toggle("b", ch === "");
      cols[i].firstChild.style.transform = "translateY(" + -idx * ROW + "em)";
    }
  }
  var odos = d.querySelectorAll("[data-odo]");
  for (var o = 0; o < odos.length; o++) odoSet(odos[o], count);

  // ---- active pages: rows keyed by path, reordered with FLIP (transform only)
  function row(p) {
    var li = d.createElement("li");
    li.setAttribute("data-path", p.label);
    var a = d.createElement("span");
    a.className = "p";
    a.textContent = p.label;
    var b = d.createElement("span");
    b.className = "c";
    var bar = d.createElement("i");
    bar.className = "bar-l";
    bar.setAttribute("aria-hidden", "true");
    li.appendChild(a);
    li.appendChild(b);
    li.appendChild(bar);
    return li;
  }
  function paintList(pages) {
    if (!list) return;
    var old = {};
    var first = {};
    var lis = list.querySelectorAll("li[data-path]");
    for (var i = 0; i < lis.length; i++) {
      old[lis[i].getAttribute("data-path")] = lis[i];
      first[lis[i].getAttribute("data-path")] = lis[i].getBoundingClientRect().top;
    }
    var max = 1;
    pages.forEach(function (p) {
      if (p.visitors > max) max = p.visitors;
    });
    var keep = {};
    var none = list.querySelector("li.none");
    pages.forEach(function (p) {
      var li = old[p.label] || row(p);
      keep[p.label] = true;
      li.querySelector(".c").textContent = fmt(p.visitors);
      li.querySelector(".bar-l").style.setProperty("--s", (p.visitors / max).toFixed(3));
      list.appendChild(li);
    });
    Object.keys(old).forEach(function (k) {
      if (!keep[k]) old[k].remove();
    });
    if (pages.length && none) none.remove();
    if (!pages.length && !none) {
      none = d.createElement("li");
      none.className = "none";
      none.textContent = "Nobody is on the site right now. Pages show up here as visitors arrive.";
      list.appendChild(none);
    }
    if (reduce.matches) return;
    pages.forEach(function (p) {
      var li = old[p.label];
      if (!li || first[p.label] === undefined) return;
      var dy = first[p.label] - li.getBoundingClientRect().top;
      if (!dy) return;
      li.style.transition = "none";
      li.style.transform = "translateY(" + dy + "px)";
      void li.offsetHeight;
      li.style.transition = "transform .45s var(--ease)";
      li.style.transform = "";
    });
  }

  // ---- screen readers: one summary per 30 s at most, in #live-say (role=status)
  var lastSay = 0;
  var sayTimer = 0;
  var sayText = say ? say.textContent : "";
  function announce(text) {
    sayText = text;
    if (!say || sayTimer) return;
    var wait = Math.max(0, lastSay + 30000 - Date.now());
    sayTimer = setTimeout(function () {
      sayTimer = 0;
      // Only a change spends the 30 s budget; a repeat of the same summary is dropped.
      if (say.textContent === sayText) return;
      lastSay = Date.now();
      say.textContent = sayText;
    }, wait);
  }

  // ---- paint: at most once a second, whatever the socket's pace
  function paint(s) {
    var v = Number(s.visitors) || 0;
    var up = v > count;
    var zero = v === 0;
    count = v;
    for (var i = 0; i < odos.length; i++) {
      odoSet(odos[i], v);
      odos[i].classList.toggle("zero", zero);
    }
    if (box) {
      box.classList.toggle("is-zero", zero);
      var con = box.closest(".console");
      if (con) con.classList.toggle("idle", zero);
    }
    d.querySelectorAll(".ldot").forEach(function (dot) {
      dot.classList.toggle("zero", zero);
      if (up && !reduce.matches) {
        dot.classList.remove("ping");
        void dot.offsetWidth;
        dot.classList.add("ping");
      }
    });
    d.querySelectorAll("[data-live-n]").forEach(function (n) {
      n.textContent = fmt(v);
      var chip = n.closest(".live-chip");
      if (chip) chip.classList.toggle("zero", zero);
    });
    d.querySelectorAll("[data-live-unit]").forEach(function (u) {
      u.textContent = word(v, "visitor", "visitors") + " in the last 5\u00a0minutes";
    });
    if (arrived && v > 0) arrived.hidden = false;
    paintList(Array.isArray(s.topPages) ? s.topPages : []);
    announce(fmt(v) + " " + word(v, "visitor", "visitors") + " online now");
  }
  var pending = null;
  var lastPaint = 0;
  var paintTimer = 0;
  function queue(s) {
    pending = s;
    if (paintTimer) return;
    paintTimer = setTimeout(
      function () {
        paintTimer = 0;
        lastPaint = Date.now();
        paint(pending);
      },
      Math.max(0, lastPaint + 1000 - Date.now()),
    );
  }

  // ---- socket: backoff 3, 6, 12, 24, 48 s, then a final state, not forever
  function status(t) {
    d.querySelectorAll(".js-status").forEach(function (s) {
      s.textContent = t;
    });
  }
  var tries = 0;
  (function connect() {
    var ws = new WebSocket(
      (location.protocol === "https:" ? "wss" : "ws") +
        "://" +
        location.host +
        "/live?site=" +
        encodeURIComponent(site),
    );
    var pingTimer = setInterval(function () {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 15000);
    ws.onopen = function () {
      tries = 0;
      status("Live.");
    };
    ws.onmessage = function (e) {
      try {
        queue(JSON.parse(e.data));
      } catch (_) {}
    };
    ws.onclose = function () {
      clearInterval(pingTimer);
      if (tries >= 5) {
        status("Live updates stopped. Reload to try again.");
        return;
      }
      status("Reconnecting\u2026");
      setTimeout(connect, 3000 * 2 ** tries++);
    };
  })();
})();
