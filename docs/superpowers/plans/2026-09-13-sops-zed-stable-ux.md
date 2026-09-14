# SOPS for Zed: stable edit UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace auto-decrypt-on-open with an explicit, queued SOPS edit session (sidecar `*.decrypted.*`, diagnostics, code action) and wire real Zed settings plus a single bundled LSP.

**Architecture:** Thin Rust WASM host starts one bundled Node LSP. The LSP owns detection, `.sops.yaml` matching, `sops` exec, and an `EditSessionRegistry` (save queue, stale-disk check, ciphertext backup/rollback). WASM only embeds `server/dist/index.js`, launches Node, and passes `LspSettings` + `which("sops")` + `shell_env()`.

**Tech Stack:** TypeScript / Node 22 (`tsx --test`, `esbuild` CJS bundle), `vscode-languageserver` 9, `yaml`, `zed_extension_api` 0.7.0 (Rust WASM).

**Spec:** `docs/superpowers/specs/2026-09-13-sops-zed-stable-ux-design.md`

## Global Constraints

- Languages: YAML, JSON, TOML only. Do not attach Plain Text. Do not add dotenv / `.env` as a first-class type.
- Do not implement encrypt-new-file via `creation_rules`, virtual `sops://` docs, hover/definition/completion/formatting, status-bar items, context menus, or `workDoneProgress`.
- `execFile` only (never `exec`). `maxBuffer` is 10 MiB. Kill `sops` after `timeoutMs` (default `60000`).
- Sidecar files and ciphertext backups are mode `0o600`. EDITOR script is mode `0o755` and must not interpolate paths into the shell; use `cp "$SOPS_ZED_CONTENT" "$1"`.
- URI conversion: Node `fileURLToPath` / `pathToFileURL`. Do not `uri.slice(7)`.
- New sidecar name is `secrets.decrypted.yaml` (insert `.decrypted` before the final extension). Create only that form. Treat legacy `.decrypted~*` as sidecar for adopt/cleanup only.
- Diagnostics source is `sops`, range is line 0, severity Information.
- Tests live in `server/test/` and are never compiled into the esbuild bundle. Runner: `tsx --test`.
- Commit only the bundled `server/dist/index.js` as the runtime JS artifact (Task 6). Do not add creation_rules encryption or dotenv as a drive-by.

## File structure

| File | Role |
|---|---|
| `server/src/types.ts` | `SopsFileType`, `FileState`, `SopsSettings`, `EditSession`, `SopsRunnerLike`, `parseSopsSettings` |
| `server/src/sops-detector.ts` | Ciphertext heuristic, sidecar naming (new + legacy), file type |
| `server/src/sops-config.ts` | Walk-up `.sops.yaml` / `.sops.yml`, `creation_rules` / `path_regex`, `isAutoEditAllowed` |
| `server/src/sops-runner.ts` | `sops decrypt` / `sops <file>` EDITOR trick, `verify()` cache, timeout, `formatSopsError` |
| `server/src/edit-session.ts` | `EditSessionRegistry`: start/adopt/save queue/backup/close/orphan cleanup |
| `server/src/index.ts` | LSP handlers only (init, diagnostics, code action, command, didOpen/Save/Close) |
| `server/src/file-state.ts` | **Delete in Task 5** (replaced by `edit-session.ts`) |
| `server/test/*.test.ts` | Node tests; not bundled |
| `src/lib.rs` | Embed one bundle, start node, pass settings / `which("sops")` / `shell_env()` |
| `extension.toml` | Languages YAML/JSON/TOML; drop Plain Text |
| `server/package.json` | `test` + `build` (tsc --noEmit && esbuild bundle) |
| `build.sh` | npm install + npm run build |
| `README.md` | User-facing sidecar UX + gitignore + language_servers order |

---

### Task 1: Detector + sidecar naming

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/types.ts`
- Modify: `server/src/sops-detector.ts`
- Create: `server/test/detector.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces:
  - `export type SopsFileType = "yaml" | "json" | "ini" | "binary"`
  - `export function isSopsEncrypted(content: string, fileType: SopsFileType): boolean`
  - `export function isDecryptedFile(filePath: string): boolean`
  - `export function getDecryptedPath(encryptedFilePath: string): string`
  - `export function getLegacyDecryptedPath(encryptedFilePath: string): string`
  - `export function getEncryptedPath(decryptedFilePath: string): string`
  - `export function possibleSidecarPaths(encryptedFilePath: string): string[]`
  - `export function detectFileType(filePath: string): SopsFileType`

- [ ] **Step 1: Add the test runner and the failing detector tests**

In `server/package.json` add `tsx` as a devDependency and a test script. Do not change the build script yet.

```json
{
  "name": "zed-sops-server",
  "version": "0.1.0",
  "description": "SOPS Language Server for Zed",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "watch": "tsc --watch",
    "test": "tsx --test test/*.test.ts"
  },
  "dependencies": {
    "vscode-languageserver": "^9.0.1",
    "vscode-languageserver-textdocument": "^1.0.12"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  }
}
```

Create `server/test/detector.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
  detectFileType,
  getDecryptedPath,
  getEncryptedPath,
  getLegacyDecryptedPath,
  isDecryptedFile,
  isSopsEncrypted,
  possibleSidecarPaths,
} from "../src/sops-detector";

describe("detectFileType", () => {
  it("maps yaml/yml/json/ini/toml and defaults other to yaml", () => {
    assert.equal(detectFileType("a.yaml"), "yaml");
    assert.equal(detectFileType("a.yml"), "yaml");
    assert.equal(detectFileType("a.JSON"), "json");
    assert.equal(detectFileType("a.ini"), "ini");
    assert.equal(detectFileType("a.toml"), "binary");
    assert.equal(detectFileType("a.txt"), "yaml");
    assert.equal(detectFileType("secrets.decrypted.yaml"), "yaml");
  });
});

describe("isSopsEncrypted json", () => {
  it("is true when parsed object has sops.version string", () => {
    assert.equal(
      isSopsEncrypted(`{"a":1,"sops":{"version":"3.9.0"}}`, "json"),
      true
    );
  });

  it("is false when sops.version is missing, not an object, or JSON parse fails", () => {
    assert.equal(isSopsEncrypted(`{"a":1}`, "json"), false);
    assert.equal(isSopsEncrypted(`{"sops":{"version":1}}`, "json"), false);
    assert.equal(isSopsEncrypted(`{"sops":null}`, "json"), false);
    assert.equal(isSopsEncrypted(`{not json`, "json"), false);
  });
});

describe("isSopsEncrypted yaml", () => {
  it("is true for a sops: line followed later by a deeper-indented version:", () => {
    const content = "hello: world\nsops:\n    version: 3.9.0\n";
    assert.equal(isSopsEncrypted(content, "yaml"), true);
  });

  it("is false without sops: or without a following indented version:", () => {
    assert.equal(isSopsEncrypted("hello: world\n", "yaml"), false);
    assert.equal(isSopsEncrypted("sops: 1\n", "yaml"), false);
    assert.equal(isSopsEncrypted("sops:\nversion: 3.9.0\n", "yaml"), false);
  });
});

describe("isSopsEncrypted ini", () => {
  it("is true iff content contains [sops]", () => {
    assert.equal(isSopsEncrypted("[sops]\nversion=3.9.0\n", "ini"), true);
    assert.equal(isSopsEncrypted("key=value\n", "ini"), false);
  });
});

describe("isSopsEncrypted toml/binary", () => {
  it("treats [sops], sops.version, or ENC[AES256_GCM as encrypted", () => {
    assert.equal(isSopsEncrypted("[sops]\nversion = \"3.9.0\"\n", "binary"), true);
    assert.equal(isSopsEncrypted("sops.version = \"3.9.0\"\n", "binary"), true);
    assert.equal(
      isSopsEncrypted('k = "ENC[AES256_GCM,data:abc]"\n', "binary"),
      true
    );
  });

  it("is false for random toml", () => {
    assert.equal(isSopsEncrypted("title = \"x\"\n", "binary"), false);
  });
});

describe("sidecar naming", () => {
  it("roundtrips secrets.yaml ↔ secrets.decrypted.yaml", () => {
    const enc = path.join("dir", "secrets.yaml");
    const dec = getDecryptedPath(enc);
    assert.equal(dec, path.join("dir", "secrets.decrypted.yaml"));
    assert.equal(getEncryptedPath(dec), enc);
    assert.equal(isDecryptedFile(dec), true);
    assert.equal(isDecryptedFile(enc), false);
  });

  it("roundtrips foo.bar.yml ↔ foo.bar.decrypted.yml", () => {
    const enc = path.join("x", "foo.bar.yml");
    const dec = getDecryptedPath(enc);
    assert.equal(dec, path.join("x", "foo.bar.decrypted.yml"));
    assert.equal(getEncryptedPath(dec), enc);
  });

  it("treats legacy .decrypted~secrets.yaml as a sidecar whose encrypted path is secrets.yaml", () => {
    const enc = path.join("dir", "secrets.yaml");
    const legacy = getLegacyDecryptedPath(enc);
    assert.equal(legacy, path.join("dir", ".decrypted~secrets.yaml"));
    assert.equal(isDecryptedFile(legacy), true);
    assert.equal(getEncryptedPath(legacy), enc);
    assert.deepEqual(possibleSidecarPaths(enc), [
      path.join("dir", "secrets.decrypted.yaml"),
      path.join("dir", ".decrypted~secrets.yaml"),
    ]);
  });

  it("does not treat an unrelated dotfile as a sidecar", () => {
    assert.equal(isDecryptedFile(path.join("dir", ".env")), false);
    assert.equal(isDecryptedFile(path.join("dir", "decrypted.yaml")), false);
  });
});
```

Run from repo root:

```bash
cd server && npm install && cd ..
```

- [ ] **Step 2: Run detector tests to verify they fail**

Run: `cd server && npm test`

Expected: FAIL — `getLegacyDecryptedPath` / `possibleSidecarPaths` not exported, `secrets.decrypted.yaml` not produced (`getDecryptedPath` still uses `.decrypted~`), `detectFileType("a.toml")` is `"yaml"` not `"binary"`, JSON parse-fail may already return false (ok), toml heuristic missing.

- [ ] **Step 3: Replace types and detector implementation**

The Task 1 gate is `npm test` (detector only), not `tsc`. Keep the existing `FileContext` / `SopsConfig` shapes so `file-state.ts` and `sops-runner.ts` still typecheck until Tasks 3–5 delete them. Add `SopsSettings`, `parseSopsSettings`, `SopsRunnerLike`, and `EditSession` alongside.

Replace `server/src/types.ts` with:

```typescript
export enum FileState {
  DECRYPTED = "decrypted",
  ENCRYPTING = "encrypting",
}

export type SopsFileType = "yaml" | "json" | "ini" | "binary";

export interface FileContext {
  state: FileState;
  encryptedFilePath: string;
  encryptedContent: string;
  decryptedFilePath: string;
  fileType: SopsFileType;
}

export interface SopsConfig {
  sopsPath: string;
  env: Record<string, string>;
}

export interface SopsSettings {
  sopsPath: string;
  env: Record<string, string>;
  autoEdit: boolean;
  timeoutMs: number;
}

export const DEFAULT_SOPS_SETTINGS: SopsSettings = {
  sopsPath: "sops",
  env: {},
  autoEdit: true,
  timeoutMs: 60_000,
};

export function parseSopsSettings(
  raw: unknown,
  defaults: SopsSettings = DEFAULT_SOPS_SETTINGS
): SopsSettings {
  const obj =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const env =
    obj.env && typeof obj.env === "object" && !Array.isArray(obj.env)
      ? Object.fromEntries(
          Object.entries(obj.env as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : defaults.env;
  return {
    sopsPath:
      typeof obj.sopsPath === "string" && obj.sopsPath.length > 0
        ? obj.sopsPath
        : defaults.sopsPath,
    env,
    autoEdit: typeof obj.autoEdit === "boolean" ? obj.autoEdit : defaults.autoEdit,
    timeoutMs:
      typeof obj.timeoutMs === "number" && Number.isFinite(obj.timeoutMs) && obj.timeoutMs > 0
        ? obj.timeoutMs
        : defaults.timeoutMs,
  };
}

export interface SopsRunnerLike {
  decrypt(filePath: string, fileType: SopsFileType): Promise<string>;
  reEncrypt(filePath: string, plaintext: string, fileType: SopsFileType): Promise<void>;
}

export interface EditSession {
  state: FileState;
  encryptedFilePath: string;
  encryptedContent: string;
  decryptedFilePath: string;
  decryptedUri: string;
  fileType: SopsFileType;
  pending: string | undefined;
}
```

Replace `server/src/sops-detector.ts` with:

```typescript
import * as path from "path";
import { SopsFileType } from "./types";

const LEGACY_PREFIX = ".decrypted~";
const NEW_SIDECAR_RE = /^(.*)\.decrypted(\.[^.]+)$/;

export function isSopsEncrypted(content: string, fileType: SopsFileType): boolean {
  try {
    if (fileType === "json") {
      const parsed = JSON.parse(content);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof parsed.sops === "object" &&
        parsed.sops !== null &&
        typeof parsed.sops.version === "string"
      );
    }

    if (fileType === "yaml") {
      const sopsMatch = content.match(/^sops:\s*$/m);
      if (!sopsMatch || sopsMatch.index === undefined) return false;
      const afterSops = content.slice(sopsMatch.index + sopsMatch[0].length);
      return /^\s+version:\s+/m.test(afterSops);
    }

    if (fileType === "ini") {
      return content.includes("[sops]");
    }

    // toml is passed as binary; same heuristic
    return (
      content.includes("[sops]") ||
      content.includes("sops.version") ||
      content.includes("ENC[AES256_GCM")
    );
  } catch {
    return false;
  }
}

export function isDecryptedFile(filePath: string): boolean {
  const name = path.basename(filePath);
  return name.startsWith(LEGACY_PREFIX) || NEW_SIDECAR_RE.test(name);
}

export function getDecryptedPath(encryptedFilePath: string): string {
  const dir = path.dirname(encryptedFilePath);
  const parsed = path.parse(encryptedFilePath);
  if (parsed.ext !== "") {
    return path.join(dir, `${parsed.name}.decrypted${parsed.ext}`);
  }
  return path.join(dir, `${parsed.base}.decrypted`);
}

export function getLegacyDecryptedPath(encryptedFilePath: string): string {
  return path.join(
    path.dirname(encryptedFilePath),
    `${LEGACY_PREFIX}${path.basename(encryptedFilePath)}`
  );
}

export function getEncryptedPath(decryptedFilePath: string): string {
  const dir = path.dirname(decryptedFilePath);
  const name = path.basename(decryptedFilePath);
  if (name.startsWith(LEGACY_PREFIX)) {
    return path.join(dir, name.slice(LEGACY_PREFIX.length));
  }
  const match = name.match(NEW_SIDECAR_RE);
  if (match) {
    return path.join(dir, `${match[1]}${match[2]}`);
  }
  return decryptedFilePath;
}

export function possibleSidecarPaths(encryptedFilePath: string): string[] {
  return [getDecryptedPath(encryptedFilePath), getLegacyDecryptedPath(encryptedFilePath)];
}

export function detectFileType(filePath: string): SopsFileType {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ini")) return "ini";
  if (lower.endsWith(".toml")) return "binary";
  return "yaml";
}
```

Note: current `index.ts` will now create `secrets.decrypted.yaml` sidecars if someone runs the old LSP. That is acceptable on this branch; Task 5 rewires open behavior.

- [ ] **Step 4: Run detector tests to verify they pass**

Run: `cd server && npm test`

Expected: PASS, all `detector.test.ts` tests.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/types.ts server/src/sops-detector.ts server/test/detector.test.ts
git commit -m "test: rewrite SOPS detector naming and ciphertext heuristics"
```

---

### Task 2: `.sops.yaml` loader and auto-edit matching

**Files:**
- Modify: `server/package.json` (add `yaml` dependency)
- Create: `server/src/sops-config.ts`
- Create: `server/test/helpers.ts`
- Create: `server/test/config.test.ts`

**Interfaces:**
- Consumes: `SopsSettings` / `DEFAULT_SOPS_SETTINGS` from `server/src/types.ts`; `path` / `fs`
- Produces:
  - `export function findSopsConfigPath(encryptedFilePath: string, workspaceFolders: string[]): string | undefined`
  - `export function pathMatchesCreationRules(encryptedFilePath: string, configPath: string, parsed: unknown, warn?: (msg: string) => void): boolean`
  - `export async function isAutoEditAllowed(absolutePath: string, settings: Pick<SopsSettings, "autoEdit">, workspaceFolders: string[], warn?: (msg: string) => void): Promise<boolean>`

- [ ] **Step 1: Add `yaml` and write failing config tests**

```bash
cd server && npm install yaml@^2.7.0 && cd ..
```

Create `server/test/helpers.ts`:

```typescript
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export async function makeTempDir(prefix = "zed-sops-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFile(
  filePath: string,
  content: string,
  mode?: number
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode });
  if (mode !== undefined) {
    await fs.chmod(filePath, mode);
  }
}
```

Create `server/test/config.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run config tests to verify they fail**

Run: `cd server && npm test`

Expected: FAIL with `Cannot find module '../src/sops-config'` (detector tests still pass).

- [ ] **Step 3: Implement `sops-config.ts`**

Create `server/src/sops-config.ts`:

```typescript
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { SopsSettings } from "./types";

function isInside(absFile: string, folder: string): boolean {
  const root = path.resolve(folder);
  const file = path.resolve(absFile);
  return file === root || file.startsWith(root + path.sep);
}

function configInDir(dir: string): string | undefined {
  const yamlPath = path.join(dir, ".sops.yaml");
  if (fs.existsSync(yamlPath)) return yamlPath;
  const ymlPath = path.join(dir, ".sops.yml");
  if (fs.existsSync(ymlPath)) return ymlPath;
  return undefined;
}

export function findSopsConfigPath(
  encryptedFilePath: string,
  workspaceFolders: string[]
): string | undefined {
  const abs = path.resolve(encryptedFilePath);
  const startDir = path.dirname(abs);
  const containing = workspaceFolders
    .map((folder) => path.resolve(folder))
    .find((folder) => isInside(abs, folder));

  if (!containing) {
    return configInDir(startDir);
  }

  let dir = startDir;
  while (true) {
    const found = configInDir(dir);
    if (found) return found;
    if (path.resolve(dir) === path.resolve(containing)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function toPosixRelative(fromDir: string, filePath: string): string {
  return path.relative(fromDir, filePath).split(path.sep).join("/");
}

export function pathMatchesCreationRules(
  encryptedFilePath: string,
  configPath: string,
  parsed: unknown,
  warn?: (msg: string) => void
): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const rules = (parsed as { creation_rules?: unknown }).creation_rules;
  if (!Array.isArray(rules)) return false;

  const configDir = path.dirname(configPath);
  const relative = toPosixRelative(configDir, encryptedFilePath);

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const pathRegex = (rule as { path_regex?: unknown }).path_regex;
    if (pathRegex === undefined || pathRegex === null || pathRegex === "") {
      return true;
    }
    if (typeof pathRegex !== "string") continue;
    try {
      if (new RegExp(pathRegex).test(relative)) return true;
    } catch {
      warn?.(
        `SOPS: invalid path_regex ${JSON.stringify(pathRegex)} in ${configPath}`
      );
    }
  }
  return false;
}

function containsGitSegment(absolutePath: string): boolean {
  return absolutePath.includes("/.git/") || absolutePath.includes("\\.git\\");
}

export async function isAutoEditAllowed(
  absolutePath: string,
  settings: Pick<SopsSettings, "autoEdit">,
  workspaceFolders: string[],
  warn?: (msg: string) => void
): Promise<boolean> {
  if (!settings.autoEdit) return false;
  if (containsGitSegment(absolutePath)) return false;
  const configPath = findSopsConfigPath(absolutePath, workspaceFolders);
  if (!configPath) return false;
  const fsPromises = await import("fs/promises");
  let parsed: unknown;
  try {
    const text = await fsPromises.readFile(configPath, "utf-8");
    parsed = parseYaml(text);
  } catch (error) {
    warn?.(
      `SOPS: failed to parse ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
  return pathMatchesCreationRules(absolutePath, configPath, parsed, warn);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`

Expected: PASS — `detector.test.ts` and `config.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/sops-config.ts server/test/helpers.ts server/test/config.test.ts
git commit -m "feat: match auto-edit against walk-up .sops.yaml creation_rules"
```

---

### Task 3: Edit session registry (mocked runner)

**Files:**
- Create: `server/src/edit-session.ts`
- Create: `server/test/session.test.ts`

**Interfaces:**
- Consumes: `SopsRunnerLike`, `EditSession`, `FileState`, `SopsFileType` from `types.ts`; `isSopsEncrypted`, `getDecryptedPath`, `possibleSidecarPaths`, `detectFileType` from `sops-detector.ts`
- Produces:
  - `export class EditSessionRegistry`
  - `constructor(runner: SopsRunnerLike)`
  - `getByDecryptedUri(uri: string): EditSession | undefined`
  - `getByDecryptedPath(filePath: string): EditSession | undefined`
  - `getByEncryptedPath(filePath: string): EditSession | undefined`
  - `async start(encryptedFilePath: string, encryptedContent: string, fileType: SopsFileType): Promise<{ session: EditSession; plaintext: string }>`
  - `async adopt(decryptedFilePath: string, encryptedFilePath: string, encryptedContent: string, fileType: SopsFileType): Promise<EditSession>`
  - `async save(decryptedUri: string, plaintext: string): Promise<void>`
  - `async close(decryptedUri: string): Promise<void>`
  - `async deleteOrphanSidecars(encryptedFilePath: string, isOpen: (sidecarPath: string) => boolean): Promise<void>`

URI helper used by the registry (duplicate of LSP helper is OK; do not import `index.ts`):

```typescript
import { pathToFileURL } from "url";
function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}
```

- [ ] **Step 1: Write failing session tests**

Create `server/test/session.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { EditSessionRegistry } from "../src/edit-session";
import { FileState, SopsRunnerLike } from "../src/types";
import { getDecryptedPath } from "../src/sops-detector";
import { makeTempDir, writeFile } from "./helpers";

const SOPS_YAML = "hello: ENC[AES256_GCM,data:x]\nsops:\n    version: 3.9.0\n";

function mockRunner(overrides: Partial<SopsRunnerLike> = {}): SopsRunnerLike & {
  decryptCalls: number;
  reEncryptCalls: string[];
} {
  const state = { decryptCalls: 0, reEncryptCalls: [] as string[] };
  return {
    decryptCalls: 0,
    reEncryptCalls: [],
    async decrypt() {
      state.decryptCalls += 1;
      this.decryptCalls = state.decryptCalls;
      return "plain: true\n";
    },
    async reEncrypt(_filePath: string, plaintext: string) {
      state.reEncryptCalls.push(plaintext);
      this.reEncryptCalls = state.reEncryptCalls;
    },
    ...overrides,
  };
}

describe("EditSessionRegistry.start", () => {
  it("writes sidecar 0o600 and records the ciphertext snapshot", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    const { session, plaintext } = await registry.start(enc, SOPS_YAML, "yaml");
    assert.equal(plaintext, "plain: true\n");
    assert.equal(session.encryptedContent, SOPS_YAML);
    assert.equal(session.decryptedFilePath, getDecryptedPath(enc));
    assert.equal(session.state, FileState.DECRYPTED);
    const stat = await fs.stat(session.decryptedFilePath);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(session.decryptedFilePath, "utf-8"), plaintext);
    assert.equal(runner.decryptCalls, 1);
  });

  it("is idempotent: second start does not decrypt again", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    const first = await registry.start(enc, SOPS_YAML, "yaml");
    const second = await registry.start(enc, SOPS_YAML, "yaml");
    assert.equal(runner.decryptCalls, 1);
    assert.equal(second.session.decryptedFilePath, first.session.decryptedFilePath);
  });

  it("refuses to overwrite a sidecar whose companion is not SOPS ciphertext", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    const sidecar = getDecryptedPath(enc);
    await writeFile(enc, "hello: world\n");
    await writeFile(sidecar, "user file\n");
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    await assert.rejects(
      () => registry.start(enc, "hello: world\n", "yaml"),
      /already exists and is not a SOPS sidecar/
    );
    assert.equal(await fs.readFile(sidecar, "utf-8"), "user file\n");
    assert.equal(runner.decryptCalls, 0);
  });
});

describe("EditSessionRegistry.save", () => {
  it("coalesces two overlapping saves to the latest plaintext", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const runner = mockRunner({
      async reEncrypt(_filePath: string, plaintext: string) {
        started += 1;
        if (started === 1) await gate;
        runner.reEncryptCalls.push(plaintext);
      },
    });
    const registry = new EditSessionRegistry(runner);
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    const uri = session.decryptedUri;
    const first = registry.save(uri, "first\n");
    await new Promise((r) => setImmediate(r));
    const second = registry.save(uri, "second\n");
    release();
    await Promise.all([first, second]);
    assert.ok(runner.reEncryptCalls.length === 1 || runner.reEncryptCalls.length === 2);
    assert.equal(runner.reEncryptCalls[runner.reEncryptCalls.length - 1], "second\n");
  });

  it("aborts stale ciphertext without calling reEncrypt", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner();
    const registry = new EditSessionRegistry(runner);
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    await writeFile(enc, SOPS_YAML + "# changed\n");
    await assert.rejects(
      () => registry.save(session.decryptedUri, "plain\n"),
      /changed on disk; not re-encrypting/
    );
    assert.deepEqual(runner.reEncryptCalls, []);
    assert.equal(session.state, FileState.DECRYPTED);
    await fs.access(session.decryptedFilePath);
  });

  it("restores backup bytes on reEncrypt throw and keeps the sidecar", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const runner = mockRunner({
      async reEncrypt() {
        await writeFile(enc, "partial-corrupt\n");
        throw new Error("sops failed");
      },
    });
    const registry = new EditSessionRegistry(runner);
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    await assert.rejects(() => registry.save(session.decryptedUri, "plain\n"));
    assert.equal(await fs.readFile(enc, "utf-8"), SOPS_YAML);
    await fs.access(session.decryptedFilePath);
    assert.equal(session.state, FileState.DECRYPTED);
  });
});

describe("EditSessionRegistry.close and orphans", () => {
  it("deletes the sidecar and drops the session", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    await writeFile(enc, SOPS_YAML);
    const registry = new EditSessionRegistry(mockRunner());
    const { session } = await registry.start(enc, SOPS_YAML, "yaml");
    await registry.close(session.decryptedUri);
    await assert.rejects(() => fs.access(session.decryptedFilePath));
    assert.equal(registry.getByDecryptedUri(session.decryptedUri), undefined);
    assert.equal(registry.getByEncryptedPath(enc), undefined);
  });

  it("deletes an on-disk sidecar when it is not in the open set", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    const sidecar = getDecryptedPath(enc);
    await writeFile(enc, SOPS_YAML);
    await writeFile(sidecar, "orphan\n");
    const registry = new EditSessionRegistry(mockRunner());
    await registry.deleteOrphanSidecars(enc, () => false);
    await assert.rejects(() => fs.access(sidecar));
  });

  it("does not delete an on-disk sidecar that is open", async () => {
    const dir = await makeTempDir();
    const enc = path.join(dir, "secrets.yaml");
    const sidecar = getDecryptedPath(enc);
    await writeFile(enc, SOPS_YAML);
    await writeFile(sidecar, "open\n");
    const registry = new EditSessionRegistry(mockRunner());
    await registry.deleteOrphanSidecars(enc, (p) => p === sidecar);
    assert.equal(await fs.readFile(sidecar, "utf-8"), "open\n");
  });
});
```

- [ ] **Step 2: Run session tests to verify they fail**

Run: `cd server && npm test`

Expected: FAIL — `Cannot find module '../src/edit-session'`.

- [ ] **Step 3: Implement `EditSessionRegistry`**

Create `server/src/edit-session.ts`:

```typescript
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import {
  getDecryptedPath,
  isSopsEncrypted,
  possibleSidecarPaths,
} from "./sops-detector";
import {
  EditSession,
  FileState,
  SopsFileType,
  SopsRunnerLike,
} from "./types";

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeSidecar(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

export class EditSessionRegistry {
  private readonly byEncrypted = new Map<string, EditSession>();
  private readonly byDecryptedUri = new Map<string, EditSession>();
  private readonly byDecryptedPath = new Map<string, EditSession>();

  constructor(private readonly runner: SopsRunnerLike) {}

  getByDecryptedUri(uri: string): EditSession | undefined {
    return this.byDecryptedUri.get(uri);
  }

  getByDecryptedPath(filePath: string): EditSession | undefined {
    return this.byDecryptedPath.get(path.resolve(filePath));
  }

  getByEncryptedPath(filePath: string): EditSession | undefined {
    return this.byEncrypted.get(path.resolve(filePath));
  }

  private index(session: EditSession): void {
    this.byEncrypted.set(path.resolve(session.encryptedFilePath), session);
    this.byDecryptedUri.set(session.decryptedUri, session);
    this.byDecryptedPath.set(path.resolve(session.decryptedFilePath), session);
  }

  private unindex(session: EditSession): void {
    this.byEncrypted.delete(path.resolve(session.encryptedFilePath));
    this.byDecryptedUri.delete(session.decryptedUri);
    this.byDecryptedPath.delete(path.resolve(session.decryptedFilePath));
  }

  async start(
    encryptedFilePath: string,
    encryptedContent: string,
    fileType: SopsFileType
  ): Promise<{ session: EditSession; plaintext: string }> {
    const resolved = path.resolve(encryptedFilePath);
    const existing = this.byEncrypted.get(resolved);
    if (existing) {
      let plaintext = "";
      try {
        plaintext = await fs.readFile(existing.decryptedFilePath, "utf-8");
      } catch {
        plaintext = "";
      }
      return { session: existing, plaintext };
    }

    const decryptedFilePath = getDecryptedPath(resolved);
    if (await exists(decryptedFilePath)) {
      const companion = await fs.readFile(resolved, "utf-8").catch(() => "");
      if (!isSopsEncrypted(companion, fileType)) {
        throw new Error(
          `SOPS: ${decryptedFilePath} already exists and is not a SOPS sidecar.`
        );
      }
    }

    const plaintext = await this.runner.decrypt(resolved, fileType);
    await writeSidecar(decryptedFilePath, plaintext);
    const session: EditSession = {
      state: FileState.DECRYPTED,
      encryptedFilePath: resolved,
      encryptedContent,
      decryptedFilePath,
      decryptedUri: filePathToUri(decryptedFilePath),
      fileType,
      pending: undefined,
    };
    this.index(session);
    return { session, plaintext };
  }

  async adopt(
    decryptedFilePath: string,
    encryptedFilePath: string,
    encryptedContent: string,
    fileType: SopsFileType
  ): Promise<EditSession> {
    const resolvedEnc = path.resolve(encryptedFilePath);
    const existing = this.byEncrypted.get(resolvedEnc);
    if (existing) return existing;
    const resolvedDec = path.resolve(decryptedFilePath);
    const session: EditSession = {
      state: FileState.DECRYPTED,
      encryptedFilePath: resolvedEnc,
      encryptedContent,
      decryptedFilePath: resolvedDec,
      decryptedUri: filePathToUri(resolvedDec),
      fileType,
      pending: undefined,
    };
    this.index(session);
    return session;
  }

  async save(decryptedUri: string, plaintext: string): Promise<void> {
    const session = this.byDecryptedUri.get(decryptedUri);
    if (!session) return;
    if (session.state === FileState.ENCRYPTING) {
      session.pending = plaintext;
      return;
    }
    session.state = FileState.ENCRYPTING;
    try {
      await this.encryptLoop(session, plaintext);
    } finally {
      if (session.state === FileState.ENCRYPTING) {
        session.state = FileState.DECRYPTED;
      }
    }
  }

  private async encryptLoop(session: EditSession, plaintext: string): Promise<void> {
    let current = plaintext;
    for (;;) {
      const onDisk = await fs.readFile(session.encryptedFilePath, "utf-8");
      if (onDisk !== session.encryptedContent) {
        session.state = FileState.DECRYPTED;
        session.pending = undefined;
        throw new Error(
          `SOPS: ${session.encryptedFilePath} changed on disk; not re-encrypting.`
        );
      }

      const backupPath = path.join(
        os.tmpdir(),
        `sops-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      try {
        await fs.writeFile(backupPath, session.encryptedContent, {
          encoding: "utf-8",
          mode: 0o600,
        });
        await fs.chmod(backupPath, 0o600);
        try {
          await this.runner.reEncrypt(
            session.encryptedFilePath,
            current,
            session.fileType
          );
        } catch (error) {
          await fs.copyFile(backupPath, session.encryptedFilePath);
          session.state = FileState.DECRYPTED;
          session.pending = undefined;
          throw error;
        }
        session.encryptedContent = await fs.readFile(
          session.encryptedFilePath,
          "utf-8"
        );
      } finally {
        await fs.unlink(backupPath).catch(() => {});
      }

      if (session.pending !== undefined) {
        current = session.pending;
        session.pending = undefined;
        continue;
      }
      session.state = FileState.DECRYPTED;
      return;
    }
  }

  async close(decryptedUri: string): Promise<void> {
    const session = this.byDecryptedUri.get(decryptedUri);
    if (!session) return;
    await fs.unlink(session.decryptedFilePath).catch(() => {});
    this.unindex(session);
  }

  async deleteOrphanSidecars(
    encryptedFilePath: string,
    isOpen: (sidecarPath: string) => boolean
  ): Promise<void> {
    for (const sidecar of possibleSidecarPaths(encryptedFilePath)) {
      if (!(await exists(sidecar))) continue;
      if (isOpen(sidecar)) continue;
      if (this.byDecryptedPath.has(path.resolve(sidecar))) continue;
      await fs.unlink(sidecar).catch(() => {});
    }
  }
}
```

On encrypt failure after `reEncrypt` mutated the ciphertext, `fs.copyFile` restores the backup. On stale check, do not call `reEncrypt`. Overlapping `save` while `ENCRYPTING` stores `pending` and returns; the in-flight loop picks it up after success. After failure, `pending` is dropped (do not auto-retry).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`

Expected: PASS — detector, config, session.

If the overlapping-save test is flaky because `setImmediate` lost the race, wait on `started === 1` instead:

```typescript
while (started === 0) {
  await new Promise((r) => setImmediate(r));
}
```

then call the second `save`, then `release()`.

- [ ] **Step 5: Commit**

```bash
git add server/src/edit-session.ts server/test/session.test.ts
git commit -m "feat: add EditSessionRegistry with save queue and backup rollback"
```

---

### Task 4: Runner timeout + safe EDITOR env

**Files:**
- Modify: `server/src/sops-runner.ts`
- Create: `server/test/runner.test.ts`

**Interfaces:**
- Consumes: `SopsSettings` from `types.ts` (replace `SopsConfig`)
- Produces:
  - `export class SopsRunner implements SopsRunnerLike`
  - `constructor(settings: SopsSettings)`
  - `updateSettings(partial: Partial<SopsSettings>): void`
  - `async verify(): Promise<"ok" | "missing">`
  - `getVerifyStatus(): "ok" | "missing" | undefined`
  - `async decrypt(filePath: string, fileType: SopsFileType): Promise<string>`
  - `async reEncrypt(filePath: string, plaintext: string, fileType: SopsFileType): Promise<void>`
  - `export function formatSopsError(error: unknown, timeoutMs?: number): string`

- [ ] **Step 1: Write failing runner tests**

Create `server/test/runner.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import { SopsRunner, formatSopsError } from "../src/sops-runner";
import { DEFAULT_SOPS_SETTINGS } from "../src/types";
import { makeTempDir, writeFile } from "./helpers";

async function writeFakeSops(
  dir: string,
  body: string
): Promise<string> {
  const bin = path.join(dir, "sops");
  await writeFile(bin, `#!/bin/sh\n${body}\n`, 0o755);
  return bin;
}

describe("formatSopsError", () => {
  it("prefers trimmed stderr and caps at 800 chars", () => {
    const stderr = `${"x".repeat(900)}\n`;
    const msg = formatSopsError({ stderr });
    assert.equal(msg.length, 800);
    assert.equal(msg, "x".repeat(800));
  });

  it("reports timeout when the process was killed", () => {
    const msg = formatSopsError({ killed: true, message: "killed" }, 50);
    assert.match(msg, /timed out after 50ms/);
  });
});

describe("SopsRunner.verify", () => {
  it("caches ok from sops --version", async () => {
    const dir = await makeTempDir();
    const bin = await writeFakeSops(
      dir,
      `if [ "$1" = "--version" ]; then echo "sops 3.9.0"; exit 0; fi; exit 1`
    );
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: bin,
    });
    assert.equal(await runner.verify(), "ok");
    assert.equal(runner.getVerifyStatus(), "ok");
    assert.equal(await runner.verify(), "ok");
  });

  it("caches missing when the binary cannot run", async () => {
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: path.join("/nonexistent", "sops-binary"),
    });
    assert.equal(await runner.verify(), "missing");
    assert.equal(runner.getVerifyStatus(), "missing");
  });
});

describe("SopsRunner.decrypt timeout", () => {
  it("kills a hanging sops and treats it as failure", async () => {
    const dir = await makeTempDir();
    const bin = await writeFakeSops(dir, `sleep 5`);
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: bin,
      timeoutMs: 200,
    });
    await assert.rejects(() => runner.decrypt(path.join(dir, "f.yaml"), "yaml"));
  });
});

describe("SopsRunner.reEncrypt EDITOR", () => {
  it("uses SOPS_ZED_CONTENT env and does not interpolate the plaintext path into the script", async () => {
    const dir = await makeTempDir();
    const seen = path.join(dir, "seen.txt");
    const target = path.join(dir, "secrets.yaml");
    await writeFile(target, "cipher\n");
    const bin = await writeFakeSops(
      dir,
      `
echo "EDITOR=$EDITOR" > "${seen}"
echo "CONTENT=$SOPS_ZED_CONTENT" >> "${seen}"
cat "$EDITOR" >> "${seen}"
# emulate sops invoking EDITOR on a temp file
tmp="${dir}/edit-target"
echo old > "$tmp"
"$EDITOR" "$tmp"
cp "$tmp" "$3" 2>/dev/null || true
echo encrypted > "${target}"
`
    );
    const runner = new SopsRunner({
      ...DEFAULT_SOPS_SETTINGS,
      sopsPath: bin,
    });
    await runner.reEncrypt(target, "new-plain\n", "yaml");
    const seenText = await fs.readFile(seen, "utf-8");
    assert.match(seenText, /CONTENT=\//);
    assert.match(seenText, /cp "\$SOPS_ZED_CONTENT" "\$1"/);
    assert.doesNotMatch(seenText, /cp "\/tmp\/sops-content-/);
    assert.equal(await fs.readFile(target, "utf-8"), "encrypted\n");
  });
});
```

The fake-sops `reEncrypt` test inspects the EDITOR script contents via `cat "$EDITOR"`. Adjust the fake script if argument positions differ — `SopsRunner` must invoke `execFile(sopsPath, [filePath], { env: { EDITOR, SOPS_ZED_CONTENT, ... }})` with **no** extra args.

- [ ] **Step 2: Run runner tests to verify they fail**

Run: `cd server && npm test`

Expected: FAIL — `formatSopsError` not exported; `verify()` still returns a version string; EDITOR script still interpolates `tmpContentFile`; no timeout passed to `execFile`.

- [ ] **Step 3: Replace `sops-runner.ts`**

```typescript
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { SopsFileType, SopsRunnerLike, SopsSettings } from "./types";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const ERROR_CAP = 800;

export function formatSopsError(error: unknown, timeoutMs?: number): string {
  const err = error as {
    killed?: boolean;
    stderr?: string;
    message?: string;
  };
  if (err && err.killed && timeoutMs !== undefined) {
    return `sops timed out after ${timeoutMs}ms`;
  }
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  const raw =
    stderr ||
    (error instanceof Error ? error.message : String(error));
  return raw.length > ERROR_CAP ? raw.slice(0, ERROR_CAP) : raw;
}

export class SopsRunner implements SopsRunnerLike {
  private settings: SopsSettings;
  private verifyStatus: "ok" | "missing" | undefined;

  constructor(settings: SopsSettings) {
    this.settings = settings;
  }

  updateSettings(partial: Partial<SopsSettings>): void {
    this.settings = { ...this.settings, ...partial };
  }

  getVerifyStatus(): "ok" | "missing" | undefined {
    return this.verifyStatus;
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.settings.env };
  }

  async verify(): Promise<"ok" | "missing"> {
    if (this.verifyStatus) return this.verifyStatus;
    try {
      await execFileAsync(this.settings.sopsPath, ["--version"], {
        env: this.env(),
        timeout: this.settings.timeoutMs,
        maxBuffer: MAX_BUFFER,
      });
      this.verifyStatus = "ok";
    } catch {
      this.verifyStatus = "missing";
    }
    return this.verifyStatus;
  }

  async decrypt(filePath: string, fileType: SopsFileType): Promise<string> {
    const { stdout } = await execFileAsync(
      this.settings.sopsPath,
      ["decrypt", "--input-type", fileType, "--output-type", fileType, filePath],
      {
        env: this.env(),
        maxBuffer: MAX_BUFFER,
        timeout: this.settings.timeoutMs,
      }
    );
    return stdout;
  }

  async reEncrypt(
    filePath: string,
    plaintext: string,
    _fileType: SopsFileType
  ): Promise<void> {
    const tmpDir = os.tmpdir();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpContentFile = path.join(tmpDir, `sops-content-${id}`);
    const tmpEditorScript = path.join(tmpDir, `sops-editor-${id}.sh`);

    try {
      await fs.writeFile(tmpContentFile, plaintext, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await fs.chmod(tmpContentFile, 0o600);
      const editorScript = `#!/bin/sh\ncp "$SOPS_ZED_CONTENT" "$1"\n`;
      await fs.writeFile(tmpEditorScript, editorScript, {
        encoding: "utf-8",
        mode: 0o755,
      });
      await fs.chmod(tmpEditorScript, 0o755);

      await execFileAsync(this.settings.sopsPath, [filePath], {
        env: {
          ...this.env(),
          EDITOR: tmpEditorScript,
          SOPS_ZED_CONTENT: tmpContentFile,
        },
        maxBuffer: MAX_BUFFER,
        timeout: this.settings.timeoutMs,
      });
    } finally {
      await fs.unlink(tmpContentFile).catch(() => {});
      await fs.unlink(tmpEditorScript).catch(() => {});
    }
  }
}
```

`index.ts` still constructs `new SopsRunner({ sopsPath, env })` (old `SopsConfig`). That is assignment-compatible with `SopsSettings` if extra fields are missing — **it is not**: `SopsSettings` requires `autoEdit` and `timeoutMs`. Update the constructor call in `index.ts` now so `tsc` does not break:

```typescript
sopsRunner = new SopsRunner(
  parseSopsSettings({
    sopsPath: (opts.sopsPath as string) || "sops",
    env: (opts.env as Record<string, string>) || {},
  })
);
```

Add the `parseSopsSettings` import. Do not otherwise rewire LSP in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test`

Expected: PASS. If the EDITOR test fails because the fake script never saw `SOPS_ZED_CONTENT`, print `env` from the fake binary (`env | grep SOPS`) and fix the assertion, not the production script shape.

- [ ] **Step 5: Commit**

```bash
git add server/src/sops-runner.ts server/src/index.ts server/test/runner.test.ts
git commit -m "fix: pass sops timeout and keep EDITOR script free of interpolated paths"
```

---

### Task 5: LSP rewire (diagnostics, code action, command, open/save/close)

**Files:**
- Modify: `server/src/index.ts` (replace)
- Delete: `server/src/file-state.ts`
- Create: `server/test/settings.test.ts`

**Interfaces:**
- Consumes: `EditSessionRegistry`, `SopsRunner`, `isAutoEditAllowed`, detector helpers, `parseSopsSettings`
- Produces: stdio LSP with capabilities
  - `textDocumentSync`: full, `openClose: true`, `save: { includeText: true }`
  - `codeActionProvider: true`
  - `executeCommandProvider: { commands: ["sops.editDecrypted"] }`
  - no hover / definition / completion / formatting
- Command `sops.editDecrypted` argument: document URI (`string`)
- Diagnostics: `source: "sops"`, codes `sops.encrypted` | `sops.editing` | `sops.managed` | `sops.unavailable`

- [ ] **Step 1: Write failing settings-parse tests (LSP-facing defaults)**

Create `server/test/settings.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SOPS_SETTINGS, parseSopsSettings } from "../src/types";

describe("parseSopsSettings", () => {
  it("defaults autoEdit true and timeoutMs 60000", () => {
    assert.deepEqual(parseSopsSettings({}), DEFAULT_SOPS_SETTINGS);
    assert.equal(DEFAULT_SOPS_SETTINGS.autoEdit, true);
    assert.equal(DEFAULT_SOPS_SETTINGS.timeoutMs, 60_000);
    assert.equal(DEFAULT_SOPS_SETTINGS.sopsPath, "sops");
  });

  it("keeps unspecified keys from defaults on merge", () => {
    const merged = parseSopsSettings(
      { autoEdit: false },
      { ...DEFAULT_SOPS_SETTINGS, sopsPath: "/opt/sops", timeoutMs: 10 }
    );
    assert.equal(merged.autoEdit, false);
    assert.equal(merged.sopsPath, "/opt/sops");
    assert.equal(merged.timeoutMs, 10);
  });
});
```

These should already pass from Task 1. That is OK — they lock the LSP defaults before the rewrite.

- [ ] **Step 2: Replace `index.ts` and delete `file-state.ts`**

Replace `server/src/index.ts` entirely with:

```typescript
import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  TextDocumentEdit,
  TextEdit,
  Range,
  Position,
  OptionalVersionedTextDocumentIdentifier,
  CreateFile,
  Diagnostic,
  DiagnosticSeverity,
  CodeAction,
  CodeActionKind,
  Command,
  CodeActionParams,
  ExecuteCommandParams,
  DidChangeConfigurationParams,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { EditSessionRegistry } from "./edit-session";
import { isAutoEditAllowed } from "./sops-config";
import {
  detectFileType,
  getEncryptedPath,
  isDecryptedFile,
  isSopsEncrypted,
} from "./sops-detector";
import { formatSopsError, SopsRunner } from "./sops-runner";
import {
  DEFAULT_SOPS_SETTINGS,
  parseSopsSettings,
  SopsSettings,
} from "./types";

const COMMAND_EDIT = "sops.editDecrypted";

process.on("uncaughtException", (error) => {
  try {
    connection.console.error(
      `Uncaught Exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
  } catch {
    // connection may not be usable
  }
  process.exit(1);
});

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: SopsSettings = DEFAULT_SOPS_SETTINGS;
let sopsRunner = new SopsRunner(settings);
let registry = new EditSessionRegistry(sopsRunner);
let workspaceFolders: string[] = [];
let verifyPromise: Promise<"ok" | "missing"> = Promise.resolve("ok");

process.on("unhandledRejection", (reason) => {
  const msg =
    reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  connection.console.error(`Unhandled Rejection: ${msg}`);
});

function uriToFilePath(uri: string): string {
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  return uri;
}

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function line0Range(text: string): Range {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return Range.create(Position.create(0, 0), Position.create(0, firstLine.length));
}

function infoDiagnostic(code: string, message: string, text: string): Diagnostic {
  return {
    range: line0Range(text),
    message,
    severity: DiagnosticSeverity.Information,
    source: "sops",
    code,
  };
}

function isSidecarOpen(sidecarPath: string): boolean {
  const uri = filePathToUri(sidecarPath);
  return documents.get(uri) !== undefined;
}

async function publishCiphertextDiagnostics(
  uri: string,
  text: string,
  sidecarBasename?: string
): Promise<void> {
  if (sopsRunner.getVerifyStatus() === "missing") {
    connection.sendDiagnostics({
      uri,
      diagnostics: [
        infoDiagnostic("sops.unavailable", "SOPS binary not found", text),
      ],
    });
    return;
  }
  if (sidecarBasename) {
    connection.sendDiagnostics({
      uri,
      diagnostics: [
        infoDiagnostic(
          "sops.editing",
          `SOPS: editing ${sidecarBasename}`,
          text
        ),
      ],
    });
    return;
  }
  connection.sendDiagnostics({
    uri,
    diagnostics: [infoDiagnostic("sops.encrypted", "SOPS encrypted", text)],
  });
}

function publishSidecarManaged(uri: string, text: string): void {
  connection.sendDiagnostics({
    uri,
    diagnostics: [
      infoDiagnostic("sops.managed", "SOPS managed · save re-encrypts", text),
    ],
  });
}

async function openDecryptedFile(
  decryptedUri: string,
  decryptedFilePath: string,
  content: string
): Promise<boolean> {
  try {
    const existingContent = await fs.readFile(decryptedFilePath, "utf-8");
    const lines = existingContent.split("\n");
    const lastLine = Math.max(lines.length - 1, 0);
    const lastChar = (lines[lastLine] ?? "").length;
    const result = await connection.workspace.applyEdit({
      documentChanges: [
        CreateFile.create(decryptedUri, { overwrite: true }),
        TextDocumentEdit.create(
          OptionalVersionedTextDocumentIdentifier.create(decryptedUri, null),
          [
            TextEdit.replace(
              Range.create(
                Position.create(0, 0),
                Position.create(lastLine, lastChar)
              ),
              content
            ),
          ]
        ),
      ],
    });
    return result.applied;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    connection.console.error(`SOPS: Failed to open sidecar via applyEdit: ${msg}`);
    return false;
  }
}

async function startEditSession(encryptedUri: string): Promise<void> {
  const encryptedPath = uriToFilePath(encryptedUri);
  const existing = registry.getByEncryptedPath(encryptedPath);
  if (existing) {
    const opened = await openDecryptedFile(
      existing.decryptedUri,
      existing.decryptedFilePath,
      await fs.readFile(existing.decryptedFilePath, "utf-8").catch(() => "")
    );
    if (!opened) {
      connection.window.showInformationMessage(
        `SOPS: decrypted to ${existing.decryptedFilePath} — open it to edit.`
      );
    }
    return;
  }

  let encryptedContent: string;
  try {
    encryptedContent =
      documents.get(encryptedUri)?.getText() ??
      (await fs.readFile(encryptedPath, "utf-8"));
  } catch (error) {
    connection.window.showErrorMessage(formatSopsError(error, settings.timeoutMs));
    return;
  }
  const fileType = detectFileType(encryptedPath);
  try {
    const { session, plaintext } = await registry.start(
      encryptedPath,
      encryptedContent,
      fileType
    );
    const opened = await openDecryptedFile(
      session.decryptedUri,
      session.decryptedFilePath,
      plaintext
    );
    if (!opened) {
      connection.window.showInformationMessage(
        `SOPS: decrypted to ${session.decryptedFilePath} — open it to edit.`
      );
    }
    const cipherDoc = documents.get(encryptedUri);
    await publishCiphertextDiagnostics(
      encryptedUri,
      cipherDoc?.getText() ?? encryptedContent,
      path.basename(session.decryptedFilePath)
    );
    const sidecarDoc = documents.get(session.decryptedUri);
    publishSidecarManaged(
      session.decryptedUri,
      sidecarDoc?.getText() ?? plaintext
    );
  } catch (error: unknown) {
    const msg = formatSopsError(error, settings.timeoutMs);
    connection.window.showErrorMessage(msg);
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  settings = parseSopsSettings(params.initializationOptions);
  sopsRunner = new SopsRunner(settings);
  registry = new EditSessionRegistry(sopsRunner);
  workspaceFolders = (params.workspaceFolders ?? []).map((folder) =>
    uriToFilePath(folder.uri)
  );
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: true },
      },
      codeActionProvider: true,
      executeCommandProvider: { commands: [COMMAND_EDIT] },
    },
  };
});

connection.onInitialized(() => {
  verifyPromise = sopsRunner.verify().then((status) => {
    if (status === "missing") {
      connection.window.showWarningMessage(
        "SOPS binary not found. Install sops and ensure it is on PATH, or set lsp.sops-lsp.settings.sopsPath."
      );
    } else {
      connection.console.log("SOPS LSP initialized");
    }
    return status;
  });
});

function settingsFromChange(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (
    obj.sopsPath !== undefined ||
    obj.autoEdit !== undefined ||
    obj.timeoutMs !== undefined ||
    obj.env !== undefined
  ) {
    return obj;
  }
  const lsp = obj.lsp;
  if (lsp && typeof lsp === "object") {
    const server = (lsp as Record<string, unknown>)["sops-lsp"];
    if (server && typeof server === "object") {
      const nested = server as Record<string, unknown>;
      return nested.settings ?? nested;
    }
  }
  return raw;
}

connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
  settings = parseSopsSettings(settingsFromChange(change.settings), settings);
  sopsRunner.updateSettings(settings);
});

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const fromDiag = params.context.diagnostics.some(
    (d) =>
      d.source === "sops" &&
      (d.code === "sops.encrypted" || d.code === "sops.unavailable")
  );
  const filePath = uriToFilePath(params.textDocument.uri);
  if (isDecryptedFile(filePath)) return [];
  const doc = documents.get(params.textDocument.uri);
  const encrypted =
    !!doc && isSopsEncrypted(doc.getText(), detectFileType(filePath));
  if (!fromDiag && !encrypted) return [];
  return [
    CodeAction.create(
      "SOPS: Edit decrypted",
      Command.create("SOPS: Edit decrypted", COMMAND_EDIT, params.textDocument.uri),
      CodeActionKind.QuickFix
    ),
  ];
});

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command !== COMMAND_EDIT) return;
  const uri = params.arguments?.[0];
  if (typeof uri !== "string") return;
  await startEditSession(uri);
});

documents.onDidOpen(async (event) => {
  const { document } = event;
  const uri = document.uri;
  const filePath = uriToFilePath(uri);

  if (isDecryptedFile(filePath)) {
    if (registry.getByDecryptedUri(uri)) {
      publishSidecarManaged(uri, document.getText());
      return;
    }
    const encryptedFilePath = getEncryptedPath(filePath);
    try {
      const encryptedContent = await fs.readFile(encryptedFilePath, "utf-8");
      const fileType = detectFileType(encryptedFilePath);
      if (!isSopsEncrypted(encryptedContent, fileType)) return;
      await registry.adopt(
        filePath,
        encryptedFilePath,
        encryptedContent,
        fileType
      );
      publishSidecarManaged(uri, document.getText());
      const encUri = filePathToUri(encryptedFilePath);
      const encDoc = documents.get(encUri);
      if (encDoc) {
        await publishCiphertextDiagnostics(
          encUri,
          encDoc.getText(),
          path.basename(filePath)
        );
      }
    } catch {
      // Companion missing — ignore
    }
    return;
  }

  const content = document.getText();
  const fileType = detectFileType(filePath);
  if (!isSopsEncrypted(content, fileType)) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  await verifyPromise;
  await publishCiphertextDiagnostics(uri, content);

  await registry.deleteOrphanSidecars(filePath, isSidecarOpen);

  const session = registry.getByEncryptedPath(filePath);
  if (session) {
    await publishCiphertextDiagnostics(
      uri,
      content,
      path.basename(session.decryptedFilePath)
    );
    return;
  }

  void (async () => {
    try {
      if (
        await isAutoEditAllowed(filePath, settings, workspaceFolders, (msg) =>
          connection.console.warn(msg)
        )
      ) {
        await startEditSession(uri);
      }
    } catch (error) {
      connection.console.error(formatSopsError(error, settings.timeoutMs));
    }
  })();
});

documents.onDidSave(async (event) => {
  const { document } = event;
  const ctx = registry.getByDecryptedUri(document.uri);
  if (!ctx) return;
  // includeText keeps the in-memory document current; that is the plaintext.
  // Fall back to the sidecar on disk only if getText is unavailable.
  const plaintext =
    document.getText() ??
    (await fs.readFile(ctx.decryptedFilePath, "utf-8"));
  try {
    await registry.save(document.uri, plaintext);
    connection.console.log(`SOPS: Re-encrypted ${ctx.encryptedFilePath}`);
  } catch (error: unknown) {
    const msg = formatSopsError(error, settings.timeoutMs);
    connection.console.error(`SOPS: Re-encryption failed: ${msg}`);
    connection.window.showErrorMessage(msg);
  }
});

documents.onDidClose(async (event) => {
  const uri = event.document.uri;
  const filePath = uriToFilePath(uri);

  if (isDecryptedFile(filePath)) {
    const session = registry.getByDecryptedUri(uri);
    const encryptedFilePath = session?.encryptedFilePath;
    await registry.close(uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
    if (encryptedFilePath) {
      const encUri = filePathToUri(encryptedFilePath);
      const encDoc = documents.get(encUri);
      if (encDoc) {
        await publishCiphertextDiagnostics(encUri, encDoc.getText());
      }
    }
    return;
  }

  connection.sendDiagnostics({ uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
```

Delete `server/src/file-state.ts`.

Collision / decrypt errors surface via `showErrorMessage` with `formatSopsError` (stderr preferred, 800-char cap). `applyEdit` failure keeps the sidecar and shows `SOPS: decrypted to <path> — open it to edit.` Auto-edit is fired without awaiting inside `onDidOpen` (void IIFE) so `didOpen` is not blocked on `sops decrypt`.

- [ ] **Step 3: Typecheck and run the full unit suite**

Run:

```bash
cd server && npx tsc --noEmit && npm test
```

Expected: `tsc` PASS (no `file-state.ts`, no hover providers). `npm test` PASS.

If `tsc` complains about `CreateFile.create` overwrite option, use:

```typescript
CreateFile.create(decryptedUri, { overwrite: true, ignoreIfExists: false })
```

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts server/test/settings.test.ts
git rm server/src/file-state.ts
git commit -m "feat: rewire SOPS LSP to diagnostics, code action, and queued sessions"
```

---

### Task 6: WASM settings + single-file bundle

**Files:**
- Modify: `server/package.json` (esbuild build)
- Modify: `build.sh`
- Modify: `src/lib.rs`
- Modify: `.gitignore`
- Delete committed per-module dist artifacts: `server/dist/file-state.js`, `file-state.d.ts`, `file-state.js.map`, `types.js`, `types.d.ts`, `types.js.map`, `sops-detector.js`, `sops-detector.d.ts`, `sops-detector.js.map`, `sops-runner.js`, `sops-runner.d.ts`, `sops-runner.js.map`, `index.d.ts`, `index.js.map` (keep `server/dist/index.js` bundle)
- Modify: `server/tsconfig.json` only if needed (`noEmit` is handled by the npm script)

**Interfaces:**
- Consumes: `zed_extension_api` 0.7.0 — `LspSettings::for_worktree`, `Worktree::which`, `Worktree::shell_env`
- Produces:
  - `fn language_server_command(...) -> Result<zed::Command, String>` writes **only** `dist/index.js`, no `npm_install_package`
  - `fn language_server_initialization_options(...) -> Result<Option<zed::serde_json::Value>, String>`
  - `fn language_server_workspace_configuration(...) -> Result<Option<zed::serde_json::Value>, String>`
  - Init JSON object: `{ sopsPath, env, autoEdit, timeoutMs }`
  - Merge: `settings` over `initialization_options`; if `sopsPath` still unset/empty, `worktree.which("sops")` then `"sops"`

- [ ] **Step 1: Switch the server build to tsc --noEmit + esbuild bundle**

Add esbuild:

```bash
cd server && npm install --save-dev esbuild@^0.25.0 && cd ..
```

`server/package.json` scripts:

```json
"scripts": {
  "build": "tsc --noEmit && esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js",
  "watch": "esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.js --watch",
  "test": "tsx --test test/*.test.ts"
}
```

Replace `build.sh` with:

```bash
#!/bin/bash
set -e

echo "Installing server dependencies..."
cd server && npm install

echo "Building bundled language server..."
npm run build
cd ..

echo "Build complete."
```

Update `.gitignore`:

```
target/
server/node_modules/
*.wasm
.claude/
server/dist/*
!server/dist/index.js
```

- [ ] **Step 2: Produce the bundle and prove it is standalone**

Run:

```bash
cd server && npm run build && cd ..
rg -n "require\\(" server/dist/index.js | head
node --check server/dist/index.js
```

Expected: `npm run build` PASS. `server/dist/index.js` exists and is a single file. `node --check` PASS. The bundle must contain inlined `vscode-languageserver` / `yaml` (no runtime resolve of those packages). It may still `require("fs")` / `child_process` / other node builtins.

Delete leftover per-module emit if present:

```bash
rm -f server/dist/*.d.ts server/dist/*.map \
  server/dist/types.js server/dist/sops-detector.js \
  server/dist/sops-runner.js server/dist/file-state.js \
  server/dist/sops-config.js server/dist/edit-session.js
```

Keep `server/dist/index.js`.

- [ ] **Step 3: Rewrite `src/lib.rs`**

Replace `src/lib.rs` with:

```rust
use zed_extension_api::{self as zed, serde_json::{json, Map, Value}, settings::LspSettings};

struct SopsExtension;

fn merge_objects(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                base_map.insert(key, value);
            }
            Value::Object(base_map)
        }
        (_base, overlay) => overlay,
    }
}

fn lsp_options(worktree: &zed::Worktree) -> Result<Value, String> {
    let lsp = LspSettings::for_worktree("sops-lsp", worktree).unwrap_or_default();
    let mut options = lsp.initialization_options.unwrap_or_else(|| json!({}));
    if let Some(settings) = lsp.settings {
        options = merge_objects(options, settings);
    }
    let mut map: Map<String, Value> = match options {
        Value::Object(map) => map,
        other => {
            let mut map = Map::new();
            map.insert("value".to_string(), other);
            map
        }
    };
    let sops_path_missing = match map.get("sopsPath") {
        None => true,
        Some(Value::String(s)) if s.is_empty() => true,
        Some(Value::Null) => true,
        _ => false,
    };
    if sops_path_missing {
        let resolved = worktree
            .which("sops")
            .unwrap_or_else(|| "sops".to_string());
        map.insert("sopsPath".to_string(), Value::String(resolved));
    }
    if !map.contains_key("env") {
        map.insert("env".to_string(), json!({}));
    }
    if !map.contains_key("autoEdit") {
        map.insert("autoEdit".to_string(), Value::Bool(true));
    }
    if !map.contains_key("timeoutMs") {
        map.insert("timeoutMs".to_string(), json!(60_000));
    }
    Ok(Value::Object(map))
}

impl zed::Extension for SopsExtension {
    fn new() -> Self {
        SopsExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command, String> {
        let work_dir = std::env::current_dir()
            .map_err(|e| format!("Failed to get work dir: {}", e))?;

        let dist_dir = work_dir.join("dist");
        let server_entry = dist_dir.join("index.js");
        std::fs::create_dir_all(&dist_dir)
            .map_err(|e| format!("Failed to create dist dir: {}", e))?;
        std::fs::write(&server_entry, include_str!("../server/dist/index.js"))
            .map_err(|e| format!("Failed to write index.js: {}", e))?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                server_entry.to_string_lossy().to_string(),
                "--stdio".to_string(),
            ],
            env: worktree.shell_env(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>, String> {
        Ok(Some(lsp_options(worktree)?))
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>, String> {
        Ok(Some(lsp_options(worktree)?))
    }
}

zed::register_extension!(SopsExtension);
```

If `zed::serde_json` is not a re-export on 0.7.0, switch imports to whatever the crate actually exports (`use zed_extension_api::serde_json::{json, Map, Value}` or `extern crate` path from docs.rs). Do **not** add a direct `serde_json` dependency unless the crate does not re-export it. `LspSettings` default comes from `#[derive(Default)]` on 0.7.0.

There are no WASM integration tests in this version. Verification:

```bash
cd server && npm test && npm run build && cd ..
# rustc/wasm32 may be unavailable in this worktree; if `cargo` works:
# cargo check --target wasm32-wasip1 || cargo check
```

If cargo is unavailable, still land the Rust source; `include_str!("../server/dist/index.js")` must compile once the bundle exists.

- [ ] **Step 4: Commit**

```bash
git add src/lib.rs build.sh server/package.json server/package-lock.json .gitignore server/dist/index.js
git rm -f --ignore-unmatch \
  server/dist/file-state.js server/dist/file-state.d.ts server/dist/file-state.js.map \
  server/dist/types.js server/dist/types.d.ts server/dist/types.js.map \
  server/dist/sops-detector.js server/dist/sops-detector.d.ts server/dist/sops-detector.js.map \
  server/dist/sops-runner.js server/dist/sops-runner.d.ts server/dist/sops-runner.js.map \
  server/dist/index.d.ts server/dist/index.js.map \
  server/dist/sops-config.js server/dist/sops-config.d.ts \
  server/dist/edit-session.js server/dist/edit-session.d.ts
git commit -m "build: bundle sops-lsp into one file and wire Zed LspSettings"
```

---

### Task 7: README and `extension.toml` language list

**Files:**
- Modify: `extension.toml`
- Create: `README.md`

**Interfaces:**
- Consumes: none
- Produces: user-facing install/edit/gitignore notes; languages `YAML`, `JSON`, `TOML` only

- [ ] **Step 1: Drop Plain Text from the language server attachment**

`extension.toml`:

```toml
id = "sops"
name = "SOPS"
version = "0.1.0"
schema_version = 1
authors = ["Mees"]
description = "Transparent SOPS encryption/decryption for Zed"
repository = "https://github.com/meesk/zed-sops"

[language_servers.sops-lsp]
name = "SOPS LSP"
languages = ["YAML", "JSON", "TOML"]
```

- [ ] **Step 2: Write the short README required for sidecar-in-project**

Create `README.md`:

```markdown
# SOPS for Zed

Edit [SOPS](https://github.com/getsops/sops)-encrypted YAML, JSON, and TOML in Zed via a plaintext sidecar. Zed has no virtual documents, so the decrypted buffer is a real file next to the original.

## Install

1. Install the `sops` binary and make sure it is on `PATH` (or set `sopsPath` below).
2. Install this extension in Zed.
3. Optional user settings:

```json
{
  "lsp": {
    "sops-lsp": {
      "settings": {
        "sopsPath": "/opt/homebrew/bin/sops",
        "env": { "SOPS_AGE_KEY_FILE": "/Users/me/key.txt" },
        "autoEdit": true,
        "timeoutMs": 60000
      }
    }
  }
}
```

## Usage

1. Open a SOPS-encrypted YAML/JSON/TOML file. A diagnostic appears: `SOPS encrypted`.
2. Run the code action **SOPS: Edit decrypted**, or let auto-edit start a session when a `.sops.yaml` `creation_rules` entry matches this path (`autoEdit` defaults to true; no config file means no auto-edit).
3. Edit the sidecar tab (`secrets.yaml` → `secrets.decrypted.yaml`). Save it to re-encrypt the original. Close it to delete the plaintext sidecar.
4. The ciphertext tab stays open; that is a Zed limitation, not a leak of the edit session.

## Gitignore

Add these patterns so plaintext sidecars are never committed:

```
*.decrypted.yaml
*.decrypted.yml
*.decrypted.json
*.decrypted.toml
*.decrypted.ini
```

## YAML language server order

If go-to-definition on YAML breaks, keep `yaml-language-server` ahead of `sops-lsp`:

```json
{
  "languages": {
    "YAML": {
      "language_servers": ["yaml-language-server", "sops-lsp"]
    }
  }
}
```
```

- [ ] **Step 3: Final verification**

Run:

```bash
cd server && npm test && npm run build && cd ..
test -f server/dist/index.js
rg -n "Plain Text" extension.toml || true
rg -n "hover|completion|definition" server/src/index.ts || true
```

Expected: tests PASS, bundle exists, `extension.toml` has no `Plain Text`, `index.ts` does not advertise hover/definition/completion.

- [ ] **Step 4: Commit**

```bash
git add README.md extension.toml
git commit -m "docs: describe sidecar edit UX and drop Plain Text attachment"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| New sidecar naming + legacy adopt/cleanup | 1, 3 (`possibleSidecarPaths`), 5 (open sidecar / orphan) |
| Ciphertext heuristics including toml/binary and JSON parse-fail | 1 |
| `.sops.yaml` walk-up, `path_regex`, catch-all, invalid regex, `/.git/` | 2 |
| `isAutoEditAllowed` all three conditions | 2, 5 (didOpen) |
| Explicit code action; no auto-decrypt on every open | 5 |
| Session idempotency, 0o600 sidecar, collision refuse | 3 |
| Save queue, stale abort, backup restore, close deletes sidecar | 3, 5 |
| EDITOR env, no path interpolation, timeout, execFile, 10 MiB | 4 |
| Diagnostics codes/messages/source/range/severity | 5 |
| `sops.editDecrypted` command + applyEdit fallback message | 5 |
| Close ciphertext does not destroy session | 5 |
| `fileURLToPath` / `pathToFileURL` | 5 |
| Settings from WASM `LspSettings` + `which("sops")` + `shell_env()` | 6 |
| Single bundled `index.js`, no runtime `npm_install_package` | 6 |
| README gitignore + language_servers order; drop Plain Text | 7 |
| No hover/definition/completion; no dotenv; no creation_rules encrypt | 5, 7, Global Constraints |

Out of scope (do not implement): binary-as-first-class besides TOML-as-`binary`, dotenv, progress notifications, registry publish, WASM tests, in-buffer decrypt, closing the ciphertext tab.
