import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexUrl = new URL("../web/index.html", import.meta.url);
const serverUrl = new URL("../bin/server.mjs", import.meta.url);

test("every external dashboard script is served by the local static file map", async () => {
  const [index, server] = await Promise.all([
    readFile(indexUrl, "utf8"),
    readFile(serverUrl, "utf8"),
  ]);

  const scripts = [...index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);

  assert.ok(scripts.includes("/session.js"), "dashboard must load the session bootstrap");
  assert.ok(scripts.length > 0, "dashboard should reference external scripts");

  for (const script of scripts) {
    assert.match(
      server,
      new RegExp(`\\[\\"${escapeRegExp(script)}\\",\\s*\\[\\"[^\\"]+\\",\\s*\\"text/javascript; charset=utf-8\\"\\]\\]`),
      `${script} must be registered in STATIC_FILES`,
    );
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
