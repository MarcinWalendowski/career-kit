/*
 * app.js - the previewer shell.
 *
 * The one thing this does that the two editors it replaces did not: it writes
 * back to disk. The old career-hub footer said "paste back into the chat", so
 * every change made a round trip through a human and a clipboard. Here an edit
 * lands in $CAREER_HOME/knowledge-base.md through PUT /api/cv/section, the
 * rendered CV is derived from that file, and version history is git in the
 * workspace. localStorage holds theme, audience, pane width and which button
 * is lit, and never holds content.
 *
 * Plain browser JS. No build step, no framework, no CDN: the page is served
 * from loopback and has to work with the network unplugged.
 */
(function () {
  "use strict";

  var tokenMeta = document.querySelector('meta[name="career-token"]');
  var TOKEN = tokenMeta ? tokenMeta.content : "";
  var PREF = "career-kit:previewer";
  var SAVE_DEBOUNCE = 700;

  var el = {
    kb: document.getElementById("kb"),
    kbPath: document.getElementById("kb-path"),
    cvHost: document.getElementById("cv-host"),
    cvTheme: document.getElementById("cv-theme"),
    cvStyle: document.getElementById("cv-theme-style"),
    rail: document.getElementById("rail-body"),
    save: document.getElementById("save-state"),
    workspace: document.getElementById("workspace"),
    count: document.getElementById("chg-count"),
    conflict: document.getElementById("conflict"),
    conflictDetail: document.getElementById("conflict-detail"),
    lint: document.getElementById("lint"),
    lintDetail: document.getElementById("lint-detail"),
    audienceStrip: document.getElementById("audience-strip"),
    audienceLabel: document.getElementById("audience-label"),
    audienceText: document.getElementById("audience-text"),
    paneSource: document.getElementById("pane-source"),
    split: document.getElementById("split"),
    panes: document.getElementById("panes"),
  };

  var state = {
    etag: null,
    saveTimer: null,
    anno: null,
    baselineSource: {},  // aid -> knowledge base text as it was when the CV loaded
    anchorSource: {},    // aid -> knowledge base text as it stands now
    notes: {},
    audiences: [],
    audience: null,
    conflict: null,
    mode: "off",
  };

  /* ------------------------------------------------------------- prefs */

  function pref(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(PREF + ":" + key);
      localStorage.setItem(PREF + ":" + key, value);
    } catch (e) { /* preferences are optional */ }
    return null;
  }

  /* --------------------------------------------------------------- api */

  function api(path, opts) {
    var o = opts || {};
    var init = {
      method: o.method || "GET",
      headers: { "X-Career-Token": TOKEN },
      cache: "no-store",
    };
    if (o.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(o.body);
    }
    return fetch(path, init).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { error: text }; }
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  function setSave(kind, message) {
    el.save.className = "ck-save ck-save-" + kind;
    el.save.textContent = message || ({
      saving: "Saving",
      saved: "Saved",
      error: "Save failed",
      conflict: "Conflict",
      ready: "Ready",
    })[kind] || kind;
  }

  /* ----------------------------------------------------- knowledge base */

  function loadKb() {
    return api("/api/kb").then(function (r) {
      if (!r.ok) return setSave("error", "Could not read the knowledge base");
      el.kb.value = r.data.text;
      state.etag = r.data.etag;
      el.kbPath.textContent = r.data.path || "";
      setSave("ready");
    });
  }

  function saveKb() {
    var text = el.kb.value;
    setSave("saving");
    return api("/api/kb", { method: "PUT", body: { text: text, etag: state.etag } }).then(function (r) {
      if (r.status === 409) {
        state.conflict = { theirs: r.data.text, etag: r.data.etag, mine: text };
        el.conflictDetail.textContent =
          "The file on disk moved on while you were typing. Reload theirs to take the disk version and lose your unsaved lines, or keep mine to overwrite it.";
        el.conflict.hidden = false;
        setSave("conflict");
        return;
      }
      if (!r.ok) return setSave("error", (r.data && r.data.error) || "Save failed");
      state.etag = r.data.etag;
      setSave("saved");
      // A source edit changes the document's shape, so the render and the
      // annotation baseline are both rebuilt. An in-place edit does not go
      // through here, which is what keeps the caret from jumping mid-word.
      return loadCv();
    });
  }

  function scheduleKbSave() {
    if (state.saveTimer) clearTimeout(state.saveTimer);
    setSave("saving", "Unsaved");
    state.saveTimer = setTimeout(function () {
      state.saveTimer = null;
      saveKb();
    }, SAVE_DEBOUNCE);
  }

  /* ------------------------------------------------------------ render */

  function loadCv() {
    return api("/api/cv").then(function (r) {
      if (r.status === 422) return showLint(r.data);
      if (!r.ok) {
        el.cvHost.textContent = (r.data && r.data.error) || "Could not render the CV.";
        return;
      }
      el.cvStyle.textContent = r.data.css || "";
      el.cvTheme.textContent = "theme: " + (r.data.theme || "default");
      var body = /<article[\s\S]*<\/article>/i.exec(r.data.html);
      el.cvHost.innerHTML = body ? body[0] : r.data.html;

      state.baselineSource = {};
      state.anchorSource = {};
      (r.data.anchors || []).forEach(function (a) {
        state.baselineSource[a.aid] = a.text;
        state.anchorSource[a.aid] = a.text;
      });

      buildRail();
      mountAnnotate();
    });
  }

  /* --------------------------------------------------------- annotation */

  function mountAnnotate() {
    if (state.anno) state.anno.destroy();
    state.anno = window.CareerAnnotate.create({
      annoSelector: "[data-aid]",
      containers: ["#cv-host"],
      storageKey: PREF,
      sourceLabel: "knowledge-base.md",
      onEdit: writeSection,
      onNote: writeNote,
      onCount: function (c) { el.count.textContent = String(c.edits + c.notes); },
      onMode: function (mode) {
        state.mode = mode;
        document.getElementById("btn-edit").classList.toggle("ck-on", mode === "edit");
        document.getElementById("btn-note").classList.toggle("ck-on", mode === "note");
      },
    });
    state.anno.hydrate({ notes: state.notes, edits: {} });
  }

  /*
   * Map a plain-text edit back onto the markdown it came from.
   *
   * The pane shows rendered HTML, so an edit arrives without the markers that
   * made a word bold. Replacing the whole block with plain text would silently
   * strip that formatting, so: find the span that actually changed, and if the
   * removed text appears exactly once in the source, swap just that span.
   * Anything ambiguous falls back to the plain text, which is lossy but never
   * wrong about what the user typed.
   */
  function patchSource(source, before, after) {
    if (!source || before === after) return after;
    if (source.indexOf(before) >= 0) return source.split(before).join(after);

    // Rendering only ever deletes characters from the markdown: the asterisks
    // around a bold run, the brackets and href of a link, the backticks around
    // code. So the rendered text is a subsequence of its source, and walking
    // the two together gives every rendered character its index in the file.
    // If that walk fails the two are not related the way we assumed, and the
    // typed text is written as-is rather than spliced somewhere wrong.
    var map = [];
    var j = 0;
    for (var i = 0; i < before.length; i++) {
      while (j < source.length && source[j] !== before[i]) j++;
      if (j >= source.length) return after;
      map.push(j++);
    }

    var start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    var endB = before.length, endA = after.length;
    while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) { endB--; endA--; }

    var added = after.slice(start, endA);
    var from = start < map.length ? map[start] : source.length;
    var to = endB > start ? map[endB - 1] + 1 : from;
    return source.slice(0, from) + added + source.slice(to);
  }

  function writeSection(aid, record) {
    var text;
    if (record) {
      text = patchSource(state.anchorSource[aid] || record.orig, record.orig, record.cur);
    } else {
      // A revert has to reach the file too. The rendered pane going back to
      // the old words while the knowledge base keeps the new ones is exactly
      // the drift this previewer exists to remove.
      text = state.baselineSource[aid];
      if (text === undefined) return;
    }
    setSave("saving");
    api("/api/cv/section", { method: "PUT", body: { aid: aid, text: text } }).then(function (r) {
      if (r.status === 422) return showLint(r.data);
      if (!r.ok) return setSave("error", (r.data && r.data.error) || "Could not write that line");
      state.anchorSource[aid] = text;
      state.etag = r.data.etag;
      setSave("saved");
      return api("/api/kb").then(function (kb) {
        if (!kb.ok) return;
        el.kb.value = kb.data.text;
        state.etag = kb.data.etag;
      });
    });
  }

  /* ------------------------------------------------------------- notes */

  function loadNotes() {
    return api("/api/notes").then(function (r) {
      state.notes = (r.ok && r.data.notes) || {};
    });
  }

  function writeNote(aid, record) {
    if (record) state.notes[aid] = record;
    else delete state.notes[aid];
    setSave("saving");
    api("/api/notes", { method: "PUT", body: { aid: aid, note: record } }).then(function (r) {
      setSave(r.ok ? "saved" : "error");
    });
  }

  function buildRail() {
    el.rail.innerHTML = "";
    var sections = Array.prototype.slice.call(el.cvHost.querySelectorAll("[data-anno-section]"));
    if (!sections.length) {
      var empty = document.createElement("div");
      empty.className = "ck-rail-empty";
      empty.textContent = "Sections appear here once the knowledge base has headings.";
      el.rail.appendChild(empty);
      return;
    }
    sections.forEach(function (sec) {
      var name = sec.getAttribute("data-anno-section");
      var aid = "sec:" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      var wrap = document.createElement("div");
      wrap.className = "ck-rail-item";
      var label = document.createElement("button");
      label.type = "button";
      label.className = "ck-rail-label";
      label.textContent = name;
      label.addEventListener("click", function () {
        sec.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      var ta = document.createElement("textarea");
      ta.className = "ck-rail-note";
      ta.placeholder = "Note for Claude about this section";
      ta.value = (state.notes[aid] && state.notes[aid].note) || "";
      var timer = null;
      ta.addEventListener("input", function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          var v = ta.value.trim();
          writeNote(aid, v ? { note: v, crumb: name, ts: new Date().toISOString() } : null);
          wrap.classList.toggle("has-note", !!v);
        }, SAVE_DEBOUNCE);
      });
      wrap.classList.toggle("has-note", !!ta.value.trim());
      wrap.appendChild(label);
      wrap.appendChild(ta);
      el.rail.appendChild(wrap);
    });
  }

  /* --------------------------------------------------------- audiences */

  /* The audience list is fetched, never written here. Three framing variants
   * hardcoded as JS string literals in the old hub is one of the duplications
   * this product exists to stop, so adding a fourth is a workspace edit. */
  function loadAudiences() {
    return api("/api/audiences").then(function (r) {
      state.audiences = (r.ok && r.data.audiences) || [];
      var saved = pref("audience");
      var found = null;
      for (var i = 0; i < state.audiences.length; i++) {
        if (state.audiences[i].id === saved) found = state.audiences[i];
      }
      applyAudience(found || state.audiences[0] || null);
    });
  }

  function applyAudience(a) {
    state.audience = a;
    var button = document.getElementById("btn-audience");
    if (!a) {
      button.textContent = "Audience";
      el.audienceStrip.hidden = true;
      return;
    }
    button.textContent = "Audience: " + a.label;
    el.cvHost.setAttribute("data-audience", a.id);
    el.audienceLabel.textContent = a.label;
    el.audienceText.textContent = a.text || "No framing text for this audience yet.";
    el.audienceStrip.hidden = false;
    pref("audience", a.id);
  }

  function cycleAudience() {
    if (state.audiences.length < 2) return;
    var idx = 0;
    for (var i = 0; i < state.audiences.length; i++) {
      if (state.audience && state.audiences[i].id === state.audience.id) idx = i;
    }
    applyAudience(state.audiences[(idx + 1) % state.audiences.length]);
  }

  /* --------------------------------------------------------------- pdf */

  function showLint(data) {
    var findings = (data && data.findings) || [];
    el.lintDetail.innerHTML = "";
    var intro = document.createElement("div");
    intro.textContent = (data && data.detail) || "Make the text visible or delete it.";
    el.lintDetail.appendChild(intro);
    findings.forEach(function (f) {
      var row = document.createElement("div");
      row.className = "ck-lint-row";
      var sel = document.createElement("code");
      sel.textContent = f.selector;
      var rule = document.createElement("code");
      rule.textContent = f.rule;
      row.appendChild(sel);
      row.appendChild(document.createTextNode(" sets "));
      row.appendChild(rule);
      row.appendChild(document.createTextNode(" in " + (f.where || "the stylesheet") + ". " + f.why));
      el.lintDetail.appendChild(row);
    });
    el.lint.hidden = false;
    setSave("error", "Render refused");
  }

  function exportPdf() {
    setSave("saving", "Rendering PDF");
    api("/api/render", { method: "POST", body: { target: "pdf" } }).then(function (r) {
      if (r.status === 422) return showLint(r.data);
      if (!r.ok) return setSave("error", (r.data && r.data.error) || "PDF failed");
      if (r.data.pdfPath) setSave("saved", "PDF written to " + r.data.pdfPath);
      else setSave("error", (r.data.warnings || []).join(" ") || "No PDF produced");
    });
  }

  /* ------------------------------------------------------------ layout */

  function initSplit() {
    var saved = parseFloat(pref("split"));
    if (saved > 12 && saved < 80) el.paneSource.style.flexBasis = saved + "%";
    var dragging = false;
    el.split.addEventListener("pointerdown", function (ev) {
      dragging = true;
      el.split.setPointerCapture(ev.pointerId);
      document.body.classList.add("ck-dragging");
    });
    el.split.addEventListener("pointermove", function (ev) {
      if (!dragging) return;
      var rect = el.panes.getBoundingClientRect();
      var pct = ((ev.clientX - rect.left) / rect.width) * 100;
      pct = Math.max(15, Math.min(75, pct));
      el.paneSource.style.flexBasis = pct + "%";
    });
    function stop(ev) {
      if (!dragging) return;
      dragging = false;
      try { el.split.releasePointerCapture(ev.pointerId); } catch (e) { /* already released */ }
      document.body.classList.remove("ck-dragging");
      pref("split", parseFloat(el.paneSource.style.flexBasis) || 40);
    }
    el.split.addEventListener("pointerup", stop);
    el.split.addEventListener("pointercancel", stop);
    el.split.addEventListener("keydown", function (ev) {
      var cur = parseFloat(el.paneSource.style.flexBasis) || 40;
      if (ev.key === "ArrowLeft") cur -= 2;
      else if (ev.key === "ArrowRight") cur += 2;
      else return;
      ev.preventDefault();
      cur = Math.max(15, Math.min(75, cur));
      el.paneSource.style.flexBasis = cur + "%";
      pref("split", cur);
    });
  }

  function initTheme() {
    var saved = pref("theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    document.getElementById("btn-theme").addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      if (!cur) cur = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      var next = cur === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      pref("theme", next);
    });
  }

  /* -------------------------------------------------------------- boot */

  function wire() {
    el.kb.addEventListener("input", scheduleKbSave);
    document.getElementById("btn-edit").addEventListener("click", function () { state.anno.toggleEdit(); });
    document.getElementById("btn-note").addEventListener("click", function () { state.anno.toggleNote(); });
    document.getElementById("btn-review").addEventListener("click", function () { state.anno.openDrawer(); });
    document.getElementById("btn-audience").addEventListener("click", cycleAudience);
    document.getElementById("btn-pdf").addEventListener("click", exportPdf);
    document.getElementById("lint-close").addEventListener("click", function () { el.lint.hidden = true; });

    document.getElementById("conflict-theirs").addEventListener("click", function () {
      if (!state.conflict) return;
      el.kb.value = state.conflict.theirs;
      state.etag = state.conflict.etag;
      state.conflict = null;
      el.conflict.hidden = true;
      setSave("saved", "Reloaded from disk");
      loadCv();
    });
    document.getElementById("conflict-mine").addEventListener("click", function () {
      if (!state.conflict) return;
      var mine = state.conflict.mine;
      state.etag = state.conflict.etag;
      state.conflict = null;
      el.conflict.hidden = true;
      el.kb.value = mine;
      saveKb();
    });

    window.addEventListener("beforeunload", function (ev) {
      if (state.saveTimer) {
        ev.preventDefault();
        ev.returnValue = "";
      }
    });
  }

  // Exposed so the markdown-mapping heuristic can be exercised on its own. The
  // guard below is the same seam: loaded without the server's token meta tag,
  // this file defines its helpers and talks to nobody.
  window.CareerPreviewer = { patchSource: patchSource };
  if (!tokenMeta) return;

  initTheme();
  initSplit();
  wire();

  api("/api/health").then(function (r) {
    if (r.status === 401) {
      setSave("error", "The page loaded without a token. Restart the previewer.");
      return;
    }
    if (r.ok) el.workspace.textContent = r.data.careerHome;
  });

  loadNotes().then(loadKb).then(loadCv).then(loadAudiences);
})();
