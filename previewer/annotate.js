/*
 * annotate.js - the annotation engine, lifted from a working CV editor and
 * made to take a document instead of being one.
 *
 * What changed in the port, and why:
 *
 *   1. The selector list and the breadcrumb function used to be two constants
 *      that knew about .job, .co and .eyebrow. They are options now. The
 *      default crumbFor walks up to the nearest [data-anno-section] and
 *      [data-anno-item], so the engine learns a document's shape from two
 *      attributes and never from a class name.
 *
 *   2. Persistence used to be localStorage. It is a pair of injected
 *      callbacks now, debounced, and the caller writes them to disk. This is
 *      the whole point of the previewer: the old editor's footer said "paste
 *      back into the chat", and that loop is gone. localStorage in this file
 *      holds nothing but which mode a button is in.
 *
 * Everything else is kept because it already worked: stable data-aid anchors,
 * breadcrumbs, a pristine baseline captured before any stored edit is applied,
 * badges, the review drawer with edits and notes counted separately,
 * jump-to-anchor with a flash, per-edit revert, clear-all behind a confirm,
 * Escape to close, Cmd-Enter to save a note, and the before/after markdown
 * export, which is the best thing in the original.
 *
 * Plain browser JS, no build step, no framework, no network.
 */
(function (global) {
  "use strict";

  function q(sel, root) { return (root || document).querySelector(sel); }
  function all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function elm(tag, cls, txt) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (txt !== undefined) d.textContent = txt;
    return d;
  }
  function btn(cls, txt, fn) {
    var b = elm("button", cls, txt);
    b.type = "button";
    b.onclick = fn;
    return b;
  }
  function aidSort(a, b) {
    var pa = String(a).split("-"), pb = String(b).split("-");
    if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
    return (+pa[1] || 0) - (+pb[1] || 0);
  }

  /* Default breadcrumb: section and item come from data attributes, so this
   * function is document-shaped rather than resume-shaped. */
  function defaultCrumb(el) {
    var parts = [];
    var sec = el.closest("[data-anno-section]");
    var item = el.closest("[data-anno-item]");
    if (sec) parts.push(sec.getAttribute("data-anno-section"));
    if (item) parts.push(item.getAttribute("data-anno-item"));
    if (!parts.length) {
      var h = el.closest("[data-anno-title]");
      if (h) parts.push(h.getAttribute("data-anno-title"));
    }
    return parts.filter(Boolean).join(" › ") || "Document";
  }

  function create(options) {
    var opt = options || {};
    var annoSelector = opt.annoSelector || "[data-aid]";
    var crumbFor = typeof opt.crumbFor === "function" ? opt.crumbFor : defaultCrumb;
    var onEdit = opt.onEdit || function () {};
    var onNote = opt.onNote || function () {};
    var onCount = opt.onCount || function () {};
    var onMode = opt.onMode || function () {};
    var storageKey = opt.storageKey || "career-kit:previewer";
    var sourceLabel = opt.sourceLabel || "knowledge-base.md";
    var debounceMs = opt.debounceMs === undefined ? 400 : opt.debounceMs;

    var notes = {};   // aid -> {note, crumb, snapshot, ts}
    var edits = {};   // aid -> {orig, cur, curHTML, crumb, ts}
    var orig = {};    // aid -> {text, html}   pristine baseline from the render
    var annotate = false, editMode = false, currentAid = null;
    var editTimers = {}, noteTimers = {};
    var destroyed = false;

    /* ---------------------------------------------------------- chrome */

    var editor = elm("div", "ck-note-editor");
    editor.id = "ck-note-editor";
    var neCrumb = elm("div", "ne-crumb");
    var neText = document.createElement("textarea");
    neText.placeholder = "Note for Claude, for example: tighten this, add the number, drop this bullet";
    var neRow = elm("div", "ne-row");
    var neSave = btn("ne-save", "Save note", function () { saveNote(); });
    var neDel = btn("ne-del", "Delete", function () { deleteCurrent(); });
    var neCancel = btn("ne-cancel", "Cancel", function () { closeEditor(); });
    neRow.appendChild(neSave); neRow.appendChild(neDel); neRow.appendChild(neCancel);
    editor.appendChild(neCrumb); editor.appendChild(neText); editor.appendChild(neRow);

    var scrim = elm("div", "ck-scrim");
    scrim.addEventListener("click", function () { closeDrawer(); });

    var drawer = elm("aside", "ck-drawer");
    drawer.setAttribute("aria-label", "Review changes");
    var head = elm("div", "dr-head");
    var title = elm("h3", null, "Review ");
    var count = elm("span", "dr-count");
    title.appendChild(count);
    head.appendChild(title);
    head.appendChild(btn("dr-close", "×", function () { closeDrawer(); }));
    var list = elm("div", "dr-list");
    var foot = elm("div", "dr-foot");
    var footRow = elm("div", "fr");
    var exportBox = document.createElement("textarea");
    exportBox.className = "dr-export";
    exportBox.readOnly = true;
    exportBox.addEventListener("click", function () { exportBox.select(); });
    footRow.appendChild(btn("fbtn", "Download .md", function () { downloadMd(); }));
    footRow.appendChild(btn("fbtn danger", "Clear all", function () { clearAll(); }));
    foot.appendChild(footRow);
    foot.appendChild(elm("div", "foot-hint", "Edits are written straight to the knowledge base. This panel is the diff, kept so you can see what changed before you commit it."));
    foot.appendChild(exportBox);
    drawer.appendChild(head); drawer.appendChild(list); drawer.appendChild(foot);

    document.body.appendChild(editor);
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);

    /* ------------------------------------------------------- anchoring */

    function containerList() {
      var raw = opt.containers || [document.body];
      var out = [];
      for (var i = 0; i < raw.length; i++) {
        var c = typeof raw[i] === "string" ? q(raw[i]) : raw[i];
        if (c) out.push(c);
      }
      return out.length ? out : [document.body];
    }

    /* Anchors already present in the render are kept. A server-rendered CV
     * carries data-aid values that map to knowledge-base line ranges, and
     * renumbering them here would break the write-back. */
    function initAnchors() {
      var containers = containerList();
      for (var ci = 0; ci < containers.length; ci++) {
        var container = containers[ci];
        var prefix = container.getAttribute && container.getAttribute("data-anno-prefix");
        if (!prefix) prefix = "c" + ci;
        var found = all(annoSelector, container);
        for (var i = 0; i < found.length; i++) {
          var el = found[i];
          if (!el.getAttribute("data-aid")) el.setAttribute("data-aid", prefix + "-" + i);
          if (!el.getAttribute("data-crumb")) el.setAttribute("data-crumb", crumbFor(el));
        }
      }
    }

    function anchorEls() {
      var out = [];
      var containers = containerList();
      for (var i = 0; i < containers.length; i++) {
        out = out.concat(all("[data-aid]", containers[i]));
      }
      return out;
    }

    function byAid(aid) {
      var els = anchorEls();
      for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute("data-aid") === aid) return els[i];
      }
      return null;
    }

    function cleanContent(el) {
      var c = el.cloneNode(true);
      var badges = all(".note-badge, .edit-badge", c);
      for (var i = 0; i < badges.length; i++) badges[i].remove();
      return { html: c.innerHTML.trim(), text: c.textContent.replace(/\s+/g, " ").trim() };
    }

    /* The baseline is captured before any stored edit is applied. Capture it
     * after and every "before" in the diff is somebody else's after. */
    function captureOrig() {
      orig = {};
      var els = anchorEls();
      for (var i = 0; i < els.length; i++) {
        orig[els[i].getAttribute("data-aid")] = cleanContent(els[i]);
      }
    }

    function anchorText(aid) {
      var el = byAid(aid);
      if (el) return el.textContent.replace(/\s+/g, " ").trim();
      return (notes[aid] && notes[aid].snapshot) || "";
    }

    /* ----------------------------------------------------- persistence */

    function flushEdit(aid) {
      if (editTimers[aid]) clearTimeout(editTimers[aid]);
      editTimers[aid] = setTimeout(function () {
        delete editTimers[aid];
        onEdit(aid, edits[aid] || null);
      }, debounceMs);
    }
    function flushNote(aid) {
      if (noteTimers[aid]) clearTimeout(noteTimers[aid]);
      noteTimers[aid] = setTimeout(function () {
        delete noteTimers[aid];
        onNote(aid, notes[aid] || null);
      }, Math.min(debounceMs, 250));
    }

    /* ---------------------------------------------------------- render */

    function counts() {
      return { edits: Object.keys(edits).length, notes: Object.keys(notes).length };
    }

    function updateCounts() {
      var c = counts();
      count.textContent = (c.edits + c.notes)
        ? "· " + c.edits + " edit" + (c.edits !== 1 ? "s" : "") + ", " + c.notes + " note" + (c.notes !== 1 ? "s" : "")
        : "";
      onCount(c);
    }

    function render() {
      var els = anchorEls();
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var aid = el.getAttribute("data-aid");
        var badge = el.querySelector(":scope > .note-badge");
        if (notes[aid]) {
          el.classList.add("noted");
          if (!badge) {
            badge = elm("button", "note-badge", "✎");
            badge.type = "button";
            badge.title = "Edit note";
            badge.setAttribute("contenteditable", "false");
            badge.addEventListener("click", (function (target) {
              return function (ev) { ev.stopPropagation(); openEditor(target); };
            })(el));
            el.appendChild(badge);
          }
        } else {
          el.classList.remove("noted");
          if (badge) badge.remove();
        }
        if (edits[aid]) el.classList.add("edited");
        else el.classList.remove("edited");
      }
      updateCounts();
      renderDrawer();
      exportBox.value = buildMarkdown();
    }

    function renderDrawer() {
      list.innerHTML = "";
      var eids = Object.keys(edits).sort(aidSort);
      var nids = Object.keys(notes).sort(aidSort);
      if (!eids.length && !nids.length) {
        var empty = elm("div", "dr-empty");
        empty.appendChild(elm("div", null, "Nothing yet."));
        empty.appendChild(elm("div", null, "Turn on Edit to change text, or Note to leave a comment."));
        list.appendChild(empty);
        return;
      }
      if (eids.length) {
        list.appendChild(elm("div", "dr-subhead", "Edits (" + eids.length + ")"));
        eids.forEach(function (aid, i) {
          var e = edits[aid];
          var card = elm("div", "note-card edit");
          card.appendChild(elm("div", "nc-crumb", (i + 1) + " · " + (e.crumb || "")));
          card.appendChild(elm("div", "nc-before", e.orig));
          card.appendChild(elm("div", "nc-after", e.cur));
          var act = elm("div", "nc-actions");
          act.appendChild(btn("nc-jump", "Jump", function () { jumpTo(aid); }));
          act.appendChild(btn("nc-del", "Revert", function () { revertEdit(aid); }));
          card.appendChild(act);
          list.appendChild(card);
        });
      }
      if (nids.length) {
        list.appendChild(elm("div", "dr-subhead", "Notes (" + nids.length + ")"));
        nids.forEach(function (aid, i) {
          var n = notes[aid];
          var card = elm("div", "note-card");
          card.appendChild(elm("div", "nc-crumb", (i + 1) + " · " + (n.crumb || "")));
          card.appendChild(elm("div", "nc-anchor", "“" + anchorText(aid) + "”"));
          card.appendChild(elm("div", "nc-text", n.note));
          var act = elm("div", "nc-actions");
          act.appendChild(btn("nc-jump", "Jump", function () { jumpTo(aid); }));
          act.appendChild(btn("nc-edit", "Edit", function () { jumpTo(aid, true); }));
          act.appendChild(btn("nc-del", "Delete", function () { delNote(aid); }));
          card.appendChild(act);
          list.appendChild(card);
        });
      }
    }

    /* ----------------------------------------------------------- modes */

    function setEditable(on) {
      var els = anchorEls();
      for (var i = 0; i < els.length; i++) {
        if (on) {
          els[i].setAttribute("contenteditable", "true");
          els[i].spellcheck = false;
        } else {
          els[i].removeAttribute("contenteditable");
        }
      }
    }

    function rememberMode() {
      try {
        localStorage.setItem(storageKey + ":mode", editMode ? "edit" : annotate ? "note" : "off");
      } catch (e) { /* preferences only, never content */ }
    }

    function setMode(mode) {
      editMode = mode === "edit";
      annotate = mode === "note";
      document.body.classList.toggle("ck-editing", editMode);
      document.body.classList.toggle("ck-annotating", annotate);
      setEditable(editMode);
      if (!annotate) closeEditor();
      rememberMode();
      onMode(mode);
    }
    function toggleEdit() { setMode(editMode ? "off" : "edit"); }
    function toggleNote() { setMode(annotate ? "off" : "note"); }

    function revertEdit(aid) {
      var el = byAid(aid);
      if (el && orig[aid]) el.innerHTML = orig[aid].html;
      delete edits[aid];
      onEdit(aid, null);
      render();
    }

    /* ---------------------------------------------------------- editor */

    function openEditor(el) {
      currentAid = el.getAttribute("data-aid");
      neCrumb.textContent = el.getAttribute("data-crumb") || crumbFor(el);
      neText.value = (notes[currentAid] && notes[currentAid].note) || "";
      neDel.style.display = notes[currentAid] ? "" : "none";
      editor.style.display = "block";
      var r = el.getBoundingClientRect();
      var top = r.bottom + window.scrollY + 8;
      var left = r.left + window.scrollX;
      var maxLeft = window.scrollX + document.documentElement.clientWidth - editor.offsetWidth - 12;
      if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
      editor.style.top = top + "px";
      editor.style.left = left + "px";
      neText.focus();
    }
    function closeEditor() {
      editor.style.display = "none";
      currentAid = null;
    }
    function saveNote() {
      if (!currentAid) return;
      var v = neText.value.trim();
      var el = byAid(currentAid);
      if (!v) {
        delete notes[currentAid];
      } else {
        notes[currentAid] = {
          note: v,
          crumb: el ? el.getAttribute("data-crumb") : (notes[currentAid] && notes[currentAid].crumb) || "",
          snapshot: el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 400) : (notes[currentAid] && notes[currentAid].snapshot) || "",
          ts: new Date().toISOString(),
        };
      }
      flushNote(currentAid);
      render();
      closeEditor();
    }
    function deleteCurrent() {
      if (!currentAid) return;
      var aid = currentAid;
      delete notes[aid];
      flushNote(aid);
      render();
      closeEditor();
    }
    function delNote(aid) {
      delete notes[aid];
      flushNote(aid);
      render();
    }

    function jumpTo(aid, editNote) {
      var el = byAid(aid);
      if (!el) return;
      closeDrawer();
      if (opt.onJump) opt.onJump(aid, el);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      if (editNote) {
        if (!annotate) setMode("note");
        setTimeout(function () { openEditor(el); }, 260);
      }
    }

    function openDrawer() {
      drawer.classList.add("open");
      scrim.style.display = "block";
    }
    function closeDrawer() {
      drawer.classList.remove("open");
      scrim.style.display = "none";
    }

    /* ---------------------------------------------------------- export */

    function buildMarkdown() {
      var eids = Object.keys(edits).sort(aidSort);
      var nids = Object.keys(notes).sort(aidSort);
      if (!eids.length && !nids.length) return "";
      var L = [
        "# Changes for Claude: " + new Date().toLocaleString(),
        "_source: " + sourceLabel + " · " + eids.length + " edit" + (eids.length !== 1 ? "s" : "") +
          ", " + nids.length + " note" + (nids.length !== 1 ? "s" : "") + "_",
        "",
      ];
      if (eids.length) {
        L.push("## Edits (already written to the knowledge base)", "");
        eids.forEach(function (aid, i) {
          var e = edits[aid];
          L.push("### " + (i + 1) + " · " + (e.crumb || ""));
          L.push("- BEFORE: " + e.orig);
          L.push("+ AFTER:  " + e.cur);
          L.push("");
        });
      }
      if (nids.length) {
        L.push("## Notes", "");
        nids.forEach(function (aid, i) {
          var n = notes[aid];
          L.push("### " + (i + 1) + " · " + (n.crumb || ""));
          L.push("> " + anchorText(aid));
          L.push("**Note:** " + n.note);
          L.push("");
        });
      }
      return L.join("\n").trim();
    }

    function downloadMd() {
      var md = buildMarkdown();
      if (!md) return;
      var blob = new Blob([md], { type: "text/markdown" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "cv-changes.md";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }

    function clearAll() {
      if (!Object.keys(notes).length && !Object.keys(edits).length) return;
      if (!global.confirm("Discard all notes and revert every edit on this page to the rendered text?")) return;
      Object.keys(edits).forEach(function (aid) {
        var el = byAid(aid);
        if (el && orig[aid]) el.innerHTML = orig[aid].html;
        onEdit(aid, null);
      });
      Object.keys(notes).forEach(function (aid) { onNote(aid, null); });
      notes = {};
      edits = {};
      render();
    }

    /* --------------------------------------------------------- wiring */

    function onClick(ev) {
      if (!annotate || destroyed) return;
      if (ev.target.closest("#ck-note-editor")) return;
      if (ev.target.closest(".note-badge")) return;
      var el = ev.target.closest("[data-aid]");
      if (el && anchorEls().indexOf(el) >= 0) openEditor(el);
    }

    function onInput(ev) {
      if (!editMode || destroyed) return;
      var el = ev.target.closest("[data-aid]");
      if (!el) return;
      var aid = el.getAttribute("data-aid");
      var cur = cleanContent(el);
      var base = orig[aid] || { text: "", html: "" };
      if (cur.text !== base.text) {
        edits[aid] = {
          orig: base.text, cur: cur.text, curHTML: cur.html,
          crumb: el.getAttribute("data-crumb") || "", ts: new Date().toISOString(),
        };
        el.classList.add("edited");
      } else {
        delete edits[aid];
        el.classList.remove("edited");
      }
      flushEdit(aid);
      updateCounts();
      exportBox.value = buildMarkdown();
      if (drawer.classList.contains("open")) renderDrawer();
    }

    function onKey(ev) {
      if (destroyed) return;
      if (ev.key === "Escape") { closeEditor(); closeDrawer(); }
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter" && editor.style.display === "block") {
        ev.preventDefault();
        saveNote();
      }
    }

    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("keydown", onKey);

    /* ----------------------------------------------------------- boot */

    function refresh() {
      initAnchors();
      captureOrig();
      render();
    }

    /* Stored state arrives after the baseline exists, never before. */
    function hydrate(state) {
      var s = state || {};
      notes = s.notes ? JSON.parse(JSON.stringify(s.notes)) : {};
      edits = s.edits ? JSON.parse(JSON.stringify(s.edits)) : {};
      Object.keys(edits).forEach(function (aid) {
        var el = byAid(aid);
        if (el && typeof edits[aid].curHTML === "string") el.innerHTML = edits[aid].curHTML;
      });
      render();
    }

    function destroy() {
      destroyed = true;
      document.removeEventListener("click", onClick);
      document.removeEventListener("input", onInput);
      document.removeEventListener("keydown", onKey);
      editor.remove(); scrim.remove(); drawer.remove();
    }

    refresh();
    try {
      var saved = localStorage.getItem(storageKey + ":mode");
      if (saved === "edit" || saved === "note") setMode(saved);
    } catch (e) { /* preferences only */ }

    return {
      refresh: refresh,
      hydrate: hydrate,
      buildMarkdown: buildMarkdown,
      downloadMd: downloadMd,
      openDrawer: openDrawer,
      closeDrawer: closeDrawer,
      toggleEdit: toggleEdit,
      toggleNote: toggleNote,
      setMode: setMode,
      clearAll: clearAll,
      jumpTo: jumpTo,
      counts: counts,
      getState: function () { return { edits: edits, notes: notes }; },
      destroy: destroy,
    };
  }

  global.CareerAnnotate = { create: create, defaultCrumb: defaultCrumb };
})(typeof window !== "undefined" ? window : this);
