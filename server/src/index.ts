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
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs/promises";
import { FileStateManager } from "./file-state";
import {
  isSopsEncrypted,
  detectFileType,
} from "./sops-detector";
import { SopsRunner } from "./sops-runner";
import { FileState } from "./types";

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const stateManager = new FileStateManager();

let sopsRunner: SopsRunner;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const opts = (params.initializationOptions as Record<string, unknown>) || {};

  sopsRunner = new SopsRunner({
    sopsPath: (opts.sopsPath as string) || "sops",
    env: (opts.env as Record<string, string>) || {},
  });

  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: true },
      },
    },
  };
});

connection.onInitialized(async () => {
  try {
    const version = await sopsRunner.verify();
    connection.console.log(`SOPS LSP initialized (sops ${version})`);
  } catch {
    connection.window.showWarningMessage(
      "SOPS binary not found. Install sops and ensure it is on PATH, or set sopsPath in settings."
    );
  }
});

function uriToFilePath(uri: string): string {
  if (uri.startsWith("file://")) {
    return decodeURIComponent(uri.slice(7));
  }
  return uri;
}

/**
 * On file open: detect SOPS encryption and replace buffer with decrypted content.
 */
documents.onDidOpen(async (event) => {
  const { document } = event;
  const uri = document.uri;
  const content = document.getText();
  const fileType = detectFileType(uri);

  if (!isSopsEncrypted(content, fileType)) {
    return;
  }

  const filePath = uriToFilePath(uri);
  stateManager.init(uri, filePath, content, fileType);

  try {
    const decryptedContent = await sopsRunner.decrypt(filePath, fileType);

    const applied = await replaceBufferContent(uri, document, content, decryptedContent);

    if (applied) {
      stateManager.transition(uri, FileState.DECRYPTED);
      connection.console.log(`SOPS: Decrypted ${filePath}`);
    } else {
      stateManager.remove(uri);
      connection.window.showWarningMessage(
        "SOPS: Could not auto-decrypt. The file appears SOPS-encrypted."
      );
    }
  } catch (error: unknown) {
    stateManager.remove(uri);
    const msg = error instanceof Error ? error.message : String(error);
    connection.window.showErrorMessage(`SOPS decrypt failed: ${msg}`);
  }
});

/**
 * On file save: re-encrypt if the file is managed by us.
 *
 * After Zed saves, the file on disk contains plaintext. We:
 * 1. Read the plaintext
 * 2. Re-encrypt the original file on disk
 * 3. Do NOT touch the buffer — it already has the user's plaintext
 *
 * We skip replaceBufferContent after save because workspace/applyEdit
 * marks the buffer dirty, which triggers Zed's autosave to overwrite
 * the encrypted file with plaintext again.
 */
documents.onDidSave(async (event) => {
  const { document } = event;
  const uri = document.uri;
  const ctx = stateManager.get(uri);

  if (!ctx) return;
  if (ctx.state === FileState.ENCRYPTING) return;
  if (ctx.state !== FileState.DECRYPTED) return;

  stateManager.transition(uri, FileState.ENCRYPTING);

  try {
    const filePath = ctx.encryptedFilePath;

    // Read what the user just saved to disk
    const newPlaintext = await fs.readFile(filePath, "utf-8");

    // If the saved content is already encrypted (e.g. Zed reloaded encrypted
    // content from disk after a previous save), skip re-encryption.
    if (isSopsEncrypted(newPlaintext, ctx.fileType)) {
      stateManager.transition(uri, FileState.DECRYPTED);
      connection.console.log(`SOPS: Saved content is already encrypted, skipping`);
      return;
    }

    // Restore encrypted content so sops can re-encrypt
    await fs.writeFile(filePath, ctx.encryptedContent, "utf-8");

    // Re-encrypt using the EDITOR trick (preserves keys & metadata)
    await sopsRunner.reEncrypt(filePath, newPlaintext, ctx.fileType);

    // Store the new encrypted content. The file on disk is now encrypted.
    // Zed will detect the disk content differs from the buffer and reload,
    // which triggers onDidOpen → automatic decryption again.
    const newEncrypted = await fs.readFile(filePath, "utf-8");
    stateManager.updateEncryptedContent(uri, newEncrypted);
    stateManager.transition(uri, FileState.DECRYPTED);

    connection.console.log(`SOPS: Re-encrypted ${filePath} successfully`);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    connection.console.error(`SOPS: Re-encryption failed: ${msg}`);
    connection.window.showErrorMessage(`SOPS re-encryption failed: ${msg}`);
    stateManager.transition(uri, FileState.DECRYPTED);
  }
});

/**
 * On close: restore encrypted content to disk.
 */
documents.onDidClose((event) => {
  const uri = event.document.uri;
  const ctx = stateManager.get(uri);

  if (ctx && ctx.encryptedContent) {
    const filePath = ctx.encryptedFilePath;
    fs.writeFile(filePath, ctx.encryptedContent, "utf-8").catch(() => {});
    connection.console.log(`SOPS: Restored encrypted content on close: ${filePath}`);
  }

  stateManager.remove(uri);
});

/**
 * Replace the entire buffer content via workspace/applyEdit.
 */
async function replaceBufferContent(
  uri: string,
  document: TextDocument,
  currentContent: string,
  newContent: string
): Promise<boolean> {
  const fullRange = Range.create(
    Position.create(0, 0),
    document.positionAt(currentContent.length)
  );

  const result = await connection.workspace.applyEdit({
    documentChanges: [
      TextDocumentEdit.create(
        OptionalVersionedTextDocumentIdentifier.create(uri, document.version),
        [TextEdit.replace(fullRange, newContent)]
      ),
    ],
  });

  return result.applied;
}

documents.listen(connection);
connection.listen();
