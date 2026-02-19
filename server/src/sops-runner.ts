import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { SopsConfig, SopsFileType } from "./types";

const execFileAsync = promisify(execFile);

export class SopsRunner {
  private config: SopsConfig;

  constructor(config: SopsConfig) {
    this.config = config;
  }

  /**
   * Verify that sops is installed and accessible.
   */
  async verify(): Promise<string> {
    const { stdout } = await execFileAsync(this.config.sopsPath, ["--version"], {
      env: { ...process.env, ...this.config.env },
    });
    return stdout.trim();
  }

  /**
   * Decrypt a SOPS-encrypted file and return the plaintext content.
   */
  async decrypt(filePath: string, fileType: SopsFileType): Promise<string> {
    const { stdout } = await execFileAsync(
      this.config.sopsPath,
      ["decrypt", "--input-type", fileType, "--output-type", fileType, filePath],
      {
        env: { ...process.env, ...this.config.env },
        maxBuffer: 10 * 1024 * 1024,
      }
    );
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
  async reEncrypt(
    filePath: string,
    newContent: string,
    _fileType: SopsFileType
  ): Promise<void> {
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
    } finally {
      await fs.unlink(tmpContentFile).catch(() => {});
      await fs.unlink(tmpEditorScript).catch(() => {});
    }
  }
}
