import { fileURLToPath } from "url";
import type {
  ClientCapabilities,
  ShowDocumentParams,
} from "vscode-languageserver/node";

type ZedConnection = {
  window: {
    showDocument(params: ShowDocumentParams): Promise<{ success: boolean }>;
    showInformationMessage(message: string): unknown;
  };
  console: { warn(message: string): unknown };
};

export function supportsShowDocument(
  capabilities: ClientCapabilities
): boolean {
  return capabilities.window?.showDocument?.support === true;
}

function displayPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

export class ZedClient {
  constructor(
    private readonly connection: ZedConnection,
    private readonly canShowDocument: boolean
  ) {}

  async openDocument(uri: string): Promise<"opened" | "manual"> {
    if (this.canShowDocument) {
      try {
        const result = await this.connection.window.showDocument({
          uri,
          external: false,
          takeFocus: true,
        });
        if (result.success) return "opened";
        this.connection.console.warn(`SOPS: Zed declined to open ${uri}`);
      } catch (error) {
        this.connection.console.warn(
          `SOPS: window/showDocument failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    const filePath = displayPath(uri);
    this.connection.window.showInformationMessage(
      `SOPS: decrypted file is ready at ${filePath}. Open it manually; this Zed build does not support window/showDocument.`
    );
    return "manual";
  }
}
