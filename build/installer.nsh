; Extra uninstall step: remove notr's "start with Windows" entry.
; Skipped when the uninstaller runs as part of an update (the new version
; re-adds the entry itself on first launch).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "notr"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "notr"
  ${endIf}
!macroend
