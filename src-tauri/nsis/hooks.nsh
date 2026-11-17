; Kimochi's additions to Tauri's NSIS installer (bundle.windows.nsis.installerHooks).
;
; Uninstalling: Tauri's uninstaller has an "Also remove my Kimochi settings and data" box on its
; first page (Tauri's own "Delete the application data" box, relabelled in English.nsh and
; Japanese.nsh). It starts unticked. When it is ticked, Tauri removes the two data folders,
; %APPDATA%\dev.kimochi.app and %LOCALAPPDATA%\dev.kimochi.app (settings, the Log, sessions,
; models, engines, dictionaries in the web storage, logs). The hook below then removes what
; Kimochi keeps outside them:
;
; - %LOCALAPPDATA%\kimochi-voicehook: sentence-audio captures and the voice hook's DLL copies.
; - The Yomitan API helper's browser registrations (HKCU\Software\<browser>\NativeMessagingHosts\
;   yomitan_api), but only those that point at the helper Kimochi installed in its own data folder.
;   A helper the user installed some other way is left alone.
; - The `kimochi` command's folder (%LOCALAPPDATA%\dev.kimochi.app\bin) on the user's PATH.
;
; Nothing here runs unless the box was ticked. A silent (/S) or passive (/P) uninstall never shows
; the page, so the box stays unticked and everything is kept. An update (/UPDATE, which the
; updater passes) never removes anything, even if the box were somehow ticked.
; scripts/nsis-uninstall.test.mjs checks that Tauri's template still names the variables used here.

!macro KIMOCHI_FORGET_NATIVE_HOST BROWSER
  ReadRegStr $R0 HKCU "${BROWSER}\NativeMessagingHosts\yomitan_api" ""
  ${If} $R0 == "$LOCALAPPDATA\${BUNDLEID}\yomitan-host\yomitan_api.json"
  ${OrIf} $R0 == "$LOCALAPPDATA\${BUNDLEID}\yomitan-host\yomitan_api_firefox.json"
    DeleteRegKey HKCU "${BROWSER}\NativeMessagingHosts\yomitan_api"
    DeleteRegKey /ifempty HKCU "${BROWSER}\NativeMessagingHosts"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    ; An empty %LOCALAPPDATA% would turn these into paths at the root of a drive.
    ${If} $LOCALAPPDATA != ""
      ; The voice hook's folder, by its exact name (sentence_audio/voice_hook.rs).
      RMDir /r "$LOCALAPPDATA\kimochi-voicehook"

      ; The browsers Kimochi registers the Yomitan API helper with (reader/yomitan_host.rs).
      !insertmacro KIMOCHI_FORGET_NATIVE_HOST "Software\Google\Chrome"
      !insertmacro KIMOCHI_FORGET_NATIVE_HOST "Software\Chromium"
      !insertmacro KIMOCHI_FORGET_NATIVE_HOST "Software\BraveSoftware\Brave-Browser"
      !insertmacro KIMOCHI_FORGET_NATIVE_HOST "Software\Microsoft\Edge"
      !insertmacro KIMOCHI_FORGET_NATIVE_HOST "Software\Vivaldi"
      !insertmacro KIMOCHI_FORGET_NATIVE_HOST "Software\Mozilla"

      ; The `kimochi` command (cli/install.rs): take its folder off the user's PATH. PowerShell
      ; edits the stored value, keeping every other entry and its %VARIABLES% as they are, and
      ; only writes it back if the folder was on it. The folder is passed in the environment, so
      ; no path is quoted into the command.
      System::Call 'Kernel32::SetEnvironmentVariable(t "KIMOCHI_CLI_DIR", t "$LOCALAPPDATA\${BUNDLEID}\bin")i'
      nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $$env:KIMOCHI_CLI_DIR.TrimEnd('\'); $$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $$true); if ($$k) { $$old = [string]$$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $$all = @($$old -split ';'); $$kept = @($$all | Where-Object { $$_.Trim().TrimEnd('\') -ine $$d }); if ($$kept.Count -ne $$all.Count) { $$k.SetValue('Path', ($$kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString); [Environment]::SetEnvironmentVariable('KIMOCHI_CLI_REFRESH', $$null, 'User') }; $$k.Close() }"`
      Pop $R0
    ${EndIf}
  ${EndIf}
!macroend
