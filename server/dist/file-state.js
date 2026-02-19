"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileStateManager = void 0;
const types_1 = require("./types");
class FileStateManager {
    constructor() {
        this.files = new Map();
    }
    get(uri) {
        return this.files.get(uri);
    }
    init(uri, encryptedFilePath, encryptedContent, fileType) {
        const ctx = {
            state: types_1.FileState.ENCRYPTED,
            uri,
            encryptedFilePath,
            encryptedContent,
            fileType,
        };
        this.files.set(uri, ctx);
        return ctx;
    }
    transition(uri, state) {
        const ctx = this.files.get(uri);
        if (ctx)
            ctx.state = state;
    }
    updateEncryptedContent(uri, content) {
        const ctx = this.files.get(uri);
        if (ctx)
            ctx.encryptedContent = content;
    }
    remove(uri) {
        this.files.delete(uri);
    }
}
exports.FileStateManager = FileStateManager;
//# sourceMappingURL=file-state.js.map