/*
 * serve.test.mjs - the previewer server's guards, as negative controls.
 *
 * Every assertion here is a removal test: take the guard away and the case
 * passes instead of failing. That is the point. A local server that writes
 * files in a private workspace is reachable by every page in the browser, so
 * "it worked when I clicked around" is not evidence about any of this.
 *
 * The requests go through node:http rather than fetch because two of these
 * tests need to set headers fetch will not let you set, Host being the whole
 * subject of one of them.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../engine/serve.mjs";

const KB = [
  "# Ada Lovelace",
  "",
  "## Summary",
  "",
  "Engineer who ships whole products.",
  "",
  "## Experience",
  "",
  "### Analytical Engines Ltd",
  "",
  "- Shipped the first program",
  "",
].join("\n");

let home;
let server;

function call(opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign({}, o.headers || {});
    if (o.token !== null) headers["X-Career-Token"] = o.token || server.token;
    let body;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = httpRequest(
      { host: "127.0.0.1", port: server.port, method: o.method || "GET", path: o.path, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { text += c; });
        res.on("end", () => {
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
          resolve({ status: res.statusCode, headers: res.headers, text, data });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

before(async () => {
  home = mkdtempSync(join(tmpdir(), "career-home-"));
  writeFileSync(join(home, "profile.yaml"), "name: Ada Lovelace\n", "utf8");
  writeFileSync(join(home, "knowledge-base.md"), KB, "utf8");
  // Port 0 asks the OS for an ephemeral port, so a developer running the real
  // previewer on 7749 does not collide with the suite.
  server = await startServer({ home, port: 0 });
});

after(async () => {
  if (server) await server.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("guards", () => {
  it("mints a token at boot and stores it 0600", () => {
    const file = join(home, ".previewer-token");
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, "utf8").trim(), server.token);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(server.token.length >= 32);
  });

  it("gives 401 without a token", async () => {
    const r = await call({ path: "/api/health", token: null });
    assert.equal(r.status, 401);
    assert.equal(r.data.error, "unauthorized");
  });

  it("gives 401 for a wrong token", async () => {
    const r = await call({ path: "/api/health", token: "0".repeat(64) });
    assert.equal(r.status, 401);
  });

  it("gives 421 for a non-loopback Host header", async () => {
    const r = await call({ path: "/api/health", headers: { Host: "career.example.com" } });
    assert.equal(r.status, 421);
    assert.equal(r.data.error, "misdirected-request");
  });

  it("gives 421 before it checks the token, so rebinding learns nothing", async () => {
    const r = await call({ path: "/api/health", token: null, headers: { Host: "attacker.test" } });
    assert.equal(r.status, 421);
  });

  it("accepts localhost as a Host", async () => {
    const r = await call({ path: "/api/health", headers: { Host: `localhost:${server.port}` } });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.careerHome, home);
  });

  it("never caches an API response", async () => {
    const r = await call({ path: "/api/health" });
    assert.equal(r.headers["cache-control"], "no-store");
  });

  it("serves the page with a CSP and the token inlined", async () => {
    const r = await call({ path: "/", token: null });
    assert.equal(r.status, 200);
    assert.match(r.headers["content-security-policy"], /default-src 'none'/);
    assert.ok(r.text.includes(server.token));
    assert.ok(!r.text.includes("__CAREER_TOKEN__"));
  });
});

describe("knowledge base", () => {
  it("reads the file with a content hash etag", async () => {
    const r = await call({ path: "/api/kb" });
    assert.equal(r.status, 200);
    assert.equal(r.data.text, KB);
    assert.equal(r.data.etag.length, 16);
  });

  it("writes when the etag matches", async () => {
    const read = await call({ path: "/api/kb" });
    const next = read.data.text + "\nA new line.\n";
    const w = await call({ path: "/api/kb", method: "PUT", body: { text: next, etag: read.data.etag } });
    assert.equal(w.status, 200);
    assert.notEqual(w.data.etag, read.data.etag);
    assert.equal(readFileSync(join(home, "knowledge-base.md"), "utf8"), next);
  });

  it("gives 409 on a stale etag and hands back the current file", async () => {
    const r = await call({
      path: "/api/kb",
      method: "PUT",
      body: { text: "clobbered", etag: "0000000000000000" },
    });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, "stale-etag");
    assert.ok(r.data.text.includes("Ada Lovelace"));
    assert.notEqual(readFileSync(join(home, "knowledge-base.md"), "utf8"), "clobbered");
  });
});

describe("cv write-through", () => {
  it("edits a bullet and the change lands in the knowledge base", async () => {
    const cv = await call({ path: "/api/cv" });
    assert.equal(cv.status, 200);
    const bullet = cv.data.anchors.find((a) => a.text.startsWith("Shipped"));
    assert.ok(bullet, "no bullet anchor in the render");

    const w = await call({
      path: "/api/cv/section",
      method: "PUT",
      body: { aid: bullet.aid, text: "Shipped the first program, then the notes" },
    });
    assert.equal(w.status, 200);
    assert.equal(w.data.target, join(home, "knowledge-base.md"));

    const kb = readFileSync(join(home, "knowledge-base.md"), "utf8");
    assert.ok(kb.includes("- Shipped the first program, then the notes"));
    // There is no rendered file to go stale: the CV is derived on read.
    assert.ok(!existsSync(join(home, "cv", "cv.html")));

    // The other half of the P3 gate: the re-render shows the edited line.
    const again = await call({ path: "/api/cv" });
    assert.ok(again.data.html.includes("Shipped the first program, then the notes"));
    assert.ok(again.data.anchors.some((a) => a.text === "Shipped the first program, then the notes"));
    assert.notEqual(again.data.etag, cv.data.etag);
  });

  it("gives 404 for an anchor that is not in the document", async () => {
    const r = await call({ path: "/api/cv/section", method: "PUT", body: { aid: "no-such-1", text: "x" } });
    assert.equal(r.status, 404);
    assert.equal(r.data.error, "unknown-anchor");
  });
});

describe("render", () => {
  it("gives 422 and names the selector when the document hides text", async () => {
    // A workspace theme is the realistic attack surface: knowledge base text is
    // escaped on render, so hidden text has to arrive through a stylesheet.
    mkdirSync(join(home, "cv", "themes", "hostile"), { recursive: true });
    writeFileSync(
      join(home, "cv", "themes", "hostile", "theme.css"),
      ".cv-doc{background:#ffffff}\n.cv-doc li{color:#ffffff;font-size:0}\n",
      "utf8",
    );
    writeFileSync(join(home, "cv", "theme"), "hostile\n", "utf8");

    const r = await call({ path: "/api/render", method: "POST", body: { target: "html" } });
    assert.equal(r.status, 422);
    assert.equal(r.data.error, "hidden-text");
    assert.ok(r.data.findings.length > 0);
    assert.ok(r.data.selectors.some((s) => s.includes("li")), JSON.stringify(r.data.selectors));
    assert.match(r.data.detail, /no override/);
  });

  it("renders again once the hidden text is gone", async () => {
    writeFileSync(join(home, "cv", "themes", "hostile", "theme.css"), ".cv-doc li{color:#333}\n", "utf8");
    const r = await call({ path: "/api/render", method: "POST", body: { target: "md" } });
    assert.equal(r.status, 200);
    assert.match(r.data.md, /Ada Lovelace/);
  });
});

describe("ingest", () => {
  it("writes captures to jobs/inbox and never to jobs", async () => {
    const r = await call({
      path: "/api/ingest",
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${server.port}` },
      body: {
        source: "linkedin",
        jobs: [
          { company: "Analytical Engines", role: "Founding Engineer", url: "https://example.com/1" },
          { id: "difference-engine-swe", company: "Difference Engine", role: "Software Engineer" },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.ingested, 2);

    const inbox = readdirSync(join(home, "jobs", "inbox"));
    assert.equal(inbox.length, 2);
    assert.ok(inbox.includes("difference-engine-swe.json"));

    const jobs = readdirSync(join(home, "jobs")).filter((f) => f.endsWith(".json"));
    assert.deepEqual(jobs, [], "a capture reached jobs/ and it must never do that");

    const record = JSON.parse(readFileSync(join(home, "jobs", "inbox", "difference-engine-swe.json"), "utf8"));
    assert.equal(record.status, "discovered");
    assert.equal(record.source, "linkedin");
    assert.ok(record.captured_at);
  });

  it("rejects an ingest with no Origin", async () => {
    const r = await call({ path: "/api/ingest", method: "POST", body: { source: "x", jobs: [] } });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, "origin-not-allowed");
  });

  it("rejects an ingest from a web page origin", async () => {
    const r = await call({
      path: "/api/ingest",
      method: "POST",
      headers: { Origin: "https://jobs.example.com" },
      body: { source: "x", jobs: [{ company: "Evil" }] },
    });
    assert.equal(r.status, 403);
    assert.ok(!existsSync(join(home, "jobs", "inbox", "evil.json")));
  });

  it("still needs the token", async () => {
    const r = await call({
      path: "/api/ingest",
      method: "POST",
      token: null,
      headers: { Origin: `http://127.0.0.1:${server.port}` },
      body: { source: "x", jobs: [] },
    });
    assert.equal(r.status, 401);
  });
});

describe("jobs and notes", () => {
  it("lists jobs and reads one back", async () => {
    mkdirSync(join(home, "jobs"), { recursive: true });
    writeFileSync(
      join(home, "jobs", "analytical-engines-founding.json"),
      JSON.stringify({ id: "analytical-engines-founding", company: "Analytical Engines", status: "drafted" }),
      "utf8",
    );
    const list = await call({ path: "/api/jobs?status=drafted" });
    assert.equal(list.status, 200);
    assert.equal(list.data.count, 1);

    const one = await call({ path: "/api/jobs/analytical-engines-founding" });
    assert.equal(one.status, 200);
    assert.equal(one.data.job.company, "Analytical Engines");

    const missing = await call({ path: "/api/jobs/nope" });
    assert.equal(missing.status, 404);
  });

  it("round-trips a note", async () => {
    const w = await call({ path: "/api/notes", method: "PUT", body: { aid: "s0-0", note: { note: "tighten this", ts: "2026-07-28T00:00:00Z" } } });
    assert.equal(w.status, 200);
    assert.equal(w.data.count, 1);
    const r = await call({ path: "/api/notes" });
    assert.equal(r.data.notes["s0-0"].note, "tighten this");

    const d = await call({ path: "/api/notes", method: "PUT", body: { aid: "s0-0", note: null } });
    assert.equal(d.data.count, 0);
  });

  it("reads the audience list from the workspace rather than from code", async () => {
    const fallback = await call({ path: "/api/audiences" });
    assert.equal(fallback.data.source, "fallback");

    writeFileSync(
      join(home, "audiences.json"),
      JSON.stringify([{ id: "startup", label: "Startup", text: "Ships fast." }, { id: "enterprise", label: "Enterprise", text: "Reviewable." }]),
      "utf8",
    );
    const r = await call({ path: "/api/audiences" });
    assert.equal(r.data.source, "audiences.json");
    assert.equal(r.data.audiences.length, 2);
    assert.equal(r.data.audiences[0].label, "Startup");
  });
});

describe("binding", () => {
  it("falls forward when the requested port is taken, and mints a fresh token", async () => {
    const second = await startServer({ home, port: server.port });
    try {
      assert.notEqual(second.port, server.port);
      assert.ok(second.port > server.port);
      assert.notEqual(second.token, server.token);
      // The first server's token is now the stale one on disk, so it must not
      // be accepted by the process that did not mint it.
      const r = await new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1", port: second.port, path: "/api/health",
            headers: { "X-Career-Token": server.token },
          },
          (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode })); },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(r.status, 401);
    } finally {
      await second.close();
    }
  });
});

describe("routing", () => {
  it("gives 404 for an unknown api route", async () => {
    const r = await call({ path: "/api/nope" });
    assert.equal(r.status, 404);
  });

  it("serves only the four previewer files", async () => {
    for (const path of ["/style.css", "/app.js", "/annotate.js"]) {
      const r = await call({ path, token: null });
      assert.equal(r.status, 200, path);
    }
    const traversal = await call({ path: "/../engine/serve.mjs", token: null });
    assert.equal(traversal.status, 404);
  });
});
