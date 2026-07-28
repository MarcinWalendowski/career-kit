/**
 * popup.js - the only thing that can start a capture.
 *
 * Clicking the button injects content.js into the active tab, once. There is no
 * other trigger anywhere in this extension: no declared content script, no
 * alarm, no navigation listener. If the popup is closed, nothing runs.
 *
 * The token lives in chrome.storage.local and is the only credential the
 * extension holds. It is your local previewer's per-boot token, not a
 * credential for any job board, and it never reaches the page.
 */

const $ = (id) => document.getElementById(id);
const els = {
  token: $("token"),
  port: $("port"),
  capture: $("capture"),
  check: $("check"),
  status: $("status"),
  site: $("site"),
};

const SUPPORTED = [
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)workatastartup\.com$/, "Work at a Startup"],
  [/(^|\.)justjoin\.it$/, "justjoin.it"],
  [/(^|\.)nofluffjobs\.com$/, "NoFluffJobs"],
  [/(^|\.)pracuj\.pl$/, "pracuj.pl"],
];

function say(text, kind) {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? ` ${kind}` : "");
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/* ------------------------------------------------------------------- boot */

(async () => {
  const saved = await chrome.storage.local.get(["token", "port", "lastResult"]);
  if (saved.token) els.token.value = saved.token;
  if (saved.port) els.port.value = saved.port;
  if (saved.lastResult) render(saved.lastResult);

  const tab = await activeTab();
  let host = "";
  try {
    host = tab && tab.url ? new URL(tab.url).hostname : "";
  } catch {
    host = "";
  }
  const known = SUPPORTED.find(([re]) => re.test(host));
  if (known) {
    els.site.textContent = `${known[1]}. Ready to capture what is on screen.`;
  } else if (host) {
    els.site.textContent = `${host} has no parser. Supported: LinkedIn, Work at a Startup, justjoin.it, NoFluffJobs, pracuj.pl.`;
    els.capture.disabled = true;
  } else {
    els.site.textContent = "No page in the active tab.";
    els.capture.disabled = true;
  }
})();

/* ---------------------------------------------------------------- persist */

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.local.set({
      token: els.token.value.trim(),
      port: Number(els.port.value) || 8899,
    });
  }, 200);
}
els.token.addEventListener("input", persist);
els.port.addEventListener("input", persist);

/* ---------------------------------------------------------------- actions */

els.capture.addEventListener("click", async () => {
  await chrome.storage.local.set({
    token: els.token.value.trim(),
    port: Number(els.port.value) || 8899,
  });

  const tab = await activeTab();
  if (!tab) return say("No active tab.", "err");

  say("Reading the page.");
  els.capture.disabled = true;
  try {
    // activeTab grants access to this one tab, because you clicked the action.
    // It is not a standing permission on the site.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  } catch (err) {
    els.capture.disabled = false;
    return say(`Could not read this page: ${err.message}`, "err");
  }
  // background.js posts the result, and also stores it, so a popup that closes
  // mid-capture does not lose the outcome.
  setTimeout(() => { els.capture.disabled = false; }, 1500);
});

els.check.addEventListener("click", async () => {
  await chrome.storage.local.set({ token: els.token.value.trim(), port: Number(els.port.value) || 8899 });
  say("Checking.");
  const res = await chrome.runtime.sendMessage({ type: "career-kit/health" });
  if (res && res.ok) {
    say(`Server up. Workspace: ${res.careerHome || "unknown"}`, "ok");
  } else {
    say((res && res.detail) || "No answer from the local server.", "err");
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "career-kit/result") render(msg.result);
});

function render(r) {
  if (!r) return;
  if (r.ok) {
    const parts = [`Wrote ${r.written} to jobs/inbox/`];
    if (r.skipped) parts.push(`${r.skipped} already known`);
    if (r.failed) parts.push(`${r.failed} cards could not be parsed`);
    return say(`${parts.join(". ")}.`, "ok");
  }
  say(r.detail || `Capture failed: ${r.reason || "unknown"}.`, "err");
}
