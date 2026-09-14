import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { supportsShowDocument, ZedClient } from "../src/zed-client";

describe("supportsShowDocument", () => {
  it("requires the explicit LSP client capability", () => {
    assert.equal(supportsShowDocument({}), false);
    assert.equal(
      supportsShowDocument({ window: { showDocument: { support: true } } }),
      true
    );
  });
});

describe("ZedClient.openDocument", () => {
  it("uses window/showDocument and requests focus when supported", async () => {
    const shown: unknown[] = [];
    const messages: string[] = [];
    const client = new ZedClient(
      {
        window: {
          async showDocument(params: unknown) {
            shown.push(params);
            return { success: true };
          },
          showInformationMessage(message: string) {
            messages.push(message);
          },
        },
        console: { warn() {} },
      },
      true
    );
    const result = await client.openDocument("file:///tmp/.decrypted.a.yaml");
    assert.equal(result, "opened");
    assert.deepEqual(shown, [
      {
        uri: "file:///tmp/.decrypted.a.yaml",
        external: false,
        takeFocus: true,
      },
    ]);
    assert.deepEqual(messages, []);
  });

  it("does not send showDocument when unsupported", async () => {
    let showCalls = 0;
    const messages: string[] = [];
    const client = new ZedClient(
      {
        window: {
          async showDocument() {
            showCalls += 1;
            return { success: true };
          },
          showInformationMessage(message: string) {
            messages.push(message);
          },
        },
        console: { warn() {} },
      },
      false
    );
    const result = await client.openDocument("file:///tmp/.decrypted.a.yaml");
    assert.equal(result, "manual");
    assert.equal(showCalls, 0);
    assert.match(messages[0], /\/tmp\/\.decrypted\.a\.yaml/);
    assert.match(messages[0], /open it manually/i);
  });

  it("falls back when a supported client returns success false", async () => {
    const messages: string[] = [];
    const client = new ZedClient(
      {
        window: {
          async showDocument() {
            return { success: false };
          },
          showInformationMessage(message: string) {
            messages.push(message);
          },
        },
        console: { warn() {} },
      },
      true
    );
    assert.equal(
      await client.openDocument("file:///tmp/.decrypted.a.yaml"),
      "manual"
    );
    assert.equal(messages.length, 1);
  });

  it("falls back when showDocument throws", async () => {
    const messages: string[] = [];
    const client = new ZedClient(
      {
        window: {
          async showDocument() {
            throw new Error("unhandled method");
          },
          showInformationMessage(message: string) {
            messages.push(message);
          },
        },
        console: { warn() {} },
      },
      true
    );
    assert.equal(
      await client.openDocument("file:///tmp/.decrypted.a.yaml"),
      "manual"
    );
    assert.equal(messages.length, 1);
  });
});
