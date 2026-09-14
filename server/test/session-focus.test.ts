import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { shouldKeepSidecarOnFocus } from "../src/session-focus";

const enc = path.join("proj", "a.yaml");
const dec = path.join("proj", ".decrypted.a.yaml");
const other = path.join("proj", "c.yaml");
const otherEnc = path.join("proj", "b.yaml");

describe("shouldKeepSidecarOnFocus", () => {
  it("keeps the sidecar while the ciphertext companion is focused", () => {
    assert.equal(
      shouldKeepSidecarOnFocus({
        focusedPath: enc,
        encryptedPath: enc,
        decryptedPath: dec,
        bufferText: undefined,
        diskText: "plain\n",
      }),
      true
    );
  });

  it("keeps the sidecar while the sidecar itself is focused", () => {
    assert.equal(
      shouldKeepSidecarOnFocus({
        focusedPath: dec,
        encryptedPath: enc,
        decryptedPath: dec,
        bufferText: "plain\n",
        diskText: "plain\n",
      }),
      true
    );
  });

  it("drops the sidecar when a third file is focused and there are no unsaved edits", () => {
    assert.equal(
      shouldKeepSidecarOnFocus({
        focusedPath: other,
        encryptedPath: enc,
        decryptedPath: dec,
        bufferText: "plain\n",
        diskText: "plain\n",
      }),
      false
    );
    assert.equal(
      shouldKeepSidecarOnFocus({
        focusedPath: other,
        encryptedPath: enc,
        decryptedPath: dec,
        bufferText: undefined,
        diskText: "plain\n",
      }),
      false
    );
  });

  it("keeps the sidecar when another file is focused but the buffer is dirty", () => {
    assert.equal(
      shouldKeepSidecarOnFocus({
        focusedPath: other,
        encryptedPath: enc,
        decryptedPath: dec,
        bufferText: "plain\n# edited\n",
        diskText: "plain\n",
      }),
      true
    );
  });

  it("drops the sidecar when another encrypted file is focused and the buffer is clean", () => {
    assert.equal(
      shouldKeepSidecarOnFocus({
        focusedPath: otherEnc,
        encryptedPath: enc,
        decryptedPath: dec,
        bufferText: undefined,
        diskText: "plain\n",
      }),
      false
    );
  });
});
