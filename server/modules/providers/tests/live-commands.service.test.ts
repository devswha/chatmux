import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GJC_BUILTIN_COMMANDS,
  scanGjcCommandDirectory,
  dedupeCommandsByName,
  type LiveGjcCommand,
} from "@/modules/providers/services/live-commands.service.js";

test("scanGjcCommandDirectory maps files to slash commands with descriptions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmd-"));
  try {
    await fs.writeFile(
      path.join(root, "omg:easy.md"),
      "---\ndescription: Plain-language answers\n---\nbody\n",
      "utf8",
    );
    await fs.mkdir(path.join(root, "group"), { recursive: true });
    await fs.writeFile(
      path.join(root, "group", "deep.md"),
      "# First heading line\nmore\n",
      "utf8",
    );
    // Non-markdown files must be ignored.
    await fs.writeFile(path.join(root, "notes.txt"), "ignore me", "utf8");

    const commands = await scanGjcCommandDirectory(root, "user");
    const byName = new Map(commands.map((command) => [command.name, command]));

    assert.equal(commands.length, 2);
    assert.equal(
      byName.get("/omg:easy")?.description,
      "Plain-language answers",
    );
    assert.equal(byName.get("/omg:easy")?.namespace, "user");
    assert.equal(byName.get("/omg:easy")?.scope, "user");
    // A frontmatter-less file falls back to its first content line (heading stripped).
    assert.equal(byName.get("/group/deep")?.description, "First heading line");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scanGjcCommandDirectory returns [] for a missing directory", async () => {
  const missing = path.join(os.tmpdir(), "gjc-cmd-does-not-exist-xyz", "nope");
  assert.deepEqual(await scanGjcCommandDirectory(missing, "project"), []);
});
test("scanGjcCommandDirectory caps command discovery at 500 files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmd-limit-"));
  try {
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        fs.writeFile(path.join(root, `command-${index}.md`), "body\n", "utf8"),
      ),
    );

    assert.equal((await scanGjcCommandDirectory(root, "user")).length, 500);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("scanGjcCommandDirectory rejects roots and entries that escape containment", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmd-contained-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-cmd-outside-"));
  try {
    await fs.writeFile(path.join(root, "safe.md"), "safe\n", "utf8");
    await fs.writeFile(path.join(outside, "escaped.md"), "escaped\n", "utf8");
    await fs.symlink(outside, path.join(root, "escaped-dir"));

    const commands = await scanGjcCommandDirectory(root, "project", root);
    assert.deepEqual(
      commands.map((command) => command.name),
      ["/safe"],
    );
    assert.deepEqual(
      await scanGjcCommandDirectory(outside, "project", root),
      [],
    );
    assert.deepEqual(
      await scanGjcCommandDirectory(
        path.join(root, "escaped-dir"),
        "project",
        root,
      ),
      [],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("dedupeCommandsByName keeps the first occurrence of each name", () => {
  const input: LiveGjcCommand[] = [
    {
      name: "/omg:easy",
      description: "native",
      namespace: "user",
      scope: "user",
    },
    {
      name: "/omg:easy",
      description: "skill dupe",
      namespace: "skill",
      scope: "user",
    },
    { name: "/other", description: "", namespace: "project", scope: "project" },
  ];
  const out = dedupeCommandsByName(input);
  assert.equal(out.length, 2);
  assert.equal(out[0].description, "native");
  assert.equal(out[1].name, "/other");
});

test("the gjc builtin catalog exposes native TUI commands and wins dedupe over file commands", () => {
  // Regression: the live command list only scanned on-disk markdown, so the
  // TUI's own commands (/clear, /compact, /model, ...) never reached the deck.
  const names = new Set(GJC_BUILTIN_COMMANDS.map((command) => command.name));
  for (const expected of ["/clear", "/compact", "/model", "/resume", "/effort", "/context"]) {
    assert.ok(names.has(expected), `builtin catalog must include ${expected}`);
  }
  assert.ok(
    GJC_BUILTIN_COMMANDS.every(
      (command) => command.namespace === "builtin" && command.description.length > 0,
    ),
  );

  // A user markdown file named like a builtin must not shadow the native one.
  const merged = dedupeCommandsByName([
    ...GJC_BUILTIN_COMMANDS,
    { name: "/clear", description: "user file", namespace: "user", scope: "user" },
  ]);
  const clear = merged.filter((command) => command.name === "/clear");
  assert.equal(clear.length, 1);
  assert.equal(clear[0].namespace, "builtin");
});
