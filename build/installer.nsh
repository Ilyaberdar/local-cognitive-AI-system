; Opens the shipped sandbox folder (the helper and its Node) to the sandbox's tools capability, once, at
; install time. The app also does this when it starts, which covers a per-user install (perMachine:
; false), where the install folder is the user's and writable; it is here as well so that a per-machine
; install, whose folder a normal user cannot change, is set up by the elevated installer instead.
!macro customInstall
  nsExec::Exec '"$INSTDIR\resources\sandbox\win32-x64\lc-sandbox.exe" grant-tools "$INSTDIR\resources\sandbox\win32-x64"'
!macroend

; The uninstaller removes the Synthesis sandbox's AppContainer profile (the app creates it the first
; time a run uses the sandbox). A missing or already-removed profile is not an error.
!macro customUnInstall
  nsExec::Exec '"$INSTDIR\resources\sandbox\win32-x64\lc-sandbox.exe" uninstall'
!macroend
