import * as path from "path";

export function shouldKeepSidecarOnFocus(opts: {
  focusedPath: string;
  encryptedPath: string;
  decryptedPath: string;
  bufferText: string | undefined;
  diskText: string;
}): boolean {
  const focused = path.resolve(opts.focusedPath);
  if (focused === path.resolve(opts.encryptedPath)) return true;
  if (focused === path.resolve(opts.decryptedPath)) return true;
  if (opts.bufferText !== undefined && opts.bufferText !== opts.diskText) {
    return true;
  }
  return false;
}
