import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, vi } from "vitest";

vi.unmock("node:fs");

test("host-provided modules are wildcard peers, not runtime dependencies", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  const hostPackages = new Set([
    ...["@earendil-works", "@mariozechner"].flatMap((scope) =>
      ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-tui"].map(
        (name) => `${scope}/${name}`,
      ),
    ),
    "typebox",
    "@sinclair/typebox",
  ]);

  for (const name of Object.keys(manifest.dependencies ?? {})) {
    assert.equal(
      hostPackages.has(name),
      false,
      `${name} must be host-provided`,
    );
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (hostPackages.has(name)) assert.equal(range, "*", name);
  }
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
    "typebox",
  ]) {
    assert.equal(manifest.peerDependencies?.[name], "*", name);
    assert.ok(
      manifest.devDependencies?.[name],
      `${name} is needed for local tests`,
    );
  }
  for (const name of [
    "@mariozechner/pi-ai",
    "@mariozechner/pi-coding-agent",
    "@mariozechner/pi-tui",
  ]) {
    assert.equal(manifest.peerDependencies?.[name], undefined, name);
    assert.equal(manifest.devDependencies?.[name], undefined, name);
  }
});
