"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileStateManager = void 0;
const types_1 = require("./types");
/**
 * Manages state for SOPS-managed files.
 * Keyed by the decrypted sidecar file's URI (the file open in the editor).
 */
class FileStateManager {
    constructor() {
        this.files = new Map();
    }
    get(decryptedUri) {
        return this.files.get(decryptedUri);
    }
    init(decryptedUri, encryptedFilePath, encryptedContent, decryptedFilePath, fileType) {
        const ctx = {
            state: types_1.FileState.DECRYPTED,
            encryptedFilePath,
            encryptedContent,
            decryptedFilePath,
            fileType,
        };
        this.files.set(decryptedUri, ctx);
        return ctx;
    }
    transition(decryptedUri, state) {
        const ctx = this.files.get(decryptedUri);
        if (ctx)
            ctx.state = state;
    }
    updateEncryptedContent(decryptedUri, content) {
        const ctx = this.files.get(decryptedUri);
        if (ctx)
            ctx.encryptedContent = content;
    }
    remove(decryptedUri) {
        this.files.delete(decryptedUri);
    }
}
exports.FileStateManager = FileStateManager;
//# sourceMappingURL=file-state.js.map