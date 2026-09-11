!macro customInit
  nsExec::Exec 'taskkill /F /IM "Klikač.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Klikac.exe" /T'
  Sleep 400
!macroend
