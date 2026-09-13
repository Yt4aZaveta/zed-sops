import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
  findSopsConfigPath,
  isAutoEditAllowed,
  pathMatchesCreationRules,
} from "../src/sops-config";
import { makeTempDir, writeFile } from "./helpers";

const catchAll = "creation_rules:\n  - age: age1test\n";

describe("findSopsConfigPath", () => {
  it("returns undefined when no .sops.yaml exists", async () => {
    const root = await makeTempDir();
    const file = path.join(root, "secrets.yaml");
    await writeFile(file, "a: 1\n");
    assert.equal(findSopsConfigPath(file, [root]), undefined);
  });

  it("walk-up finds nested config before parent", async () => {
    const root = await makeTempDir();
    const nested = path.join(root, "app");
    const file = path.join(nested, "secrets.yaml");
    await writeFile(path.join(root, ".sops.yaml"), "creation_rules: []\n");
    await writeFile(path.join(nested, ".sops.yaml"), catchAll);
    await writeFile(file, "a: 1\n");
    assert.equal(
      findSopsConfigPath(file, [root]),
      path.join(nested, ".sops.yaml")
    );
  });

  it("does not walk above the workspace folder", async () => {
    const root = await makeTempDir();
    const ws = path.join(root, "ws");
    const file = path.join(ws, "secrets.yaml");
    await writeFile(path.join(root, ".sops.yaml"), catchAll);
    await writeFile(file, "a: 1\n");
    assert.equal(findSopsConfigPath(file, [ws]), undefined);
  });

  it("looks only in the file directory when no workspace folder contains it", async () => {
    const root = await makeTempDir();
    const dir = path.join(root, "only");
    const file = path.join(dir, "secrets.yaml");
    await writeFile(path.join(root, ".sops.yaml"), catchAll);
    await writeFile(file, "a: 1\n");
    assert.equal(findSopsConfigPath(file, []), undefined);
    await writeFile(path.join(dir, ".sops.yml"), catchAll);
    assert.equal(
      findSopsConfigPath(file, []),
      path.join(dir, ".sops.yml")
    );
  });
});

describe("pathMatchesCreationRules", () => {
  it("does not match when creation_rules is missing or not an array", () => {
    const configPath = path.join("/ws", ".sops.yaml");
    const file = path.join("/ws", "secrets.yaml");
    assert.equal(pathMatchesCreationRules(file, configPath, {}), false);
    assert.equal(
      pathMatchesCreationRules(file, configPath, { creation_rules: "nope" }),
      false
    );
  });

  it("matches secrets/.* relative to the config dir, not other/a.yaml", () => {
    const configPath = path.join("/ws", ".sops.yaml");
    const parsed = { creation_rules: [{ path_regex: "secrets/.*" }] };
    assert.equal(
      pathMatchesCreationRules(
        path.join("/ws", "secrets", "a.yaml"),
        configPath,
        parsed
      ),
      true
    );
    assert.equal(
      pathMatchesCreationRules(
        path.join("/ws", "other", "a.yaml"),
        configPath,
        parsed
      ),
      false
    );
  });

  it("treats a rule without path_regex as a catch-all", () => {
    const configPath = path.join("/ws", ".sops.yaml");
    assert.equal(
      pathMatchesCreationRules(
        path.join("/ws", "any", "file.yaml"),
        configPath,
        { creation_rules: [{ age: "age1x" }] }
      ),
      true
    );
  });

  it("does not throw on invalid regex and does not match that rule", () => {
    const configPath = path.join("/ws", ".sops.yaml");
    const warnings: string[] = [];
    assert.equal(
      pathMatchesCreationRules(
        path.join("/ws", "a.yaml"),
        configPath,
        { creation_rules: [{ path_regex: "(" }] },
        (msg) => warnings.push(msg)
      ),
      false
    );
    assert.ok(warnings.length >= 1);
  });
});

describe("isAutoEditAllowed", () => {
  it("is false when autoEdit is false even if a catch-all rule matches", async () => {
    const root = await makeTempDir();
    const file = path.join(root, "secrets.yaml");
    await writeFile(path.join(root, ".sops.yaml"), catchAll);
    await writeFile(file, "a: 1\n");
    assert.equal(
      await isAutoEditAllowed(file, { autoEdit: false }, [root]),
      false
    );
  });

  it("is true when autoEdit is true and a catch-all rule matches", async () => {
    const root = await makeTempDir();
    const file = path.join(root, "secrets.yaml");
    await writeFile(path.join(root, ".sops.yaml"), catchAll);
    await writeFile(file, "a: 1\n");
    assert.equal(
      await isAutoEditAllowed(file, { autoEdit: true }, [root]),
      true
    );
  });

  it("is false when the absolute path contains /.git/ even if a catch-all matches", async () => {
    const root = await makeTempDir();
    const file = path.join(root, ".git", "secrets.yaml");
    await writeFile(path.join(root, ".sops.yaml"), catchAll);
    await writeFile(file, "a: 1\n");
    assert.equal(
      await isAutoEditAllowed(file, { autoEdit: true }, [root]),
      false
    );
  });

  it("is false when no config file exists", async () => {
    const root = await makeTempDir();
    const file = path.join(root, "secrets.yaml");
    await writeFile(file, "a: 1\n");
    assert.equal(
      await isAutoEditAllowed(file, { autoEdit: true }, [root]),
      false
    );
  });
});
