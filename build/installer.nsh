; The uninstaller removes the Synthesis sandbox's AppContainer profile (the app creates it the first
; time a run uses the sandbox). A missing or already-removed profile is not an error.
!macro customUnInstall
  nsExec::Exec '"$INSTDIR\resources\sandbox\win32-x64\lc-sandbox.exe" uninstall'
!macroend
