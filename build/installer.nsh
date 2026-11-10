; Extra uninstall step: remove utilr's "start with Windows" entry.
; Skipped when the uninstaller runs as part of an update (the new version
; re-adds the entry itself on first launch).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "utilr"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "utilr"
  ${endIf}
!macroend
