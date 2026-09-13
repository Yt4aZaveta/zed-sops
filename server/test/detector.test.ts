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
