use crate::error::AppError;
use crate::services::http_api;

/// Restart the embedded HTTP API server on a new port.
///
/// Called by the frontend when the user changes `extensionApiPort` in
/// Advanced settings and confirms the port-switch dialog.  The old server
/// is stopped before binding the new port.
#[tauri::command]
pub async fn restart_http_api(app: tauri::AppHandle, port: u16) -> Result<(), AppError> {
    http_api::restart_on_port(&app, port).await
}
