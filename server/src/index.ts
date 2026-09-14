import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  Range,
  Position,
  Diagnostic,
  DiagnosticSeverity,
  CodeAction,
  CodeActionKind,
  Command,
  CodeActionParams,
  ExecuteCommandParams,
  DidChangeConfigurationParams,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import { EditSessionRegistry } from "./edit-session";
import { isAutoEditAllowed } from "./sops-config";
import {
  detectFileType,
  isDecryptedFile,
  isSopsEncrypted,
} from "./sops-detector";
import { formatSopsError, SopsRunner } from "./sops-runner";
import { supportsShowDocument, ZedClient } from "./zed-client";
import { SidecarStore } from "./sidecar-store";
import {
  DEFAULT_SOPS_SETTINGS,
  parseSopsSettings,
  SopsSettings,
} from "./types";

const COMMAND_EDIT = "sops.editDecrypted";

process.on("uncaughtException", (error) => {
  try {
    connection.console.error(
      `Uncaught Exception: ${error instanceof Error ? error.stack ?? error.message : String(error)}`
    );
  } catch {
    // connection may not be usable
  }
  process.exit(1);
});

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let settings: SopsSettings = DEFAULT_SOPS_SETTINGS;
let sopsRunner = new SopsRunner(settings);
let sidecars = new SidecarStore(path.join(process.cwd(), ".zed-sops-state"), { pid: process.pid, nonce: randomUUID() });
let registry = new EditSessionRegistry(sopsRunner, sidecars);
let zedClient = new ZedClient(connection, false);
let workspaceFolders: string[] = [];
let verifyPromise: Promise<"ok" | "missing" | "error"> = Promise.resolve("ok");

process.on("unhandledRejection", (reason) => {
  const msg =
    reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  connection.console.error(`Unhandled Rejection: ${msg}`);
});

function uriToFilePath(uri: string): string {
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  return uri;
}

function filePathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}

function line0Range(text: string): Range {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return Range.create(Position.create(0, 0), Position.create(0, firstLine.length));
}

function infoDiagnostic(code: string, message: string, text: string): Diagnostic {
  return {
    range: line0Range(text),
    message,
    severity: DiagnosticSeverity.Information,
    source: "sops",
    code,
  };
}

async function publishCiphertextDiagnostics(
  uri: string,
  text: string,
  sidecarBasename?: string
): Promise<void> {
  if (sopsRunner.getVerifyStatus() === "missing") {
    connection.sendDiagnostics({
      uri,
      diagnostics: [
        infoDiagnostic("sops.unavailable", "SOPS binary not found", text),
      ],
    });
    return;
  }
  if (sidecarBasename) {
    connection.sendDiagnostics({
      uri,
      diagnostics: [
        infoDiagnostic(
          "sops.editing",
          `SOPS: editing ${sidecarBasename}`,
          text
        ),
      ],
    });
    return;
  }
  connection.sendDiagnostics({
    uri,
    diagnostics: [infoDiagnostic("sops.encrypted", "SOPS encrypted", text)],
  });
}

function publishSidecarManaged(uri: string, text: string): void {
  connection.sendDiagnostics({
    uri,
    diagnostics: [
      infoDiagnostic("sops.managed", "SOPS managed · save re-encrypts", text),
    ],
  });
}

async function openDecryptedFile(decryptedUri: string): Promise<void> {
  await zedClient.openDocument(decryptedUri);
}

async function startEditSession(encryptedUri: string): Promise<void> {
  const encryptedPath = uriToFilePath(encryptedUri);
  const existing = registry.getByEncryptedPath(encryptedPath);
  if (existing) {
    try {
      await fs.stat(existing.decryptedFilePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await registry.close(existing.decryptedUri);
      } else {
        connection.window.showErrorMessage(
          formatSopsError(error, settings.timeoutMs)
        );
        return;
      }
    }
    if (registry.getByEncryptedPath(encryptedPath)) {
      await openDecryptedFile(existing.decryptedUri);
      return;
    }
  }

  // Snapshot must be disk bytes: sops and encryptLoop both read the file.
  // An unsaved ciphertext buffer would make every sidecar save look stale.
  let encryptedContent: string;
  try {
    encryptedContent = await fs.readFile(encryptedPath, "utf-8");
  } catch (error) {
    connection.window.showErrorMessage(formatSopsError(error, settings.timeoutMs));
    return;
  }
  const fileType = detectFileType(encryptedPath);
  try {
    const ownership = await sidecars.inspect(encryptedPath);
    if (ownership.kind === "live-foreign") {
      connection.window.showErrorMessage("SOPS: file is already edited by another SOPS session.");
      return;
    }
    if (ownership.kind === "stale") {
      const choice = await connection.window.showWarningMessage(
        `SOPS: a previous session left ${ownership.record.sidecarPath}.`,
        { title: "Resume decrypted file" },
        { title: "Discard decrypted file" },
        { title: "Cancel" }
      );
      if (!choice || choice.title === "Cancel") return;
      const lease = await sidecars.claimStale(ownership.record, ownership.lockDir);
      if (choice.title === "Resume decrypted file") {
        const session = await registry.adopt(lease, encryptedContent, fileType);
        await openDecryptedFile(session.decryptedUri);
        return;
      }
      await sidecars.release(lease, true);
    }
    const { session, plaintext } = await registry.start(
      encryptedPath,
      encryptedContent,
      fileType
    );
    await openDecryptedFile(session.decryptedUri);
    const cipherDoc = documents.get(encryptedUri);
    await publishCiphertextDiagnostics(
      encryptedUri,
      cipherDoc?.getText() ?? encryptedContent,
      path.basename(session.decryptedFilePath)
    );
    const sidecarDoc = documents.get(session.decryptedUri);
    publishSidecarManaged(
      session.decryptedUri,
      sidecarDoc?.getText() ?? plaintext
    );
  } catch (error: unknown) {
    const msg = formatSopsError(error, settings.timeoutMs);
    connection.window.showErrorMessage(msg);
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  zedClient = new ZedClient(
    connection,
    supportsShowDocument(params.capabilities)
  );
  settings = parseSopsSettings(params.initializationOptions);
  sopsRunner = new SopsRunner(settings);
  sidecars = new SidecarStore(settings.stateDir || path.join(process.cwd(), ".zed-sops-state"), { pid: process.pid, nonce: randomUUID() });
  registry = new EditSessionRegistry(sopsRunner, sidecars);
  workspaceFolders = (params.workspaceFolders ?? []).map((folder) =>
    uriToFilePath(folder.uri)
  );
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        save: { includeText: true },
      },
      codeActionProvider: true,
      executeCommandProvider: { commands: [COMMAND_EDIT] },
    },
  };
});

connection.onInitialized(() => {
  verifyPromise = sopsRunner.verify().then((status) => {
    if (status === "missing") {
      connection.window.showWarningMessage(
        "SOPS binary not found. Install sops and ensure it is on PATH, or set lsp.sops-lsp.settings.sopsPath."
      );
    } else if (status === "error") {
      connection.window.showWarningMessage("SOPS verification failed; check sopsPath and settings.");
    } else {
      connection.console.log("SOPS LSP initialized");
    }
    return status;
  });
});

function settingsFromChange(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  if (
    obj.sopsPath !== undefined ||
    obj.autoEdit !== undefined ||
    obj.autoEditAll !== undefined ||
    obj.keyFile !== undefined ||
    obj.timeoutMs !== undefined ||
    obj.env !== undefined
  ) {
    return obj;
  }
  const lsp = obj.lsp;
  if (lsp && typeof lsp === "object") {
    const server = (lsp as Record<string, unknown>)["sops-lsp"];
    if (server && typeof server === "object") {
      const nested = server as Record<string, unknown>;
      return nested.settings ?? nested;
    }
  }
  return raw;
}

connection.onDidChangeConfiguration((change: DidChangeConfigurationParams) => {
  settings = parseSopsSettings(settingsFromChange(change.settings), settings);
  sopsRunner.updateSettings(settings);
});

connection.onCodeAction((params: CodeActionParams): CodeAction[] => {
  const fromDiag = params.context.diagnostics.some(
    (d) =>
      d.source === "sops" &&
      (d.code === "sops.encrypted" || d.code === "sops.unavailable")
  );
  const filePath = uriToFilePath(params.textDocument.uri);
  if (isDecryptedFile(filePath)) return [];
  const doc = documents.get(params.textDocument.uri);
  const encrypted =
    !!doc && isSopsEncrypted(doc.getText(), detectFileType(filePath));
  if (!fromDiag && !encrypted) return [];
  return [
    CodeAction.create(
      "SOPS: Edit decrypted",
      Command.create("SOPS: Edit decrypted", COMMAND_EDIT, params.textDocument.uri),
      CodeActionKind.QuickFix
    ),
  ];
});

connection.onExecuteCommand(async (params: ExecuteCommandParams) => {
  if (params.command !== COMMAND_EDIT) return;
  const uri = params.arguments?.[0];
  if (typeof uri !== "string") return;
  await startEditSession(uri);
});

documents.onDidOpen(async (event) => {
  const { document } = event;
  const uri = document.uri;
  const filePath = uriToFilePath(uri);

  if (isDecryptedFile(filePath)) {
    if (registry.getByDecryptedUri(uri) ?? registry.getByDecryptedPath(filePath)) {
      publishSidecarManaged(uri, document.getText());
    }
    return;
  }

  const content = document.getText();
  const fileType = detectFileType(filePath);
  if (!isSopsEncrypted(content, fileType)) {
    connection.sendDiagnostics({ uri, diagnostics: [] });
    return;
  }

  await verifyPromise;
  await publishCiphertextDiagnostics(uri, content);

  const session = registry.getByEncryptedPath(filePath);
  if (session) {
    try {
      await fs.access(session.decryptedFilePath);
      await publishCiphertextDiagnostics(
        uri,
        content,
        path.basename(session.decryptedFilePath)
      );
      return;
    } catch {
      await registry.close(session.decryptedUri);
    }
  }

  void (async () => {
    try {
      if (
        await isAutoEditAllowed(filePath, settings, workspaceFolders, (msg) =>
          connection.console.warn(msg)
        )
      ) {
        await startEditSession(uri);
      }
    } catch (error) {
      connection.console.error(formatSopsError(error, settings.timeoutMs));
    }
  })();
});

documents.onDidSave(async (event) => {
  const { document } = event;
  const ctx =
    registry.getByDecryptedUri(document.uri) ??
    registry.lookupDecrypted(document.uri);
  if (!ctx) return;
  const plaintext = document.getText();
  try {
    await registry.save(ctx.decryptedUri, plaintext);
    connection.console.log(`SOPS: Re-encrypted ${ctx.encryptedFilePath}`);
  } catch (error: unknown) {
    const msg = formatSopsError(error, settings.timeoutMs);
    connection.console.error(`SOPS: Re-encryption failed: ${msg}`);
    connection.window.showErrorMessage(msg);
  }
});

documents.onDidClose(async (event) => {
  const uri = event.document.uri;
  const filePath = uriToFilePath(uri);

  if (isDecryptedFile(filePath)) {
    const session =
      registry.getByDecryptedUri(uri) ?? registry.getByDecryptedPath(filePath);
    const encryptedFilePath = session?.encryptedFilePath;
    await registry.close(session?.decryptedUri ?? uri);
    connection.sendDiagnostics({ uri, diagnostics: [] });
    if (encryptedFilePath) {
      const encUri = filePathToUri(encryptedFilePath);
      const encDoc = documents.get(encUri);
      if (encDoc) {
        await publishCiphertextDiagnostics(encUri, encDoc.getText());
      }
    }
    return;
  }

  connection.sendDiagnostics({ uri, diagnostics: [] });
});

documents.listen(connection);
connection.listen();
