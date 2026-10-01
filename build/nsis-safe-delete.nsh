; ===========================================================================
; youtubetv-for-windows - reparse-safe removal of the machine data tree
; ===========================================================================
;
; WHY THIS FILE EXISTS
; --------------------
; `RMDir /r` dispatches to NSIS's own `myDelete` walk
; (Source/exehead/exec.c:642-649 -> Source/exehead/util.c:229-234), which
; classifies every child with `fd.dwFileAttributes &
; FILE_ATTRIBUTE_DIRECTORY` and recurses on a match. It never tests
; `FILE_ATTRIBUTE_REPARSE_POINT` (0x400), and `RMDir` accepts no switch that
; would make it (Source/script.cpp:3596-3617), so a directory junction is
; taken for a plain subdirectory and the walk enumerates the TARGET's
; children. The machine data root is writable by BUILTIN\Users by design and
; `mklink /J` needs no privilege, so an elevated uninstaller running
; `RMDir /r` deletes through a link an unprivileged local user planted.
;
; THE MECHANISM
; -------------
; Nothing here is ever removed by path. Every object is reached through a
; HANDLE opened with FILE_FLAG_OPEN_REPARSE_POINT, and every decision is read
; from `GetFileInformationByHandle` on that handle - never from
; `GetFileAttributesW`, which re-resolves the name and would be the very
; TOCTOU hole this file exists to remove. The walk is:
;
;   1. VALIDATE the root. It must be an absolute local-drive path: one
;      character, a colon, a separator. That shape is what refuses a UNC
;      lead, a device namespace lead and every relative or drive-relative
;      lead, because none of them has a colon in second position. Its
;      deepest separator must sit at index 3 or beyond, so the removal root
;      is always at least BASE\DIRECTORY, the drive root is always a pinned
;      ancestor and never the target, and the parent-prefix arithmetic below
;      stays honest. Every component must be non-empty, must not end in a
;      space or a dot, and must not carry a colon or a forward slash. The
;      trailing space/dot rule also refuses "." and "..", which the Win32
;      parser resolves against the CURRENT directory and which would
;      silently break the prefix chain the handles are pinning.
;   2. PIN every ancestor. Each component from the drive root through the
;      root's parent is opened no-follow and must report
;      FILE_ATTRIBUTE_DIRECTORY without FILE_ATTRIBUTE_REPARSE_POINT. Those
;      handles are held for the whole walk, so no name is re-resolved while
;      one of its components could be swapped underneath it. Ancestors are
;      opened for PINNING ONLY and are never disposed: ProgramData itself
;      must survive this walk even when the removal root is something below
;      it. An ancestor junction is a REFUSAL, reported exactly like a lock.
;   3. WALK the tree. Every child is enumerated by NAME only, then opened
;      no-follow with DELETE|FILE_READ_ATTRIBUTES and share 1, and its kind
;      is read back from that handle. A reparse point is disposed as a link
;      and NEVER enumerated - that single rule is the whole point of this
;      file. A real directory is walked and then disposed. Anything else is
;      disposed.
;   4. DISPOSE by handle. `SetFileInformationByHandle` with
;      `FileDispositionInfo` (class 4, one payload byte) is issued while the
;      handle is STILL OPEN, and only then is the handle closed. Closing
;      first and re-opening by name would hand the name back to the resolver
;      in the window between the two, which is the race the handle-pinned
;      design removes. `DeleteFile`, `RMDir` and `Remove-Item` are never
;      used: all three resolve the name themselves.
;
;   A directory's children are collected onto the NSIS stack and the search
;   handle is closed BEFORE the first removal, so the walk never mutates a
;   directory it is enumerating and never nests two `FindFirst` searches.
;
; FAIL CLOSED
; -----------
; A malformed root, an ancestor junction, a failed disposition, or any other
; unexpected condition records `$ytvwSafeFailure`, stops the walk, and leaves
; the caller to show its bilingual message and abort. Only two outcomes are
; tolerated: a clean removal, and an ABSENT tree. An absent drive root, an
; absent parent, or an absent target (Win32 error 2 or 3) is a no-op, and a
; child that vanishes mid-walk (error 2 or 3) is skipped. An absent
; INTERMEDIATE ancestor is a failure, because the path is then not the one
; that was validated. An open that fails with any other error - a lock, a
; denial - is a failure too: the walk never assumes a failure is harmless.
;
; TRANSPORT (measured against this toolchain, not inferred)
; -------------------------------------------------------
; The `System::Call` spellings below were exercised on NSIS 3.0.4.1 with the
; x86-unicode System.dll before they were written down. Two results are
; load-bearing and easy to get wrong:
;
;   * `p .r0 ?e` leaves the handle in a register and pushes GetLastError, so
;     the error is read with `Pop`. A missing file is handle -1 / error 2
;     and a missing parent is handle -1 / error 3.
;   * `SetFileInformationByHandle` reports a stale GetLastError even on
;     SUCCESS (80, ERROR_FILE_EXISTS, in the measurement). Its return value
;     is therefore the only success signal, and its `?e` result is discarded
;     rather than tested.
;
; ENCODING: UTF-8 WITH BOM (EF BB BF), like build/nsis.include, so makensis
; reads this file as UTF-8 rather than as ACP.
; ===========================================================================

!ifdef BUILD_UNINSTALLER

!ifndef YTVW_NSIS_SAFE_DELETE_GUARD
!define YTVW_NSIS_SAFE_DELETE_GUARD

; Already provided by installer.nsi (MUI2) and by every standalone harness;
; included again so this file stands on its own. LogicLib guards on LOGICLIB.
!include "LogicLib.nsh"

; ---------------------------------------------------------------------------
; Win32 values, spelled out so the transport reads the same here as it did in
; the measurement. Nothing below is allowed to be "improved" without a new
; measurement.
; ---------------------------------------------------------------------------
!define YTVW_SD_ATTRIBUTE_DIRECTORY 0x10
!define YTVW_SD_ATTRIBUTE_REPARSE_POINT 0x400
; DELETE (0x10000) | FILE_READ_ATTRIBUTES (0x80)
!define YTVW_SD_ACCESS 0x10080
; FILE_READ_ATTRIBUTES alone, for the ancestors. They are pinned and verified
; and never disposed, so they never need DELETE - and asking for DELETE would
; hand the walk the right to remove ProgramData itself, which is exactly the
; capability this design exists to withhold.
!define YTVW_SD_ACCESS_PINNED 0x80
!define YTVW_SD_SHARE_READ 1
!define YTVW_SD_OPEN_EXISTING 3
; FILE_FLAG_BACKUP_SEMANTICS (0x02000000) | FILE_FLAG_OPEN_REPARSE_POINT
; (0x00200000). BACKUP_SEMANTICS is what lets a directory be opened at all.
!define YTVW_SD_NO_FOLLOW 0x02200000
!define YTVW_SD_DISPOSITION_CLASS 4
!define YTVW_SD_INFO_BYTES 52
!define YTVW_SD_DISPOSITION_BYTES 1
!define YTVW_SD_ERROR_FILE_NOT_FOUND 2
!define YTVW_SD_ERROR_PATH_NOT_FOUND 3


; ---------------------------------------------------------------------------
; State shared by the walk. NSIS registers are global to the whole script, so
; every function pushes and pops the registers it uses and passes everything
; else through these.
; ---------------------------------------------------------------------------
Var ytvwSafeRoot          ; the tree to remove, as the caller spelled it
Var ytvwSafeParent        ; root minus its last component
Var ytvwSafePrefix        ; the prefix being built, one component at a time
Var ytvwSafeRest          ; the part of the prefix not decomposed yet
Var ytvwSafeAfter         ; the part of Rest that follows the current component
Var ytvwSafeComp          ; the component under inspection
Var ytvwSafeChar          ; one character at a time
Var ytvwSafeIndex         ; forward scan cursor
Var ytvwSafeSep           ; index of the separator, -1 when there is none
Var ytvwSafeCut           ; index of the deepest separator in the root
Var ytvwSafeReject        ; why a component or the root was refused
Var ytvwSafeInfoBuf       ; BY_HANDLE_FILE_INFORMATION
Var ytvwSafeDispBuf       ; FILE_DISPOSITION_INFO
Var ytvwSafeState         ; 0 pinned, 2/3 absent, anything else refused
Var ytvwSafePinnedCount   ; ancestor handles currently on the stack
Var ytvwSafePinnedRole    ; 0 intermediate, 1 drive root, 2 deepest ancestor
Var ytvwSafePinHandle     ; the successful pin, pushed after register restoration
Var ytvwSafePinLength     ; length of the remaining ancestor path
Var ytvwSafeAbsent        ; 1 once the tree is known not to be there
Var ytvwSafeFailure       ; "" while healthy, else why the walk stopped
Var ytvwSafeEntry         ; the full path of the entry being removed
Var ytvwSafeDir           ; the directory whose children are being collected
Var ytvwSafeName          ; one collected child name
Var ytvwSafeFindHandle    ; the FindFirst handle
Var ytvwSafeFindName      ; the FindFirst name output

; ---------------------------------------------------------------------------
; YTVWRemoveDataTree - the public entry point.
;   NSIS's `Call` takes no arguments, so the tree to remove is pushed and the
;   callee consumes it. `un.YTVWRemoveDataTree` reports its outcome through
;   `$ytvwSafeFailure` (empty on success and on an absent tree) because a
;   Function cannot set the NSIS error flag for its caller.
; ---------------------------------------------------------------------------
!macro YTVWRemoveDataTree root
  Push "${root}"
  Call un.YTVWRemoveDataTree
!macroend

; ---------------------------------------------------------------------------
; un.YTVWRemoveDataTree - the orchestrator.
;   The tree to remove is the caller's pushed argument, consumed here. The
;   ancestors are pinned onto the NSIS stack and released here, so the walk
;   itself never has to unwind them.
; ---------------------------------------------------------------------------
Function un.YTVWRemoveDataTree
  Pop $ytvwSafeRoot
  Push $0
  Push $1
  Push $2
  Push $3

  ; Every variable this walk can read is written here, so none of them can be
  ; read before it is set and NSIS warning 6001 stays satisfied.
  StrCpy $ytvwSafeParent ""
  StrCpy $ytvwSafePrefix ""
  StrCpy $ytvwSafeRest ""
  StrCpy $ytvwSafeAfter ""
  StrCpy $ytvwSafeComp ""
  StrCpy $ytvwSafeChar ""
  StrCpy $ytvwSafeReject ""
  StrCpy $ytvwSafeEntry ""
  StrCpy $ytvwSafeDir ""
  StrCpy $ytvwSafeName ""
  StrCpy $ytvwSafeFindHandle ""
  StrCpy $ytvwSafeFindName ""
  StrCpy $ytvwSafeState 0
  StrCpy $ytvwSafePinnedCount 0
  StrCpy $ytvwSafePinnedRole 0
  StrCpy $ytvwSafePinHandle ""
  StrCpy $ytvwSafePinLength 0
  StrCpy $ytvwSafeAbsent 0
  StrCpy $ytvwSafeFailure ""

  ; BY_HANDLE_FILE_INFORMATION is written by the kernel through the pointer,
  ; so it has to be real memory. 52 bytes is the packed field count: the
  ; FILETIME members sit unaligned inside it, which is why only offset 0
  ; (dwFileAttributes) is ever read back and why the measurement accepted
  ; this size.
  System::Alloc ${YTVW_SD_INFO_BYTES}
  Pop $ytvwSafeInfoBuf
  ; FILE_DISPOSITION_INFO is a single BOOLEAN. TRUE, i.e. 1, is "delete".
  System::Alloc ${YTVW_SD_DISPOSITION_BYTES}
  Pop $ytvwSafeDispBuf
  System::Call '*$ytvwSafeDispBuf(&i1 1)'

  Call un.YTVWValidateRoot
    ${If} $ytvwSafeFailure == ""
  ${AndIf} $ytvwSafeAbsent == 0
    Call un.YTVWPinAncestors
  ${EndIf}
  ${If} $ytvwSafeFailure == ""
  ${AndIf} $ytvwSafeAbsent == 0
    StrCpy $ytvwSafeEntry $ytvwSafeRoot
    Call un.YTVWDeleteEntry
  ${EndIf}

  ; Release the pins, whatever happened above. The recursion is balanced, so
  ; the top of the stack is the last pin; each is closed exactly once and the
  ; drive root is never among them because it is only ever pinned.
  StrCpy $0 $ytvwSafePinnedCount
ytvwSafeRelease:
  ${If} $0 < 1
    Goto ytvwSafeReleased
  ${EndIf}
  Pop $1
  System::Call 'kernel32::CloseHandle(p r1) i .r2'
  IntOp $0 $0 - 1
  IntOp $ytvwSafePinnedCount $ytvwSafePinnedCount - 1
  Goto ytvwSafeRelease
ytvwSafeReleased:
  System::Free $ytvwSafeInfoBuf
  System::Free $ytvwSafeDispBuf
  StrCpy $ytvwSafeInfoBuf ""
  StrCpy $ytvwSafeDispBuf ""

  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------------------
; un.YTVWValidateComponent - one path component.
;   A component the walk cannot decompose the way it assumes is refused here,
;   before any handle is opened for it.
; ---------------------------------------------------------------------------
Function un.YTVWValidateComponent
  Push $0
  Push $1
  StrCpy $ytvwSafeReject ""
  ${If} $ytvwSafeComp == ""
    StrCpy $ytvwSafeReject "the machine root has an empty path component"
    Goto ytvwSafeComponentDone
  ${EndIf}
  StrLen $0 $ytvwSafeComp
  IntOp $1 $0 - 1
  StrCpy $ytvwSafeChar $ytvwSafeComp 1 $1
  ${If} $ytvwSafeChar == " "
    StrCpy $ytvwSafeReject "a path component ends in a space"
    Goto ytvwSafeComponentDone
  ${EndIf}
  ; A component ending in a dot covers "." and ".." as well: the Win32 parser
  ; drops trailing dots and resolves those two against the current directory,
  ; either of which would desynchronise the prefix chain from the real name.
  ${If} $ytvwSafeChar == "."
    StrCpy $ytvwSafeReject "a path component ends in a dot"
    Goto ytvwSafeComponentDone
  ${EndIf}
  StrCpy $ytvwSafeIndex 0
ytvwSafeComponentScan:
  ${If} $ytvwSafeIndex >= $0
    Goto ytvwSafeComponentDone
  ${EndIf}
  StrCpy $ytvwSafeChar $ytvwSafeComp 1 $ytvwSafeIndex
  ${If} $ytvwSafeChar == ":"
    StrCpy $ytvwSafeReject "a path component carries a colon"
    Goto ytvwSafeComponentDone
  ${EndIf}
  ${If} $ytvwSafeChar == "/"
    StrCpy $ytvwSafeReject "a path component carries a forward slash"
    Goto ytvwSafeComponentDone
  ${EndIf}
  IntOp $ytvwSafeIndex $ytvwSafeIndex + 1
  Goto ytvwSafeComponentScan
ytvwSafeComponentDone:
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------------------
; un.YTVWValidateRoot - the shape of the removal root.
;   Produces `$ytvwSafeParent`, the deepest ancestor that will be pinned.
; ---------------------------------------------------------------------------
Function un.YTVWValidateRoot
  Push $0
  Push $1
  StrCpy $ytvwSafeReject ""
  StrCpy $ytvwSafeParent ""

  ; One character, a colon, a separator. A UNC lead, a device namespace lead
  ; and a relative lead all fail one of these three tests.
  ;
  ; MEASURED `StrCpy` CONTRACT in this toolchain, because it is the opposite of
  ; what the manual's "offset, length" wording suggests: the four-argument form
  ; is `StrCpy dest src LENGTH OFFSET`, and a length of 0 or "" means "to the
  ; end of the string". `StrCpy d s 1 0` is the character at index 0, which is
  ; what the three probes below ask for.
  StrLen $0 $ytvwSafeRoot
  ${If} $0 < 4
    StrCpy $ytvwSafeReject "the machine root is not an absolute drive path"
    Goto ytvwSafeRootDone
  ${EndIf}
  StrCpy $1 $ytvwSafeRoot 1 0
  ${If} $1 == ":"
    StrCpy $ytvwSafeReject "the machine root has no drive designator"
    Goto ytvwSafeRootDone
  ${EndIf}
  ${If} $1 == "\"
    StrCpy $ytvwSafeReject "the machine root has no drive designator"
    Goto ytvwSafeRootDone
  ${EndIf}
  StrCpy $1 $ytvwSafeRoot 1 1
  ${If} $1 != ":"
    StrCpy $ytvwSafeReject "the machine root has no drive colon"
    Goto ytvwSafeRootDone
  ${EndIf}
  StrCpy $1 $ytvwSafeRoot 1 2
  ${If} $1 != "\"
    StrCpy $ytvwSafeReject "the machine root is drive-relative"
    Goto ytvwSafeRootDone
  ${EndIf}

  ; The deepest separator splits the target from the parent. Requiring it at
  ; index 3 or beyond keeps the removal root at least BASE\DIRECTORY, so the
  ; drive root can only ever be a pinned ancestor and the parent prefix is a
  ; real path rather than a bare "C:".
  StrCpy $ytvwSafeCut -1
  StrCpy $ytvwSafeIndex $0
ytvwSafeRootScan:
  ${If} $ytvwSafeIndex < 0
    Goto ytvwSafeRootCut
  ${EndIf}
  StrCpy $1 $ytvwSafeRoot 1 $ytvwSafeIndex
  ${If} $1 == "\"
    StrCpy $ytvwSafeCut $ytvwSafeIndex
    Goto ytvwSafeRootCut
  ${EndIf}
  IntOp $ytvwSafeIndex $ytvwSafeIndex - 1
  Goto ytvwSafeRootScan
ytvwSafeRootCut:
  ${If} $ytvwSafeCut < 3
    StrCpy $ytvwSafeReject "the machine root is not a directory below a base directory"
    Goto ytvwSafeRootDone
  ${EndIf}
  StrCpy $ytvwSafeParent $ytvwSafeRoot $ytvwSafeCut 0

ytvwSafeRootDone:
  ${If} $ytvwSafeReject != ""
    StrCpy $ytvwSafeFailure $ytvwSafeReject
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------------------
; un.YTVWOpenPinned - open one path no-follow and refuse anything that is not
;   a plain directory.
;   The path is `$ytvwSafeEntry`. On success the handle joins the stack and
;   `$ytvwSafePinnedCount` grows; `$ytvwSafeState` is 0, 2, 3 or a refusal, and
;   a refusal has already been recorded in `$ytvwSafeFailure`.
; ---------------------------------------------------------------------------
Function un.YTVWOpenPinned
  Push $0
  Push $1
  Push $2
  Push $3
  System::Call 'kernel32::CreateFileW(w "$ytvwSafeEntry", i ${YTVW_SD_ACCESS_PINNED}, i ${YTVW_SD_SHARE_READ}, p 0, i ${YTVW_SD_OPEN_EXISTING}, i ${YTVW_SD_NO_FOLLOW}, p 0) p .r0 ?e'
  Pop $1
  ${If} $0 == -1
    StrCpy $ytvwSafeState $1
    ; Not-found is not a refusal here: the caller decides whether an absent
    ; component means an absent tree or a path that is not the one it
    ; validated.
    ${If} $1 == ${YTVW_SD_ERROR_FILE_NOT_FOUND}
    ${OrIf} $1 == ${YTVW_SD_ERROR_PATH_NOT_FOUND}
          ${Else}
      StrCpy $ytvwSafeFailure "an ancestor of the machine root could not be opened"
          ${EndIf}
    Goto ytvwSafeOpenPinnedDone
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r0, p $ytvwSafeInfoBuf) i .r2 ?e'
  Pop $3
  ${If} $2 == 0
    System::Call 'kernel32::CloseHandle(p r0) i .r3'
    StrCpy $ytvwSafeState 1
    StrCpy $ytvwSafeFailure "an ancestor of the machine root could not be inspected"
    Goto ytvwSafeOpenPinnedDone
  ${EndIf}
  System::Call '*$ytvwSafeInfoBuf(i .r2)'
  IntOp $3 $2 & ${YTVW_SD_ATTRIBUTE_REPARSE_POINT}
  ${If} $3 != 0
    System::Call 'kernel32::CloseHandle(p r0) i .r3'
    StrCpy $ytvwSafeState 1
    StrCpy $ytvwSafeFailure "an ancestor of the machine root is a reparse point, so it was left alone"
    Goto ytvwSafeOpenPinnedDone
  ${EndIf}
  IntOp $3 $2 & ${YTVW_SD_ATTRIBUTE_DIRECTORY}
  ${If} $3 == 0
    System::Call 'kernel32::CloseHandle(p r0) i .r3'
    StrCpy $ytvwSafeState 1
    StrCpy $ytvwSafeFailure "an ancestor of the machine root is not a directory, so it was left alone"
    Goto ytvwSafeOpenPinnedDone
  ${EndIf}
  StrCpy $ytvwSafePinHandle $0
  IntOp $ytvwSafePinnedCount $ytvwSafePinnedCount + 1
  StrCpy $ytvwSafeState 0
ytvwSafeOpenPinnedDone:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  ${If} $ytvwSafeState == 0
    Push $ytvwSafePinHandle
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
; un.YTVWJudgePin - decide whether a failed pin means "absent tree" or
;   "something is wrong".
;   The drive root and the deepest ancestor are allowed to be absent: an
;   absent drive, an absent parent and an absent tree all mean there is
;   nothing to remove. An INTERMEDIATE ancestor that is absent means the path
;   is not the one that was validated, so the walk refuses.
; ---------------------------------------------------------------------------
Function un.YTVWJudgePin
  Push $0
  ${If} $ytvwSafeState == 0
    Goto ytvwSafeJudgePinDone
  ${EndIf}
  ${If} $ytvwSafeState == ${YTVW_SD_ERROR_FILE_NOT_FOUND}
  ${OrIf} $ytvwSafeState == ${YTVW_SD_ERROR_PATH_NOT_FOUND}
    ${If} $ytvwSafePinnedRole != 0
      StrCpy $ytvwSafeAbsent 1
      Goto ytvwSafeJudgePinDone
    ${EndIf}
  ${EndIf}
  ; Anything else has already been recorded in `$ytvwSafeFailure`.
ytvwSafeJudgePinDone:
  Pop $0
FunctionEnd

; ---------------------------------------------------------------------------
; un.YTVWPinAncestors - open every component from the drive root through the
;   root's parent, no-follow, and hold all of them for the whole walk.
;   Ancestors are pinned and verified only; this function never disposes one.
; ---------------------------------------------------------------------------
Function un.YTVWPinAncestors
  ; The prefix carries no trailing separator, so the walk below can append
  ; "COMPONENT" to it and get "DRIVE:\COMPONENT". The drive root is pinned
  ; first, with the separator added just for that one open.
  StrCpy $ytvwSafePrefix $ytvwSafeRoot 2 0
  StrCpy $ytvwSafeRest $ytvwSafeParent "" 3

  ; The drive root is always the first pin, so a not-found drive is a no-op
  ; rather than a failure.
  StrCpy $ytvwSafeEntry "$ytvwSafePrefix\"
  StrCpy $ytvwSafePinnedRole 1
  Call un.YTVWOpenPinned
  Call un.YTVWJudgePin
    ${If} $ytvwSafeFailure != ""
    Goto ytvwSafePinDone
  ${EndIf}
  ${If} $ytvwSafeAbsent == 1
    Goto ytvwSafePinDone
  ${EndIf}

ytvwSafePinWalk:
  ; Take the next component off Rest: everything up to the first separator, or
  ; all of Rest when there is none.
  StrLen $ytvwSafePinLength $ytvwSafeRest
  StrCpy $ytvwSafeSep -1
  StrCpy $ytvwSafeIndex 0
ytvwSafePinScan:
  ${If} $ytvwSafeIndex >= $ytvwSafePinLength
    Goto ytvwSafePinComponent
  ${EndIf}
  StrCpy $ytvwSafeChar $ytvwSafeRest 1 $ytvwSafeIndex
  ${If} $ytvwSafeChar == "\"
    StrCpy $ytvwSafeSep $ytvwSafeIndex
    Goto ytvwSafePinComponent
  ${EndIf}
  IntOp $ytvwSafeIndex $ytvwSafeIndex + 1
  Goto ytvwSafePinScan

ytvwSafePinComponent:
  ${If} $ytvwSafeSep == -1
    StrCpy $ytvwSafeComp $ytvwSafeRest
    StrCpy $ytvwSafeAfter ""
  ${Else}
    StrCpy $ytvwSafeComp $ytvwSafeRest $ytvwSafeSep 0
    IntOp $ytvwSafeIndex $ytvwSafeSep + 1
    StrCpy $ytvwSafeAfter $ytvwSafeRest "" $ytvwSafeIndex
  ${EndIf}
  Call un.YTVWValidateComponent
  ${If} $ytvwSafeReject != ""
    StrCpy $ytvwSafeFailure $ytvwSafeReject
    Goto ytvwSafePinDone
  ${EndIf}
  StrCpy $ytvwSafePrefix "$ytvwSafePrefix\$ytvwSafeComp"
  StrCpy $ytvwSafeEntry $ytvwSafePrefix
  StrCpy $ytvwSafePinnedRole 0
  ${If} $ytvwSafePrefix == $ytvwSafeParent
    StrCpy $ytvwSafePinnedRole 2
  ${EndIf}
  Call un.YTVWOpenPinned
  Call un.YTVWJudgePin
    ${If} $ytvwSafeFailure != ""
    Goto ytvwSafePinDone
  ${EndIf}
  ${If} $ytvwSafeAbsent == 1
    Goto ytvwSafePinDone
  ${EndIf}
  ${If} $ytvwSafePinnedRole == 2
    Goto ytvwSafePinDone
  ${EndIf}
  StrCpy $ytvwSafeRest $ytvwSafeAfter
  Goto ytvwSafePinWalk

ytvwSafePinDone:
FunctionEnd

; ---------------------------------------------------------------------------
; un.YTVWDeleteEntry - remove exactly the entry named by `$ytvwSafeEntry`.
;   The entry is opened no-follow with DELETE access, its kind is read from the
;   HANDLE, and it is disposed through that same handle while it is still open.
; ---------------------------------------------------------------------------
Function un.YTVWDeleteEntry
  Push $0
  Push $1
  Push $2
  Push $3
  ${If} $ytvwSafeFailure != ""
    Goto ytvwSafeDeleteEntryDone
  ${EndIf}
  System::Call 'kernel32::CreateFileW(w "$ytvwSafeEntry", i ${YTVW_SD_ACCESS}, i ${YTVW_SD_SHARE_READ}, p 0, i ${YTVW_SD_OPEN_EXISTING}, i ${YTVW_SD_NO_FOLLOW}, p 0) p .r0 ?e'
  Pop $1
  ${If} $0 == -1
    ; 2 and 3 mean the entry was already gone, which is the same end state the
    ; walk wanted. Anything else - a lock, a denial - is not harmless.
    ${If} $1 == ${YTVW_SD_ERROR_FILE_NOT_FOUND}
    ${OrIf} $1 == ${YTVW_SD_ERROR_PATH_NOT_FOUND}
      StrCpy $ytvwSafeState $1
      Goto ytvwSafeDeleteEntryDone
    ${EndIf}
    StrCpy $ytvwSafeFailure "an entry of the machine root could not be opened for removal"
        Goto ytvwSafeDeleteEntryDone
  ${EndIf}
  System::Call 'kernel32::GetFileInformationByHandle(p r0, p $ytvwSafeInfoBuf) i .r2 ?e'
  Pop $3
  ${If} $2 == 0
    StrCpy $ytvwSafeFailure "an entry of the machine root could not be inspected"
        Goto ytvwSafeDeleteEntryClose
  ${EndIf}
  System::Call '*$ytvwSafeInfoBuf(i .r2)'
  ; A reparse point carries both the directory bit and the reparse bit, so the
  ; reparse test has to come first. A link is removed as itself and is never
  ; enumerated: that is the whole point of this file.
  IntOp $3 $2 & ${YTVW_SD_ATTRIBUTE_REPARSE_POINT}
  ${If} $3 != 0
        Goto ytvwSafeDeleteEntryDispose
  ${EndIf}
  IntOp $3 $2 & ${YTVW_SD_ATTRIBUTE_DIRECTORY}
  ${If} $3 == 0
        Goto ytvwSafeDeleteEntryDispose
  ${EndIf}
    StrCpy $ytvwSafeDir $ytvwSafeEntry
  Call un.YTVWDeleteChildren
  ${If} $ytvwSafeFailure != ""
    Goto ytvwSafeDeleteEntryClose
  ${EndIf}
  Goto ytvwSafeDeleteEntryDispose

ytvwSafeDeleteEntryDispose:
  ; The return value is the only success signal: this call reports a stale
  ; GetLastError even when it succeeds, so the `?e` result is dropped.
  System::Call 'kernel32::SetFileInformationByHandle(p r0, i ${YTVW_SD_DISPOSITION_CLASS}, p $ytvwSafeDispBuf, i ${YTVW_SD_DISPOSITION_BYTES}) i .r2 ?e'
  Pop $3
    ${If} $2 == 0
    StrCpy $ytvwSafeFailure "an entry of the machine root could not be marked for removal"
    Goto ytvwSafeDeleteEntryClose
  ${EndIf}

ytvwSafeDeleteEntryClose:
  System::Call 'kernel32::CloseHandle(p r0) i .r2'
ytvwSafeDeleteEntryDone:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; ---------------------------------------------------------------------------
; un.YTVWDeleteChildren - remove everything under `$ytvwSafeDir`.
;   The names are collected onto the NSIS stack and the search is closed before
;   the first removal, so the walk never deletes from a directory it is still
;   enumerating and never nests two FindFirst searches. The loop also drains
;   whatever is left when the walk has already failed, so the stack is always
;   balanced and the caller's pins stay reachable.
; ---------------------------------------------------------------------------
Function un.YTVWDeleteChildren
  Push $0
  Push $1
  StrCpy $0 0
  ${If} $ytvwSafeFailure != ""
    Goto ytvwSafeDeleteChildrenDelete
  ${EndIf}
  ClearErrors
  FindFirst $ytvwSafeFindHandle $ytvwSafeFindName "$ytvwSafeDir\*"
  IfErrors ytvwSafeDeleteChildrenDelete
ytvwSafeDeleteChildrenCollect:
  ; NSIS's own search fakes "." and ".." once the real entries run out, so
  ; both are dropped by name. Following either would walk forever.
  StrCmp $ytvwSafeFindName "." ytvwSafeDeleteChildrenNext
  StrCmp $ytvwSafeFindName ".." ytvwSafeDeleteChildrenNext
  Push $ytvwSafeFindName
  IntOp $0 $0 + 1
ytvwSafeDeleteChildrenNext:
  ClearErrors
  FindNext $ytvwSafeFindHandle $ytvwSafeFindName
  IfErrors ytvwSafeDeleteChildrenCollected
  Goto ytvwSafeDeleteChildrenCollect
ytvwSafeDeleteChildrenCollected:
  FindClose $ytvwSafeFindHandle

ytvwSafeDeleteChildrenDelete:
  ${If} $0 == 0
    Goto ytvwSafeDeleteChildrenDone
  ${EndIf}
  Pop $ytvwSafeName
  IntOp $0 $0 - 1
  ${If} $ytvwSafeFailure == ""
    ; `$ytvwSafeDir` belongs to THIS frame: the recursive call runs deeper
    ; frames that overwrite it, so it is restored before the next name is
    ; turned into a path.
    Push $ytvwSafeDir
    Push $ytvwSafeEntry
    StrCpy $ytvwSafeEntry "$ytvwSafeDir\$ytvwSafeName"
    Call un.YTVWDeleteEntry
    Pop $ytvwSafeEntry
    Pop $ytvwSafeDir
  ${EndIf}
  Goto ytvwSafeDeleteChildrenDelete

ytvwSafeDeleteChildrenDone:
  Pop $1
  Pop $0
FunctionEnd

!endif ; YTVW_NSIS_SAFE_DELETE_GUARD
!endif ; BUILD_UNINSTALLER
