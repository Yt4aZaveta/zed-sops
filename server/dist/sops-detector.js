"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSopsEncrypted = isSopsEncrypted;
exports.detectFileType = detectFileType;
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
 * Determine the SOPS file type from a file URI/path extension.
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