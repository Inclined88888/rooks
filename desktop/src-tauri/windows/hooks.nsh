; Rooks: what its per-user Windows setup adds to Tauri's NSIS installer (design 0011, section 4).
;
; Tauri includes this file near the top of its installer.nsi, before its pages, so the define below reaches the finish
; page, and inserts the NSIS_HOOK_* macros at the start and end of its Install and Uninstall sections.
;
; - A desktop shortcut only when the person asks: the finish page's box starts unticked, and a silent or passive
;   install (IT, Intune, a script) makes one only with /DESKTOP. A shortcut the person already had is kept.
; - Uninstall removes everything the setup and the app added for the program itself: the program folder, the Start
;   menu entry, the uninstall entry and the aiworkspace link handler (Tauri's own steps), the autostart value (Tauri),
;   the window's WebView2 data and the logs, the key where the setup remembered the folder, and copies of the sidecar
;   it unpacked into the temporary folder when the app was ended before it could tidy them.
; - The person's chats, keys and Room stay unless they tick "Also remove my chats, keys and the Room" (or the
;   uninstaller is run with /CLEANDATA, which CI uses). Then the app first deletes its Credential Manager entries
;   (workbench-server.exe --forget-secrets) and its data folders go. Tools another installer put in
;   %USERPROFILE%\.ai-workspace\bin are not the app's and are kept.

!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED

Var RooksHadDesktopLink
Var RooksCleanData

; Copies of the one-file sidecar left in %TEMP%\_MEI* (only ours: they hold the app's own pack folder).
Function un.RooksTidyTemp
  FindFirst $0 $1 "$TEMP\_MEI*"
  rooks_tidy_loop:
    StrCmp $1 "" rooks_tidy_done
    IfFileExists "$TEMP\$1\app\packs\bundles\*.*" 0 rooks_tidy_next
      RMDir /r "$TEMP\$1"
    rooks_tidy_next:
    FindNext $0 $1
    Goto rooks_tidy_loop
  rooks_tidy_done:
  FindClose $0
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  StrCpy $RooksHadDesktopLink 0
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    StrCpy $RooksHadDesktopLink 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Tauri makes a desktop shortcut on every silent or passive install, because those skip the finish page where the
  ; person would be asked. Rooks makes one there only when /DESKTOP is given.
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${If} $RooksHadDesktopLink = 0
      ClearErrors
      ${GetOptions} $CMDLINE "/DESKTOP" $R0
      ${If} ${Errors}
        Delete "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  StrCpy $RooksCleanData 0
  ${If} $DeleteAppDataCheckboxState = 1
    StrCpy $RooksCleanData 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/CLEANDATA" $R0
  ${IfNot} ${Errors}
    StrCpy $RooksCleanData 1
    StrCpy $DeleteAppDataCheckboxState 1 ; Tauri's own removal of the app's data folders runs too
  ${EndIf}
  ${If} $UpdateMode = 1
    StrCpy $RooksCleanData 0
  ${EndIf}
  ; The sidecar ends with the app (it is in the app's job), but a copy left running would keep its file in use.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\workbench-server.exe" "${PRODUCTNAME}"
  ${If} $RooksCleanData = 1
    ; the app's Credential Manager entries, while the program that knows them is still here
    nsExec::Exec '"$INSTDIR\workbench-server.exe" --forget-secrets'
    Pop $0
    DetailPrint "Saved keys removed from Windows ($0)"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    SetShellVarContext current
    ; the window's WebView2 data and the app's logs
    RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
    ; where the setup remembered the program folder and its language
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
    Call un.RooksTidyTemp
    ${If} $RooksCleanData = 1
      RMDir /r "$APPDATA\${BUNDLEID}"
      RMDir /r "$APPDATA\ai-workspace"
      RMDir /r "$PROFILE\.ai-workspace\try-room"
      Delete "$PROFILE\.ai-workspace\appearance.json"
      RMDir "$PROFILE\.ai-workspace" ; only when nothing else is in it
    ${EndIf}
  ${EndIf}
!macroend
