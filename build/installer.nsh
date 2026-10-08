; Custom NSIS hooks for the Rozh Windows installer, included via
; build.nsis.include in package.json. electron-builder calls specific
; macros (if you define them) at fixed points in its generated installer
; script — this file is where you add anything beyond what electron-builder's
; own nsis config options (package.json) expose.
;
; Available hooks (define only the ones you need — leave the rest out):
;   customHeader        - runs near the very top of the script, before
;                          .onInit. Good for global directives like
;                          BrandingText (see below) and !define values.
;                          NOTE: MUI_WELCOMEPAGE_TITLE / MUI_WELCOMEPAGE_TEXT
;                          and similar MUI_*PAGE_* defines are NOT safe to
;                          set here — electron-builder's assistedInstaller.nsh
;                          has already inserted those page macros by this
;                          point, so the defines would be set too late to
;                          have any effect. If you want custom welcome/finish
;                          page text, use the customWelcomePage /
;                          customFinishPage hooks below instead.
;   customInit          - runs inside .onInit (after electron-builder's own
;                          init logic), e.g. to check prerequisites.
;   customInstall       - runs at the end of the install section, e.g. to
;                          write extra registry keys or run a post-install step.
;   customUnInstall     - runs at the end of the uninstall section.
;   customWelcomePage   - define MUI_WELCOMEPAGE_TITLE/TEXT etc. here; this
;                          hook is inserted before the welcome page macro.
;   customFinishPage    - same idea, for the finish page.
;   preInit             - runs before anything else, even .onInit setup.

!macro customHeader
  ; Small branding line shown bottom-left of every installer page.
  BrandingText "Rozh — free, open-source video encoder"
!macroend

; Example (disabled) — uncomment and edit to customize the welcome page text:
; !macro customWelcomePage
;   !define MUI_WELCOMEPAGE_TITLE "Welcome to Rozh Setup"
;   !define MUI_WELCOMEPAGE_TEXT "This will install Rozh, a free video encoder built on FFmpeg.$\r$\n$\r$\nClick Next to continue."
; !macroend

; Example (disabled) — run something extra after files are installed:
; !macro customInstall
;   ; e.g. WriteRegStr HKCU "Software\Rozh" "InstallPath" "$INSTDIR"
; !macroend
