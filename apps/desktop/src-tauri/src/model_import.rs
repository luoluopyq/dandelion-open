//! Native model folder selection; hidden caches such as .lmstudio must be visible.
use std::path::PathBuf;

#[cfg(target_os = "macos")]
pub async fn pick_mlx_folder(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::NSString;

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let result = (|| {
            let mtm = MainThreadMarker::new().ok_or("模型选择窗口必须在主线程打开")?;
            let panel = NSOpenPanel::openPanel(mtm);
            panel.setTitle(Some(&NSString::from_str("选择 MLX 模型文件夹")));
            panel.setCanChooseDirectories(true);
            panel.setCanChooseFiles(false);
            panel.setAllowsMultipleSelection(false);
            panel.setCanCreateDirectories(false);
            // Set only this panel, without changing Finder or system preferences.
            panel.setShowsHiddenFiles(true);
            if panel.runModal() != NSModalResponseOK {
                return Ok(None);
            }
            panel
                .URL()
                .and_then(|url| url.to_file_path())
                .map(Some)
                .ok_or_else(|| "无法读取所选模型文件夹的路径".to_string())
        })();
        let _ = sender.send(result);
    })
    .map_err(|err| err.to_string())?;
    receiver.await.map_err(|err| err.to_string())?
}

#[cfg(not(target_os = "macos"))]
pub async fn pick_mlx_folder(_app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    tokio::task::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .map_err(|err| err.to_string())
}
