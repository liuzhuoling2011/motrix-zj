use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// Holds references to tray menu items for dynamic label updates (i18n).
/// Used by the `update_tray_menu_labels` command to set localized text
/// at runtime without rebuilding the menu.
pub struct TrayMenuState {
    pub items: Mutex<HashMap<String, MenuItem<tauri::Wry>>>,
}

pub fn setup_tray(app: &AppHandle) -> Result<TrayMenuState, Box<dyn std::error::Error>> {
    // Create MenuItem references for TrayMenuState (used by update_tray_menu_labels).
    // All three platforms use the same native menu — no platform-specific branching.
    let show_item = MenuItem::with_id(app, "show", "Show Motrix Next", true, None::<&str>)?;
    let new_task_item = MenuItem::with_id(app, "tray-new-task", "New Task", true, None::<&str>)?;
    let resume_all_item =
        MenuItem::with_id(app, "tray-resume-all", "Resume All", true, None::<&str>)?;
    let pause_all_item =
        MenuItem::with_id(app, "tray-pause-all", "Pause All", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;

    // Clone items before moving into the HashMap — the menu needs the originals,
    // while the HashMap is used for dynamic label updates.
    let mut items_map: HashMap<String, MenuItem<tauri::Wry>> = HashMap::new();
    items_map.insert("show".to_string(), show_item.clone());
    items_map.insert("tray-new-task".to_string(), new_task_item.clone());
    items_map.insert("tray-resume-all".to_string(), resume_all_item.clone());
    items_map.insert("tray-pause-all".to_string(), pause_all_item.clone());
    items_map.insert("tray-quit".to_string(), quit_item.clone());

    // Build the native OS menu — unified for macOS, Windows, and Linux.
    let menu = Menu::with_items(
        app,
        &[
            &show_item,
            &PredefinedMenuItem::separator(app)?,
            &new_task_item,
            &resume_all_item,
            &pause_all_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let _tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray-icon.png"
        ))?)
        .on_tray_icon_event(|tray, event| {
            // Left-click: show main window (macOS and Windows).
            // Linux libappindicator does not emit TrayIconEvent::Click —
            // the "Show" menu item serves as the equivalent on Linux.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                #[cfg(target_os = "macos")]
                {
                    use tauri::ActivationPolicy;
                    let _ = app.set_activation_policy(ActivationPolicy::Regular);
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "show" => {
                    #[cfg(target_os = "macos")]
                    {
                        use tauri::ActivationPolicy;
                        let _ = app.set_activation_policy(ActivationPolicy::Regular);
                    }
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "tray-new-task" | "tray-resume-all" | "tray-pause-all" => {
                    // Emit to frontend — MainLayout.vue handles these via
                    // the existing tray-menu-action listener.
                    let action = event
                        .id
                        .as_ref()
                        .strip_prefix("tray-")
                        .unwrap_or(event.id.as_ref());
                    let _ = app.emit("tray-menu-action", action);
                }
                "tray-quit" => {
                    // Emit to Vue for consistent exit sequence (animation + cleanup).
                    // handleExitConfirm() in MainLayout.vue calls exit(0) after
                    // the closing animation completes.
                    let _ = app.emit("tray-menu-action", "quit");
                }
                _ => {}
            }
        })
        .build(app)?;

    Ok(TrayMenuState {
        items: Mutex::new(items_map),
    })
}
