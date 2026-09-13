import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

export async function makeTempDir(prefix = "zed-sops-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFile(
  filePath: string,
  content: string,
  mode?: number
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode });
  if (mode !== undefined) {
    await fs.chmod(filePath, mode);
  }
}
