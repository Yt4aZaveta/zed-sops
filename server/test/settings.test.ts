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

  it("defaults autoEditAll false and keyFile empty", () => {
    assert.equal(DEFAULT_SOPS_SETTINGS.autoEditAll, false);
    assert.equal(DEFAULT_SOPS_SETTINGS.keyFile, "");
  });

  it("injects keyFile as SOPS_AGE_SSH_PRIVATE_KEY_FILE when env omits it", () => {
    const parsed = parseSopsSettings({
      keyFile: "/Users/me/id_rsa",
    });
    assert.equal(parsed.keyFile, "/Users/me/id_rsa");
    assert.equal(parsed.env.SOPS_AGE_SSH_PRIVATE_KEY_FILE, "/Users/me/id_rsa");
  });

  it("does not override env.SOPS_AGE_SSH_PRIVATE_KEY_FILE with keyFile", () => {
    const parsed = parseSopsSettings({
      keyFile: "/Users/me/id_rsa",
      env: { SOPS_AGE_SSH_PRIVATE_KEY_FILE: "/other/key" },
    });
    assert.equal(parsed.env.SOPS_AGE_SSH_PRIVATE_KEY_FILE, "/other/key");
    assert.equal(parsed.keyFile, "/Users/me/id_rsa");
  });

  it("replaces derived keyFile environment when keyFile changes or clears", () => {
    let settings = parseSopsSettings({ keyFile: "/key-a" });
    assert.equal(settings.env.SOPS_AGE_SSH_PRIVATE_KEY_FILE, "/key-a");
    settings = parseSopsSettings({ keyFile: "/key-b" }, { ...settings, env: {} });
    assert.equal(settings.env.SOPS_AGE_SSH_PRIVATE_KEY_FILE, "/key-b");
    settings = parseSopsSettings({ keyFile: "", env: {} }, { ...settings, env: {} });
    assert.equal(settings.env.SOPS_AGE_SSH_PRIVATE_KEY_FILE, undefined);
  });

  it("replaces configured environment entries", () => {
    const initial = parseSopsSettings({ env: { OLD: "1" } });
    const next = parseSopsSettings({ env: {} }, initial);
    assert.deepEqual(next.env, {});
  });
});
