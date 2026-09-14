import * as fs from "fs/promises";
import { CreateFile } from "vscode-languageserver/node";

export function sidecarOpenEdit(decryptedUri: string): {
  documentChanges: ReturnType<typeof CreateFile.create>[];
} {
  return {
    documentChanges: [
      CreateFile.create(decryptedUri, {
        overwrite: true,
        ignoreIfExists: false,
      }),
    ],
  };
}

export async function ensureSidecarContent(
  filePath: string,
  content: string
): Promise<void> {
  let onDisk: string | null = null;
  try {
    onDisk = await fs.readFile(filePath, "utf-8");
  } catch {
    onDisk = null;
  }
  if (onDisk === content) return;
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

export async function restoreSidecarAfterOpen(
  filePath: string,
  content: string
): Promise<void> {
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
  const now = new Date();
  await fs.utimes(filePath, now, now);
}
