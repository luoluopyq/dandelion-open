//! Interpreter discovery for the managed MLX environment, including GUI launches
//! whose PATH often exposes only Apple's old system Python.
use crate::{Error, Result};
use std::path::PathBuf;

const PROBE: &str = "import json, platform, sys; print(json.dumps({'version': list(sys.version_info[:2]), 'machine': platform.machine()}))";

fn supported_python(output: &[u8]) -> bool {
    let Ok(info) = serde_json::from_slice::<serde_json::Value>(output) else {
        return false;
    };
    let Some(version) = info["version"].as_array() else {
        return false;
    };
    version.first().and_then(|v| v.as_u64()) == Some(3)
        && version
            .get(1)
            .and_then(|v| v.as_u64())
            .is_some_and(|v| v >= 11)
        && matches!(info["machine"].as_str(), Some("arm64" | "aarch64"))
}

pub(crate) async fn python_is_supported(python: &std::path::Path) -> bool {
    match tokio::process::Command::new(python)
        .args(["-c", PROBE])
        .output()
        .await
    {
        Ok(output) => output.status.success() && supported_python(&output.stdout),
        Err(_) => false,
    }
}

pub(crate) async fn find_python() -> Result<PathBuf> {
    let names = [
        "python3.12",
        "python3.11",
        "python3.13",
        "python3.14",
        "python3",
    ];
    let mut candidates: Vec<PathBuf> = names.iter().map(PathBuf::from).collect();
    let mut roots = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(base) = directories::BaseDirs::new() {
        let home = base.home_dir();
        roots.push(home.join(".local/bin"));
        roots.push(home.join(".pyenv/shims"));
        if let Ok(versions) = std::fs::read_dir(home.join(".pyenv/versions")) {
            let mut bins: Vec<_> = versions.flatten().map(|v| v.path().join("bin")).collect();
            bins.sort();
            roots.extend(bins);
        }
    }
    for root in roots {
        candidates.extend(names.iter().map(|name| root.join(name)));
    }
    for candidate in candidates {
        if python_is_supported(&candidate).await {
            return Ok(candidate);
        }
    }
    Err(Error::Sidecar("未找到原生 Apple Silicon Python 3.11 或更高版本。请安装 Python 3.12 后重试；macOS 自带 Python 3.9 无法安装当前 MLX 运行器。".into()))
}

#[cfg(test)]
mod tests {
    use super::supported_python;

    #[test]
    fn interpreter_must_support_mlx_version_and_native_architecture() {
        assert!(supported_python(br#"{"version":[3,12],"machine":"arm64"}"#));
        assert!(supported_python(
            br#"{"version":[3,11],"machine":"aarch64"}"#
        ));
        assert!(!supported_python(br#"{"version":[3,9],"machine":"arm64"}"#));
        assert!(!supported_python(
            br#"{"version":[3,12],"machine":"x86_64"}"#
        ));
        assert!(!supported_python(br#"{"version":[],"machine":"arm64"}"#));
        assert!(!supported_python(b"not a Python interpreter"));
    }
}
