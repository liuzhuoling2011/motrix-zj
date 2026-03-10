; NSIS installer hooks for Motrix Next.
; These macros are invoked by Tauri's NSIS template during both
; fresh installs AND silent OTA (updater) installs.

!macro NSIS_HOOK_POSTINSTALL
  ; Flush Windows icon cache so updated icons appear immediately.
  ; ie4uinit.exe is a built-in Windows 10/11 system utility that
  ; soft-refreshes the shell icon display without requiring a reboot.
  ; This is the industry-standard approach used by Electron, VS Code,
  ; and other major desktop applications.
  nsExec::ExecToLog 'ie4uinit.exe -show'
!macroend
