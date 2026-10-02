; Clean Mic installer hooks (Tauri NSIS bundler).
; After installing, offer VB-CABLE if it isn't installed yet: Clean Mic sends the clean voice
; through it so Discord, OBS, games, etc. can use it as a microphone.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToStack `powershell -NoProfile -NonInteractive -Command "if (Get-CimInstance Win32_SoundDevice | Where-Object Name -like '*VB-Audio Virtual Cable*') { exit 0 } else { exit 1 }"`
  Pop $0
  Pop $1
  ${If} $0 != 0
  ${AndIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "Clean Mic needs VB-CABLE (a free virtual audio cable) so Discord, OBS, games and other apps can use your clean voice as a microphone.$\r$\n$\r$\nInstall VB-CABLE now? Windows will ask for permission.$\r$\n$\r$\nVB-CABLE is made by VB-Audio (www.vb-cable.com). It is donationware, all participations are welcome." IDYES install_vbcable IDNO skip_vbcable
    install_vbcable:
      DetailPrint "Installing VB-CABLE..."
      ExecShellWait "runas" "$INSTDIR\vbcable\VBCABLE_Setup_x64.exe" "-i -h" SW_HIDE
      nsExec::ExecToStack `powershell -NoProfile -NonInteractive -Command "if (Get-CimInstance Win32_SoundDevice | Where-Object Name -like '*VB-Audio Virtual Cable*') { exit 0 } else { exit 1 }"`
      Pop $0
      Pop $1
      ${If} $0 == 0
        MessageBox MB_OK|MB_ICONINFORMATION "VB-CABLE is installed. If Clean Mic doesn't show $\"CABLE Input$\" right away, restart your computer.$\r$\n$\r$\nIn Discord, OBS, games, etc. choose $\"CABLE Output$\" as your microphone."
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "VB-CABLE was not installed. You can install it later from inside Clean Mic."
      ${EndIf}
    skip_vbcable:
  ${EndIf}
!macroend
