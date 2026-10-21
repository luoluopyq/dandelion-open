//! Dandelion Open 更新检查：查 GitHub Releases 最新标签，并跳转下载页。
//!
//! 开源版不分发更新签名私钥，因此不做 in-app 签名自动更新（商业版的
//! `tauri_plugin_updater` 路径已整体移除）；「检查更新」只做诚实的
//! 版本比对 + 在浏览器打开 Release 页，由用户自行下载安装。

use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const LATEST_API: &str = "https://api.github.com/repos/luoluopyq/dandelion-open/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/luoluopyq/dandelion-open/releases/latest";
/// 结果缓存时长：够覆盖设置页来回切换与启动首查，又不至于把新版本藏太久。
const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub name: String,
    pub notes: String,
    pub url: String,
}

#[derive(Default)]
pub struct Updates {
    cache: Mutex<Option<(Instant, UpdateInfo)>>,
}

fn parse_semver(tag: &str) -> Option<(u64, u64, u64)> {
    let core = tag.trim().trim_start_matches('v').split(['-', '+']).next()?;
    let mut parts = core.split('.');
    Some((
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ))
}

/// 仅比较 x.y.z 数字段；预发布后缀（`-rc1` 等）不参与比较。开源版发布
/// 均为正式标签，宁可漏报一次更新，也不把用户引向不完整的预发布包。
fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_semver(latest), parse_semver(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

async fn fetch_latest() -> Result<UpdateInfo, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let value: Value = client
        .get(LATEST_API)
        .header(reqwest::header::USER_AGENT, "dandelion-open-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|_| "网络不可用，检查更新失败".to_string())?
        .error_for_status()
        .map_err(|_| "GitHub Releases 查询失败".to_string())?
        .json()
        .await
        .map_err(|_| "GitHub Releases 响应格式不正确".to_string())?;
    let latest = text_field(&value, "tag_name");
    if parse_semver(&latest).is_none() {
        return Err("GitHub Releases 标签无法解析".into());
    }
    let url = text_field(&value, "html_url");
    if !url.starts_with("https://github.com/luoluopyq/dandelion-open/releases") {
        return Err("Release 下载地址不合法".into());
    }
    Ok(UpdateInfo {
        current: env!("CARGO_PKG_VERSION").into(),
        available: is_newer(&latest, env!("CARGO_PKG_VERSION")),
        latest,
        name: text_field(&value, "name"),
        notes: text_field(&value, "body"),
        url,
    })
}

#[tauri::command]
pub async fn check_update(
    updates: tauri::State<'_, Updates>,
    force: Option<bool>,
) -> Result<UpdateInfo, String> {
    if force.unwrap_or(false) {
        *updates.cache.lock().map_err(|_| "更新状态锁异常")? = None;
    } else if let Some((at, info)) = updates.cache.lock().map_err(|_| "更新状态锁异常")?.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return Ok(info.clone());
        }
    }
    let info = fetch_latest().await?;
    if let Ok(mut cache) = updates.cache.lock() {
        *cache = Some((Instant::now(), info.clone()));
    }
    Ok(info)
}

/// 在系统浏览器打开下载页。地址只取自最近一次检查通过白名单校验的
/// Release 链接，否则回落 releases/latest 固定跳转——前端无法注入任意 URL。
#[tauri::command]
pub fn open_download(updates: tauri::State<'_, Updates>) -> Result<(), String> {
    let url = updates
        .cache
        .lock()
        .ok()
        .and_then(|cache| cache.as_ref().map(|(_, info)| info.url.clone()))
        .unwrap_or_else(|| RELEASES_PAGE.to_string());
    open_in_browser(&url)
}

/// 拒绝任何可被 shell 解释拼接的字符：地址本源自白名单校验，这是纵深防御。
fn url_is_safe(url: &str) -> bool {
    !url.contains(['"', '&', '|', '^', '<', '>', '\n', '\r'])
}

fn open_in_browser(url: &str) -> Result<(), String> {
    if !url_is_safe(url) {
        return Err("下载地址不合法".into());
    }
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(url);
        command
    };
    command.spawn().map(|_| ()).map_err(|e| format!("无法打开浏览器：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison_ignores_prerelease_suffix_and_bad_input() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("v0.0.9", "0.1.0"));
        // 数字段相等时，后缀不参与比较：宁可漏报也不推向预发布。
        assert!(!is_newer("0.1.1-rc1", "0.1.1"));
        assert!(!is_newer("garbage", "0.1.0"));
        assert!(!is_newer("0.1", "0.1.0"));
    }

    #[test]
    fn browser_open_rejects_shell_meta_characters() {
        assert!(url_is_safe("https://github.com/luoluopyq/dandelion-open/releases"));
        assert!(!url_is_safe("https://example.com/\"&calc"));
        assert!(!url_is_safe("https://example.com/a|b"));
        // 含元字符的地址在 spawn 之前就被拒绝，测试不会真的打开浏览器。
        assert!(open_in_browser("https://example.com/\"&calc").is_err());
    }
}
