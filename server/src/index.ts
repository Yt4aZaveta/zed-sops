import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  TextDocumentEdit,
  TextEdit,
  Range,
  Position,
  OptionalVersionedTextDocumentIdentifier,
  CreateFile,
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
import { fileURLToPath, pathToFileURL } from "url";
import { EditSessionRegistry } from "./edit-session";
import { isAutoEditAllowed } from "./sops-config";
import {
  detectFileType,
  getEncryptedPath,
  isDecryptedFile,
  isSopsEncrypted,
} from "./sops-detector";
import { formatSopsError, SopsRunner } from "./sops-runner";
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
let registry = new EditSessionRegistry(sopsRunner);
let workspaceFolders: string[] = [];
let verifyPromise: Promise<"ok" | "missing"> = Promise.resolve("ok");

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

function isSidecarOpen(sidecarPath: string): boolean {
  const uri = filePathToUri(sidecarPath);
  return documents.get(uri) !== undefined;
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

async function openDecryptedFile(
  decryptedUri: string,
  decryptedFilePath: string,
  content: string
): Promise<boolean> {
  try {
    const existingContent = await fs.readFile(decryptedFilePath, "utf-8");
    const lines = existingContent.split("\n");
    const lastLine = Math.max(lines.length - 1, 0);
    const lastChar = (lines[lastLine] ?? "").length;
    const result = await connection.workspace.applyEdit({
      documentChanges: [
        CreateFile.create(decryptedUri, { overwrite: true }),
        TextDocumentEdit.create(
          OptionalVersionedTextDocumentIdentifier.create(decryptedUri, null),
          [
            TextEdit.replace(
              Range.create(
                Position.create(0, 0),
                Position.create(lastLine, lastChar)
              ),
              content
            ),
          ]
        ),
      ],
    });
    return result.applied;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    connection.console.error(`SOPS: Failed to open sidecar via applyEdit: ${msg}`);
    return false;
  }
}

async function startEditSession(encryptedUri: string): Promise<void> {
  const encryptedPath = uriToFilePath(encryptedUri);
  const existing = registry.getByEncryptedPath(encryptedPath);
  if (existing) {
    const opened = await openDecryptedFile(
      existing.decryptedUri,
      existing.decryptedFilePath,
      await fs.readFile(existing.decryptedFilePath, "utf-8").catch(() => "")
    );
    if (!opened) {
      connection.window.showInformationMessage(
        `SOPS: decrypted to ${existing.decryptedFilePath} — open it to edit.`
      );
    }
    return;
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
    const { session, plaintext } = await registry.start(
      encryptedPath,
      encryptedContent,
      fileType
    );
    const opened = await openDecryptedFile(
      session.decryptedUri,
      session.decryptedFilePath,
      plaintext
    );
    if (!opened) {
      connection.window.showInformationMessage(
        `SOPS: decrypted to ${session.decryptedFilePath} — open it to edit.`
      );
    }
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
  settings = parseSopsSettings(params.initializationOptions);
  sopsRunner = new SopsRunner(settings);
  registry = new EditSessionRegistry(sopsRunner);
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
    if (registry.getByDecryptedUri(uri)) {
      publishSidecarManaged(uri, document.getText());
      return;
    }
    const encryptedFilePath = getEncryptedPath(filePath);
    try {
      const encryptedContent = await fs.readFile(encryptedFilePath, "utf-8");
      const fileType = detectFileType(encryptedFilePath);
      if (!isSopsEncrypted(encryptedContent, fileType)) return;
      await registry.adopt(
        filePath,
        encryptedFilePath,
        encryptedContent,
        fileType
      );
      publishSidecarManaged(uri, document.getText());
      const encUri = filePathToUri(encryptedFilePath);
      const encDoc = documents.get(encUri);
      if (encDoc) {
        await publishCiphertextDiagnostics(
          encUri,
          encDoc.getText(),
          path.basename(filePath)
        );
      }
    } catch {
      // Companion missing — ignore
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

  await registry.deleteOrphanSidecars(filePath, isSidecarOpen);

  const session = registry.getByEncryptedPath(filePath);
  if (session) {
    await publishCiphertextDiagnostics(
      uri,
      content,
      path.basename(session.decryptedFilePath)
    );
    return;
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
  const ctx = registry.getByDecryptedUri(document.uri);
  if (!ctx) return;
  // includeText keeps the in-memory document current; that is the plaintext.
  // Fall back to the sidecar on disk only if getText is unavailable.
  const plaintext =
    document.getText() ??
    (await fs.readFile(ctx.decryptedFilePath, "utf-8"));
  try {
    await registry.save(document.uri, plaintext);
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
    const session = registry.getByDecryptedUri(uri);
    const encryptedFilePath = session?.encryptedFilePath;
    await registry.close(uri);
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
