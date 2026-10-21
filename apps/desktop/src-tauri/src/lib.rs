//! In-process Tauri host. Vue may only `invoke` the allowlisted commands below.
mod knowledge_items;
mod updates;

use dandelion_core::acp::RequestPermissionOutcome;
use dandelion_core::{
    Authority, ChildListItem, ContextBuildRequest, ContextPack, ContextStatus, CorpusDoc,
    CronJobRow, CronRunRow, DesktopHost, EntityGraphProjection, HardwareProbe, KnowledgeAnswer,
    KnowledgeApiProvision, KnowledgeCollection, KnowledgeCustomer, KnowledgeDeletionAudit,
    KnowledgeDeletionProof, KnowledgeDocument, KnowledgeDocumentVersion, KnowledgeExternalDecision,
    KnowledgeFeedback, KnowledgeMember, KnowledgeQualityMetrics, KnowledgeRetentionPreview,
    KnowledgeRole, KnowledgeSearchHit, KnowledgeSpace, KnowledgeSyncPreview, KnowledgeSyncSource,
    KnowledgeTenant, LocalModel, McpInstallPlan, McpListItem, McpRegistryPage, McpServerConfig,
    MemoryDomain, MemoryEvent, MemoryEventDraft, MemoryEventKind, MemoryFiles, MemoryKind,
    MemoryScope, ModelDownloadStatus, PreflightMetrics, ProjectRow, PromptRequest, ProviderProbe,
    Runtime, SandboxRoots, Sensitivity, SessionId, SessionPrefs, SessionSearchHit, Settings,
    SidecarStatus, SkillInstallReport, SkillListItem, SourceRef, SpaceAnswer, SpaceSearchResult,
    TaskMode, TemporalProjectionItem, TodoItem, PRODUCT_NAME,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::process::Command as ProcessCommand;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::sync::Arc;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};
use tokio::sync::{broadcast, RwLock};
use tokio_util::sync::CancellationToken;

struct AppState {
    host: Arc<DesktopHost>,
    runtime: RwLock<Runtime>,
    bus_gen: AtomicU64,
    agent_installs: Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeFileImportFailure {
    source_id: String,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeFileImportResult {
    imported: Vec<KnowledgeDocumentVersion>,
    failures: Vec<KnowledgeFileImportFailure>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionEvent {
    request_id: String,
    session_id: String,
    title: String,
    tool_call_id: Option<String>,
    options: Vec<dandelion_core::acp::PermissionOption>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PermissionAnswer {
    request_id: String,
    option_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderEntry {
    name: String,
    relative_path: String,
    is_dir: bool,
    size: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilePreview {
    name: String,
    relative_path: String,
    content: String,
    truncated: bool,
    binary: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewFile {
    path: String,
    index_status: String,
    worktree_status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewSnapshot {
    branch: String,
    files: Vec<ReviewFile>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFile {
    path: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    id: String,
    subject: String,
    author: String,
    date: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranch {
    name: String,
    current: bool,
    upstream: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitSnapshot {
    root: String,
    git_available: bool,
    repository: bool,
    branch: String,
    user_name: String,
    user_email: String,
    staged: Vec<GitFile>,
    unstaged: Vec<GitFile>,
    untracked: Vec<GitFile>,
    history: Vec<GitCommit>,
    local_branches: Vec<GitBranch>,
    remote_branches: Vec<GitBranch>,
}

const MAIN_SURFACE: &str = "main";
const WINDOW_09_SURFACE: &str = "window-09";
const WIN09_PREFIX: &str = "win09-";
const EMBEDDED_BROWSER_LABEL: &str = "workspace-browser";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEmbedRequest {
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn map_err(err: dandelion_core::Error) -> String {
    err.to_string()
}

/// Windows only: 强制把进程标记为 PerMonitorV2 DPI 感知。
/// 必须在任何窗口/UI 元素创建之前调用。
/// tauri-build 默认 manifest 通常已经声明 PerMonitorV2，这里作为兜底，
/// 避免被打包工具、链接顺序或某些 Windows 版本默认值影响。
#[cfg(windows)]
pub fn enable_per_monitor_v2_dpi() {
    use windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    unsafe {
        // 重复调用会返回 false，但不会崩；第一次成功即可
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
}

#[cfg(not(windows))]
pub fn enable_per_monitor_v2_dpi() {
    // 其他平台无操作
}

fn win09_label(session_id: &str) -> String {
    format!("{WIN09_PREFIX}{session_id}")
}

fn parse_win09_label(label: &str) -> Option<&str> {
    label.strip_prefix(WIN09_PREFIX)
}

fn restore_occupancy(rt: &Runtime, id: &SessionId, prev: Option<String>) {
    let _ = rt.release_session(id, WINDOW_09_SURFACE);
    if let Some(holder) = prev {
        let _ = rt.occupy_session(id, &holder);
    }
}

/// 把窗口逻辑尺寸 clamp 到其当前所在显示器的工作区以内。
///
/// 多显示器 / 多 DPI 环境下，窗口从一块屏拖到另一块尺寸或缩放比例不同的屏幕时，
/// Windows 会重新缩放窗口并触发 `ScaleFactorChanged`，Tauri 把新的物理尺寸当逻辑尺寸
/// 处理，导致窗口瞬间放大、内容撑不满（或撑出屏幕）。这里以当前显示器 `work_area`
/// 为上限回退逻辑尺寸，确保窗口始终落在可视工作区内。
fn clamp_window_to_work_area(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    let max_w = work.size.width as f64 / scale;
    let max_h = work.size.height as f64 / scale;

    let Ok(scale_now) = window.scale_factor() else {
        return;
    };
    let Ok(inner) = window.inner_size() else {
        return;
    };
    let logical = inner.to_logical::<f64>(scale_now);

    // 下限 900x600 保证窗口仍可用；上限取当前显示器工作区允许的最大逻辑尺寸
    let width = logical.width.clamp(900.0, max_w.max(900.0));
    let height = logical.height.clamp(600.0, max_h.max(600.0));
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
}

fn apply_main_window_geometry(window: &tauri::WebviewWindow, settings: &Settings) {
    // 防御性夹紧：极端配置或 env 注入可能让宽高越界到不合法值
    // （旧 settings.json 里写过的超大值 / 注入 0 之类）。src-tauri 设置的窗口出厂
    // 默认值（tauri.conf.json）与 Settings::defaults() 保持一致即可。
    let width = f64::from(settings.ui_window_width).clamp(900.0, 1920.0);
    let height = f64::from(settings.ui_window_height).clamp(600.0, 1200.0);
    let _ = window.set_size(tauri::LogicalSize::new(width, height));
    // 初次应用几何后再按当前显示器工作区夹一次，防止从旧分辨率设置还原出超界尺寸
    clamp_window_to_work_area(window);
    if settings.ui_window_maximized {
        let _ = window.maximize();
    }
}

fn persist_main_window_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let (raw_width, raw_height) = match (window.inner_size(), window.scale_factor()) {
        (Ok(physical), Ok(scale)) => {
            let logical = physical.to_logical::<u32>(scale);
            (logical.width, logical.height)
        }
        _ => return,
    };
    // 窗口几何的有效范围与 dandelion-core 的 UI_WINDOW_MIN/MAX_W/H 保持一致
    // （src-tauri 只能调 settings-core 提供的小写常量，但为避免跨 crate 依赖，
    // 这里在边界直接 inline 同样的上下限）。即使 WebView 在多 DPI 切换过程中
    // 报告了一个异常大的逻辑尺寸，也只写入上限以内的合理值。
    let width = raw_width.clamp(900, 1920);
    let height = raw_height.clamp(600, 1200);
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(rt) = state.runtime.try_read() else {
        return;
    };
    let data_dir = rt.info().data_dir;
    drop(rt);
    let mut patch = Map::new();
    patch.insert("dandelion.ui.windowWidth".into(), json!(width));
    patch.insert("dandelion.ui.windowHeight".into(), json!(height));
    patch.insert("dandelion.ui.windowMaximized".into(), json!(maximized));
    let _ = Settings::patch_file(&data_dir, &patch);
}

fn close_orphan_win09(app: &AppHandle, rt: &Runtime) {
    let labels: Vec<String> = app
        .webview_windows()
        .into_keys()
        .filter(|label| parse_win09_label(label).is_some())
        .collect();
    for label in labels {
        let Some(id) = parse_win09_label(&label) else {
            continue;
        };
        let gone = SessionId::parse(id.to_string())
            .ok()
            .and_then(|sid| rt.session_export(&sid).ok())
            .is_none();
        if gone {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.close();
            }
        }
    }
}

#[tauri::command]
async fn runtime_info(state: State<'_, AppState>) -> Result<dandelion_core::RuntimeInfo, String> {
    let rt = state.runtime.read().await;
    Ok(rt.info())
}

#[tauri::command]
async fn session_new(state: State<'_, AppState>) -> Result<String, String> {
    let rt = state.runtime.read().await;
    rt.create_session(None)
        .map(|id| id.to_string())
        .map_err(map_err)
}

#[tauri::command]
async fn session_prompt(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    mode: Option<String>,
    image_urls: Option<Vec<String>>,
) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    let mut req = PromptRequest::new(sid, text);
    if let Some(mode) = mode {
        req.task_mode = mode.parse::<TaskMode>()?;
    }
    req.input_images = image_urls.unwrap_or_default();
    // Base64 inflates bytes by ~4/3; compare the data URL against the
    // decoded-byte budget with headroom instead of a second constant.
    let settings = rt.settings();
    let url_cap = settings.vision_max_image_bytes / 3 * 4 + 64;
    if req.input_images.len() > settings.vision_max_images as usize
        || req.input_images.iter().any(|url| {
            url.len() > url_cap
                || !(url.starts_with("data:image/png;base64,")
                    || url.starts_with("data:image/jpeg;base64,")
                    || url.starts_with("data:image/webp;base64,")
                    || url.starts_with("data:image/gif;base64,"))
        })
    {
        return Err(format!(
            "最多附加 {} 张 PNG/JPEG/WebP/GIF 图片，每张不超过 {} MiB（可在设置 dandelion.vision.* 调整）",
            settings.vision_max_images,
            settings.vision_max_image_bytes / 1_048_576
        )
        .into());
    }
    rt.prompt(req)
        .await
        .map(|id| id.to_string())
        .map_err(map_err)
}

/// Turn a picked/dropped image file into a data URL (the webview cannot read
/// dropped file bytes itself under Tauri's drag-and-drop bridge).
#[tauri::command]
async fn file_image_data_url(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let rt = state.runtime.read().await;
    rt.file_image_data_url(std::path::Path::new(&path)).map_err(map_err)
}

/// Render a persisted chat-history image attachment back to a data URL.
#[tauri::command]
async fn attachment_data_url(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let rt = state.runtime.read().await;
    rt.attachment_data_url(&path).map_err(map_err)
}

/// "images" (structured, multimodal) or "files" (path-based degradation).
#[tauri::command]
async fn agent_engine_vision(state: State<'_, AppState>, engine: String) -> Result<String, String> {
    let rt = state.runtime.read().await;
    rt.engine_vision(&engine).map(str::to_owned).map_err(map_err)
}

#[tauri::command]
async fn prompt_refine(
    state: State<'_, AppState>,
    text: String,
    session_id: Option<String>,
) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    let sid = session_id.map(SessionId::parse).transpose().map_err(map_err)?;
    rt.refine_prompt(&text, sid.as_ref()).await.map_err(map_err)
}

#[tauri::command]
async fn session_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.cancel(sid).await.map_err(map_err)
}

#[tauri::command]
async fn agent_plugins_list(state: State<'_, AppState>) -> Result<Vec<dandelion_core::AgentPluginInfo>, String> {
    state.runtime.read().await.agent_plugins_list().map_err(map_err)
}

#[tauri::command]
async fn agent_plugin_connect(state: State<'_, AppState>, id: String, path: Option<String>) -> Result<(), String> {
    state.runtime.read().await.agent_plugin_connect(&id, path.map(PathBuf::from)).map_err(map_err)
}

#[tauri::command]
async fn agent_plugin_install(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let cancel = CancellationToken::new();
    {
        let mut installs = state.agent_installs.lock().map_err(|_| "安装状态不可用".to_string())?;
        if installs.contains_key(&id) { return Err("此 Agent 正在安装中".into()); }
        installs.insert(id.clone(), cancel.clone());
    }
    let rt = state.runtime.read().await.clone();
    let event_id = id.clone();
    let result = rt.agent_plugin_install_with_progress(&id, cancel, move |progress| {
        let _ = app.emit("agent-install-progress", json!({
            "id": event_id, "phase": progress.phase, "detail": progress.detail,
        }));
    }).await;
    if let Ok(mut installs) = state.agent_installs.lock() { installs.remove(&id); }
    result.map_err(map_err)
}

#[tauri::command]
async fn agent_plugin_install_cancel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let installs = state.agent_installs.lock().map_err(|_| "安装状态不可用".to_string())?;
    if let Some(cancel) = installs.get(&id) { cancel.cancel(); }
    Ok(())
}

#[tauri::command]
async fn agent_plugin_set_model(state: State<'_, AppState>, id: String, model: Option<String>) -> Result<(), String> {
    state.runtime.read().await.agent_plugin_set_model(&id, model).map_err(map_err)
}

#[tauri::command]
async fn agent_plugin_uninstall(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if state.agent_installs.lock().map_err(|_| "安装状态不可用".to_string())?.contains_key(&id) {
        return Err("正在安装，请先取消安装".into());
    }
    let rt = state.runtime.read().await.clone();
    rt.agent_plugin_remove(&id).await.map_err(map_err)
}

#[tauri::command]
async fn agent_plugin_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.agent_plugin_stop(&id).await.map_err(map_err)
}

#[tauri::command]
async fn terminal_kill(state: State<'_, AppState>, terminal_id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.terminal_kill(&terminal_id).map_err(map_err)
}

#[tauri::command]
async fn background_processes(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<dandelion_core::jobs::BackgroundProcess>, String> {
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    Ok(state.runtime.read().await.background_processes(&sid))
}

#[tauri::command]
async fn terminal_run_user(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.terminal_run_user(&sid, &command, cwd.as_deref().map(Path::new))
        .map(|_| ())
        .map_err(map_err)
}

#[tauri::command]
async fn folder_pick() -> Result<Option<String>, String> {
    let picked = tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    // canonicalize 在 Windows 上会加 `\\?\` 扩展长度前缀；那是实现细节，不是用户
    // 可见拼写。项目表入库时剥掉它（`project_create`），这里若不剥，同一个目录
    // 就有了两种拼写，会话按字符串相等永远归不进项目。与 `canonical_workspace`
    // 同一口径：canonicalize 之后一律 dunce::simplified。
    Ok(picked.map(|path| {
        let canonical = path.canonicalize().unwrap_or(path);
        dunce::simplified(&canonical).display().to_string()
    }))
}

#[tauri::command]
async fn file_pick(images_only: bool) -> Result<Vec<String>, String> {
    let picked = tokio::task::spawn_blocking(move || {
        let dialog = rfd::FileDialog::new();
        if images_only {
            dialog
                .add_filter("Images", &["png", "jpg", "jpeg", "webp", "gif", "bmp"])
                .pick_files()
        } else {
            dialog.pick_files()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(picked
        .unwrap_or_default()
        .into_iter()
        .map(|path| path.canonicalize().unwrap_or(path).display().to_string())
        .collect())
}

/// The browser is a child WebView of the main window, not a popup and not an
/// iframe. This is the same architectural constraint used by desktop agents:
/// remote sites regularly reject iframe embedding through CSP/X-Frame-Options.
/// On Windows this must execute away from the synchronous command handler,
/// otherwise child WebView creation can deadlock the UI thread.
#[tauri::command]
async fn browser_embed_show(app: AppHandle, request: BrowserEmbedRequest) -> Result<(), String> {
    let url = request
        .url
        .trim()
        .parse::<tauri::Url>()
        .map_err(|e| format!("invalid URL: {e}"))?;
    tokio::task::spawn_blocking(move || {
        let main = app
            .get_window("main")
            .ok_or_else(|| "主窗口不存在".to_owned())?;
        let position = LogicalPosition::new(request.x, request.y);
        let size = LogicalSize::new(request.width.max(1.0), request.height.max(1.0));
        if let Some(webview) = app.get_webview(EMBEDDED_BROWSER_LABEL) {
            webview.navigate(url).map_err(|e| e.to_string())?;
            webview.set_position(position).map_err(|e| e.to_string())?;
            webview.set_size(size).map_err(|e| e.to_string())?;
            webview.show().map_err(|e| e.to_string())?;
        } else {
            let builder = tauri::webview::WebviewBuilder::new(
                EMBEDDED_BROWSER_LABEL,
                WebviewUrl::External(url),
            );
            main.add_child(builder, position, size)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn browser_embed_hide(app: AppHandle) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if let Some(webview) = app.get_webview(EMBEDDED_BROWSER_LABEL) {
            webview.hide().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn folder_list(root: String, relative_path: String) -> Result<Vec<FolderEntry>, String> {
    tokio::task::spawn_blocking(move || list_folder_entries(&root, &relative_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn folder_read(root: String, relative_path: String) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || read_folder_file(&root, &relative_path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_write_file(
    root: String,
    relative_path: String,
    content: String,
) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || {
        let (root, path) = safe_workspace_target(&root, &relative_path)?;
        if !path.is_file() {
            return Err("只能保存项目中的现有文件".into());
        }
        std::fs::write(&path, content).map_err(|e| e.to_string())?;
        read_folder_file(root.to_string_lossy().as_ref(), &relative_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_create_entry(
    root: String,
    relative_path: String,
    is_dir: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let (_, path) = safe_workspace_target(&root, &relative_path)?;
        if path.exists() {
            return Err("同名文件或目录已存在".into());
        }
        if is_dir {
            std::fs::create_dir(&path).map_err(|e| e.to_string())?;
        } else {
            std::fs::File::create(&path).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_rename_entry(
    root: String,
    relative_path: String,
    next_relative_path: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let (_, from) = safe_workspace_target(&root, &relative_path)?;
        let (_, to) = safe_workspace_target(&root, &next_relative_path)?;
        if !from.exists() {
            return Err("要重命名的文件或目录不存在".into());
        }
        if to.exists() {
            return Err("目标名称已存在".into());
        }
        std::fs::rename(from, to).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_delete_entry(root: String, relative_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let (_, path) = safe_workspace_target(&root, &relative_path)?;
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|_| "要删除的文件或目录不存在".to_string())?;
        if metadata.is_dir() {
            std::fs::remove_dir_all(path).map_err(|e| e.to_string())
        } else {
            std::fs::remove_file(path).map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_review(root: String) -> Result<ReviewSnapshot, String> {
    tokio::task::spawn_blocking(move || read_workspace_review(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_snapshot(root: String) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || read_git_snapshot(&root))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_init(root: String) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root, &["init"])?;
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_configure(
    root: String,
    user_name: String,
    user_email: String,
) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        if user_name.trim().is_empty() || user_email.trim().is_empty() {
            return Err("Git 用户名和邮箱不能为空".into());
        }
        run_git(&root, &["config", "user.name", user_name.trim()])?;
        run_git(&root, &["config", "user.email", user_email.trim()])?;
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_diff(root: String, path: Option<String>, staged: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || read_git_diff(&root, path.as_deref(), staged))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_stage(root: String, path: String, staged: bool) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let path = safe_git_path(&path)?;
        if staged {
            run_git(&root, &["restore", "--staged", "--", &path])?;
        } else {
            run_git(&root, &["add", "--", &path])?;
        }
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_commit(root: String, message: String) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let message = message.trim();
        if message.is_empty() {
            return Err("提交说明不能为空".into());
        }
        run_git(&root, &["commit", "-m", message])?;
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_restore_file(root: String, path: String, staged: bool) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let path = safe_git_path(&path)?;
        if staged {
            run_git(&root, &["restore", "--staged", "--worktree", "--", &path])?;
        } else {
            run_git(&root, &["restore", "--worktree", "--", &path])?;
        }
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_reset_hard(root: String, commit: String) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let commit = commit.trim();
        if commit.len() < 7 || commit.len() > 64 || !commit.chars().all(|ch| ch.is_ascii_hexdigit())
        {
            return Err("无效的提交哈希".into());
        }
        run_git(&root, &["reset", "--hard", commit])?;
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_switch_branch(
    root: String,
    branch: String,
    remote: bool,
) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        let branch = safe_git_branch(&branch)?;
        if remote {
            if branch.ends_with("/HEAD") {
                return Err("不能切换到远程 HEAD 引用".into());
            }
            let local = branch
                .split_once('/')
                .map(|(_, name)| name)
                .ok_or_else(|| "无效的远程分支".to_string())?;
            if run_git(
                &root,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{local}"),
                ],
            )
            .is_ok()
            {
                run_git(&root, &["switch", local])?;
            } else {
                run_git(&root, &["switch", "--track", "-c", local, &branch])?;
            }
        } else {
            run_git(&root, &["switch", &branch])?;
        }
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_fetch(root: String) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root, &["fetch", "--prune"])?;
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_pull(root: String) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        // Fast-forward only: GUI pull must never create an implicit merge commit.
        run_git(&root, &["pull", "--ff-only"])?;
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn git_push(root: String) -> Result<GitSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        run_git(&root, &["push"])?;
        read_git_snapshot(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn list_folder_entries(root: &str, relative_path: &str) -> Result<Vec<FolderEntry>, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("selected folder is no longer available".into());
    }
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("invalid folder path".into());
    }
    let current = root
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !current.starts_with(&root) || !current.is_dir() {
        return Err("folder is outside the selected root".into());
    }
    let mut entries = std::fs::read_dir(&current)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            let is_dir = metadata.is_dir();
            let relative_path = path
                .strip_prefix(&root)
                .ok()?
                .to_string_lossy()
                .replace('\\', "/");
            Some(FolderEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                relative_path,
                is_dir,
                size: (!is_dir).then_some(metadata.len()),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries.truncate(300);
    Ok(entries)
}

fn safe_selected_path(root: &str, relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("invalid file path".into());
    }
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&root) {
        return Err("file is outside the selected root".into());
    }
    Ok((root, path))
}

/// Resolves an existing-or-new path while keeping every project file mutation
/// inside the selected workspace.  The project root itself is never a target.
fn safe_workspace_target(root: &str, relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let relative = Path::new(relative_path);
    if relative_path.trim().is_empty()
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err("invalid project path".into());
    }
    let path = root.join(relative);
    let parent = path
        .parent()
        .ok_or_else(|| "invalid project path".to_string())?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err("path is outside the selected project".into());
    }
    Ok((root, path))
}

fn read_folder_file(root: &str, relative_path: &str) -> Result<FilePreview, String> {
    let (root, path) = safe_selected_path(root, relative_path)?;
    if !path.is_file() {
        return Err("selected path is not a file".into());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let binary = bytes.iter().take(8_192).any(|byte| *byte == 0);
    let limit = 256 * 1024;
    let truncated = bytes.len() > limit;
    let content = if binary {
        "此文件为二进制文件，无法在此预览。".into()
    } else {
        String::from_utf8_lossy(&bytes[..bytes.len().min(limit)]).into_owned()
    };
    Ok(FilePreview {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        relative_path: path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/"),
        content,
        truncated,
        binary,
    })
}

/// 桌面宿主是 GUI 进程（无控制台），git.exe 是控制台子系统程序：不设
/// CREATE_NO_WINDOW 时每次 git 辅助调用（状态刷新、diff、版本探测）都会在
/// Windows 上闪出一个黑色控制台窗口。与 dandelion-core 的
/// agent_plugins::hide_console_windows 同一策略 —— 凡 stdio 被我们捕获的
/// 子进程一律无窗托管。
fn git_command() -> ProcessCommand {
    let mut command = ProcessCommand::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

fn read_workspace_review(root: &str) -> Result<ReviewSnapshot, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let output = git_command()
        .args([
            "-C",
            &root.to_string_lossy(),
            "status",
            "--short",
            "--branch",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let branch = lines
        .next()
        .unwrap_or("## 未知分支")
        .trim_start_matches("## ")
        .to_string();
    let files = lines
        .filter_map(|line| {
            if line.len() < 4 {
                return None;
            }
            let mut chars = line.chars();
            let index_status = chars.next()?.to_string();
            let worktree_status = chars.next()?.to_string();
            Some(ReviewFile {
                path: line[3..].to_string(),
                index_status,
                worktree_status,
            })
        })
        .collect();
    Ok(ReviewSnapshot { branch, files })
}

fn git_root(root: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if root.is_dir() {
        Ok(root)
    } else {
        Err("所选路径不是目录".into())
    }
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let root = git_root(root)?;
    let output = git_command()
        .arg("-C")
        .arg(&root)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|_| "未找到 Git。请安装 Git 并重新打开应用。".to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() {
            "Git 命令执行失败".into()
        } else {
            message
        })
    }
}

fn safe_git_path(path: &str) -> Result<String, String> {
    let path = Path::new(path);
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("无效的 Git 文件路径".into());
    }
    Ok(path.to_string_lossy().replace('\\', "/"))
}

fn safe_git_branch(branch: &str) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.contains("..")
        || branch
            .chars()
            .any(|ch| !(ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-' | '.')))
    {
        return Err("无效的分支名称".into());
    }
    Ok(branch.to_string())
}

fn read_git_snapshot(root: &str) -> Result<GitSnapshot, String> {
    let root_path = git_root(root)?;
    let root = root_path
        .display()
        .to_string()
        .trim_start_matches(r"\\?\")
        .to_string();
    let version = git_command().arg("--version").output();
    let Ok(version) = version else {
        return Ok(GitSnapshot {
            root,
            git_available: false,
            repository: false,
            branch: String::new(),
            user_name: String::new(),
            user_email: String::new(),
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            history: vec![],
            local_branches: vec![],
            remote_branches: vec![],
        });
    };
    if !version.status.success() {
        return Ok(GitSnapshot {
            root,
            git_available: false,
            repository: false,
            branch: String::new(),
            user_name: String::new(),
            user_email: String::new(),
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            history: vec![],
            local_branches: vec![],
            remote_branches: vec![],
        });
    }
    let repository = run_git(&root, &["rev-parse", "--is-inside-work-tree"]).is_ok();
    if !repository {
        return Ok(GitSnapshot {
            root,
            git_available: true,
            repository: false,
            branch: String::new(),
            user_name: String::new(),
            user_email: String::new(),
            staged: vec![],
            unstaged: vec![],
            untracked: vec![],
            history: vec![],
            local_branches: vec![],
            remote_branches: vec![],
        });
    }
    let branch = run_git(&root, &["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let user_name = run_git(&root, &["config", "--get", "user.name"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let user_email = run_git(&root, &["config", "--get", "user.email"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let status = run_git(&root, &["status", "--porcelain=v1"]).unwrap_or_default();
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    for line in status.lines() {
        if line.len() < 4 {
            continue;
        }
        let mut chars = line.chars();
        let index = chars.next().unwrap_or(' ');
        let worktree = chars.next().unwrap_or(' ');
        let path = line[3..].to_string();
        if index == '?' && worktree == '?' {
            untracked.push(GitFile {
                path,
                status: "未跟踪".into(),
            });
        } else {
            if index != ' ' {
                staged.push(GitFile {
                    path: path.clone(),
                    status: index.to_string(),
                });
            }
            if worktree != ' ' {
                unstaged.push(GitFile {
                    path,
                    status: worktree.to_string(),
                });
            }
        }
    }
    let history_text = run_git(
        &root,
        &[
            "log",
            "--pretty=format:%H%x1f%an%x1f%ad%x1f%s",
            "--date=short",
            "-n",
            "40",
        ],
    )
    .unwrap_or_default();
    let history = history_text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            Some(GitCommit {
                id: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
            })
        })
        .collect();
    let local_branches = run_git(
        &root,
        &[
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)%x1f%(HEAD)%x1f%(upstream:short)",
        ],
    )
    .unwrap_or_default()
    .lines()
    .filter_map(|line| {
        let mut parts = line.split('\x1f');
        Some(GitBranch {
            name: parts.next()?.to_string(),
            current: parts.next()? == "*",
            upstream: parts.next().unwrap_or_default().to_string(),
        })
    })
    .collect();
    let remote_branches = run_git(
        &root,
        &["for-each-ref", "refs/remotes", "--format=%(refname:short)"],
    )
    .unwrap_or_default()
    .lines()
    .filter(|name| !name.ends_with("/HEAD"))
    .map(|name| GitBranch {
        name: name.to_string(),
        current: false,
        upstream: String::new(),
    })
    .collect();
    Ok(GitSnapshot {
        root,
        git_available: true,
        repository: true,
        branch,
        user_name,
        user_email,
        staged,
        unstaged,
        untracked,
        history,
        local_branches,
        remote_branches,
    })
}

fn read_git_diff(root: &str, path: Option<&str>, staged: bool) -> Result<String, String> {
    let root_path = git_root(root)?;
    let safe_path = path.map(safe_git_path).transpose()?;
    if let Some(path) = safe_path.as_deref() {
        let tracked = git_command()
            .arg("-C")
            .arg(&root_path)
            .args(["ls-files", "--error-unmatch", "--", path])
            .output()
            .map_err(|_| "未找到 Git。请安装 Git 并重新打开应用。".to_string())?
            .status
            .success();
        if !tracked && !staged {
            let file = root_path.join(path);
            let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
            if bytes.iter().take(8_192).any(|byte| *byte == 0) {
                return Ok(format!("新增的二进制文件：{path}\n无法在此显示文本对比。"));
            }
            let text = String::from_utf8_lossy(&bytes);
            let body = text
                .lines()
                .map(|line| format!("+{line}"))
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(format!("diff --git a/{path} b/{path}\nnew file mode 100644\n--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n{body}", text.lines().count()));
        }
    }
    let mut command = git_command();
    command
        .arg("-C")
        .arg(root_path)
        .args([
            "-c",
            "core.pager=cat",
            "diff",
            "--no-ext-diff",
            "--no-color",
        ])
        .env("GIT_PAGER", "cat");
    if staged {
        command.arg("--staged");
    }
    if let Some(path) = safe_path.as_deref() {
        command.arg("--").arg(path);
    }
    let output = command
        .output()
        .map_err(|_| "未找到 Git。请安装 Git 并重新打开应用。".to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[tauri::command]
async fn session_export(state: State<'_, AppState>, session_id: String) -> Result<Value, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_export(&sid).map_err(map_err)
}

#[tauri::command]
async fn session_export_window(
    state: State<'_, AppState>,
    session_id: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_export_window(&sid, offset.unwrap_or(0), limit.unwrap_or(60))
        .map_err(map_err)
}

#[tauri::command]
async fn sessions_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<dandelion_core::SessionRow>, String> {
    let rt = state.runtime.read().await;
    rt.sessions_list(limit, offset.unwrap_or(0))
        .map_err(map_err)
}

/// 空间列表，每行额外带 `accessible`：目录当前是否读得到。
///
/// 读不到（移动盘没插、网络盘没连）只影响这一个字段，数据原样保留，由界面
/// 提示用户；这取代了旧的「启动时目录不在就连会话一起删」的自动清理。
#[tauri::command]
async fn projects_list(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let rt = state.runtime.read().await;
    rt.projects_list()
        .map(|rows| {
            rows.into_iter()
                .map(|row| {
                    let mut value = serde_json::to_value(&row).unwrap_or(serde_json::Value::Null);
                    if let Some(obj) = value.as_object_mut() {
                        obj.insert(
                            "accessible".into(),
                            serde_json::Value::Bool(Path::new(&row.workspace).is_dir()),
                        );
                    }
                    value
                })
                .collect()
        })
        .map_err(map_err)
}

#[tauri::command]
async fn project_create(
    state: State<'_, AppState>,
    workspace: String,
) -> Result<ProjectRow, String> {
    let rt = state.runtime.read().await;
    rt.project_create(Path::new(&workspace)).map_err(map_err)
}

#[tauri::command]
async fn project_delete(
    state: State<'_, AppState>,
    id: String,
    purge_sessions: Option<bool>,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    // 桌面端的工作空间是会话的归属单位，默认连会话一起删；显式传 false 才是
    // 旧行为（把会话归档、只撤掉书签）。Runtime::project_delete 会先取消并
    // 限时等待牵连会话的运行任务、收掉后台进程树，再删记录（工作单条目 2）。
    rt.project_delete(&id, purge_sessions.unwrap_or(true))
        .await
        .map_err(map_err)
}

/// 改空间的显示名。只动 `projects.name`，目录与会话归属都不变。
#[tauri::command]
async fn project_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.project_rename(&id, &name).map_err(map_err)
}

/// 把空间从列表里撤掉，保留它的对话（对话落进「未归属」）。
#[tauri::command]
async fn project_unlist(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.project_unlist(&id).map_err(map_err)
}

/// 在系统文件管理器里打开这个空间的目录。
///
/// 侧栏右键「打开文件夹」走这里。走系统自带的文件管理器而不是自己做一棵树：
/// 用户在这个动作里要的是「用他自己熟悉的工具看这个目录」，不是再嵌一个浏览器。
#[tauri::command]
fn project_reveal(workspace: String) -> Result<(), String> {
    let path = Path::new(&workspace);
    if !path.exists() {
        return Err(format!("目录不存在：{workspace}"));
    }
    reveal_in_file_manager(path)
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    let status = if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(path).status()
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).status()
    } else {
        std::process::Command::new("xdg-open").arg(path).status()
    };
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(_) => Err("文件管理器返回了失败".into()),
        Err(err) => Err(format!("无法打开文件管理器：{err}")),
    }
}

// 「目录当前不存在就批量清掉空间连同会话」的 `projects_prune_missing` 命令已
// 移除：启动时目录读不到多半是移动盘/网络盘没就位，不是用户要删。误接一次就
// 是永久丢数据，所以这个入口整个拿掉。空间级删除走 `project_delete`（侧栏右键
// 的用户动作），批量清理由 `projects_prune_empty` 承担。

/// 清掉一个对话都没有的工作空间，返回被清掉的那些（`dry_run` 时只返回名单）。
///
/// 判据由后端按 SQL 算，前端名单不可信：rows 只有最近一页，用它判断「这个空间
/// 有没有对话」会把超出窗口的对话当成不存在。
#[tauri::command]
async fn projects_prune_empty(
    state: State<'_, AppState>,
    dry_run: Option<bool>,
) -> Result<Vec<ProjectRow>, String> {
    let rt = state.runtime.read().await;
    rt.projects_prune_empty(dry_run.unwrap_or(false))
        .map_err(map_err)
}

#[tauri::command]
async fn session_set_title(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_set_title(&sid, &title).map_err(map_err)
}

#[tauri::command]
async fn session_set_pinned(
    state: State<'_, AppState>,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.session_set_pinned(&SessionId::parse(session_id).map_err(map_err)?, pinned)
        .map_err(map_err)
}

#[tauri::command]
async fn session_set_archived(
    state: State<'_, AppState>,
    session_id: String,
    archived: bool,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.session_set_archived(&SessionId::parse(session_id).map_err(map_err)?, archived)
        .map_err(map_err)
}

#[tauri::command]
async fn session_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_delete(&sid).await.map_err(map_err)?;
    close_orphan_win09(&app, &rt);
    Ok(())
}

#[tauri::command]
async fn session_occupy(
    state: State<'_, AppState>,
    session_id: String,
    surface: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.occupy_session(&sid, &surface).map_err(map_err)
}

#[tauri::command]
async fn session_release(
    state: State<'_, AppState>,
    session_id: String,
    surface: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.release_session(&sid, &surface).map_err(map_err)
}

#[tauri::command]
async fn session_occupancy(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.occupancy_holder(&sid).map_err(map_err)
}

#[tauri::command]
fn session_detached_ids(app: AppHandle) -> Vec<String> {
    app.webview_windows()
        .into_keys()
        .filter_map(|label| parse_win09_label(&label).map(str::to_string))
        .collect()
}

#[tauri::command]
fn session_focus_detached(app: AppHandle, session_id: String) -> bool {
    match app.get_webview_window(&win09_label(&session_id)) {
        Some(win) => win.set_focus().is_ok(),
        None => false,
    }
}

#[tauri::command]
async fn session_detach(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let sid = SessionId::parse(session_id.clone()).map_err(map_err)?;
    let label = win09_label(&session_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let rt = state.runtime.read().await;
        rt.transfer_session_surface(&sid, MAIN_SURFACE, WINDOW_09_SURFACE)
            .map_err(map_err)?;
        drop(rt);
        let _ = existing.set_focus();
        let _ = app.emit_to(MAIN_SURFACE, "detached-opened", &session_id);
        return Ok(());
    }

    let prev = {
        let rt = state.runtime.read().await;
        rt.transfer_session_surface(&sid, MAIN_SURFACE, WINDOW_09_SURFACE)
            .map_err(map_err)?
    };

    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("蒲公英 · 独立窗口")
        .inner_size(720.0, 640.0)
        .min_inner_size(480.0, 400.0)
        .decorations(false)
        .build();
    match built {
        Ok(win) => {
            let app_close = app.clone();
            let sid_close = sid.clone();
            win.on_window_event(move |event| {
                if !matches!(
                    event,
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                ) {
                    return;
                }
                let app = app_close.clone();
                let sid = sid_close.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let rt = state.runtime.read().await;
                    let _ = rt.release_session(&sid, WINDOW_09_SURFACE);
                    drop(rt);
                    let _ = app.emit_to(MAIN_SURFACE, "detached-closed", sid.to_string());
                });
            });
            let _ = app.emit_to(MAIN_SURFACE, "detached-opened", &session_id);
            Ok(())
        }
        Err(err) => {
            let rt = state.runtime.read().await;
            restore_occupancy(&rt, &sid, prev);
            Err(err.to_string())
        }
    }
}

#[tauri::command]
async fn session_prefs_get(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionPrefs, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_prefs(&sid).map_err(map_err)
}

#[tauri::command]
async fn session_prefs_set(
    state: State<'_, AppState>,
    session_id: String,
    prefs: SessionPrefs,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_set_prefs(&sid, prefs).map_err(map_err)
}

#[tauri::command]
async fn todo_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<TodoItem>, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.todo_list(&sid).map_err(map_err)
}

#[tauri::command]
async fn session_replace_bindings(
    state: State<'_, AppState>,
    session_id: String,
    kind: String,
    ids: Vec<String>,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_replace_bindings(&sid, &kind, &ids)
        .map_err(map_err)
}

#[tauri::command]
async fn session_duplicate(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_duplicate(&sid)
        .map(|id| id.to_string())
        .map_err(map_err)
}

#[tauri::command]
async fn session_task_bindings(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    rt.session_task_bindings(&sid).map_err(map_err)
}

#[tauri::command]
async fn sessions_search(
    state: State<'_, AppState>,
    query: String,
    workspace: Option<String>,
) -> Result<Vec<SessionSearchHit>, String> {
    let rt = state.runtime.read().await;
    rt.sessions_search(&query, workspace.as_deref())
        .map_err(map_err)
}

#[tauri::command]
async fn skills_list(state: State<'_, AppState>) -> Result<Vec<SkillListItem>, String> {
    let rt = state.runtime.read().await;
    let ws = rt.info().workspace;
    rt.skills_list(Some(&ws)).map_err(map_err)
}

#[tauri::command]
async fn mcp_list(state: State<'_, AppState>) -> Result<Vec<McpListItem>, String> {
    let rt = state.runtime.read().await.clone();
    rt.mcp_list().await.map_err(map_err)
}

#[tauri::command]
async fn mcp_start(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.mcp_start(&id).await.map_err(map_err)
}

#[tauri::command]
async fn mcp_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.mcp_stop(&id).await.map_err(map_err)
}

#[tauri::command]
async fn mcp_upsert(state: State<'_, AppState>, server: McpServerConfig) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.mcp_upsert(server).await.map_err(map_err)
}

#[tauri::command]
async fn mcp_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.mcp_remove(&id).await.map_err(map_err)
}

#[tauri::command]
async fn skills_import(state: State<'_, AppState>, path: String) -> Result<SkillListItem, String> {
    let rt = state.runtime.read().await;
    rt.skills_import(&PathBuf::from(path)).map_err(map_err)
}

#[tauri::command]
async fn skills_import_pick(
    state: State<'_, AppState>,
    folder: bool,
) -> Result<Option<SkillListItem>, String> {
    let picked = tokio::task::spawn_blocking(move || {
        let dlg = rfd::FileDialog::new();
        if folder {
            dlg.pick_folder()
        } else {
            dlg.add_filter("SKILL.md", &["md"]).pick_file()
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let rt = state.runtime.read().await;
    rt.skills_import(&path).map(Some).map_err(map_err)
}

#[tauri::command]
async fn skills_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.skills_set_enabled(&id, enabled).map_err(map_err)
}

#[tauri::command]
async fn skills_open(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let ws = rt.info().workspace;
    rt.skills_open(&id, Some(&ws)).map_err(map_err)
}

#[tauri::command]
async fn skills_export_pick(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let picked = tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(dest) = picked else {
        return Ok(None);
    };
    let rt = state.runtime.read().await;
    let ws = rt.info().workspace;
    rt.skills_export(&id, &dest, Some(&ws))
        .map(|p| Some(p.display().to_string()))
        .map_err(map_err)
}

#[tauri::command]
async fn skills_remove(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let rt = state.runtime.read().await;
    let ws = rt.info().workspace;
    rt.skills_remove(&id, Some(&ws))
        .map(|p| p.display().to_string())
        .map_err(map_err)
}

#[tauri::command]
async fn skills_install_url(
    state: State<'_, AppState>,
    url: String,
) -> Result<SkillInstallReport, String> {
    let rt = state.runtime.read().await.clone();
    rt.skills_install_url(&url).await.map_err(map_err)
}

#[tauri::command]
async fn skills_install_git(
    state: State<'_, AppState>,
    url: String,
    subdir: Option<String>,
) -> Result<SkillInstallReport, String> {
    let rt = state.runtime.read().await.clone();
    rt.skills_install_git(&url, subdir.as_deref())
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn registry_mcp_search(
    state: State<'_, AppState>,
    query: String,
    cursor: Option<String>,
) -> Result<McpRegistryPage, String> {
    let rt = state.runtime.read().await.clone();
    rt.registry_mcp_search(&query, cursor.as_deref())
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn registry_mcp_install(
    state: State<'_, AppState>,
    name: String,
    version: Option<String>,
) -> Result<McpInstallPlan, String> {
    let rt = state.runtime.read().await.clone();
    rt.registry_mcp_install(&name, version.as_deref())
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn sandbox_roots(state: State<'_, AppState>) -> Result<SandboxRoots, String> {
    let rt = state.runtime.read().await;
    Ok(rt.sandbox_roots())
}

#[tauri::command]
async fn sandbox_add_root(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let rt = state.runtime.read().await;
    rt.sandbox_add_root(&PathBuf::from(path.trim()))
        .map(|p| p.display().to_string())
        .map_err(map_err)
}

#[tauri::command]
async fn sandbox_add_pick(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let picked = tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let rt = state.runtime.read().await;
    rt.sandbox_add_root(&path)
        .map(|p| Some(p.display().to_string()))
        .map_err(map_err)
}

#[tauri::command]
async fn sandbox_remove_root(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.sandbox_remove_root(&PathBuf::from(path))
        .map_err(map_err)
}

#[tauri::command]
async fn context_status(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> Result<ContextStatus, String> {
    let rt = state.runtime.read().await;
    let ws = if let Some(raw) = session_id {
        let sid = SessionId::parse(raw).map_err(map_err)?;
        let prefs = rt.session_prefs(&sid).map_err(map_err)?;
        if let Some(p) = prefs.workspace {
            Some(p)
        } else {
            // 兜底只读会话元数据行。旧实现走 session_export，为了拿一个
            // workspace 字段把整个会话历史读出来序列化，长会话下白白贵一截。
            rt.get_session(&sid)
                .ok()
                .flatten()
                .filter(|row| !row.workspace.is_empty())
                .map(|row| PathBuf::from(row.workspace))
        }
    } else {
        None
    };
    rt.context_status_for(ws.as_deref()).map_err(map_err)
}

#[tauri::command]
async fn session_export_save(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    let value = rt.session_export(&sid).map_err(map_err)?;
    let dump = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    let suggested = format!("{}.json", sid);
    drop(rt);
    let picked = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_file_name(&suggested)
            .add_filter("JSON", &["json"])
            .save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    std::fs::write(&path, dump).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn settings_get(state: State<'_, AppState>) -> Result<Value, String> {
    let rt = state.runtime.read().await;
    let settings = rt.settings();
    let api_key_set = settings.api_key_configured();
    let mut values = settings.to_json_value();
    if let Some(obj) = values.as_object_mut() {
        obj.remove("dandelion.apiKey");
    }
    Ok(json!({
        "apiKeySet": api_key_set,
        "values": values,
    }))
}

#[tauri::command]
async fn settings_api_key_reveal(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let rt = state.runtime.read().await;
    Ok(rt.settings().api_key.filter(|key| !key.trim().is_empty()))
}

#[tauri::command]
async fn settings_patch(
    state: State<'_, AppState>,
    patch: Map<String, Value>,
) -> Result<dandelion_core::RuntimeInfo, String> {
    let rt = state.runtime.read().await.clone();
    rt.settings_patch(patch).await.map_err(map_err)
}

#[tauri::command]
async fn settings_json(state: State<'_, AppState>) -> Result<String, String> {
    let rt = state.runtime.read().await;
    rt.settings_json_redacted().map_err(map_err)
}

#[tauri::command]
async fn settings_put_json(
    state: State<'_, AppState>,
    text: String,
) -> Result<dandelion_core::RuntimeInfo, String> {
    let rt = state.runtime.read().await.clone();
    rt.settings_replace_json(&text).await.map_err(map_err)
}

#[tauri::command]
async fn provider_probe(
    state: State<'_, AppState>,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<ProviderProbe, String> {
    let rt = state.runtime.read().await.clone();
    rt.provider_probe(base_url, api_key).await.map_err(map_err)
}

#[tauri::command]
async fn cron_list(state: State<'_, AppState>) -> Result<Vec<CronJobRow>, String> {
    let rt = state.runtime.read().await;
    rt.cron_list().map_err(map_err)
}

#[tauri::command]
async fn cron_runs(
    state: State<'_, AppState>,
    id: String,
    limit: Option<u32>,
) -> Result<Vec<CronRunRow>, String> {
    let rt = state.runtime.read().await;
    rt.cron_runs(&id, limit.unwrap_or(20)).map_err(map_err)
}

#[tauri::command]
async fn cron_add(
    state: State<'_, AppState>,
    expr: String,
    prompt: String,
    workspace: Option<String>,
    model: Option<String>,
    missed_policy: Option<String>,
) -> Result<CronJobRow, String> {
    let rt = state.runtime.read().await;
    let ws = workspace
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    rt.cron_add(
        &expr,
        &prompt,
        ws,
        model.filter(|s| !s.trim().is_empty()),
        missed_policy.as_deref().unwrap_or("skip"),
    )
    .map_err(map_err)
}

#[tauri::command]
async fn cron_pause(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.cron_pause(&id).map_err(map_err)
}

#[tauri::command]
async fn cron_resume(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.cron_resume(&id).map_err(map_err)
}

#[tauri::command]
async fn cron_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.cron_remove(&id).map_err(map_err)
}

#[tauri::command]
async fn cron_run_now(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    rt.cron_start_now(&id)
        .map(|sid| sid.to_string())
        .map_err(map_err)
}

#[tauri::command]
async fn cron_stop_current(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    rt.cron_stop_current(&id)
        .await
        .map(|sid| sid.to_string())
        .map_err(map_err)
}

#[tauri::command]
async fn memory_files(state: State<'_, AppState>) -> Result<MemoryFiles, String> {
    let rt = state.runtime.read().await;
    Ok(rt.memory_files())
}

#[tauri::command]
async fn memory_set(state: State<'_, AppState>, kind: String, body: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    let kind = MemoryKind::parse(&kind).map_err(map_err)?;
    rt.memory_set(kind, &body).map_err(map_err)
}

#[tauri::command]
async fn memory_open_dir(state: State<'_, AppState>) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.open_memory_dir().map_err(map_err)
}

/// P1 Context OS commands. These expose an explicit, auditable control plane;
/// none of them injects data into an active agent prompt.
#[tauri::command]
async fn context_memory_list(
    state: State<'_, AppState>,
    domain: MemoryDomain,
    scope: MemoryScope,
) -> Result<Vec<MemoryEvent>, String> {
    let rt = state.runtime.read().await;
    rt.memory_events(domain, &scope).map_err(map_err)
}

#[tauri::command]
async fn context_memory_add(
    state: State<'_, AppState>,
    project_id: String,
    content: String,
    kind: MemoryEventKind,
) -> Result<MemoryEvent, String> {
    let project_id = project_id.trim();
    let content = content.trim();
    if !Path::new(project_id).is_absolute() || !Path::new(project_id).is_dir() {
        return Err("请选择有效的项目目录".into());
    }
    if content.is_empty() || content.len() > 4_000 {
        return Err("记忆内容需要在 1 到 4000 字节之间".into());
    }
    if !matches!(kind, MemoryEventKind::Fact | MemoryEventKind::Preference) {
        return Err("只能手动添加事实或偏好".into());
    }
    let rt = state.runtime.read().await;
    rt.append_memory_event(MemoryEventDraft {
        domain: MemoryDomain::Internal,
        scope: MemoryScope {
            project_id: Some(project_id.into()),
            ..MemoryScope::default()
        },
        kind,
        payload: json!({"content": content}),
        source_ref: SourceRef {
            kind: "desktop_user".into(),
            id: format!("manual_{}", uuid::Uuid::new_v4().simple()),
            version: None,
        },
        authority: Authority::UserConfirmed,
        valid_from: None,
        valid_to: None,
        confidence: 1.0,
        sensitivity: Sensitivity::Internal,
        revision_of: None,
    })
    .map_err(map_err)
}

#[tauri::command]
async fn context_memory_forget(
    state: State<'_, AppState>,
    domain: MemoryDomain,
    scope: MemoryScope,
    event_id: String,
    reason: String,
) -> Result<MemoryEvent, String> {
    let rt = state.runtime.read().await;
    rt.retract_memory_event(domain, &scope, &event_id, &reason)
        .map_err(map_err)
}

#[tauri::command]
async fn context_memory_confirm_candidate(
    state: State<'_, AppState>,
    domain: MemoryDomain,
    scope: MemoryScope,
    candidate_id: String,
) -> Result<MemoryEvent, String> {
    let rt = state.runtime.read().await;
    rt.confirm_memory_candidate(domain, &scope, &candidate_id)
        .map_err(map_err)
}

#[tauri::command]
async fn context_memory_revise(
    state: State<'_, AppState>,
    domain: MemoryDomain,
    scope: MemoryScope,
    event_id: String,
    content: String,
) -> Result<MemoryEvent, String> {
    let rt = state.runtime.read().await;
    rt.revise_memory_event(domain, &scope, &event_id, &content)
        .map_err(map_err)
}

#[tauri::command]
async fn context_build_preview(
    state: State<'_, AppState>,
    request: ContextBuildRequest,
) -> Result<ContextPack, String> {
    let rt = state.runtime.read().await;
    rt.build_context_pack(&request).map_err(map_err)
}

#[tauri::command]
async fn context_temporal_projection(
    state: State<'_, AppState>,
    domain: MemoryDomain,
    scope: MemoryScope,
) -> Result<Vec<TemporalProjectionItem>, String> {
    let rt = state.runtime.read().await;
    rt.temporal_projection(domain, &scope).map_err(map_err)
}

#[tauri::command]
async fn context_entity_graph_projection(
    state: State<'_, AppState>,
    domain: MemoryDomain,
    scope: MemoryScope,
) -> Result<EntityGraphProjection, String> {
    let rt = state.runtime.read().await;
    rt.entity_graph_projection(domain, &scope).map_err(map_err)
}

#[tauri::command]
async fn context_pack_audit(
    state: State<'_, AppState>,
    session_id: String,
    limit: u32,
) -> Result<Vec<ContextPack>, String> {
    let rt = state.runtime.read().await;
    rt.context_pack_audit(&session_id, limit.min(100))
        .map_err(map_err)
}

#[tauri::command]
async fn context_migrate_legacy_memory(state: State<'_, AppState>) -> Result<u32, String> {
    let rt = state.runtime.read().await;
    rt.migrate_legacy_memory_to_ledger().map_err(map_err)
}

#[tauri::command]
async fn preflight_preview(
    state: State<'_, AppState>,
    text: String,
) -> Result<dandelion_core::RoutingDecision, String> {
    let rt = state.runtime.read().await;
    rt.preflight_preview(&text).await.map_err(map_err)
}

#[tauri::command]
async fn preflight_status(
    state: State<'_, AppState>,
) -> Result<dandelion_core::PreflightStatus, String> {
    let rt = state.runtime.read().await;
    Ok(rt.preflight_status())
}

#[tauri::command]
async fn preflight_metrics(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<PreflightMetrics, String> {
    let rt = state.runtime.read().await;
    rt.preflight_metrics(limit.unwrap_or(200)).map_err(map_err)
}

/// P3 customer knowledge base. Every command carries the requested tenant,
/// customer and space scope; core validates it again before doing any read or
/// write. The desktop shell never decides ACLs itself.
#[tauri::command]
async fn knowledge_create_tenant(
    state: State<'_, AppState>,
    name: String,
) -> Result<KnowledgeTenant, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_create_tenant(&name).map_err(map_err)
}

#[tauri::command]
async fn knowledge_tenants(state: State<'_, AppState>) -> Result<Vec<KnowledgeTenant>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_tenants().map_err(map_err)
}
#[tauri::command]
async fn knowledge_local_spaces(state: State<'_, AppState>) -> Result<Vec<KnowledgeSpace>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_local_spaces().map_err(map_err)
}
#[tauri::command]
async fn knowledge_create_local_space(
    state: State<'_, AppState>,
    subject_id: String,
    name: String,
    external_policy: String,
) -> Result<KnowledgeSpace, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_create_local_space(&subject_id, &name, &external_policy)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_create_customer(
    state: State<'_, AppState>,
    tenant_id: String,
    name: String,
) -> Result<KnowledgeCustomer, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_create_customer(&tenant_id, &name)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_customers(
    state: State<'_, AppState>,
    tenant_id: String,
) -> Result<Vec<KnowledgeCustomer>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_customers(&tenant_id).map_err(map_err)
}

#[tauri::command]
async fn knowledge_create_space(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    name: String,
    external_policy: String,
) -> Result<KnowledgeSpace, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_create_space(&tenant_id, &customer_id, &name, &external_policy)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_spaces(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
) -> Result<Vec<KnowledgeSpace>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_spaces(&tenant_id, &customer_id)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_documents(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<Vec<KnowledgeDocument>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_documents(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_create_collection(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    name: String,
) -> Result<KnowledgeCollection, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_create_collection(&tenant_id, &customer_id, &space_id, &subject_id, &name)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_collections(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<Vec<KnowledgeCollection>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_collections(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_assign_collection(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    collection_id: String,
    document_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_assign_collection(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &collection_id,
        &document_id,
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_set_member(
    state: State<'_, AppState>,
    space_id: String,
    subject_id: String,
    role: KnowledgeRole,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_set_member(&space_id, &subject_id, role)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_import_document(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    source_kind: String,
    source_id: String,
    content: String,
    chunk_chars: Option<usize>,
) -> Result<(KnowledgeDocument, KnowledgeDocumentVersion), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_import_document(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &source_kind,
        &source_id,
        &content,
        chunk_chars.unwrap_or(1_200),
    )
    .map_err(map_err)
}

fn knowledge_supported_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("txt" | "md" | "markdown" | "pdf" | "html" | "htm" | "xhtml")
    )
}

fn knowledge_collect_files(root: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
    let entries =
        std::fs::read_dir(root).map_err(|error| format!("无法读取 {}：{error}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        // Do not follow directory links selected through a folder picker: that
        // prevents an accidental cycle or an import escaping the chosen tree.
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            knowledge_collect_files(&path, files)?;
        } else if file_type.is_file() && knowledge_supported_file(&path) {
            files.push(path);
        }
    }
    Ok(())
}

fn knowledge_parse_local_file(path: &Path) -> Result<(String, String), String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let source_kind = match extension.as_str() {
        "md" | "markdown" => "markdown",
        "txt" => "text",
        "pdf" => "pdf",
        "html" | "htm" | "xhtml" => "html",
        _ => return Err("仅支持 .txt、.md、.markdown、.pdf 和 .html 文件".into()),
    };
    let content = if extension == "pdf" {
        // PDF parsing is a core capability now (shared with the Wiki build
        // and CLI); the desktop calls into it instead of owning a copy.
        dandelion_core::wiki_adapters::pdf_extract_text(path).map_err(|error| error.to_string())?
    } else if source_kind == "html" {
        // Web pages are stored as their BODY-TEXT SNAPSHOT (core's html
        // adapter): the stored version content IS the snapshot, so wiki
        // citations resolve to snapshot lines exactly like text sources,
        // and 查看快照 has something honest to show.
        let out = dandelion_core::wiki_adapters::extract_source(path, 8 * 1024 * 1024)
            .map_err(|error| error.to_string())?;
        if out.chunks.is_empty() {
            return Err(if out.report.skipped.is_empty() {
                "未能从网页提取正文".to_string()
            } else {
                out.report.skipped.join("；")
            });
        }
        out.chunks
            .iter()
            .map(|chunk| chunk.text.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::from_utf8(std::fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|_| "文本文件不是 UTF-8 编码".to_string())?
    };
    let content = content.trim_start_matches('\u{feff}').trim().to_owned();
    if content.is_empty() {
        return Err("文件为空或仅含空白，没有可索引的正文。可在“全部知识”添加原件并补充笔记。".into());
    }
    Ok((source_kind.into(), content))
}

/// Choose one or more local files, or a folder recursively, then parse them
/// in the desktop host.  Core only receives extracted text plus a stable local
/// source path, keeping permissioned storage/versioning in one place.
#[tauri::command]
async fn knowledge_import_pick(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    folder: Option<bool>,
) -> Result<Option<KnowledgeFileImportResult>, String> {
    let folder = folder.unwrap_or(false);
    let picked = tokio::task::spawn_blocking(move || {
        let dialog =
            rfd::FileDialog::new().add_filter(
                "Knowledge files",
                &["txt", "md", "markdown", "pdf", "html", "htm", "xhtml"],
            );
        if folder {
            dialog.pick_folder().map(|path| vec![path])
        } else {
            dialog.pick_files()
        }
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(selected) = picked else {
        return Ok(None);
    };
    let mut paths = Vec::new();
    for path in selected {
        if path.is_dir() {
            knowledge_collect_files(&path, &mut paths)?;
        } else if knowledge_supported_file(&path) {
            paths.push(path);
        }
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return Err("未找到可导入的 .txt、.md、.markdown、.pdf 或 .html 文件".into());
    }
    let rt = state.runtime.read().await.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut imported = Vec::new();
        let mut failures = Vec::new();
        for path in paths {
            let source_id = path.to_string_lossy().into_owned();
            let parsed = knowledge_parse_local_file(&path);
            match parsed.and_then(|(source_kind, content)| {
                rt.knowledge_import_document(
                    &tenant_id,
                    &customer_id,
                    &space_id,
                    &subject_id,
                    &source_kind,
                    &source_id,
                    &content,
                    1200,
                )
                .map(|(_, version)| version)
                .map_err(|error| error.to_string())
            }) {
                Ok(version) => imported.push(version),
                Err(message) => {
                    // Persist a content-free failure record so an operator can
                    // see and retry a problematic source without exposing it.
                    let _ = rt.knowledge_sync_record_failure(
                        &tenant_id,
                        &customer_id,
                        &space_id,
                        &subject_id,
                        "local_file",
                        &source_id,
                        &message,
                    );
                    failures.push(KnowledgeFileImportFailure { source_id, message });
                }
            }
        }
        Ok::<_, String>(KnowledgeFileImportResult { imported, failures })
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(Some(result))
}

#[tauri::command]
async fn knowledge_publish_version(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    document_id: String,
    version_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_publish_version(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &document_id,
        &version_id,
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_revoke_version(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    document_id: String,
    version_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_revoke_version(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &document_id,
        &version_id,
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_sync_preview(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    source_kind: String,
    source_id: String,
    content: String,
) -> Result<KnowledgeSyncPreview, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_sync_preview(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &source_kind,
        &source_id,
        &content,
    )
    .map_err(map_err)
}
#[tauri::command]
async fn knowledge_sync_apply(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    source_kind: String,
    source_id: String,
    content: String,
    cursor: Option<String>,
) -> Result<(KnowledgeSyncPreview, Option<KnowledgeDocumentVersion>), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_sync_apply(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &source_kind,
        &source_id,
        &content,
        cursor.as_deref(),
        1200,
    )
    .map_err(map_err)
}
#[tauri::command]
async fn knowledge_sync_sources(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<Vec<KnowledgeSyncSource>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_sync_sources(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)
}
#[tauri::command]
async fn knowledge_sync_set_paused(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    source_kind: String,
    source_id: String,
    paused: bool,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_sync_set_paused(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &source_kind,
        &source_id,
        paused,
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_search(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<KnowledgeSearchHit>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_search(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &query,
        limit.unwrap_or(12),
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_answer(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    question: String,
    limit: Option<usize>,
) -> Result<KnowledgeAnswer, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_answer(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &question,
        limit.unwrap_or(6),
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_external_decision(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    requested_mode: String,
) -> Result<KnowledgeExternalDecision, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_external_decision(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &requested_mode,
    )
    .map_err(map_err)
}

/// Unified multi-space read (phase 8): explicit space ids, core-side
/// authorize + scope + external-policy gate per space, three evidence
/// surfaces merged. `knowledge_search` stays as the legacy compat entry.
#[tauri::command]
async fn space_search(
    state: State<'_, AppState>,
    subject_id: String,
    space_ids: Vec<String>,
    query: String,
    max_hits: Option<usize>,
) -> Result<SpaceSearchResult, String> {
    let rt = state.runtime.read().await;
    rt.space_search(&subject_id, &space_ids, &query, max_hits.unwrap_or(12))
        .map_err(map_err)
}

#[tauri::command]
async fn space_document_preview(
    state: State<'_, AppState>, subject_id: String, space_id: String, document_id: String,
) -> Result<dandelion_core::store::sqlite::KnowledgeDocumentPreview, String> {
    state.runtime.read().await.space_document_preview(&subject_id, &space_id, &document_id).map_err(map_err)
}

/// Resolve the exact version/chunk referenced by an assistant answer.
#[tauri::command]
async fn space_chunk_source(
    state: State<'_, AppState>, subject_id: String, space_id: String, chunk_id: String,
) -> Result<dandelion_core::store::KnowledgeSearchHit, String> {
    state.runtime.read().await.space_chunk_source(&subject_id, &space_id, &chunk_id).map_err(map_err)
}

#[tauri::command]
async fn space_ask(
    state: State<'_, AppState>,
    subject_id: String,
    space_ids: Vec<String>,
    question: String,
    max_hits: Option<usize>,
    allow_cloud: Option<bool>,
) -> Result<SpaceAnswer, String> {
    let rt = state.runtime.read().await;
    rt.space_ask(
        &subject_id,
        &space_ids,
        &question,
        max_hits.unwrap_or(8),
        allow_cloud.unwrap_or(false),
    )
    .await
    .map_err(map_err)
}

/// Space-keyed article browsing (phase-8c reader). Same fail-closed gate as
/// `space_search` — Reader authz and the local-retrieval decision run inside
/// core before anything is read. Identity is the space id, never a name.
#[tauri::command]
async fn space_status(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
) -> Result<dandelion_core::WikiStatus, String> {
    let rt = state.runtime.read().await;
    rt.space_status(&subject_id, &space_id).map_err(map_err)
}

#[tauri::command]
async fn space_show(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    page: Option<String>,
) -> Result<Vec<dandelion_core::WikiPage>, String> {
    let rt = state.runtime.read().await;
    rt.space_show(&subject_id, &space_id, page.as_deref())
        .map_err(map_err)
}

/// §八 出处可打开：resolve one citation token the reader clicked
/// (`路径:Lx-Ly`) to the FROZEN source version it was recorded against —
/// excerpt lines plus the full stored content (原文 for text, the body
/// snapshot for web pages). Same fail-closed gate inside core as every
/// other space read; refusals are named (「无法定位引用来源」/「来源已
/// 撤下」) and the payload states that a legal locator certifies nothing.
#[tauri::command]
async fn space_evidence(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    citation: String,
) -> Result<serde_json::Value, String> {
    let rt = state.runtime.read().await;
    rt.space_evidence(&subject_id, &space_id, &citation)
        .map_err(map_err)
}

/// Space-keyed ledger review (the pure-space entry point): `submit_wiki`'s
/// space attribution lands proposals in `wiki/spaces/<id>/`, and these are
/// the space-keyed counterparts of `wiki_entries`/`wiki_review_entry`/
/// `wiki_edit_entry`, so a space with no registered workspace can still be
/// reviewed in-app. Fail-closed gate inside core: id existence, archived
/// reject by name, Reader to list / Editor to mutate.
#[tauri::command]
async fn space_entries(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
) -> Result<Vec<dandelion_core::DistilledEntry>, String> {
    let rt = state.runtime.read().await;
    rt.space_entries(&subject_id, &space_id).map_err(map_err)
}

#[tauri::command]
async fn space_review_entry(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    id: String,
    action: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.space_review_entry(&subject_id, &space_id, &id, &action)
        .map_err(map_err)
}

#[tauri::command]
async fn space_edit_entry(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    id: String,
    content: Option<String>,
    kind: Option<String>,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.space_edit_entry(&subject_id, &space_id, &id, content.as_deref(), kind.as_deref())
        .map_err(map_err)
}

/// Create or replace one human-authored Wiki page of a knowledge space
/// (Editor gate inside core, fail-closed). Editing a machine-built page
/// PROTECTS it — `protected: true` means the next deep build keeps this body
/// and files the machine text as a pending conflict instead. The page lands
/// in a fresh published version immediately (same switch-version discipline
/// as the wired-PRUNE path: build, then flip, never delete-then-flip).
#[tauri::command]
async fn space_page_save(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    page: String,
    content: String,
) -> Result<dandelion_core::wiki_build::PageSaveOutcome, String> {
    let rt = state.runtime.read().await.clone();
    rt.space_page_save(&subject_id, &space_id, &page, &content)
        .map_err(map_err)
}

/// Change the space's external-model policy (space Owner, fail-closed):
/// `allow_summary` | `local_only` | `deny_cloud`. Nothing is rewritten —
/// the next ask/build-start/publish-recheck decision re-reads it, which is
/// what keeps a mid-flight build honest when the Owner flips it (the
/// publish gate then refuses and the previous version stays readable).
#[tauri::command]
async fn space_set_policy(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    policy: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.space_set_policy(&subject_id, &space_id, &policy).map_err(map_err)
}

/// The space's material list (§三 space association): every document this
/// space is a member of — its OWN (home) or LINKED in — with the link's
/// binding (`follow` / `pinned`) and the version this space actually reads
/// right now. `resolvedVersion: null` means linked but contributing no
/// evidence (a pinned version was revoked — fail closed). Reader gate.
#[tauri::command]
async fn space_materials(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
) -> Result<Vec<dandelion_core::KnowledgeSpaceMaterial>, String> {
    let rt = state.runtime.read().await;
    rt.space_materials(&subject_id, &space_id).map_err(map_err)
}

/// Link an existing material into this space (§三): same document, ONE
/// version history, no second copy. Membership is required on BOTH sides
/// (Editor here, Reader at the material's home), so linking can never read
/// through a wall. Starts as `follow`.
#[tauri::command]
async fn space_link_add(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    document_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.space_link_add(&subject_id, &space_id, &document_id)
        .map_err(map_err)
}

/// Bind a linked material: `pinned` freezes this space on one published
/// version (superseded pins fine, drafts and revoked never), `follow`
/// releases it back to the currently effective version. Editor gate.
#[tauri::command]
async fn space_link_set(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    document_id: String,
    binding: String,
    pinned_version_no: Option<i64>,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.space_link_set(&subject_id, &space_id, &document_id, &binding, pinned_version_no)
        .map_err(map_err)
}

/// Remove THIS space's link only — the material and its history live on
/// everywhere else. Honest error when there was no link.
#[tauri::command]
async fn space_link_remove(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    document_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.space_link_remove(&subject_id, &space_id, &document_id)
        .map_err(map_err)
}

/// Space deep build: materializes the space's PUBLISHED documents from the
/// store into the space's on-disk sources mirror (one-way, derived — never a
/// second knowledge store), then runs the same verified plan→articles→
/// overview pipeline as `wiki_build_deep` over the space's data dir.
/// Fail-closed Editor gate inside core; progress streams on `session-update`
/// as `_wiki_update` frames whose `workspace` names the space's sources dir,
/// so the space view claims them by space id.
#[tauri::command]
async fn space_build_deep(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    incremental: Option<bool>,
) -> Result<dandelion_core::wiki_build::BuildReport, String> {
    let rt = state.runtime.read().await.clone();
    rt.space_build_llm(&subject_id, &space_id, incremental.unwrap_or(false))
        .await
        .map_err(map_err)
}

/// Ask the in-flight deep build for this space to stop. False = none was
/// running (the request is not remembered, so it can never kill the next one).
#[tauri::command]
async fn space_build_cancel(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
) -> Result<bool, String> {
    let rt = state.runtime.read().await.clone();
    rt.space_build_cancel(&subject_id, &space_id).await.map_err(map_err)
}

/// Read the space's Wiki profile (knowledge domain settings). `None` = never
/// set, the build falls back to its heuristic (a sources mirror of documents
/// builds as a knowledge domain unless the user names it otherwise).
#[tauri::command]
async fn space_profile(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
) -> Result<Option<dandelion_core::WikiProfile>, String> {
    let rt = state.runtime.read().await;
    rt.space_profile(&subject_id, &space_id).map_err(map_err)
}

/// Set the space's Wiki profile before a build ("code" | "generic"); a saved
/// profile always beats the build's shape heuristic. Same validation as
/// `wiki_set_profile`.
#[tauri::command]
async fn space_set_profile(
    state: State<'_, AppState>,
    subject_id: String,
    space_id: String,
    profile: dandelion_core::WikiProfile,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.space_set_profile(&subject_id, &space_id, &profile).map_err(map_err)
}

#[tauri::command]
async fn knowledge_delete_document(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    document_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_delete_document(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &document_id,
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_export_save(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<Option<String>, String> {
    let rt = state.runtime.read().await;
    let snapshot = rt
        .knowledge_export(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)?;
    drop(rt);
    let dump = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_file_name("knowledge-export.json")
            .add_filter("JSON", &["json"])
            .save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    std::fs::write(&path, dump).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn knowledge_deletion_audits(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    limit: Option<u32>,
) -> Result<Vec<KnowledgeDeletionAudit>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_deletion_audits(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        limit.unwrap_or(50),
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_set_retention_days(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    retention_days: u32,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_set_retention_days(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        retention_days,
    )
    .map_err(map_err)
}

#[tauri::command]
async fn knowledge_retention_preview(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<Option<KnowledgeRetentionPreview>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_retention_preview(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)
}

#[tauri::command]
async fn knowledge_members(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<Vec<KnowledgeMember>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_members(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)
}
#[tauri::command]
async fn knowledge_manage_member(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    actor_id: String,
    member_id: String,
    role: KnowledgeRole,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_manage_member(
        &tenant_id,
        &customer_id,
        &space_id,
        &actor_id,
        &member_id,
        role,
    )
    .map_err(map_err)
}
#[tauri::command]
async fn knowledge_remove_member(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    actor_id: String,
    member_id: String,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_remove_member(&tenant_id, &customer_id, &space_id, &actor_id, &member_id)
        .map_err(map_err)
}
#[tauri::command]
async fn knowledge_create_api_client(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    label: String,
    max_requests_per_minute: u32,
    max_answer_tokens: u32,
) -> Result<KnowledgeApiProvision, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_create_api_client(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &label,
        max_requests_per_minute,
        max_answer_tokens,
    )
    .map_err(map_err)
}
#[tauri::command]
async fn knowledge_api_answer(
    state: State<'_, AppState>,
    token: String,
    question: String,
    requested_tokens: u32,
) -> Result<KnowledgeAnswer, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_api_answer(&token, &question, requested_tokens)
        .map_err(map_err)
}
#[tauri::command]
async fn knowledge_submit_feedback(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    kind: String,
    comment: Option<String>,
) -> Result<KnowledgeFeedback, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_submit_feedback(
        &tenant_id,
        &customer_id,
        &space_id,
        &subject_id,
        &kind,
        comment.as_deref(),
    )
    .map_err(map_err)
}
#[tauri::command]
async fn knowledge_feedback(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<Vec<KnowledgeFeedback>, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_feedback(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)
}
#[tauri::command]
async fn knowledge_review_feedback(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    reviewer_id: String,
    feedback_id: String,
    status: String,
    note: Option<String>,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.knowledge_review_feedback(
        &tenant_id,
        &customer_id,
        &space_id,
        &reviewer_id,
        &feedback_id,
        &status,
        note.as_deref(),
    )
    .map_err(map_err)
}
#[tauri::command]
async fn knowledge_quality_metrics(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
) -> Result<KnowledgeQualityMetrics, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_quality_metrics(&tenant_id, &customer_id, &space_id, &subject_id)
        .map_err(map_err)
}
#[tauri::command]
async fn knowledge_deletion_proof(
    state: State<'_, AppState>,
    tenant_id: String,
    customer_id: String,
    space_id: String,
    subject_id: String,
    audit_id: String,
) -> Result<KnowledgeDeletionProof, String> {
    let rt = state.runtime.read().await;
    rt.knowledge_deletion_proof(&tenant_id, &customer_id, &space_id, &subject_id, &audit_id)
        .map_err(map_err)
}

#[tauri::command]
async fn hooks_open_dir(state: State<'_, AppState>) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.open_hooks_dir().map_err(map_err)
}

#[tauri::command]
async fn children_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ChildListItem>, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    Ok(rt.children_list(&sid))
}

#[tauri::command]
async fn hardware_probe(state: State<'_, AppState>) -> Result<HardwareProbe, String> {
    let rt = state.runtime.read().await;
    Ok(rt.hardware_probe())
}

#[tauri::command]
async fn local_models(state: State<'_, AppState>) -> Result<Vec<LocalModel>, String> {
    let rt = state.runtime.read().await;
    Ok(rt.local_models())
}

#[tauri::command]
async fn local_model_import_pick(state: State<'_, AppState>) -> Result<Option<LocalModel>, String> {
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("GGUF", &["gguf"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let rt = state.runtime.read().await;
    rt.local_model_import(&path).map(Some).map_err(map_err)
}

#[tauri::command]
async fn local_model_import_mlx_pick(
    state: State<'_, AppState>,
) -> Result<Option<LocalModel>, String> {
    let picked = tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let rt = state.runtime.read().await;
    rt.local_model_import_mlx(&path).map(Some).map_err(map_err)
}

#[tauri::command]
async fn local_model_import_mlx_path(
    state: State<'_, AppState>,
    path: String,
) -> Result<LocalModel, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() {
        return Err("请输入 MLX 模型文件夹的完整绝对路径".to_string());
    }
    let rt = state.runtime.read().await;
    rt.local_model_import_mlx(&path).map_err(map_err)
}

#[tauri::command]
async fn mlx_runner_install(state: State<'_, AppState>) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    rt.install_mlx_runner().await.map_err(map_err)
}

#[tauri::command]
async fn local_model_download_modelscope(
    state: State<'_, AppState>,
    repo_id: String,
    file_path: String,
) -> Result<LocalModel, String> {
    let rt = state.runtime.read().await.clone();
    rt.local_model_download_modelscope(&repo_id, &file_path)
        .await
        .map_err(map_err)
}

#[tauri::command]
async fn model_download_status(state: State<'_, AppState>) -> Result<ModelDownloadStatus, String> {
    let rt = state.runtime.read().await;
    Ok(rt.model_download_status())
}

#[tauri::command]
async fn local_model_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.local_model_delete(&id).map_err(map_err)
}

#[tauri::command]
async fn local_model_verify(state: State<'_, AppState>, id: String) -> Result<LocalModel, String> {
    let rt = state.runtime.read().await;
    rt.local_model_verify(&id).map_err(map_err)
}

#[tauri::command]
async fn local_model_activate(
    state: State<'_, AppState>,
    id: String,
) -> Result<LocalModel, String> {
    let rt = state.runtime.read().await;
    rt.local_model_activate(&id).map_err(map_err)
}

#[tauri::command]
async fn sidecar_status(state: State<'_, AppState>) -> Result<SidecarStatus, String> {
    let rt = state.runtime.read().await;
    Ok(rt.sidecar_status())
}

#[tauri::command]
async fn sidecar_logs(state: State<'_, AppState>) -> Result<String, String> {
    let rt = state.runtime.read().await;
    Ok(rt.sidecar_logs())
}

/// Sidecar HTTP is loopback-only (`127.0.0.1` + ephemeral port). Vue never fetches llama-server.
#[tauri::command]
async fn sidecar_start(state: State<'_, AppState>) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    rt.sidecar_start().await.map_err(map_err)
}

#[tauri::command]
async fn sidecar_stop(state: State<'_, AppState>) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.sidecar_stop();
    Ok(())
}

#[tauri::command]
async fn sidecar_restart(state: State<'_, AppState>) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    rt.sidecar_restart().await.map_err(map_err)
}

#[tauri::command]
async fn corpus_list(state: State<'_, AppState>) -> Result<Vec<CorpusDoc>, String> {
    let rt = state.runtime.read().await;
    rt.corpus_list().map_err(map_err)
}

#[tauri::command]
async fn corpus_import_pick(state: State<'_, AppState>) -> Result<Option<CorpusDoc>, String> {
    let picked = tokio::task::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Text", &["txt", "md", "markdown", "rst"])
            .pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let rt = state.runtime.read().await;
    rt.corpus_import(&path).map(Some).map_err(map_err)
}

#[tauri::command]
async fn corpus_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.corpus_delete(&id).map_err(map_err)
}

#[tauri::command]
async fn wiki_status(state: State<'_, AppState>, workspace: Option<String>) -> Result<dandelion_core::WikiStatus, String> {
    let rt = state.runtime.read().await;
    Ok(rt.wiki_status_for(workspace.as_deref().map(Path::new)))
}

#[tauri::command]
async fn wiki_show(
    state: State<'_, AppState>,
    page: Option<String>,
    workspace: Option<String>,
) -> Result<Vec<dandelion_core::WikiPage>, String> {
    let rt = state.runtime.read().await;
    rt.wiki_show_for(workspace.as_deref().map(Path::new), page.as_deref()).map_err(map_err)
}

#[tauri::command]
async fn wiki_search(
    state: State<'_, AppState>,
    query: String,
    workspace: Option<String>,
) -> Result<Vec<dandelion_core::WikiHit>, String> {
    let rt = state.runtime.read().await;
    Ok(rt.wiki_search_for(workspace.as_deref().map(Path::new), &query))
}

#[tauri::command]
async fn wiki_compile(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<dandelion_core::WikiMeta, String> {
    let rt = state.runtime.read().await;
    let path = workspace.as_ref().map(PathBuf::from);
    rt.wiki_compile(path.as_deref()).map_err(map_err)
}

/// Deep build: plan → evidence-backed topic articles → overview, verified
/// and published all-or-nothing (keeps the previous version on any failure).
/// This is what the desktop "模型构建" button runs; `incremental` rebuilds
/// only what staleness names. Progress streams on `session-update` as
/// `_wiki_update` frames (build_started/build_plan/build_article/build_finished/build_error).
#[tauri::command]
async fn wiki_build_deep(
    state: State<'_, AppState>,
    workspace: Option<String>,
    incremental: Option<bool>,
) -> Result<dandelion_core::wiki_build::BuildReport, String> {
    let rt = state.runtime.read().await.clone();
    let path = workspace.as_ref().map(PathBuf::from);
    rt.wiki_build_llm(path.as_deref(), incremental.unwrap_or(false)).await.map_err(map_err)
}

/// Ask the in-flight deep build for this project to stop. False = none was
/// running (the request is not remembered, so it can never kill the next one).
#[tauri::command]
async fn wiki_build_cancel(state: State<'_, AppState>, workspace: Option<String>) -> Result<bool, String> {
    let rt = state.runtime.read().await.clone();
    Ok(rt.wiki_build_cancel(workspace.as_deref().map(Path::new)).await)
}

/// Honest scan coverage for the bound project (candidates / included /
/// excluded with reasons / child-repo probe / root suggestion). Read-only;
/// `None` until the project has been scanned or deep-built at least once.
#[tauri::command]
async fn wiki_coverage(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Option<dandelion_core::wiki_index::CoverageReport>, String> {
    let rt = state.runtime.read().await;
    Ok(rt.wiki_coverage_for(workspace.as_deref().map(Path::new)))
}

/// Pre-first-build coverage preview: runs the build's scan pass on demand so
/// the user sees root choice / included / dropped files BEFORE building
/// anything. Persists the evidence index (later builds reuse it by hash);
/// compiles no pages and never calls a model.
#[tauri::command]
async fn wiki_coverage_preview(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<dandelion_core::wiki_index::CoverageReport, String> {
    let rt = state.runtime.read().await.clone();
    rt.wiki_coverage_preview_for(workspace.as_deref().map(Path::new))
        .await
        .map_err(map_err)
}

/// Open a cited source range `rel:Lx-Ly` INSIDE the bound project. Core
/// canonicalizes and re-checks containment before reading, so a crafted
/// `rel` can never reach a sibling project; refusal comes back as an error.
#[tauri::command]
async fn wiki_read_source(
    state: State<'_, AppState>,
    workspace: Option<String>,
    rel: String,
    start: u32,
    end: u32,
) -> Result<dandelion_core::wiki::SourceWindow, String> {
    let rt = state.runtime.read().await;
    let ws = match workspace.as_ref().map(PathBuf::from) {
        Some(w) => w,
        None => rt.info().workspace,
    };
    dandelion_core::wiki::read_source_window(&ws, &rel, start, end, 400).map_err(map_err)
}

#[tauri::command]
async fn wiki_ask(
    state: State<'_, AppState>,
    question: String,
    workspace: Option<String>,
) -> Result<dandelion_core::WikiAnswer, String> {
    let rt = state.runtime.read().await.clone();
    rt.wiki_ask_for(workspace.as_deref().map(Path::new), &question).await.map_err(map_err)
}

#[tauri::command]
async fn wiki_open_dir(state: State<'_, AppState>, workspace: Option<String>) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.open_wiki_dir_for(workspace.as_deref().map(Path::new)).map_err(map_err)
}

#[tauri::command]
async fn wiki_distill(
    state: State<'_, AppState>,
    session_id: String,
    workspace: Option<String>,
) -> Result<usize, String> {
    let rt = state.runtime.read().await.clone();
    let sid = dandelion_core::SessionId::parse(&session_id).map_err(|_| "无效会话 id".to_string())?;
    rt.wiki_distill(workspace.as_deref().map(Path::new), &sid).await.map_err(map_err)
}

#[tauri::command]
async fn wiki_profile(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Option<dandelion_core::WikiProfile>, String> {
    let rt = state.runtime.read().await;
    Ok(rt.wiki_profile_for(workspace.as_deref().map(Path::new)))
}

#[tauri::command]
async fn wiki_set_profile(
    state: State<'_, AppState>,
    profile: dandelion_core::WikiProfile,
    workspace: Option<String>,
) -> Result<(), String> {
    let rt = state.runtime.read().await;
    rt.wiki_set_profile_for(workspace.as_deref().map(Path::new), &profile).map_err(map_err)
}

/// Every knowledge entry of a project, pending proposals included — the
/// Wiki panel's review list.
#[tauri::command]
async fn wiki_entries(
    state: State<'_, AppState>,
    workspace: Option<String>,
) -> Result<Vec<dandelion_core::DistilledEntry>, String> {
    let rt = state.runtime.read().await;
    Ok(rt.wiki_entries_for(workspace.as_deref().map(Path::new)))
}

/// Review one entry: approve / reject a pending proposal, or undo an accepted
/// one. Queues a coalesced recompile inside the Runtime.
#[tauri::command]
async fn wiki_review_entry(
    state: State<'_, AppState>,
    id: String,
    action: String,
    workspace: Option<String>,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.wiki_review_entry(workspace.as_deref().map(Path::new), &id, &action).map_err(map_err)
}

/// Panel edit of one entry's content and/or kind.
#[tauri::command]
async fn wiki_edit_entry(
    state: State<'_, AppState>,
    id: String,
    content: Option<String>,
    kind: Option<String>,
    workspace: Option<String>,
) -> Result<(), String> {
    let rt = state.runtime.read().await.clone();
    rt.wiki_edit_entry(
        workspace.as_deref().map(Path::new),
        &id,
        content.as_deref(),
        kind.as_deref(),
    )
    .map_err(map_err)
}

/// Open Wiki drafts of one conversation (proposals made while the session had
/// no bound project). The chat shows these with the onboarding actions.
#[tauri::command]
async fn wiki_suggest_project_name(state: State<'_, AppState>, draft_id: String) -> Result<String,String> {
    let rt=state.runtime.read().await.clone();
    rt.wiki_suggest_project_name(&draft_id).await.map_err(map_err)
}

#[tauri::command]
async fn wiki_drafts(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<dandelion_core::wiki::WikiDraft>, String> {
    let rt = state.runtime.read().await;
    let sid = SessionId::parse(session_id).map_err(map_err)?;
    Ok(rt.wiki_drafts(&sid))
}

/// Complete the project onboarding for one draft. `mode` mirrors the dialog
/// actions: "project" (registered id), "directory" (existing path), "new"
/// (parent + name; the UI shows the resulting absolute path BEFORE calling
/// this), and "space" (`space_id`: attribute the proposal to a knowledge
/// space — no project is created or bound, the conversation keeps whatever
/// project binding it has). Directory validation, registration, session
/// binding and the re-validated submit all happen host-side in the Runtime,
/// idempotently.
#[tauri::command]
async fn wiki_resolve_draft(
    state: State<'_, AppState>,
    draft_id: String,
    mode: String,
    project_id: Option<String>,
    path: Option<String>,
    parent: Option<String>,
    name: Option<String>,
    space_id: Option<String>,
    publish: Option<bool>,
) -> Result<dandelion_core::wiki::WikiDraftOutcome, String> {
    let rt = state.runtime.read().await.clone();
    let target = match mode.as_str() {
        "project" => dandelion_core::wiki::WikiDraftTarget::ExistingProject {
            project_id: project_id.ok_or_else(|| "缺少项目 id".to_string())?,
        },
        "directory" => dandelion_core::wiki::WikiDraftTarget::RegisterDirectory {
            path: PathBuf::from(path.ok_or_else(|| "缺少目录路径".to_string())?),
        },
        "new" => dandelion_core::wiki::WikiDraftTarget::NewProject {
            parent: PathBuf::from(parent.ok_or_else(|| "缺少父目录".to_string())?),
            name: name.ok_or_else(|| "缺少项目名".to_string())?,
        },
        "space" => dandelion_core::wiki::WikiDraftTarget::Space {
            space_id: space_id.ok_or_else(|| "缺少知识空间 id".to_string())?,
        },
        other => return Err(format!("unknown wiki draft target: {other}")),
    };
    rt.wiki_confirm_draft(&draft_id, target, publish.unwrap_or(false)).map_err(map_err)
}

/// User dismissed onboarding: the draft disappears; nothing was created.
#[tauri::command]
async fn wiki_cancel_draft(state: State<'_, AppState>, draft_id: String) -> Result<bool, String> {
    let rt = state.runtime.read().await;
    rt.wiki_cancel_draft(&draft_id).map_err(map_err)
}

#[tauri::command]
async fn spec_start(
    state: State<'_, AppState>,
    mode: String,
    text: String,
    session_id: Option<String>,
) -> Result<dandelion_core::SpecHandle, String> {
    let rt = state.runtime.read().await.clone();
    let mode = dandelion_core::SpecMode::parse(&mode).map_err(map_err)?;
    let sid = match session_id {
        Some(s) => SessionId::parse(s).map_err(map_err)?,
        None => rt.new_session(None),
    };
    let req = PromptRequest::new(sid, text);
    rt.spec_start(mode, req).await.map_err(map_err)
}

#[tauri::command]
async fn spec_revise(
    state: State<'_, AppState>,
    spec_id: String,
    text: String,
) -> Result<dandelion_core::SpecDiff, String> {
    let rt = state.runtime.read().await.clone();
    let req = PromptRequest::new(rt.new_session(None), text);
    rt.spec_revise(&spec_id, req).await.map_err(map_err)
}

#[tauri::command]
async fn spec_show(
    state: State<'_, AppState>,
    spec_id: String,
) -> Result<dandelion_core::SpecSnapshot, String> {
    let rt = state.runtime.read().await;
    rt.spec_show(&spec_id).map_err(map_err)
}

#[tauri::command]
async fn spec_diff(
    state: State<'_, AppState>,
    spec_id: String,
) -> Result<dandelion_core::SpecDiff, String> {
    let rt = state.runtime.read().await;
    rt.spec_diff(&spec_id).map_err(map_err)
}

#[tauri::command]
async fn spec_approve(
    state: State<'_, AppState>,
    spec_id: String,
) -> Result<dandelion_core::SpecSnapshot, String> {
    let rt = state.runtime.read().await.clone();
    rt.spec_approve(&spec_id).await.map_err(map_err)
}

#[tauri::command]
async fn spec_run(
    state: State<'_, AppState>,
    spec_id: String,
    text: Option<String>,
) -> Result<String, String> {
    let rt = state.runtime.read().await.clone();
    let req = PromptRequest::new(
        rt.new_session(None),
        text.unwrap_or_else(|| "execute approved plan".into()),
    );
    rt.spec_run(&spec_id, req)
        .await
        .map(|s| s.to_string())
        .map_err(map_err)
}

/// 同一请求会广播到所有窗口；一个窗口应答后广播 resolved，其余窗口关闭镜像弹窗。
#[tauri::command]
fn host_permission_respond(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    answer: PermissionAnswer,
) -> Result<(), String> {
    let outcome = match answer.option_id.as_str() {
        "allow" => RequestPermissionOutcome::Selected {
            option_id: "allow".into(),
        },
        "allow_turn" => RequestPermissionOutcome::Selected {
            option_id: "allow_turn".into(),
        },
        "deny" => RequestPermissionOutcome::Selected {
            option_id: "deny".into(),
        },
        "cancelled" => RequestPermissionOutcome::Cancelled,
        _ => RequestPermissionOutcome::Denied,
    };
    state.host.respond(&answer.request_id, outcome);
    let _ = app.emit(
        "permission-resolved",
        json!({ "requestId": answer.request_id }),
    );
    Ok(())
}

/// 未决审批快照：错过一次性事件的窗口在 focus 时拉取并重放弹窗。
#[tauri::command]
fn host_permission_pending(state: State<'_, AppState>) -> Vec<PermissionEvent> {
    state
        .host
        .pending_requests()
        .into_iter()
        .map(|(request_id, req)| {
            let tool_call_id = req
                .subject
                .as_ref()
                .and_then(|subject| subject.tool_call_id.as_ref())
                .map(ToString::to_string);
            PermissionEvent {
                request_id,
                session_id: req.session_id.to_string(),
                title: req.title,
                tool_call_id,
                options: req.options,
            }
        })
        .collect()
}

/// 把 Runtime 总线抽给一个接收方；Closed 或代际更替时结束。
/// 单独抽出来是为了能测到最疼的那条分支：接收队列 Lagged 时旧实现直接
/// `continue`，丢多少帧、丢了什么状态一概不知。现在把丢失条数交给
/// `on_lagged`（真实实现记日志并通知前端按落库状态重建），不再静默。
async fn pump_bus(
    rx: &mut broadcast::Receiver<dandelion_core::BusFrame>,
    alive: impl Fn() -> bool,
    on_frame: impl Fn(&dandelion_core::BusFrame) -> bool,
    mut on_lagged: impl FnMut(u64),
) {
    loop {
        if !alive() {
            return;
        }
        match rx.recv().await {
            Ok(frame) => {
                if !on_frame(&frame) {
                    return;
                }
            }
            Err(broadcast::error::RecvError::Lagged(missed)) => on_lagged(missed),
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

fn spawn_bus_forwarder(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 跨代际累计：断一次网重订阅不该把「今天一共丢了多少」清零。
        let lagged_total = std::sync::atomic::AtomicU64::new(0);
        loop {
            let gen = app.state::<AppState>().bus_gen.load(Ordering::SeqCst);
            let mut rx = app.state::<AppState>().runtime.read().await.subscribe();
            pump_bus(
                &mut rx,
                || app.state::<AppState>().bus_gen.load(Ordering::SeqCst) == gen,
                |frame| {
                    let _ = app.emit("session-update", frame);
                    true
                },
                |missed| {
                    let missed = missed as u64;
                    let total = lagged_total.fetch_add(missed, Ordering::SeqCst) + missed;
                    tracing::warn!(
                        missed,
                        lagged_total = total,
                        "session-update subscriber lagged; telling frontend to resync from persisted state"
                    );
                    let _ = app.emit("bus-lagged", json!({ "missed": missed, "total": total }));
                },
            )
            .await;
        }
    });
}

/// Thin forwarder (work-order §二 measurement): the frontend buffers its own
/// boot-phase marks locally and flushes them once, at boot end. Nothing here
/// changes behavior — it only mirrors `performance.now()` milestones into the
/// same tracing stream the backend phases land on, so one log file carries
/// process → window → first-paint → session-ready on a single clock.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootMark {
    phase: String,
    elapsed_ms: u64,
    detail: String,
}

#[tauri::command]
fn boot_marks(marks: Vec<BootMark>) {
    for m in marks {
        tracing::info!(
            phase = %m.phase,
            elapsed_ms = m.elapsed_ms,
            detail = %m.detail,
            "boot mark (frontend)"
        );
    }
}

/// Dandelion Open：与商业版**并行安装、数据隔离**。core 的
/// `product_data_dir()` 优先读 `DANDELION_DATA_DIR`，这里在创建任何宿主之前
/// 把它指到 Open 版自己的目录（用户显式设置了该变量时尊重用户）。
fn ensure_isolated_data_dir() {
    if std::env::var_os("DANDELION_DATA_DIR")
        .is_some_and(|v| !v.to_string_lossy().trim().is_empty())
    {
        return;
    }
    #[cfg(windows)]
    let isolated = std::env::var_os("APPDATA")
        .map(|root| std::path::PathBuf::from(root).join("dandelion-open"));
    #[cfg(target_os = "macos")]
    let isolated = std::env::var_os("HOME")
        .map(|home| std::path::PathBuf::from(home).join("Library/Application Support/dandelion-open"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let isolated = std::env::var_os("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| std::path::PathBuf::from(home).join(".local/share"))
        })
        .map(|base| base.join("dandelion-open"));
    if let Some(dir) = isolated {
        std::env::set_var("DANDELION_DATA_DIR", dir);
    }
}

pub fn run() {
    ensure_isolated_data_dir();
    // Startup phase timing (work-order §二): per-phase info logs, on the same
    // wall clock as the core debug timings, so "which phase costs what" is
    // readable from one capture without mixing them into one number.
    let tokio_rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    tauri::async_runtime::set(tokio_rt.handle().clone());
    let _enter = tokio_rt.enter();

    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("dandelion_desktop=info,dandelion_core=info")
    });
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(false)
        .try_init();

    let t = std::time::Instant::now();
    let host = Arc::new(DesktopHost::new_default());
    // Dandelion Open：无账号门禁——不设 execution guard（core 默认放行），
    // 应用启动即可直接使用全部功能。
    let data_dir = host.data_dir();
    let _ = Settings::write_template_if_absent(&data_dir);
    tracing::info!(elapsed_ms = t.elapsed().as_millis() as u64, "startup: host + settings template");
    // NOTE for the startup batch: this runs synchronously on the main thread
    // *before* the window builder below, i.e. it gates "window appears".
    let t = std::time::Instant::now();
    let runtime = Runtime::new(host.clone()).unwrap_or_else(|err| {
        panic!("{PRODUCT_NAME} desktop failed to start Runtime: {err}");
    });
    tracing::info!(elapsed_ms = t.elapsed().as_millis() as u64, "startup: runtime new (main thread, before window)");

    let t_build = std::time::Instant::now();
    tauri::Builder::default()
        .manage(updates::Updates::default())
        .manage(AppState {
            host,
            runtime: RwLock::new(runtime),
            bus_gen: AtomicU64::new(0),
            agent_installs: Mutex::new(HashMap::new()),
        })
        .setup(move |app| {
            tracing::info!(
                elapsed_ms = t_build.elapsed().as_millis() as u64,
                "startup: setup entered (window + webview created)"
            );
            let handle = app.handle().clone();
            let host = app.state::<AppState>().host.clone();
            let emit = handle.clone();
            host.set_permission_sink(Arc::new(move |request_id, req| {
                let tool_call_id = req
                    .subject
                    .as_ref()
                    .and_then(|subject| subject.tool_call_id.as_ref())
                    .map(ToString::to_string);
                let payload = PermissionEvent {
                    request_id,
                    session_id: req.session_id.to_string(),
                    title: req.title,
                    tool_call_id,
                    options: req.options,
                };
                // 广播而非只发占用窗口：审批必须可达，任务在哪个窗口跑都一样，
                // 弹窗自带“来自任务”标注，任一窗口可答，应答后 resolved 关其余。
                tracing::info!(
                    request_id = %payload.request_id,
                    session = %payload.session_id,
                    "permission request broadcast to all windows"
                );
                let _ = emit.emit("permission-request", payload);
            }));
            spawn_bus_forwarder(handle);
            if let Some(main) = app.get_webview_window("main") {
                let settings = app
                    .state::<AppState>()
                    .runtime
                    .try_read()
                    .ok()
                    .map(|rt| rt.settings());
                if let Some(settings) = settings {
                    apply_main_window_geometry(&main, &settings);
                }
                let persist = app.handle().clone();
                let main_for_dpi = main.clone();
                main.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) {
                        persist_main_window_geometry(&persist);
                    }
                    // 关键：跨 DPI 显示器拖拽时，WebView2 会把新物理尺寸当逻辑尺寸处理，
                    // 窗口瞬间放大数倍。这里先用 scale_factor 反算回逻辑尺寸重设，
                    // 再按当前显示器工作区夹一次上限，防止在尺寸/缩放不同的屏之间拖拽时
                    // 窗口超出可视工作区，也保证内容始终撑满窗口。
                    if let WindowEvent::ScaleFactorChanged {
                        scale_factor,
                        new_inner_size,
                        ..
                    } = event
                    {
                        let logical_w = new_inner_size.width as f64 / scale_factor;
                        let logical_h = new_inner_size.height as f64 / scale_factor;
                        let _ =
                            main_for_dpi.set_size(tauri::LogicalSize::new(logical_w, logical_h));
                        clamp_window_to_work_area(&main_for_dpi);
                    }
                });
            }
            let boot = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let info = boot.state::<AppState>().runtime.read().await.info();
                tracing::info!(
                    version = info.version,
                    data_dir = %info.data_dir.display(),
                    base_url_set = info.base_url_set,
                    loop_ready = info.loop_ready,
                    "desktop Runtime ready"
                );
            });
            Ok(())
        })
        .invoke_handler({
            let handler: Arc<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync> = Arc::new(tauri::generate_handler![
            updates::check_update, updates::open_download,
            boot_marks,
            runtime_info,
            session_new,
            session_prompt,
            file_image_data_url,
            attachment_data_url,
            agent_engine_vision,
            prompt_refine,
            session_cancel,
            agent_plugins_list,
            agent_plugin_connect,
            agent_plugin_install,
            agent_plugin_install_cancel,
            agent_plugin_set_model,
            agent_plugin_uninstall,
            agent_plugin_stop,
            terminal_kill,
            background_processes,
            terminal_run_user,
            folder_pick,
            file_pick,
            browser_embed_show,
            browser_embed_hide,
            folder_list,
            folder_read,
            workspace_write_file,
            workspace_create_entry,
            workspace_rename_entry,
            workspace_delete_entry,
            workspace_review,
            git_snapshot,
            git_init,
            git_configure,
            git_diff,
            git_stage,
            git_commit,
            git_restore_file,
            git_reset_hard,
            git_switch_branch,
            git_fetch,
            git_pull,
            git_push,
            session_export,
            session_export_window,
            sessions_list,
            projects_list,
            project_create,
            project_delete,
            project_rename,
            project_unlist,
            project_reveal,
            projects_prune_empty,
            session_set_title,
            session_set_pinned,
            session_set_archived,
            session_delete,
            session_occupy,
            session_release,
            session_occupancy,
            session_detached_ids,
            session_focus_detached,
            session_detach,
            session_prefs_get,
            session_prefs_set,
            todo_list,
            session_replace_bindings,
            session_duplicate,
            session_task_bindings,
            sessions_search,
            skills_list,
            mcp_list,
            mcp_start,
            mcp_stop,
            mcp_upsert,
            mcp_remove,
            skills_import,
            skills_import_pick,
            skills_set_enabled,
            skills_open,
            skills_export_pick,
            skills_remove,
            skills_install_url,
            skills_install_git,
            registry_mcp_search,
            registry_mcp_install,
            sandbox_roots,
            sandbox_add_root,
            sandbox_add_pick,
            sandbox_remove_root,
            context_status,
            session_export_save,
            settings_get,
            settings_api_key_reveal,
            settings_patch,
            settings_json,
            settings_put_json,
            provider_probe,
            cron_list,
            cron_runs,
            cron_add,
            cron_pause,
            cron_resume,
            cron_remove,
            cron_run_now,
            cron_stop_current,
            memory_files,
            memory_set,
            memory_open_dir,
            context_memory_list,
            context_memory_add,
            context_memory_forget,
            context_memory_confirm_candidate,
            context_memory_revise,
            context_build_preview,
            context_temporal_projection,
            context_entity_graph_projection,
            context_pack_audit,
            context_migrate_legacy_memory,
            preflight_preview,
            preflight_status,
            preflight_metrics,
            knowledge_create_tenant,
            knowledge_tenants,
            knowledge_local_spaces,
            knowledge_items::knowledge_item_list,
            knowledge_items::knowledge_item_get,
            knowledge_items::knowledge_item_save,
            knowledge_items::knowledge_items_pick,
            knowledge_items::knowledge_item_retry,
            knowledge_items::knowledge_item_organize,
            knowledge_items::knowledge_item_ai_policy,
            knowledge_items::knowledge_item_classify,
            knowledge_items::knowledge_item_delete,
            knowledge_items::knowledge_item_save_draft,
            knowledge_items::knowledge_item_export,
            knowledge_create_local_space,
            knowledge_create_customer,
            knowledge_customers,
            knowledge_create_space,
            knowledge_spaces,
            knowledge_documents,
            knowledge_create_collection,
            knowledge_collections,
            knowledge_assign_collection,
            knowledge_set_member,
            knowledge_import_document,
            knowledge_import_pick,
            knowledge_publish_version,
            knowledge_revoke_version,
            knowledge_sync_preview,
            knowledge_sync_apply,
            knowledge_sync_sources,
            knowledge_sync_set_paused,
            knowledge_search,
            knowledge_answer,
            knowledge_external_decision,
            space_search,
            space_chunk_source,
            space_document_preview,
            space_ask,
            space_status,
            space_show,
            space_evidence,
            space_entries,
            space_review_entry,
            space_edit_entry,
            space_page_save,
            space_set_policy,
            space_materials,
            space_link_add,
            space_link_set,
            space_link_remove,
            space_build_deep,
            space_build_cancel,
            space_profile,
            space_set_profile,
            knowledge_delete_document,
            knowledge_export_save,
            knowledge_deletion_audits,
            knowledge_set_retention_days,
            knowledge_retention_preview,
            knowledge_members,
            knowledge_manage_member,
            knowledge_remove_member,
            knowledge_create_api_client,
            knowledge_api_answer,
            knowledge_submit_feedback,
            knowledge_feedback,
            knowledge_review_feedback,
            knowledge_quality_metrics,
            knowledge_deletion_proof,
            hooks_open_dir,
            children_list,
            hardware_probe,
            local_models,
            local_model_import_pick,
            local_model_import_mlx_pick,
            local_model_import_mlx_path,
            mlx_runner_install,
            local_model_download_modelscope,
            model_download_status,
            local_model_delete,
            local_model_verify,
            local_model_activate,
            sidecar_status,
            sidecar_logs,
            sidecar_start,
            sidecar_stop,
            sidecar_restart,
            corpus_list,
            corpus_import_pick,
            corpus_delete,
            wiki_status,
            wiki_show,
            wiki_search,
            wiki_compile,
            wiki_build_deep,
            wiki_build_cancel,
            wiki_coverage,
            wiki_coverage_preview,
            wiki_read_source,
            wiki_ask,
            wiki_open_dir,
            wiki_distill,
            wiki_profile,
            wiki_set_profile,
            wiki_entries,
            wiki_review_entry,
            wiki_edit_entry,
            wiki_suggest_project_name,
            wiki_drafts,
            wiki_resolve_draft,
            wiki_cancel_draft,
            spec_start,
            spec_revise,
            spec_show,
            spec_diff,
            spec_approve,
            spec_run,
            host_permission_respond,
            host_permission_pending,
            ]);
            // Dandelion Open：不再包账号授权层，命令直达 handler。
            move |invoke: tauri::ipc::Invoke| handler(invoke)
        })
        .build(tauri::generate_context!())
        .expect("error while building Dandelion desktop")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                persist_main_window_geometry(app_handle);
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(rt) = state.runtime.try_read() {
                        rt.sidecar_kill_on_exit();
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use dandelion_core::acp::{SessionNotification, SessionUpdate};
    use dandelion_core::{BusFrame, SessionId};
    use std::path::Path;

    #[test]
    fn frontend_must_not_call_openai() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut hits = Vec::new();
        for entry in walkdir::WalkDir::new(&src)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let Some(ext) = path.extension().and_then(|s| s.to_str()) else {
                continue;
            };
            if !matches!(ext, "ts" | "vue" | "js" | "mjs") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(path) else {
                continue;
            };
            if text.contains("/v1/chat/completions") || text.contains("api.openai.com") {
                hits.push(path.display().to_string());
            }
        }
        assert!(
            hits.is_empty(),
            "Vue must not call the model; hits: {hits:?}"
        );
    }

    #[test]
    fn child_idle_must_not_end_parent_session() {
        let parent = SessionId::parse("tsk_parent").unwrap();
        let child = SessionId::parse("tsk_child").unwrap();
        let frame = BusFrame::session_update(
            1,
            SessionNotification {
                session_id: child,
                update: SessionUpdate::idle("end_turn"),
            },
        );
        assert!(
            !frame.belongs_to_session(&parent),
            "subscribe filter must drop child idle"
        );
    }

    /// 工作单 2026-10-19 第二版·条目 4：接收队列 Lagged 不许再静默 continue。
    /// 容量 1 的通道灌 3 帧必然落后 —— pump 必须把丢失条数交出来，
    /// 并且不停机：落后之后还要继续把剩下的帧送完。
    #[tokio::test]
    async fn pump_bus_reports_lag_then_keeps_pumping() {
        use super::pump_bus;
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
        let (tx, mut rx) = tokio::sync::broadcast::channel::<dandelion_core::BusFrame>(1);
        let mk = |seq: u64| {
            BusFrame::session_update(
                seq,
                SessionNotification {
                    session_id: SessionId::parse("tsk_pump").unwrap(),
                    update: SessionUpdate::idle("end_turn"),
                },
            )
        };
        tx.send(mk(1)).unwrap();
        tx.send(mk(2)).unwrap();
        tx.send(mk(3)).unwrap();
        drop(tx); // 之后通道无发送方：收完现存帧泵自然结束（Closed）。
        let delivered = AtomicUsize::new(0);
        let lags = std::sync::Mutex::new(Vec::<u64>::new());
        let alive = AtomicBool::new(true);
        pump_bus(
            &mut rx,
            || alive.load(AtomicOrdering::Relaxed),
            |_| {
                delivered.fetch_add(1, AtomicOrdering::Relaxed);
                true
            },
            |missed| lags.lock().unwrap().push(missed as u64),
        )
        .await;
        assert_eq!(*lags.lock().unwrap(), vec![2], "落后 2 帧必须被数出来并上报");
        assert_eq!(delivered.load(AtomicOrdering::Relaxed), 1, "落后不是停机理由，最新帧仍要送达");
    }
    /// 会话切换工作单（2026-10-19）：移动盘/网络盘暂时没就位曾触发启动即删对话。
    /// 现在宿主不再暴露「目录缺失就批量删除」的命令，空间列表只带 `accessible`
    /// 提示；此测试钉死这条边界，防止有人把自动删除接回来。
    #[test]
    fn startup_must_not_purge_missing_workspaces() {
        let src = include_str!("lib.rs");
        assert!(
            // concat! 拆开字面量：include_str 把本测试也读进 src，
            // 断言字符串本身不能成为被搜索的完整文本。
            !src.contains(concat!("async fn projects_prune_", "missing")),
            "宿主不得再暴露 projects_prune_missing 命令：启动读不到目录不是删除理由"
        );
        assert!(
            src.contains("\"accessible\""),
            "projects_list 必须给每行带 accessible，让侧栏能显示「暂时不可访问」而不是消失"
        );
        // 前端也不许残留调用（注释里的说明性提及没有左括号，不会误伤）。
        let fe = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        for entry in walkdir::WalkDir::new(&fe)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !path.is_file()
                || !matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("ts" | "vue" | "js" | "mjs")
                )
            {
                continue;
            }
            let text = std::fs::read_to_string(path).unwrap_or_default();
            assert!(
                !text.contains("projectsPruneMissing(")
                    && !text.contains("invoke(\"projects_prune_missing\""),
                "前端残留自动删除调用: {}",
                path.display()
            );
        }
    }

    #[test]
    fn cd1_ipc_commands_are_registered() {
        let src = include_str!("lib.rs");
        for name in [
            "session_set_title",
            "session_delete",
            "session_occupy",
            "session_release",
            "session_prefs_get",
            "session_prefs_set",
            "session_replace_bindings",
            "session_duplicate",
            "session_task_bindings",
            "sessions_search",
            "skills_list",
            "mcp_list",
            "mcp_start",
            "mcp_stop",
            "mcp_upsert",
            "mcp_remove",
            "skills_import_pick",
            "skills_set_enabled",
            "skills_open",
            "skills_export_pick",
            "skills_remove",
            "skills_install_url",
            "skills_install_git",
            "registry_mcp_search",
            "registry_mcp_install",
            "sandbox_roots",
            "sandbox_add_root",
            "sandbox_add_pick",
            "sandbox_remove_root",
            "context_status",
            "session_export_save",
            "settings_json",
            "settings_put_json",
            "provider_probe",
            "session_detach",
            "session_occupancy",
            "session_focus_detached",
            "session_detached_ids",
            "cron_list",
            "cron_add",
            "cron_run_now",
            "cron_stop_current",
            "memory_files",
            "memory_set",
            "memory_open_dir",
            "hooks_open_dir",
            "children_list",
            "hardware_probe",
            "local_models",
            "local_model_import_pick",
            "local_model_download_modelscope",
            "model_download_status",
            "local_model_delete",
            "local_model_verify",
            "local_model_activate",
            "sidecar_status",
            "sidecar_logs",
            "sidecar_start",
            "sidecar_stop",
            "sidecar_restart",
            "corpus_list",
            "corpus_import_pick",
            "corpus_delete",
            "wiki_status",
            "wiki_show",
            "wiki_search",
            "wiki_compile",
            "wiki_open_dir",
            "wiki_entries",
            "wiki_review_entry",
            "wiki_edit_entry",
            "wiki_drafts",
            "wiki_resolve_draft",
            "wiki_cancel_draft",
            "space_build_deep",
            "space_build_cancel",
            "space_profile",
            "space_set_profile",
            "spec_start",
            "spec_revise",
            "spec_show",
            "spec_diff",
            "spec_approve",
            "spec_run",
        ] {
            assert!(src.contains(name), "G5 IPC missing {name}");
        }
        assert!(
            src.contains("rt.settings_patch(patch)"),
            "settings_patch must hot-apply via Runtime"
        );
        assert!(
            src.contains("WebviewWindowBuilder"),
            "09 must be a second Tauri webview"
        );
        assert!(
            src.contains("emit.emit(\"permission-request\""),
            "permission dialog must broadcast to every window, not just the occupying one"
        );
        assert!(
            src.contains("\"permission-resolved\""),
            "answered permission must close mirrored dialogs in other windows"
        );
        assert!(
            src.contains("host_permission_pending"),
            "windows must be able to replay unanswered permission requests on focus"
        );
    }

    #[test]
    fn g5b_frontend_has_material_panels_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        for name in [
            "components/SkillPanel.vue",
            "components/McpPanel.vue",
            "components/SandboxPanel.vue",
        ] {
            assert!(src.join(name).is_file(), "missing {name}");
        }
        let dock = std::fs::read_to_string(src.join("components/Dock.vue")).unwrap();
        assert!(dock.contains("插件"), "{dock}");
        assert!(dock.contains("知识"), "{dock}");
        assert!(!dock.contains("G5-C 再接线"), "settings dock is G5-C");
        assert!(dock.contains("openSettings(\"models\")"), "{dock}");
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(store.contains("mcpStart"), "05 start must hit Runtime");
        assert!(store.contains("sandboxAddPick") || store.contains("addSandboxRoot"));
        assert!(store.contains("sandboxAddRoot") || store.contains("addSandboxPath"));
        assert!(!store.contains("/v1/chat/completions"));
        let sandbox = std::fs::read_to_string(src.join("components/SandboxPanel.vue")).unwrap();
        assert!(sandbox.contains("manualPath") && sandbox.contains("store.addSandboxPath"));
        let mcp = std::fs::read_to_string(src.join("components/McpPanel.vue")).unwrap();
        assert!(mcp.contains("停 MCP 不会停对话"), "{mcp}");
    }

    #[test]
    fn g5c_frontend_has_settings_pages_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        for name in [
            "components/SettingsEditor.vue",
            "components/SettingsSummary.vue",
            "components/ProvidersPanel.vue",
            "lib/settings-catalog.ts",
        ] {
            assert!(src.join(name).is_file(), "missing {name}");
        }
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(catalog.contains("dandelion.temperature"));
        assert!(catalog.contains("dandelion.maxTokens"));
        assert!(
            catalog.contains("dandelion.spec.generateMaxIterations"),
            "C16 wired"
        );
        assert!(catalog.contains("dandelion.web.timeoutMs"), "C12 wired");
        assert!(
            catalog.contains("dandelion.terminal.liveChunkBytes"),
            "C13 wired"
        );
        assert!(
            catalog.contains("dandelion.encryptApiKey"),
            "G5-I encryptApiKey wired"
        );
        assert!(
            catalog.contains("dandelion.compact.preflightEnabled"),
            "C2b wired"
        );
        let editor = std::fs::read_to_string(src.join("components/SettingsEditor.vue")).unwrap();
        assert!(editor.contains("SecurityPanel"));
        let security = std::fs::read_to_string(src.join("components/SecurityPanel.vue")).unwrap();
        assert!(security.contains("dandelion.permission.rules"));
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(store.contains("settingsPatch"), "15/17 must patch Runtime");
        assert!(store.contains("providerProbe"), "12 test is HTTP probe");
        assert!(!store.contains("/v1/chat/completions"));
    }

    #[test]
    fn g5d_frontend_has_detached_window_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(
            store.contains("sessionDetach"),
            "08 must call session_detach"
        );
        assert!(
            store.contains("window-09"),
            "occupancy surface is window-09"
        );
        assert!(!store.contains("/v1/chat/completions"));
        let sidebar = std::fs::read_to_string(src.join("components/ConversationSidebar.vue")).unwrap();
        assert!(sidebar.contains("分离为独立窗口"), "{sidebar}");
        assert!(sidebar.contains("store.detachSession"), "detach action must call the runtime");
        assert!(
            !sidebar.contains("G5-D：独立窗 occupancy"),
            "08 detach must be enabled"
        );
        let app = std::fs::read_to_string(src.join("App.vue")).unwrap();
        assert!(app.contains("detached"), "09 layout has no Dock");
        let caps = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities/default.json"),
        )
        .unwrap();
        assert!(caps.contains("win09-*"), "09 windows need IPC capability");
        let rust = include_str!("lib.rs");
        assert!(rust.contains("session_detach"));
        assert!(rust.contains("蒲公英 · 独立窗口"));
        assert!(rust.contains("transfer_session_surface"));
    }

    #[test]
    fn g5e_frontend_has_cron_memory_hooks_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        for name in [
            "components/CronPanel.vue",
            "components/MemoryPanel.vue",
            "components/HooksPanel.vue",
        ] {
            assert!(src.join(name).is_file(), "missing {name}");
        }
        let chat = std::fs::read_to_string(src.join("components/ChatPane.vue")).unwrap();
        assert!(chat.contains("stopTree") && chat.contains("viewTree"));
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(!catalog.contains("G5-E 再接线"), "20/22/23 must be wired");
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(store.contains("cronRunNow") || store.contains("runCron"));
        assert!(store.contains("saveMemory"));
        assert!(store.contains("stopTree"));
        assert!(!store.contains("/v1/chat/completions"));
        let rust = include_str!("lib.rs");
        assert!(rust.contains("cron_start_now") || rust.contains("cron_run_now"));
        assert!(rust.contains("memory_files"));
        assert!(rust.contains("children_list"));
        assert!(rust.contains("hooks_open_dir"));
    }

    #[test]
    fn g5f_frontend_has_sidecar_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        assert!(src.join("components/LocalModelsPanel.vue").is_file());
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(!catalog.contains("G5-F 再接线"), "11 must be wired");
        assert!(catalog.contains("dandelion.maxLocalConcurrency"));
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(store.contains("sidecarStart") || store.contains("startSidecar"));
        assert!(!store.contains("/v1/chat/completions"));
        let rust = include_str!("lib.rs");
        assert!(rust.contains("sidecar_start"));
        assert!(rust.contains("sidecar_kill_on_exit"));
        assert!(rust.contains("127.0.0.1"));
        let panel = std::fs::read_to_string(src.join("components/LocalModelsPanel.vue")).unwrap();
        assert!(panel.contains("添加模型") && panel.contains("MLX"));
        assert!(panel.contains("sidecar"));
    }

    #[test]
    fn g5g_frontend_has_corpus_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        assert!(src.join("components/CorpusPanel.vue").is_file());
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(!catalog.contains("G5-G 再接线"), "04 must be wired");
        assert!(catalog.contains("dandelion.corpus.chunkChars"));
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(store.contains("corpusImportPick") || store.contains("importCorpus"));
        assert!(store.contains("setCorpusIds"));
        assert!(!store.contains("/v1/chat/completions"));
        assert!(!store.contains("qdrant"));
        let rust = include_str!("lib.rs");
        assert!(rust.contains("corpus_import_pick"));
        let dock = std::fs::read_to_string(src.join("components/Dock.vue")).unwrap();
        assert!(dock.contains("知识"));
        let cfg = std::fs::read_to_string(src.join("components/TaskConfig.vue")).unwrap();
        assert!(!cfg.contains("G5-G 再接线"));
        let panel = std::fs::read_to_string(src.join("components/CorpusPanel.vue")).unwrap();
        assert!(panel.contains("上传文档"));
        assert!(panel.contains("项目理解 → 19"));
        assert!(panel.contains("openSettings('wiki')") || panel.contains("openSettings(\"wiki\")"));
        assert!(!panel.contains("disabled title=\"C17"));
    }

    #[test]
    fn g5h_frontend_has_todo_card_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let bubble = std::fs::read_to_string(src.join("components/MessageBubble.vue")).unwrap();
        assert!(
            bubble.contains("todo-card") || bubble.contains("todo-list"),
            "{bubble}"
        );
        assert!(
            bubble.contains("parseTodo") || bubble.contains("todos"),
            "{bubble}"
        );
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(catalog.contains("dandelion.todo.maxItems"));
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(!store.contains("/v1/chat/completions"));
        let dock = std::fs::read_to_string(src.join("components/Dock.vue")).unwrap();
        assert!(!dock.contains("id: \"todo\""), "todo is not a Dock switch");
    }

    #[test]
    fn g5h_frontend_has_web_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(catalog.contains("dandelion.web.timeoutMs"));
        assert!(catalog.contains("dandelion.web.searchUrl"));
        assert!(catalog.contains("联网搜索"));
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(!store.contains("/v1/chat/completions"));
        let dock = std::fs::read_to_string(src.join("components/Dock.vue")).unwrap();
        assert!(!dock.contains("id: \"web\""), "web is not a Dock switch");
        assert!(!dock.contains("web_search"));
    }

    #[test]
    fn g5h_frontend_has_live_terminal_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        assert!(src.join("components/TerminalPane.vue").is_file());
        let pane = std::fs::read_to_string(src.join("components/TerminalPane.vue")).unwrap();
        assert!(pane.contains("杀进程树"), "{pane}");
        assert!(pane.contains("关闭窗"), "{pane}");
        assert!(pane.contains("killLiveTerminal") || pane.contains("terminalKill"));
        let bubble = std::fs::read_to_string(src.join("components/MessageBubble.vue")).unwrap();
        assert!(bubble.contains("在终端打开"), "{bubble}");
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(catalog.contains("dandelion.terminal.liveChunkBytes"));
        assert!(catalog.contains("dandelion.terminal.liveFlushMs"));
        let types = std::fs::read_to_string(src.join("lib/types.ts")).unwrap();
        assert!(types.contains("terminal_update"));
        assert!(types.contains("terminal_output_chunk"));
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(store.contains("openLiveTerminal"));
        assert!(store.contains("terminalKill"));
        assert!(!store.contains("/v1/chat/completions"));
        let close = store
            .split("async function closeTab")
            .nth(1)
            .and_then(|s| s.split("async function").next())
            .unwrap_or("");
        assert!(
            !close.contains("sessionCancel"),
            "close Tab must not cancel: {close}"
        );
        let dock = std::fs::read_to_string(src.join("components/Dock.vue")).unwrap();
        assert!(
            !dock.contains("id: \"terminal\""),
            "25 is not a Dock switch"
        );
        let app = std::fs::read_to_string(src.join("App.vue")).unwrap();
        assert!(app.contains("TerminalPane"));
    }

    #[test]
    fn g5a_frontend_has_task_tree_not_second_loop() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(store.contains("sessionOccupy"), "tabs must occupy in core");
        assert!(
            store.contains("sessionDuplicate"),
            "copy must go through Runtime"
        );
        assert!(!store.contains("/v1/chat/completions"));
    }

    #[test]
    fn g5i_packaging_csp_and_no_second_backend() {
        let tauri_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf = std::fs::read_to_string(tauri_dir.join("tauri.conf.json")).unwrap();
        let windows_conf =
            std::fs::read_to_string(tauri_dir.join("tauri.windows.conf.json")).unwrap();
        let macos_conf =
            std::fs::read_to_string(tauri_dir.join("tauri.macos.conf.json")).unwrap();
        assert!(
            windows_conf.contains("\"nsis\""),
            "Windows must build one NSIS installer"
        );
        assert!(
            windows_conf.contains("g5-desktop-before-build.ps1"),
            "Windows beforeBuild copies optional dln.exe extra"
        );
        assert!(
            macos_conf.contains("darwin-before-build.sh"),
            "macOS beforeBuild copies optional dln extra"
        );
        assert!(conf.contains("\"withGlobalTauri\": false"), "{conf}");
        let csp_line = conf.lines().find(|l| l.contains("\"csp\"")).unwrap_or("");
        assert!(
            !csp_line.contains("https:"),
            "CSP must not allow https model hosts: {csp_line}"
        );
        assert!(
            !csp_line.to_lowercase().contains("openai"),
            "CSP must not allow openai: {csp_line}"
        );
        assert!(csp_line.contains("ipc:"), "{csp_line}");
        let caps = std::fs::read_to_string(tauri_dir.join("capabilities/default.json")).unwrap();
        for forbidden in ["http:", "fs:", "shell:", "sql:"] {
            assert!(
                !caps.contains(forbidden),
                "capability must not grant {forbidden}: {caps}"
            );
        }
        let rust = std::fs::read_to_string(tauri_dir.join("src/lib.rs")).unwrap();
        assert!(rust.contains("persist_main_window_geometry"));
        assert!(rust.contains("apply_main_window_geometry"));
        assert!(rust.contains("sidecar_kill_on_exit"));
        assert!(
            !rust.contains("Command::new(\"dln\")") && !rust.contains("sidecar(\"dln\")"),
            "must not spawn dln as Agent sidecar"
        );
        let src = tauri_dir.join("../src");
        let catalog = std::fs::read_to_string(src.join("lib/settings-catalog.ts")).unwrap();
        assert!(catalog.contains("dandelion.encryptApiKey"));
        assert!(rust.contains("dandelion.ui.windowWidth"));
        let store = std::fs::read_to_string(src.join("stores/session.ts")).unwrap();
        assert!(!store.contains("/v1/chat/completions"));
        let script_text =
            std::fs::read_to_string(tauri_dir.join("../../../scripts/g5-desktop-before-build.ps1"))
                .unwrap();
        assert!(script_text.contains("dandelion-cli"));
        assert!(
            script_text.contains("not an Agent sidecar"),
            "{script_text}"
        );
    }
}
