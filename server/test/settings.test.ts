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
