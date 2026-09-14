use zed_extension_api::{
    self as zed,
    serde_json::{json, Map, Value},
    settings::LspSettings,
};

struct SopsExtension;

fn merge_objects(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                base_map.insert(key, value);
            }
            Value::Object(base_map)
        }
        (_base, overlay) => overlay,
    }
}

fn lsp_options(worktree: &zed::Worktree) -> Result<Value, String> {
    let lsp = LspSettings::for_worktree("sops-lsp", worktree).unwrap_or_default();
    let mut options = lsp.initialization_options.unwrap_or_else(|| json!({}));
    if let Some(settings) = lsp.settings {
        options = merge_objects(options, settings);
    }
    let mut map: Map<String, Value> = match options {
        Value::Object(map) => map,
        other => {
            let mut map = Map::new();
            map.insert("value".to_string(), other);
            map
        }
    };
    let sops_path_missing = match map.get("sopsPath") {
        None => true,
        Some(Value::String(s)) if s.is_empty() => true,
        Some(Value::Null) => true,
        _ => false,
    };
    if sops_path_missing {
        let resolved = worktree.which("sops").unwrap_or_else(|| "sops".to_string());
        map.insert("sopsPath".to_string(), Value::String(resolved));
    }
    if !map.contains_key("env") {
        map.insert("env".to_string(), json!({}));
    }
    if !map.contains_key("autoEdit") {
        map.insert("autoEdit".to_string(), Value::Bool(true));
    }
    if !map.contains_key("autoEditAll") {
        map.insert("autoEditAll".to_string(), Value::Bool(false));
    }
    if !map.contains_key("timeoutMs") {
        map.insert("timeoutMs".to_string(), json!(60_000));
    }
    let state_dir = std::env::current_dir()
        .map_err(|e| format!("Failed to get extension work dir: {e}"))?
        .join("state");
    map.insert(
        "stateDir".to_string(),
        Value::String(state_dir.to_string_lossy().to_string()),
    );
    Ok(Value::Object(map))
}

impl zed::Extension for SopsExtension {
    fn new() -> Self {
        SopsExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command, String> {
        let work_dir =
            std::env::current_dir().map_err(|e| format!("Failed to get work dir: {}", e))?;

        let dist_dir = work_dir.join("dist");
        let server_entry = dist_dir.join("index.js");
        std::fs::create_dir_all(&dist_dir)
            .map_err(|e| format!("Failed to create dist dir: {}", e))?;
        let bundle = include_str!("../server/dist/index.js").as_bytes();
        let needs_write = std::fs::read(&server_entry)
            .map(|old| old != bundle)
            .unwrap_or(true);
        if needs_write {
            let temp = dist_dir.join(format!("index.js.{}.tmp", std::process::id()));
            let mut file = std::fs::File::create(&temp)
                .map_err(|e| format!("Failed to create temporary index.js: {}", e))?;
            use std::io::Write;
            file.write_all(bundle)
                .and_then(|_| file.sync_all())
                .map_err(|e| format!("Failed to write index.js: {}", e))?;
            std::fs::rename(&temp, &server_entry)
                .map_err(|e| format!("Failed to publish index.js: {}", e))?;
        }

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                server_entry.to_string_lossy().to_string(),
                "--stdio".to_string(),
            ],
            env: worktree.shell_env(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>, String> {
        Ok(Some(lsp_options(worktree)?))
    }

    fn language_server_workspace_configuration(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<zed::serde_json::Value>, String> {
        Ok(Some(lsp_options(worktree)?))
    }
}

zed::register_extension!(SopsExtension);
