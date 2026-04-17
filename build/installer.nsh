; ─── SaleSide custom NSIS hooks ───────────────────────────────────────────────
;
; preInit runs inside .onInit — before any installer page is shown.
; We send a graceful WM_CLOSE signal (no /F force-kill, no /T tree-kill)
; so the app can clean up before files are overwritten.
; Running "SaleSide.exe --quit" first lets the app quit itself cleanly
; when it was launched with that flag (see main.js --quit handler).

!macro preInit
  ; Ask any running instance to quit gracefully via the --quit flag.
  ; If the app is not installed yet this is a no-op.
  nsExec::ExecToLog '"SaleSide.exe" --quit'
  Sleep 1500
  ; Send a polite close signal to any remaining Electron helper windows.
  ; No /F (force) or /T (tree-kill) — those flags trigger AV heuristics.
  nsExec::ExecToLog 'taskkill /IM "SaleSide.exe"'
  nsExec::ExecToLog 'taskkill /IM "SaleSide Helper.exe"'
  nsExec::ExecToLog 'taskkill /IM "SaleSide Helper (GPU).exe"'
  nsExec::ExecToLog 'taskkill /IM "SaleSide Helper (Renderer).exe"'
  Sleep 1500
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'taskkill /IM "SaleSide.exe"'
  Sleep 1000
!macroend
