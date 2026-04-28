use crate::error::AppError;
use std::path::Path;
use tauri::{AppHandle, Manager};

const EXTENSION_DIR_NAME: &str = "chromium-mv3";

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    for entry in std::fs::read_dir(src)
        .map_err(|e| AppError::Io(format!("read_dir {src:?}: {e}")))?
    {
        let entry = entry.map_err(|e| AppError::Io(format!("read entry: {e}")))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            std::fs::create_dir_all(&to)
                .map_err(|e| AppError::Io(format!("create_dir_all {to:?}: {e}")))?;
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)
                .map_err(|e| AppError::Io(format!("copy {from:?} → {to:?}: {e}")))?;
        }
    }
    Ok(())
}

/// Materialize the bundled MV3 browser extension into the user's app data
/// directory and return its absolute path. Existing copies are replaced so
/// the user always loads the version shipped with the current app build.
///
/// The frontend then tells the user to load it via Chrome's "load unpacked"
/// developer flow — Chrome doesn't allow side-loading from disk by any
/// other path, so handing back a stable directory + opening the dialog is
/// the most we can streamline.
#[tauri::command]
pub fn install_browser_extension(app: AppHandle) -> Result<String, AppError> {
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|e| AppError::Io(format!("resource_dir: {e}")))?;
    let source = resource_root
        .join("resources")
        .join("extension")
        .join(EXTENSION_DIR_NAME);
    if !source.is_dir() {
        return Err(AppError::Io(format!(
            "bundled extension missing at {source:?}"
        )));
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("app_data_dir: {e}")))?;
    let dest = data_dir.join("browser-extension").join(EXTENSION_DIR_NAME);

    if dest.exists() {
        std::fs::remove_dir_all(&dest)
            .map_err(|e| AppError::Io(format!("clear old extension dir {dest:?}: {e}")))?;
    }
    std::fs::create_dir_all(&dest)
        .map_err(|e| AppError::Io(format!("create extension dir {dest:?}: {e}")))?;
    copy_dir_recursive(&source, &dest)?;

    log::info!("install_browser_extension: source={source:?} dest={dest:?}");
    Ok(dest.to_string_lossy().into_owned())
}
