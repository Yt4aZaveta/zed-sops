use zed_extension_api as zed;

struct SopsExtension;

impl zed::Extension for SopsExtension {
    fn new() -> Self {
        SopsExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command, String> {
        let work_dir = std::env::current_dir()
            .map_err(|e| format!("Failed to get work dir: {}", e))?;

        // Install npm dependencies into the work directory if not present
        if !work_dir.join("node_modules").exists() {
            zed::npm_install_package("vscode-languageserver", &"9.0.1")
                .map_err(|e| format!("Failed to install vscode-languageserver: {}", e))?;
            zed::npm_install_package("vscode-languageserver-textdocument", &"1.0.12")
                .map_err(|e| format!("Failed to install vscode-languageserver-textdocument: {}", e))?;
        }

        // Write server JS files (embedded at compile time) to the work directory.
        // Always overwrite to ensure the latest version is deployed.
        let dist_dir = work_dir.join("dist");
        let server_entry = dist_dir.join("index.js");
        std::fs::create_dir_all(&dist_dir)
            .map_err(|e| format!("Failed to create dist dir: {}", e))?;
        std::fs::write(&server_entry, include_str!("../server/dist/index.js"))
            .map_err(|e| format!("Failed to write index.js: {}", e))?;
        std::fs::write(dist_dir.join("types.js"), include_str!("../server/dist/types.js"))
            .map_err(|e| format!("Failed to write types.js: {}", e))?;
        std::fs::write(dist_dir.join("sops-detector.js"), include_str!("../server/dist/sops-detector.js"))
            .map_err(|e| format!("Failed to write sops-detector.js: {}", e))?;
        std::fs::write(dist_dir.join("sops-runner.js"), include_str!("../server/dist/sops-runner.js"))
            .map_err(|e| format!("Failed to write sops-runner.js: {}", e))?;
        std::fs::write(dist_dir.join("file-state.js"), include_str!("../server/dist/file-state.js"))
            .map_err(|e| format!("Failed to write file-state.js: {}", e))?;

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                server_entry.to_string_lossy().to_string(),
                "--stdio".to_string(),
            ],
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(SopsExtension);
