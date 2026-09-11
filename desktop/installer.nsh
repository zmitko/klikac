!macro customInit
  nsExec::Exec 'taskkill /F /IM "Klikač.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Klikac.exe" /T'
  Sleep 400
!macroend

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall add rule name="Klikac" dir=in action=allow protocol=TCP localport=1883,18080,18232 profile=any'
!macroend
