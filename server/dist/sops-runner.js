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
exports.SopsRunner = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
class SopsRunner {
    constructor(config) {
        this.config = config;
    }
    /**
     * Verify that sops is installed and accessible.
     */
    async verify() {
        const { stdout } = await execFileAsync(this.config.sopsPath, ["--version"], {
            env: { ...process.env, ...this.config.env },
        });
        return stdout.trim();
    }
    /**
     * Decrypt a SOPS-encrypted file and return the plaintext content.
     */
    async decrypt(filePath, fileType) {
        const { stdout } = await execFileAsync(this.config.sopsPath, ["decrypt", "--input-type", fileType, "--output-type", fileType, filePath], {
            env: { ...process.env, ...this.config.env },
            maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
    }
    /**
     * Re-encrypt a file using the EDITOR trick.
     *
     * This preserves the original encryption keys and metadata because SOPS
     * handles the re-encryption itself using its standard edit workflow:
     * 1. Create a temp script that writes newContent to whatever file sops passes
     * 2. Set EDITOR to this script
     * 3. Run `sops <filepath>` — sops decrypts, calls "editor", re-encrypts
     */
    async reEncrypt(filePath, newContent, _fileType) {
        const tmpDir = os.tmpdir();
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const tmpContentFile = path.join(tmpDir, `sops-content-${id}`);
        const tmpEditorScript = path.join(tmpDir, `sops-editor-${id}.sh`);
        try {
            await fs.writeFile(tmpContentFile, newContent, { mode: 0o600 });
            const editorScript = `#!/bin/sh\ncp "${tmpContentFile}" "$1"\n`;
            await fs.writeFile(tmpEditorScript, editorScript, { mode: 0o755 });
            await execFileAsync(this.config.sopsPath, [filePath], {
                env: {
                    ...process.env,
                    ...this.config.env,
                    EDITOR: tmpEditorScript,
                },
                maxBuffer: 10 * 1024 * 1024,
            });
        }
        finally {
            await fs.unlink(tmpContentFile).catch(() => { });
            await fs.unlink(tmpEditorScript).catch(() => { });
        }
    }
}
exports.SopsRunner = SopsRunner;
//# sourceMappingURL=sops-runner.js.map