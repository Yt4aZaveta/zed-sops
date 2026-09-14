import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { SopsSettings } from "./types";

function isInside(absFile: string, folder: string): boolean {
  const root = path.resolve(folder);
  const file = path.resolve(absFile);
  return file === root || file.startsWith(root + path.sep);
}

function configInDir(dir: string): string | undefined {
  const yamlPath = path.join(dir, ".sops.yaml");
  if (fs.existsSync(yamlPath)) return yamlPath;
  const ymlPath = path.join(dir, ".sops.yml");
  if (fs.existsSync(ymlPath)) return ymlPath;
  return undefined;
}

export function findSopsConfigPath(
  encryptedFilePath: string,
  workspaceFolders: string[]
): string | undefined {
  const abs = path.resolve(encryptedFilePath);
  const startDir = path.dirname(abs);
  const containing = workspaceFolders
    .map((folder) => path.resolve(folder))
    .find((folder) => isInside(abs, folder));

  if (!containing) {
    return configInDir(startDir);
  }

  let dir = startDir;
  while (true) {
    const found = configInDir(dir);
    if (found) return found;
    if (path.resolve(dir) === path.resolve(containing)) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function toPosixRelative(fromDir: string, filePath: string): string {
  return path.relative(fromDir, filePath).split(path.sep).join("/");
}

export function pathMatchesCreationRules(
  encryptedFilePath: string,
  configPath: string,
  parsed: unknown,
  warn?: (msg: string) => void
): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const rules = (parsed as { creation_rules?: unknown }).creation_rules;
  if (!Array.isArray(rules)) return false;

  const configDir = path.dirname(configPath);
  const relative = toPosixRelative(configDir, encryptedFilePath);

  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const pathRegex = (rule as { path_regex?: unknown }).path_regex;
    if (pathRegex === undefined || pathRegex === null || pathRegex === "") {
      return true;
    }
    if (typeof pathRegex !== "string") continue;
    try {
      if (new RegExp(pathRegex).test(relative)) return true;
    } catch {
      warn?.(
        `SOPS: invalid path_regex ${JSON.stringify(pathRegex)} in ${configPath}`
      );
    }
  }
  return false;
}

function containsGitSegment(absolutePath: string): boolean {
  return absolutePath.includes("/.git/") || absolutePath.includes("\\.git\\");
}

export async function isAutoEditAllowed(
  absolutePath: string,
  settings: Pick<SopsSettings, "autoEdit" | "autoEditAll">,
  workspaceFolders: string[],
  warn?: (msg: string) => void
): Promise<boolean> {
  if (!settings.autoEdit) return false;
  if (containsGitSegment(absolutePath)) return false;
  if (settings.autoEditAll) return true;
  const configPath = findSopsConfigPath(absolutePath, workspaceFolders);
  if (!configPath) return false;
  let parsed: unknown;
  try {
    const text = await fsPromises.readFile(configPath, "utf-8");
    parsed = parseYaml(text);
  } catch (error) {
    warn?.(
      `SOPS: failed to parse ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
  return pathMatchesCreationRules(absolutePath, configPath, parsed, warn);
}
