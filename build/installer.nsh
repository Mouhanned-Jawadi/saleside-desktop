; ─── SaleSide custom NSIS hooks ───────────────────────────────────────────────
;
; preInit runs inside .onInit — before any installer page is shown.
; This ensures SaleSide.exe is dead before NSIS tries to overwrite its files.

!macro preInit
  nsExec::ExecToLog 'taskkill /F /IM "SaleSide.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "SaleSide Helper.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "SaleSide Helper (GPU).exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "SaleSide Helper (Renderer).exe" /T'
  Sleep 2000
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /F /IM "SaleSide.exe" /T'
  Sleep 1000
!macroend
