/**
 * background.js - the only place a network request is made.
 *
 * It makes exactly one kind of request, to exactly one host: a POST to
 * http://127.0.0.1:<port>/api/ingest on your own machine. There is no other
 * endpoint, no telemetry, no error reporting, and no host in the manifest
 * besides 127.0.0.1.
 *
 * Why the POST lives here and not in content.js: in MV3 a content script's
 * fetch is subject to the page's CORS policy, so a request from a job board's
 * page to your local server is blocked by the page, not by us. The service
 * worker is the supported place for a cross-origin request the extension owns.
 * It also means the page never sees the token.
 *
 * There is no alarm, no timer and no navigation listener in this file. The
 * service worker wakes when you click, and goes back to sleep.
 */

/**
 * Must match DEFAULT_PORT in engine/serve.mjs. The server owns this number; the
 * extension only follows it. They disagreed once (7749 there, 8899 here) and the
 * result was an extension that could never reach the server on a default install,
 * with no error either side could explain: the POST just failed to connect.
 */
const DEFAULT_PORT = 7749;

/** Read settings once per request rather than caching: a token you rotated
 *  should take effect on the next click, not the next browser restart. */
async function settings() {
  const s = await chrome.storage.local.get(["token", "port"]);
  return { token: s.token || "", port: Number(s.port) || DEFAULT_PORT };
}

function base(port) {
  return `http://127.0.0.1:${port}`;
}

async function ingest(payload) {
  const { token, port } = await settings();
  if (!token) {
    return { ok: false, reason: "no-token", detail: "Paste the previewer token into the popup first." };
  }

  let res;
  try {
    res = await fetch(`${base(port)}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Career-Token": token },
      body: JSON.stringify({ source: payload.source, url: payload.url, jobs: payload.jobs }),
    });
  } catch (err) {
    return {
      ok: false,
      reason: "no-server",
      detail: `Could not reach ${base(port)}. Is the previewer running? (career-serve)`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "bad-token", detail: "The server rejected the token. Copy it again from .previewer-token." };
  }
  if (!res.ok) {
    return { ok: false, reason: "server-error", detail: `Server returned ${res.status}.` };
  }

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  // serve.mjs answers {ok, written, skipped, ids, skippedDetail, dir}. Read
  // `written` rather than the count we sent: the server drops a record it
  // cannot read, and a popup that reports what it POSTed would claim 23
  // captures on a run that wrote 21.
  //
  // The fallback is deliberately the pessimistic direction. If the field ever
  // goes missing we report the POSTed count, which OVERstates, so the failure
  // is visible in the inbox rather than silent. test/integration.test.mjs
  // asserts the field name matches so it should never come to that.
  const written = typeof body.written === "number" ? body.written : payload.jobs.length;
  const skipped = typeof body.skipped === "number"
    ? body.skipped
    : Math.max(0, payload.jobs.length - written);
  return { ok: true, written, dropped: skipped, dir: body.dir || null };
}

async function health() {
  const { token, port } = await settings();
  try {
    const res = await fetch(`${base(port)}/api/health`, { headers: { "X-Career-Token": token } });
    if (!res.ok) return { ok: false, detail: `Server returned ${res.status}.` };
    const body = await res.json();
    return { ok: true, careerHome: body.careerHome || null, version: body.version || null };
  } catch {
    return { ok: false, detail: `No server on ${base(port)}.` };
  }
}

/** The result of the last capture, so the popup can show it even if it was
 *  closed while the capture ran. */
async function publish(result) {
  await chrome.storage.local.set({ lastResult: { ...result, at: new Date().toISOString() } });
  // The popup may be gone. That is not an error worth surfacing.
  chrome.runtime.sendMessage({ type: "career-kit/result", result }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "career-kit/captured") {
    (async () => {
      if (!msg.ok) {
        await publish({ ok: false, reason: msg.reason, detail: msg.detail, source: null });
        return;
      }
      if (!msg.jobs.length) {
        await publish({
          ok: false,
          reason: "nothing-parsed",
          source: msg.source,
          detail: `Captured ${msg.seen} cards, could not parse ${msg.failed}. The site markup probably changed.`,
        });
        return;
      }
      const sent = await ingest(msg);
      await publish({
        ...sent,
        source: msg.source,
        seen: msg.seen,
        parsed: msg.parsed,
        failed: msg.failed,
      });
    })();
    return; // no response expected
  }

  if (msg.type === "career-kit/health") {
    health().then(sendResponse);
    return true; // keep the channel open for the async reply
  }
});
