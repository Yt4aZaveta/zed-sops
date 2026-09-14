import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { SopsFileType, SopsRunnerLike, SopsSettings } from "./types";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const ERROR_CAP = 800;

export function formatSopsError(error: unknown, timeoutMs?: number): string {
  const err = error as {
    killed?: boolean;
    stderr?: string;
    message?: string;
  };
  if (err && err.killed && timeoutMs !== undefined) {
    return `sops timed out after ${timeoutMs}ms`;
  }
  const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : "";
  const raw =
    stderr ||
    (error instanceof Error ? error.message : String(error));
  return raw.length > ERROR_CAP ? raw.slice(0, ERROR_CAP) : raw;
}

export class SopsRunner implements SopsRunnerLike {
  private settings: SopsSettings;
  private verifyStatus: "ok" | "missing" | "error" | undefined;

  constructor(settings: SopsSettings) {
    this.settings = settings;
  }

  updateSettings(next: SopsSettings): boolean {
    const changed = this.settings.sopsPath !== next.sopsPath || JSON.stringify(this.settings.env) !== JSON.stringify(next.env) || this.settings.timeoutMs !== next.timeoutMs;
    this.settings = next;
    if (changed) this.verifyStatus = undefined;
    return changed;
  }

  getVerifyStatus(): "ok" | "missing" | "error" | undefined {
    return this.verifyStatus;
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.settings.env };
  }

  async verify(): Promise<"ok" | "missing" | "error"> {
    if (this.verifyStatus) return this.verifyStatus;
    try {
      await execFileAsync(this.settings.sopsPath, ["--version"], {
        env: this.env(),
        timeout: this.settings.timeoutMs,
        maxBuffer: MAX_BUFFER,
      });
      this.verifyStatus = "ok";
    } catch (error) {
      this.verifyStatus = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "error";
    }
    return this.verifyStatus;
  }

  async decrypt(filePath: string, fileType: SopsFileType): Promise<string> {
    const { stdout } = await execFileAsync(
      this.settings.sopsPath,
      ["decrypt", "--input-type", fileType, "--output-type", fileType, filePath],
      {
        env: this.env(),
        maxBuffer: MAX_BUFFER,
        timeout: this.settings.timeoutMs,
      }
    );
    return stdout;
  }

  async reEncryptStaged(
    filePath: string,
    expectedCiphertext: string,
    plaintext: string,
    fileType: SopsFileType
  ): Promise<string> {
    const originalStat = await fs.stat(filePath);
    const stageDir = await fs.mkdtemp(path.join(path.dirname(filePath), ".zed-sops-stage-"));
    await fs.chmod(stageDir, 0o700);
    const staged = path.join(stageDir, path.basename(filePath));
    const tmpContentFile = path.join(stageDir, "plaintext");
    const tmpEditorScript = path.join(stageDir, "editor.sh");

    try {
      await fs.writeFile(staged, expectedCiphertext, { encoding: "utf8", mode: originalStat.mode & 0o777 });
      await fs.chmod(staged, originalStat.mode & 0o777);
      await fs.writeFile(tmpContentFile, plaintext, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await fs.chmod(tmpContentFile, 0o600);
      const editorScript = `#!/bin/sh\ncp "$SOPS_ZED_CONTENT" "$1"\n`;
      await fs.writeFile(tmpEditorScript, editorScript, {
        encoding: "utf-8",
        mode: 0o700,
      });
      await fs.chmod(tmpEditorScript, 0o700);

      await execFileAsync(this.settings.sopsPath, ["--input-type", fileType, "--output-type", fileType, staged], {
        env: {
          ...this.env(),
          EDITOR: tmpEditorScript,
          SOPS_ZED_CONTENT: tmpContentFile,
        },
        maxBuffer: MAX_BUFFER,
        timeout: this.settings.timeoutMs,
      });
      await this.decrypt(staged, fileType);
      const current = await fs.readFile(filePath, "utf8");
      if (current !== expectedCiphertext) throw new Error(`SOPS: ${filePath} changed on disk; not publishing staged ciphertext.`);
      const committed = await fs.readFile(staged, "utf8");
      await fs.chmod(staged, originalStat.mode & 0o777);
      const handle = await fs.open(staged, "r"); await handle.sync(); await handle.close();
      await fs.rename(staged, filePath);
      const dirHandle = await fs.open(path.dirname(filePath), "r"); await dirHandle.sync(); await dirHandle.close();
      return committed;
    } finally {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
