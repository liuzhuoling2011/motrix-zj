; NSIS installer hooks for Motrix Next.
; These macros are invoked by Tauri's NSIS template during both
; fresh installs AND silent OTA (updater) installs.

!macro NSIS_HOOK_PREINSTALL
  ; ── Migration: currentUser → both ──────────────────────────────
  ;
  ; Versions ≤ 3.6.2-beta.1 shipped with installMode "currentUser",
  ; which writes the uninstall registry entry under HKCU.
  ;
  ; Starting from 3.6.2, installMode is "both".  In silent/update
  ; mode (/S), the "both" NSIS template defaults to per-machine
  ; scope and reads HKLM — it will NOT find the old HKCU entry,
  ; causing a duplicate installation.
  ;
  ; Fix: unconditionally check HKCU for a previous per-user install.
  ; If found, strip surrounding quotes from the path and copy it
  ; into $INSTDIR so the installer overwrites the existing files
  ; in-place.
  ;
  ; Registry key: HKCU\Software\Microsoft\Windows\CurrentVersion
  ;                 \Uninstall\MotrixNext
  ; Tauri uses the productName (not identifier) as the key name.
  ; The InstallLocation value is stored WITH surrounding quotes
  ; (e.g., "C:\Users\xxx\AppData\Local\MotrixNext"), so we must
  ; strip them before assigning to $INSTDIR.
  ;
  ; This block is safe for fresh installs (key absent → no-op) and
  ; for users who already migrated (HKLM entry found by the "both"
  ; template before this hook even runs for file-copy decisions).

  ReadRegStr $R0 HKCU \
    "Software\Microsoft\Windows\CurrentVersion\Uninstall\MotrixNext" \
    "InstallLocation"
  StrCmp $R0 "" _motrix_skip_migration 0
    ; Strip surrounding quotes: "C:\path" → C:\path
    StrCpy $R1 $R0 1        ; first character
    StrCmp $R1 '"' 0 +2     ; if it starts with a quote
      StrCpy $R0 $R0 "" 1   ; remove first char
    StrLen $R1 $R0
    IntOp $R1 $R1 - 1
    StrCpy $R2 $R0 1 $R1    ; last character
    StrCmp $R2 '"' 0 +2     ; if it ends with a quote
      StrCpy $R0 $R0 $R1    ; remove last char
    StrCpy $INSTDIR $R0
    ; Sync $OUTDIR — Tauri's template calls `SetOutPath $INSTDIR`
    ; BEFORE this hook, so $OUTDIR still points to the old path.
    ; We must re-issue SetOutPath to redirect all subsequent File
    ; commands to the migrated directory.
    SetOutPath $INSTDIR
  _motrix_skip_migration:

  ; Defense-in-depth: kill any lingering sidecar before file copy.
  ; Tauri bundles externalBin as motrixnext-aria2c.exe (renamed from aria2c).
  ; aria2 is single-process — no child processes to worry about.
  ; On Windows, a running .exe is locked by the OS and cannot be overwritten.
  ; taskkill exits with code 128 if the process does not exist — harmless.
  nsExec::Exec 'taskkill /F /IM motrixnext-aria2c.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Flush Windows icon cache so updated icons appear immediately.
  ; ie4uinit.exe is a built-in Windows 10/11 system utility that
  ; soft-refreshes the shell icon display without requiring a reboot.
  ; This is the industry-standard approach used by Electron, VS Code,
  ; and other major desktop applications.
  nsExec::ExecToLog 'ie4uinit.exe -show'
!macroend
