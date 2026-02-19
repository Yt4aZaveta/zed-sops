"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileState = void 0;
var FileState;
(function (FileState) {
    /** File is confirmed SOPS-encrypted, not yet decrypted in buffer */
    FileState["ENCRYPTED"] = "encrypted";
    /** Buffer contains decrypted content, user is editing */
    FileState["DECRYPTED"] = "decrypted";
    /** Re-encryption in progress */
    FileState["ENCRYPTING"] = "encrypting";
})(FileState || (exports.FileState = FileState = {}));
//# sourceMappingURL=types.js.map