import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
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
  private verifyStatus: "ok" | "missing" | undefined;

  constructor(settings: SopsSettings) {
    this.settings = settings;
  }

  updateSettings(partial: Partial<SopsSettings>): void {
    this.settings = { ...this.settings, ...partial };
  }

  getVerifyStatus(): "ok" | "missing" | undefined {
    return this.verifyStatus;
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.settings.env };
  }

  async verify(): Promise<"ok" | "missing"> {
    if (this.verifyStatus) return this.verifyStatus;
    try {
      await execFileAsync(this.settings.sopsPath, ["--version"], {
        env: this.env(),
        timeout: this.settings.timeoutMs,
        maxBuffer: MAX_BUFFER,
      });
      this.verifyStatus = "ok";
    } catch {
      this.verifyStatus = "missing";
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

  async reEncrypt(
    filePath: string,
    plaintext: string,
    _fileType: SopsFileType
  ): Promise<void> {
    const tmpDir = os.tmpdir();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tmpContentFile = path.join(tmpDir, `sops-content-${id}`);
    const tmpEditorScript = path.join(tmpDir, `sops-editor-${id}.sh`);

    try {
      await fs.writeFile(tmpContentFile, plaintext, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await fs.chmod(tmpContentFile, 0o600);
      const editorScript = `#!/bin/sh\ncp "$SOPS_ZED_CONTENT" "$1"\n`;
      await fs.writeFile(tmpEditorScript, editorScript, {
        encoding: "utf-8",
        mode: 0o755,
      });
      await fs.chmod(tmpEditorScript, 0o755);

      await execFileAsync(this.settings.sopsPath, [filePath], {
        env: {
          ...this.env(),
          EDITOR: tmpEditorScript,
          SOPS_ZED_CONTENT: tmpContentFile,
        },
        maxBuffer: MAX_BUFFER,
        timeout: this.settings.timeoutMs,
      });
    } finally {
      await fs.unlink(tmpContentFile).catch(() => {});
      await fs.unlink(tmpEditorScript).catch(() => {});
    }
  }
}
