"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const node_1 = require("vscode-languageserver/node");
const vscode_languageserver_textdocument_1 = require("vscode-languageserver-textdocument");
const fs = __importStar(require("fs/promises"));
const file_state_1 = require("./file-state");
const sops_detector_1 = require("./sops-detector");
const sops_runner_1 = require("./sops-runner");
const types_1 = require("./types");
process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
});
process.on("unhandledRejection", (reason) => {
    console.error("Unhandled Rejection:", reason);
});
const connection = (0, node_1.createConnection)(node_1.ProposedFeatures.all);
const documents = new node_1.TextDocuments(vscode_languageserver_textdocument_1.TextDocument);
const stateManager = new file_state_1.FileStateManager();
let sopsRunner;
connection.onInitialize((params) => {
    const opts = params.initializationOptions || {};
    sopsRunner = new sops_runner_1.SopsRunner({
        sopsPath: opts.sopsPath || "sops",
        env: opts.env || {},
    });
    return {
        capabilities: {
            textDocumentSync: {
                openClose: true,
                change: node_1.TextDocumentSyncKind.Full,
                save: { includeText: true },
            },
        },
    };
});
connection.onInitialized(async () => {
    try {
        const version = await sopsRunner.verify();
        connection.console.log(`SOPS LSP initialized (sops ${version})`);
    }
    catch {
        connection.window.showWarningMessage("SOPS binary not found. Install sops and ensure it is on PATH, or set sopsPath in settings.");
    }
});
function uriToFilePath(uri) {
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
    const fileType = (0, sops_detector_1.detectFileType)(uri);
    if (!(0, sops_detector_1.isSopsEncrypted)(content, fileType)) {
        return;
    }
    const filePath = uriToFilePath(uri);
    stateManager.init(uri, filePath, content, fileType);
    try {
        const decryptedContent = await sopsRunner.decrypt(filePath, fileType);
        const applied = await replaceBufferContent(uri, document, content, decryptedContent);
        if (applied) {
            stateManager.transition(uri, types_1.FileState.DECRYPTED);
            connection.console.log(`SOPS: Decrypted ${filePath}`);
        }
        else {
            stateManager.remove(uri);
            connection.window.showWarningMessage("SOPS: Could not auto-decrypt. The file appears SOPS-encrypted.");
        }
    }
    catch (error) {
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
    if (!ctx)
        return;
    if (ctx.state === types_1.FileState.ENCRYPTING)
        return;
    if (ctx.state !== types_1.FileState.DECRYPTED)
        return;
    stateManager.transition(uri, types_1.FileState.ENCRYPTING);
    try {
        const filePath = ctx.encryptedFilePath;
        // Read what the user just saved to disk
        const newPlaintext = await fs.readFile(filePath, "utf-8");
        // If the saved content is already encrypted (e.g. Zed reloaded encrypted
        // content from disk after a previous save), skip re-encryption.
        if ((0, sops_detector_1.isSopsEncrypted)(newPlaintext, ctx.fileType)) {
            stateManager.transition(uri, types_1.FileState.DECRYPTED);
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
        stateManager.transition(uri, types_1.FileState.DECRYPTED);
        connection.console.log(`SOPS: Re-encrypted ${filePath} successfully`);
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        connection.console.error(`SOPS: Re-encryption failed: ${msg}`);
        connection.window.showErrorMessage(`SOPS re-encryption failed: ${msg}`);
        stateManager.transition(uri, types_1.FileState.DECRYPTED);
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
        fs.writeFile(filePath, ctx.encryptedContent, "utf-8").catch(() => { });
        connection.console.log(`SOPS: Restored encrypted content on close: ${filePath}`);
    }
    stateManager.remove(uri);
});
/**
 * Replace the entire buffer content via workspace/applyEdit.
 */
async function replaceBufferContent(uri, document, currentContent, newContent) {
    const fullRange = node_1.Range.create(node_1.Position.create(0, 0), document.positionAt(currentContent.length));
    const result = await connection.workspace.applyEdit({
        documentChanges: [
            node_1.TextDocumentEdit.create(node_1.OptionalVersionedTextDocumentIdentifier.create(uri, document.version), [node_1.TextEdit.replace(fullRange, newContent)]),
        ],
    });
    return result.applied;
}
documents.listen(connection);
connection.listen();
//# sourceMappingURL=index.js.map