!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

!ifndef BUILD_UNINSTALLER
Var DesktopShortcutCheckbox
Var CreateDesktopShortcutChoice

!macro customInit
  StrCpy $CreateDesktopShortcutChoice ${BST_CHECKED}
!macroend

!macro customPageAfterChangeDir
  Page custom DesktopShortcutPage DesktopShortcutPageLeave
!macroend

Function DesktopShortcutPage
  !insertmacro MUI_HEADER_TEXT "Additional Tasks" "Select optional tasks for this installation."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateCheckbox} 0 8u 100% 12u "&Create a desktop shortcut"
  Pop $DesktopShortcutCheckbox

  ${If} "$CreateDesktopShortcutChoice" == "${BST_CHECKED}"
    ${NSD_Check} $DesktopShortcutCheckbox
  ${Else}
    ${NSD_Uncheck} $DesktopShortcutCheckbox
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function DesktopShortcutPageLeave
  ${NSD_GetState} $DesktopShortcutCheckbox $CreateDesktopShortcutChoice
FunctionEnd

!macro customInstall
  ${If} "$CreateDesktopShortcutChoice" != "${BST_CHECKED}"
    Delete "$newDesktopLink"
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts "false"
  ${Else}
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" KeepShortcuts "true"
  ${EndIf}
!macroend
!endif
