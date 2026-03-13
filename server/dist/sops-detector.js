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
exports.isSopsEncrypted = isSopsEncrypted;
exports.isDecryptedFile = isDecryptedFile;
exports.getDecryptedPath = getDecryptedPath;
exports.getEncryptedPath = getEncryptedPath;
exports.detectFileType = detectFileType;
const path = __importStar(require("path"));
const DECRYPTED_PREFIX = ".decrypted~";
/**
 * Detect if file content is SOPS-encrypted by checking for the sops metadata block.
 */
function isSopsEncrypted(content, fileType) {
    try {
        if (fileType === "json") {
            const parsed = JSON.parse(content);
            return (typeof parsed === "object" &&
                parsed !== null &&
                typeof parsed.sops === "object" &&
                typeof parsed.sops.version === "string");
        }
        if (fileType === "yaml") {
            const sopsMatch = content.match(/^sops:\s*$/m);
            if (!sopsMatch)
                return false;
            const afterSops = content.slice(sopsMatch.index + sopsMatch[0].length);
            return /^\s+version:\s+/m.test(afterSops);
        }
        if (fileType === "ini") {
            return content.includes("[sops]");
        }
        if (fileType === "dotenv") {
            return content.includes("sops_version=");
        }
        return false;
    }
    catch {
        return false;
    }
}
/**
 * Check if a file path refers to a .decrypted~ sidecar file.
 */
function isDecryptedFile(filePath) {
    return path.basename(filePath).startsWith(DECRYPTED_PREFIX);
}
/**
 * Get the .decrypted~ sidecar path for an encrypted file.
 * e.g. /path/to/secrets.yaml → /path/to/.decrypted~secrets.yaml
 */
function getDecryptedPath(encryptedFilePath) {
    const dir = path.dirname(encryptedFilePath);
    const name = path.basename(encryptedFilePath);
    return path.join(dir, `${DECRYPTED_PREFIX}${name}`);
}
/**
 * Get the original encrypted file path from a .decrypted~ sidecar path.
 * e.g. /path/to/.decrypted~secrets.yaml → /path/to/secrets.yaml
 */
function getEncryptedPath(decryptedFilePath) {
    const dir = path.dirname(decryptedFilePath);
    const name = path.basename(decryptedFilePath);
    return path.join(dir, name.slice(DECRYPTED_PREFIX.length));
}
/**
 * Determine the SOPS file type from a file URI/path extension.
 * Handles both encrypted files and .decrypted~ sidecar files.
 */
function detectFileType(uri) {
    const lower = uri.toLowerCase();
    if (lower.endsWith(".yaml") || lower.endsWith(".yml"))
        return "yaml";
    if (lower.endsWith(".json"))
        return "json";
    if (lower.endsWith(".ini"))
        return "ini";
    if (lower.endsWith(".env") || lower.includes(".env."))
        return "dotenv";
    return "yaml";
}
//# sourceMappingURL=sops-detector.js.map