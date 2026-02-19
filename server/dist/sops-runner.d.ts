import { SopsConfig, SopsFileType } from "./types";
export declare class SopsRunner {
    private config;
    constructor(config: SopsConfig);
    /**
     * Verify that sops is installed and accessible.
     */
    verify(): Promise<string>;
    /**
     * Decrypt a SOPS-encrypted file and return the plaintext content.
     */
    decrypt(filePath: string, fileType: SopsFileType): Promise<string>;
    /**
     * Re-encrypt a file using the EDITOR trick.
     *
     * This preserves the original encryption keys and metadata because SOPS
     * handles the re-encryption itself using its standard edit workflow:
     * 1. Create a temp script that writes newContent to whatever file sops passes
     * 2. Set EDITOR to this script
     * 3. Run `sops <filepath>` — sops decrypts, calls "editor", re-encrypts
     */
    reEncrypt(filePath: string, newContent: string, _fileType: SopsFileType): Promise<void>;
}
