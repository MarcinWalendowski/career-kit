#!/usr/bin/env node
/**
 * serve.mjs - the previewer's local HTTP server.
 *
 * LOOPBACK IS NOT AUTHENTICATION. Every page open in the user's browser can
 * POST to http://127.0.0.1:<port>, and this server writes files in a private
 * workspace. So four guards, all of them on by default and none of them
 * configurable away:
 *
 *   1. It binds 127.0.0.1 only, never 0.0.0.0.
 *   2. Every /api/* call must carry X-Career-Token, matching a token minted at
 *      boot and written to $CAREER_HOME/.previewer-token with mode 0600. The
 *      previewer page is served with the token already inlined, so the human
 *      never types it.
 *   3. Any request whose Host header is not 127.0.0.1:<port> or
 *      localhost:<port> is rejected with 421. The check is on Host and not on
 *      Origin on purpose: this is the DNS-rebinding guard, and a rebinding
 *      attack arrives with an attacker hostname in Host while Origin looks
 *      like whatever the attacker wants it to look like.
 *   4. /api/ingest additionally requires an Origin of chrome-extension://...
 *      or the loopback origin, because it is the one route a browser extension
 *      is meant to reach.
 *
 * Writes are optimistically concurrent. Claude and the human edit the same
 * knowledge base at the same time, so PUT /api/kb carries the etag it read and
 * gets a 409 if the file moved underneath it. The etag is a content hash and
 * never an mtime, because two writes inside one filesystem timestamp tick are
 * exactly the case that matters.
 *
 * Zero dependencies: node:http and nothing else.
 */

import { createServer as createHttpServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync,
  statSync, writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT, ensureRuntimeDirs, findCareerHome, paths, slug } from "./paths.mjs";
import {
  HiddenTextError, applyAnchorEdit, maskHtmlComments, parseMarkdown, render, scopeCss,
} from "./render.mjs";

const DEFAULT_PORT = 7749;
const PORT_TRIES = 20;
const MAX_BODY = 4 * 1024 * 1024;
const PREVIEWER_DIR = join(PLUGIN_ROOT, "previewer");

const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/annotate.js": ["annotate.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/* ---------------------------------------------------------------- helpers */

export function etagOf(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, 16);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch (e) {
    throw Object.assign(new Error("invalid JSON body: " + e.message), { status: 400 });
  }
}

function readTextFile(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/* ------------------------------------------------------------- audiences */

/**
 * The audience list is read from the workspace, never hardcoded here.
 *
 * career-hub.html held its three framing variants as JS string literals copied
 * out of the knowledge base, which is one of the duplications this whole
 * product exists to stop. So: an explicit audiences.json if the user wrote
 * one, otherwise the subsections of whichever knowledge-base section is about
 * framing, otherwise a single default. Adding a fourth audience is a knowledge
 * base edit and touches no code.
 */
export function readAudiences(P) {
  const explicit = join(P.home, "audiences.json");
  if (existsSync(explicit)) {
    try {
      const data = JSON.parse(readFileSync(explicit, "utf8"));
      const list = Array.isArray(data) ? data : Array.isArray(data.audiences) ? data.audiences : [];
      const mapped = list
        .map((a) => (typeof a === "string" ? { id: slug(a), label: a, text: "" } : {
          id: slug(a.id || a.label || ""), label: a.label || a.id || "", text: a.text || "",
        }))
        .filter((a) => a.id);
      if (mapped.length) return { audiences: mapped, source: "audiences.json" };
    } catch {
      /* fall through to the knowledge base */
    }
  }

  const kb = readTextFile(P.kb);
  if (kb) {
    // The framing-variants section leads with an authoring comment. Without the
    // mask the first "paragraph" under the heading is that comment, so the
    // audience toggle offers it as the variant's text.
    const blocks = parseMarkdown(maskHtmlComments(kb));
    let inSection = false;
    const found = [];
    let current = null;
    for (const b of blocks) {
      if (b.type === "heading" && b.level === 2) {
        inSection = /audience|framing|positioning|variant/i.test(b.text);
        current = null;
        continue;
      }
      if (!inSection) continue;
      if (b.type === "heading" && b.level >= 3) {
        current = { id: slug(b.text), label: b.text.trim(), text: "" };
        found.push(current);
        continue;
      }
      if (current && (b.type === "para" || b.type === "quote") && !current.text) {
        current.text = b.text;
      }
    }
    const usable = found.filter((a) => a.id);
    if (usable.length) return { audiences: usable, source: "knowledge-base.md" };
  }

  return {
    audiences: [{ id: "default", label: "Default", text: "" }],
    source: "fallback",
    hint: 'Add a knowledge-base section whose heading mentions audience or framing, with one "###" subsection per audience, or write audiences.json.',
  };
}

/* ----------------------------------------------------------------- jobs */

function readJobDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const record = JSON.parse(readFileSync(join(dir, f), "utf8"));
        return { ...record, _file: f };
      } catch {
        return { id: f.replace(/\.json$/, ""), _file: f, _unreadable: true };
      }
    });
}

function ingestId(job, index) {
  const base = job.id || [job.company, job.role].filter(Boolean).join("-") || `capture-${index + 1}`;
  return slug(base) || `capture-${index + 1}`;
}

/* --------------------------------------------------------------- server */

export async function startServer(options = {}) {
  const home = options.home || findCareerHome();
  const P = ensureRuntimeDirs(paths(home));
  const token = options.token || randomBytes(32).toString("hex");
  const host = "127.0.0.1";
  const state = { port: 0 };

  const hostAllowed = (headerHost) => {
    const want = [`127.0.0.1:${state.port}`, `localhost:${state.port}`, `[::1]:${state.port}`];
    return want.includes(String(headerHost || "").toLowerCase());
  };

  // Any extension origin, never a fixed id. An unpacked extension gets a new
  // id on every install, so pinning one would break the first thing a new user
  // does, and pinning it buys nothing: an id is not a secret and the token is
  // what actually authorises the call.
  const originAllowed = (origin) => {
    if (!origin) return false;
    if (/^(chrome|moz|safari-web)-extension:\/\/[\w-]+$/i.test(origin)) return true;
    return [`http://127.0.0.1:${state.port}`, `http://localhost:${state.port}`].includes(origin.toLowerCase());
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err && err.status ? err.status : 500;
      send(res, status, { error: err && err.message ? err.message : "internal error" });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, `http://${host}:${state.port}`);
    const path = url.pathname;

    // Guard 3, first, and for every route including the page itself.
    if (!hostAllowed(req.headers.host)) {
      return send(res, 421, {
        error: "misdirected-request",
        detail: "The previewer answers on 127.0.0.1 and localhost only. A different Host header means the request was routed here by a name this server does not serve.",
      });
    }

    if (!path.startsWith("/api/")) return serveStatic(req, res, path);

    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      const headers = originAllowed(origin)
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Career-Token",
            "Access-Control-Max-Age": "600",
          }
        : {};
      return send(res, originAllowed(origin) ? 204 : 403, "", headers);
    }

    // Guard 2.
    if (!safeEqual(req.headers["x-career-token"], token)) {
      return send(res, 401, {
        error: "unauthorized",
        detail: "Every /api/ call needs the X-Career-Token header. The token is minted at boot and stored in .previewer-token.",
      });
    }

    const method = req.method;

    if (path === "/api/health" && method === "GET") {
      return send(res, 200, { ok: true, careerHome: P.home, version: pluginVersion(), port: state.port });
    }

    if (path === "/api/kb" && method === "GET") {
      const text = readTextFile(P.kb);
      const mtime = existsSync(P.kb) ? statSync(P.kb).mtimeMs : null;
      return send(res, 200, { text, etag: etagOf(text), mtime, path: P.kb });
    }

    if (path === "/api/kb" && method === "PUT") {
      const body = await readJson(req);
      if (typeof body.text !== "string") return send(res, 400, { error: "text is required" });
      const current = readTextFile(P.kb);
      const currentEtag = etagOf(current);
      if (body.etag !== undefined && body.etag !== currentEtag) {
        return send(res, 409, {
          error: "stale-etag",
          detail: "The knowledge base changed since you loaded it. Reload to take the file on disk, or resend with the current etag to keep yours.",
          etag: currentEtag,
          text: current,
        });
      }
      writeFileSync(P.kb, body.text, "utf8");
      return send(res, 200, { ok: true, etag: etagOf(body.text), bytes: Buffer.byteLength(body.text) });
    }

    if (path === "/api/cv" && method === "GET") {
      const text = readTextFile(P.kb);
      const theme = (readTextFile(P.cvTheme).trim() || url.searchParams.get("theme") || "default").trim();
      try {
        const out = render(text, { theme, target: "html", home: P.home });
        // The pane gets the .page element and a scoped copy of the theme CSS.
        // A theme styles html, body, h1, ul and li, so injected unscoped it
        // would restyle the previewer around it.
        return send(res, 200, {
          html: out.page, css: scopeCss(out.css, "#cv-host"), anchors: out.anchors,
          title: out.title, theme, fills: out.fills, etag: etagOf(text),
        });
      } catch (e) {
        if (e instanceof HiddenTextError) return send(res, 422, hiddenTextPayload(e));
        throw e;
      }
    }

    if (path === "/api/cv/section" && method === "PUT") {
      const body = await readJson(req);
      if (!body.aid || typeof body.text !== "string") {
        return send(res, 400, { error: "aid and text are required" });
      }
      const current = readTextFile(P.kb);
      const currentEtag = etagOf(current);
      if (body.etag !== undefined && body.etag !== currentEtag) {
        return send(res, 409, { error: "stale-etag", etag: currentEtag, text: current });
      }
      const theme = (readTextFile(P.cvTheme).trim() || "default").trim();
      let anchors;
      try {
        anchors = render(current, { theme, target: "html", home: P.home }).anchors;
      } catch (e) {
        if (e instanceof HiddenTextError) return send(res, 422, hiddenTextPayload(e));
        throw e;
      }
      // The write goes to the knowledge base. There is no rendered file to edit:
      // every CV surface is derived, and a fact lives in exactly one place.
      const next = applyAnchorEdit(current, anchors, body.aid, body.text);
      if (next === null) return send(res, 404, { error: "unknown-anchor", aid: body.aid });
      writeFileSync(P.kb, next, "utf8");
      return send(res, 200, { ok: true, etag: etagOf(next), aid: body.aid, target: P.kb });
    }

    if (path === "/api/notes" && method === "GET") {
      const file = notesFile(P);
      const notes = existsSync(file) ? JSON.parse(readTextFile(file) || "{}") : {};
      return send(res, 200, { notes, etag: etagOf(JSON.stringify(notes)) });
    }

    if (path === "/api/notes" && method === "PUT") {
      const body = await readJson(req);
      const file = notesFile(P);
      let notes = existsSync(file) ? JSON.parse(readTextFile(file) || "{}") : {};
      if (body.notes && typeof body.notes === "object") {
        notes = body.notes;
      } else if (body.aid) {
        if (!body.note) delete notes[body.aid];
        else notes[body.aid] = typeof body.note === "string" ? { note: body.note, ts: new Date().toISOString() } : body.note;
      } else {
        return send(res, 400, { error: "send {aid, note} or {notes}" });
      }
      writeFileSync(file, JSON.stringify(notes, null, 2) + "\n", "utf8");
      return send(res, 200, { ok: true, count: Object.keys(notes).length, etag: etagOf(JSON.stringify(notes)) });
    }

    if (path === "/api/audiences" && method === "GET") {
      return send(res, 200, readAudiences(P));
    }

    if (path === "/api/render" && method === "POST") {
      const body = await readJson(req);
      const target = body.target || "html";
      if (!["html", "md", "pdf"].includes(target)) {
        return send(res, 400, { error: "target must be html, md or pdf" });
      }
      const theme = (body.theme || readTextFile(P.cvTheme).trim() || "default").trim();
      const text = readTextFile(P.kb);
      try {
        const out = render(text, {
          theme, target, home: P.home,
          outDir: P.outputs,
          out: target === "pdf" ? join(P.outputs, "cv.pdf") : undefined,
        });
        return send(res, 200, {
          ok: true, target, theme, title: out.title,
          html: target === "html" ? out.html : undefined,
          css: target === "html" ? out.css : undefined,
          md: out.md, pdfPath: out.pdfPath, warnings: out.warnings,
        });
      } catch (e) {
        if (e instanceof HiddenTextError) return send(res, 422, hiddenTextPayload(e));
        throw e;
      }
    }

    if (path === "/api/jobs" && method === "GET") {
      const wantStatus = url.searchParams.get("status");
      let jobs = readJobDir(P.jobs);
      if (url.searchParams.get("inbox") === "1") jobs = jobs.concat(readJobDir(P.jobsInbox).map((j) => ({ ...j, _inbox: true })));
      if (wantStatus) jobs = jobs.filter((j) => j.status === wantStatus);
      return send(res, 200, { jobs, count: jobs.length });
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
    if (jobMatch && method === "GET") {
      const id = slug(decodeURIComponent(jobMatch[1]));
      for (const dir of [P.jobs, P.jobsInbox]) {
        const file = join(dir, `${id}.json`);
        if (!existsSync(file)) continue;
        try {
          return send(res, 200, { job: JSON.parse(readFileSync(file, "utf8")), inbox: dir === P.jobsInbox });
        } catch (e) {
          return send(res, 500, { error: "unreadable-record", detail: e.message, id });
        }
      }
      return send(res, 404, { error: "not-found", id });
    }

    if (path === "/api/ingest" && method === "POST") {
      // Guard 4. This is the only route a browser extension is meant to reach.
      const origin = req.headers.origin;
      if (!originAllowed(origin)) {
        return send(res, 403, {
          error: "origin-not-allowed",
          detail: "Ingest accepts the extension origin or the loopback origin only.",
        });
      }
      const body = await readJson(req);
      const jobs = Array.isArray(body.jobs) ? body.jobs : null;
      if (!jobs) return send(res, 400, { error: "jobs must be an array" });
      if (!body.source) return send(res, 400, { error: "source is required" });

      // Captures land in jobs/inbox/ and never in jobs/. A record only leaves
      // the inbox once triage has resolved its apply route and identity, which
      // is why the channel is "none" here rather than a guess from the page.
      mkdirSync(P.jobsInbox, { recursive: true });
      const now = new Date().toISOString();
      const written = [];
      const skipped = [];
      jobs.forEach((job, i) => {
        if (!job || typeof job !== "object") {
          skipped.push({ index: i, reason: "not-an-object" });
          return;
        }
        const id = ingestId(job, i);
        const record = {
          ...job,
          id,
          source: job.source || body.source,
          url: job.url || body.url || null,
          apply: { channel: "none", ...(job.apply || {}) },
          status: "discovered",
          discovered_at: job.discovered_at || now,
          captured_at: now,
        };
        writeFileSync(join(P.jobsInbox, `${id}.json`), JSON.stringify(record, null, 2) + "\n", "utf8");
        written.push(id);
      });
      const headers = { "Access-Control-Allow-Origin": origin };
      // One name per number. `ingested` used to sit here alongside `written`
      // carrying the identical value, which is how a reader picks the wrong one
      // and how the two drift the first time only one is updated. Nothing has
      // shipped yet, so there is no reason to keep both.
      return send(res, 200, {
        ok: true,
        written: written.length,
        skipped: skipped.length,
        ids: written,
        skippedDetail: skipped,
        dir: P.jobsInbox,
      }, headers);
    }

    return send(res, 404, { error: "no-such-route", path, method });
  }

  function serveStatic(req, res, path) {
    const entry = STATIC_FILES[path];
    if (!entry || req.method !== "GET") return send(res, 404, { error: "not-found", path });
    const [name, type] = entry;
    const file = join(PREVIEWER_DIR, name);
    if (!existsSync(file)) return send(res, 404, { error: "previewer file missing", file });
    let body = readFileSync(file, "utf8");
    if (extname(name) === ".html") {
      // The token is inlined so the human never types it. A page from another
      // origin cannot read this one's DOM, so a meta tag is a fine carrier and
      // it keeps script-src at 'self' with no inline script.
      body = body.replace(/__CAREER_TOKEN__/g, token).replace(/__CAREER_PORT__/g, String(state.port));
    }
    return send(res, 200, body, {
      "Content-Type": type,
      "Content-Security-Policy": CSP,
    });
  }

  let port = options.port !== undefined ? Number(options.port) : Number(process.env.CAREER_PORT || DEFAULT_PORT);
  let bound = false;
  let lastError = null;
  const tries = port === 0 ? 1 : PORT_TRIES;
  for (let i = 0; i < tries; i++) {
    try {
      await listenOn(server, port + i, host);
      bound = true;
      state.port = server.address().port;
      break;
    } catch (e) {
      lastError = e;
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  if (!bound) throw lastError || new Error("could not bind a port");

  // The token file is written only once a port is actually bound. A server
  // that failed to start has no business overwriting the token of one that is
  // running, and the token is per boot rather than per workspace: a second
  // previewer on the same workspace takes over the file, and the first keeps
  // serving on the token it printed.
  writeFileSync(P.previewerToken, token + "\n", { mode: 0o600 });
  chmodSync(P.previewerToken, 0o600);

  const url = `http://${host}:${state.port}/`;
  return {
    server,
    port: state.port,
    token,
    url,
    home: P.home,
    paths: P,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

function notesFile(P) {
  return join(P.outputs, "previewer-notes.json");
}

function hiddenTextPayload(err) {
  return {
    error: "hidden-text",
    detail: "The render was refused because the document contains text a human reader cannot see. Make it visible or delete it. This check has no override.",
    findings: err.findings,
    selectors: err.findings.map((f) => f.selector),
  };
}

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener("listening", onListening);
      reject(e);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/* ------------------------------------------------------------------ cli */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i].startsWith("--port=")) out.port = Number(argv[i].split("=")[1]);
    else if (argv[i] === "--home") out.home = argv[++i];
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const started = await startServer(args);
  process.stdout.write(
    `career-kit previewer\n` +
      `  workspace: ${started.home}\n` +
      `  open:      ${started.url}\n` +
      `  token:     ${started.token}\n` +
      `             (also in ${started.paths.previewerToken}, mode 0600)\n` +
      `  Ctrl-C to stop.\n`,
  );
  const stop = async () => {
    await started.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export default { startServer };
