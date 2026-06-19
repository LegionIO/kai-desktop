#!/usr/bin/env bash
#
# LocalLinuxHelper.sh — long-lived NDJSON helper for Kai on Linux.
#
# Protocol (matches electron/platform/helper-process.ts):
#   stdin  : { "id": <int>, "cmd": "<name>", "args": <any> }
#   stdout : { "id": <int>, "ok": <bool>, "data"?: <any>, "error"?: <string> }
#
# X11 path uses xdotool + maim/scrot/import + xprop/wmctrl.
# Wayland path uses grim + wtype/ydotool where available; many ops degrade.
# Text-field introspection / UI tree are delegated to atspi_helper.py — the
# adapter talks to that process directly, so this script does not proxy it.

set -u

SESSION_TYPE="${XDG_SESSION_TYPE:-x11}"

have() { command -v "$1" >/dev/null 2>&1; }

HAVE_JQ=0;       have jq       && HAVE_JQ=1
HAVE_XDOTOOL=0;  have xdotool  && HAVE_XDOTOOL=1
HAVE_MAIM=0;     have maim     && HAVE_MAIM=1
HAVE_SCROT=0;    have scrot    && HAVE_SCROT=1
HAVE_IMPORT=0;   have import   && HAVE_IMPORT=1
HAVE_GRIM=0;     have grim     && HAVE_GRIM=1
HAVE_WTYPE=0;    have wtype    && HAVE_WTYPE=1
HAVE_YDOTOOL=0;  have ydotool  && HAVE_YDOTOOL=1
HAVE_WMCTRL=0;   have wmctrl   && HAVE_WMCTRL=1
HAVE_XRANDR=0;   have xrandr   && HAVE_XRANDR=1
HAVE_XPROP=0;    have xprop    && HAVE_XPROP=1
HAVE_XSEL=0;     have xsel     && HAVE_XSEL=1
HAVE_XCLIP=0;    have xclip    && HAVE_XCLIP=1
HAVE_WLPASTE=0;  have wl-paste && HAVE_WLPASTE=1

if [ "$HAVE_JQ" -ne 1 ]; then
  printf '{"event":"fatal","error":"jq is required but not installed"}\n'
  exit 1
fi

emit_ok()  { jq -nc --argjson id "$1" --argjson data "$2" '{id:$id, ok:true, data:$data}'; }
emit_okn() { jq -nc --argjson id "$1" '{id:$id, ok:true, data:null}'; }
emit_err() { jq -nc --argjson id "$1" --arg err "$2" '{id:$id, ok:false, error:$err}'; }

json_str() { jq -Rn --arg v "$1" '$v'; }

# --- input ------------------------------------------------------------------

map_button() {
  case "$1" in
    right) echo 3 ;;
    middle) echo 2 ;;
    *) echo 1 ;;
  esac
}

# Translate Kai key names (mac/win style) to xdotool keysyms.
map_keys_xdotool() {
  local out=()
  for k in "$@"; do
    case "$(printf '%s' "$k" | tr '[:upper:]' '[:lower:]')" in
      ctrl|control) out+=("ctrl") ;;
      # Models often emit mac-style cmd/command for the primary modifier;
      # on Linux that means Ctrl. Only explicit win/super maps to Super.
      cmd|command|meta) out+=("ctrl") ;;
      win|super) out+=("super") ;;
      alt|option) out+=("alt") ;;
      shift) out+=("shift") ;;
      enter|return) out+=("Return") ;;
      esc|escape) out+=("Escape") ;;
      tab) out+=("Tab") ;;
      space) out+=("space") ;;
      backspace) out+=("BackSpace") ;;
      delete) out+=("Delete") ;;
      up) out+=("Up") ;; down) out+=("Down") ;;
      left) out+=("Left") ;; right) out+=("Right") ;;
      home) out+=("Home") ;; end) out+=("End") ;;
      pageup) out+=("Prior") ;; pagedown) out+=("Next") ;;
      f1|f2|f3|f4|f5|f6|f7|f8|f9|f10|f11|f12) out+=("$(printf '%s' "$k" | tr '[:lower:]' '[:upper:]')") ;;
      *) out+=("$k") ;;
    esac
  done
  local IFS='+'
  printf '%s' "${out[*]}"
}

do_move() {
  local x="$1" y="$2"
  if [ "$HAVE_XDOTOOL" -eq 1 ]; then xdotool mousemove "$x" "$y"; return; fi
  if [ "$HAVE_YDOTOOL" -eq 1 ]; then ydotool mousemove -a -x "$x" -y "$y"; return; fi
  return 1
}

do_click() {
  local x="$1" y="$2" btn; btn="$(map_button "$3")"
  if [ "$HAVE_XDOTOOL" -eq 1 ]; then xdotool mousemove "$x" "$y" click "$btn"; return; fi
  if [ "$HAVE_YDOTOOL" -eq 1 ]; then ydotool mousemove -a -x "$x" -y "$y"; ydotool click "0xC$((btn-1))"; return; fi
  return 1
}

do_double_click() {
  local x="$1" y="$2"
  if [ "$HAVE_XDOTOOL" -eq 1 ]; then xdotool mousemove "$x" "$y" click --repeat 2 1; return; fi
  if [ "$HAVE_YDOTOOL" -eq 1 ]; then ydotool mousemove -a -x "$x" -y "$y"; ydotool click 0xC0 0xC0; return; fi
  return 1
}

do_drag() {
  local sx="$1" sy="$2" ex="$3" ey="$4"
  if [ "$HAVE_XDOTOOL" -eq 1 ]; then
    xdotool mousemove "$sx" "$sy" mousedown 1 mousemove "$ex" "$ey" mouseup 1
    return
  fi
  return 1
}

do_scroll() {
  local dx="$1" dy="$2"
  if [ "$HAVE_XDOTOOL" -eq 1 ]; then
    local n
    if [ "$dy" -gt 0 ]; then n=$(( dy>10 ? 10 : dy )); xdotool click --repeat "$n" 5; fi
    if [ "$dy" -lt 0 ]; then n=$(( -dy>10 ? 10 : -dy )); xdotool click --repeat "$n" 4; fi
    if [ "$dx" -gt 0 ]; then n=$(( dx>10 ? 10 : dx )); xdotool click --repeat "$n" 7; fi
    if [ "$dx" -lt 0 ]; then n=$(( -dx>10 ? 10 : -dx )); xdotool click --repeat "$n" 6; fi
    return
  fi
  return 1
}

do_type() {
  local text="$1" delay="${2:-12}"
  if [ "$HAVE_XDOTOOL" -eq 1 ]; then xdotool type --clearmodifiers --delay "$delay" -- "$text"; return; fi
  if [ "$HAVE_WTYPE" -eq 1 ]; then wtype -- "$text"; return; fi
  if [ "$HAVE_YDOTOOL" -eq 1 ]; then ydotool type -- "$text"; return; fi
  return 1
}

is_modifier() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    ctrl|control|shift|alt|option|meta|cmd|command|win|super|logo) return 0 ;;
    *) return 1 ;;
  esac
}

map_wtype_modifier() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    ctrl|control|cmd|command|meta) echo ctrl ;;
    shift) echo shift ;;
    alt|option) echo alt ;;
    win|super|logo) echo logo ;;
    *) echo "$1" ;;
  esac
}

do_keys() {
  local combo; combo="$(map_keys_xdotool "$@")"
  if [ "$HAVE_XDOTOOL" -eq 1 ]; then xdotool key --clearmodifiers "$combo"; return; fi
  if [ "$HAVE_WTYPE" -eq 1 ]; then
    local mod_press=() mod_release=() key_seq=()
    for k in "$@"; do
      if is_modifier "$k"; then
        local m; m="$(map_wtype_modifier "$k")"
        mod_press+=(-M "$m")
        mod_release=(-m "$m" "${mod_release[@]}")
      else
        key_seq+=(-k "$(map_keys_xdotool "$k")")
      fi
    done
    wtype "${mod_press[@]}" "${key_seq[@]}" "${mod_release[@]}"
    return
  fi
  # ydotool's `key` subcommand expects raw evdev keycode:state pairs, not key
  # names. Mapping the full set is out of scope here; let the caller fall back
  # to the nut-js adapter for keyboard shortcuts when only ydotool is present.
  return 1
}

# --- screenshot -------------------------------------------------------------

png_dimensions() {
  # Read width/height from PNG IHDR (bytes 16-23). Fallback to identify/file.
  local f="$1" w h
  if have identify; then
    read -r w h < <(identify -format '%w %h' "$f" 2>/dev/null)
  fi
  if [ -z "${w:-}" ]; then
    local hex; hex="$(od -An -tx1 -j16 -N8 "$f" | tr -d ' \n')"
    w=$((16#${hex:0:8})); h=$((16#${hex:8:8}))
  fi
  printf '%s %s' "$w" "$h"
}

emit_screenshot() {
  local id="$1" tmp="$2"
  if [ ! -s "$tmp" ]; then emit_err "$id" "screenshot produced no data"; rm -f "$tmp"; return; fi
  local b64 dims w h
  b64="$(base64 -w0 "$tmp" 2>/dev/null || base64 "$tmp" | tr -d '\n')"
  read -r w h < <(png_dimensions "$tmp")
  rm -f "$tmp"
  emit_ok "$id" "$(jq -nc --arg b "$b64" --argjson w "${w:-0}" --argjson h "${h:-0}" '{imageBase64:$b,width:$w,height:$h}')"
}

shot_display() {
  local id="$1" idx="${2:-0}" tmp; tmp="$(mktemp --suffix=.png)"
  if [ "$SESSION_TYPE" = "wayland" ] && [ "$HAVE_GRIM" -eq 1 ]; then
    local out; out="$(have wlr-randr && wlr-randr 2>/dev/null | awk '/^[^ ]/ {print $1}' | sed -n "$((idx+1))p")"
    if [ -n "${out:-}" ]; then grim -o "$out" "$tmp"; else grim "$tmp"; fi
  elif [ "$HAVE_MAIM" -eq 1 ] && [ "$HAVE_XRANDR" -eq 1 ]; then
    local geom; geom="$(xrandr --listactivemonitors | awk 'NR>1{print $3}' | sed -n "$((idx+1))p")"
    if [ -n "$geom" ]; then
      # Geometry: WIDTH/MMWxHEIGHT/MMH{+|-}X{+|-}Y — offsets may be negative.
      local parsed; parsed="$(printf '%s' "$geom" | sed -E 's#^([0-9]+)/[0-9]+x([0-9]+)/[0-9]+([+-][0-9]+)([+-][0-9]+)$#\1 \2 \3 \4#')"
      if [ "$parsed" != "$geom" ]; then
        local w h x y; read -r w h x y <<<"$parsed"
        maim -g "${w}x${h}${x}${y}" "$tmp"
      else
        maim "$tmp"
      fi
    else
      maim "$tmp"
    fi
  elif [ "$HAVE_MAIM" -eq 1 ]; then maim "$tmp"
  elif [ "$HAVE_SCROT" -eq 1 ]; then scrot "$tmp"
  elif [ "$HAVE_IMPORT" -eq 1 ]; then import -window root "$tmp"
  elif [ "$HAVE_GRIM" -eq 1 ]; then grim "$tmp"
  else emit_err "$id" "no screenshot tool (maim/scrot/import/grim) available"; rm -f "$tmp"; return; fi
  emit_screenshot "$id" "$tmp"
}

shot_window() {
  local id="$1" wid="$2" tmp; tmp="$(mktemp --suffix=.png)"
  if [ -z "$wid" ] || [ "$wid" = "null" ]; then
    [ "$HAVE_XDOTOOL" -eq 1 ] && wid="$(xdotool getactivewindow 2>/dev/null)"
  fi
  if [ -n "${wid:-}" ] && [ "$HAVE_MAIM" -eq 1 ]; then maim -i "$wid" "$tmp"
  elif [ -n "${wid:-}" ] && [ "$HAVE_IMPORT" -eq 1 ]; then import -window "$wid" "$tmp"
  elif [ -n "${wid:-}" ] && [ "$HAVE_SCROT" -eq 1 ]; then scrot -u "$tmp"
  else shot_display "$id" 0; return; fi
  emit_screenshot "$id" "$tmp"
}

# --- window queries ---------------------------------------------------------

active_window_json() {
  if [ "$HAVE_XDOTOOL" -ne 1 ]; then printf 'null'; return; fi
  local wid title pid wmclass geom x y w h
  wid="$(xdotool getactivewindow 2>/dev/null)" || { printf 'null'; return; }
  title="$(xdotool getwindowname "$wid" 2>/dev/null)"
  pid="$(xdotool getwindowpid "$wid" 2>/dev/null)"
  wmclass=""
  [ "$HAVE_XPROP" -eq 1 ] && wmclass="$(xprop -id "$wid" WM_CLASS 2>/dev/null | sed -n 's/.*= "\([^"]*\)", "\([^"]*\)"/\2/p')"
  geom="$(xdotool getwindowgeometry --shell "$wid" 2>/dev/null)"
  eval "$geom" 2>/dev/null
  jq -nc \
    --arg app "${wmclass:-$(cat /proc/${pid}/comm 2>/dev/null)}" \
    --arg title "${title:-}" \
    --arg owner "${wmclass:-}" \
    --argjson pid "${pid:-null}" \
    --arg wid "$wid" \
    --argjson x "${X:-0}" --argjson y "${Y:-0}" --argjson w "${WIDTH:-0}" --argjson h "${HEIGHT:-0}" \
    '{appName:$app, windowTitle:$title, ownerId:($owner|select(length>0)//null), pid:$pid, windowId:$wid, bounds:{x:$x,y:$y,width:$w,height:$h}}'
}

displays_json() {
  if [ "$HAVE_XRANDR" -ne 1 ]; then printf '{"displays":[]}'; return; fi
  xrandr --listactivemonitors | awk 'NR>1' | jq -Rn '
    {displays: [inputs
      | capture("^\\s*(?<idx>\\d+):\\s+(?<flags>\\S+)\\s+(?<w>\\d+)/\\d+x(?<h>\\d+)/\\d+(?<x>[+-]\\d+)(?<y>[+-]\\d+)\\s+(?<name>\\S+)")
      | { displayId: .name, name: .name,
          pixelWidth: (.w|tonumber), pixelHeight: (.h|tonumber),
          logicalWidth: (.w|tonumber), logicalHeight: (.h|tonumber),
          globalX: (.x|tonumber), globalY: (.y|tonumber),
          scaleFactor: 1, isPrimary: (.flags|test("\\*")), displayIndex: (.idx|tonumber) }]}'
}

running_apps_json() {
  if [ "$HAVE_WMCTRL" -eq 1 ]; then
    wmctrl -lp | awk '{print $3}' | sort -u | while read -r p; do
      [ -n "$p" ] && [ "$p" != "0" ] && printf '%s\t%s\n' "$p" "$(cat /proc/$p/comm 2>/dev/null)"
    done | jq -Rn '[inputs | split("\t") | {pid:(.[0]|tonumber), name:.[1], ownerId:null}]'
  else
    printf '[]'
  fi
}

is_fullscreen_json() {
  if [ "$HAVE_XDOTOOL" -eq 1 ] && [ "$HAVE_XPROP" -eq 1 ]; then
    local wid; wid="$(xdotool getactivewindow 2>/dev/null)"
    if [ -n "$wid" ] && xprop -id "$wid" _NET_WM_STATE 2>/dev/null | grep -q _NET_WM_STATE_FULLSCREEN; then
      printf '{"fullscreen":true}'; return
    fi
  fi
  printf '{"fullscreen":false}'
}

primary_selection() {
  if [ "$HAVE_XSEL" -eq 1 ]; then xsel -p -o 2>/dev/null; return; fi
  if [ "$HAVE_XCLIP" -eq 1 ]; then xclip -selection primary -o 2>/dev/null; return; fi
  if [ "$HAVE_WLPASTE" -eq 1 ]; then wl-paste -p 2>/dev/null; return; fi
  return 1
}

# --- input monitor (xinput test-xi2) ----------------------------------------

MONITOR_PID=""

start_monitor() {
  if [ -n "$MONITOR_PID" ]; then return 0; fi
  if ! have xinput; then return 1; fi
  (
    xinput test-xi2 --root 2>/dev/null | while IFS= read -r line; do
      case "$line" in
        *"EVENT type"*"(KeyPress)"*)
          jq -nc --argjson t "$(date +%s%3N)" '{event:"input",kind:"keyboard",eventType:"KeyPress",x:0,y:0,timestampMs:$t}'
          ;;
        *"EVENT type"*"(ButtonPress)"*)
          jq -nc --argjson t "$(date +%s%3N)" '{event:"input",kind:"mouse",eventType:"ButtonPress",x:0,y:0,timestampMs:$t}'
          ;;
        *"EVENT type"*"(Motion)"*)
          jq -nc --argjson t "$(date +%s%3N)" '{event:"input",kind:"mouse",eventType:"Motion",x:0,y:0,timestampMs:$t}'
          ;;
      esac
    done
  ) &
  MONITOR_PID=$!
}

stop_monitor() {
  if [ -n "$MONITOR_PID" ]; then
    kill "$MONITOR_PID" 2>/dev/null
    pkill -P "$MONITOR_PID" 2>/dev/null
    MONITOR_PID=""
  fi
}

trap 'stop_monitor' EXIT

# --- main loop --------------------------------------------------------------

while IFS= read -r line; do
  [ -z "$line" ] && continue
  id="$(jq -r '.id // 0' <<<"$line" 2>/dev/null)" || continue
  cmd="$(jq -r '.cmd // ""' <<<"$line")"
  args="$(jq -c '.args // {}' <<<"$line")"

  case "$cmd" in
    ping) emit_ok "$id" '{"pong":true}' ;;

    screenshotDisplay) shot_display "$id" "$(jq -r '.displayIndex // 0' <<<"$args")" ;;
    screenshotWindow)  shot_window  "$id" "$(jq -r '.windowId // ""' <<<"$args")" ;;
    displays)          emit_ok "$id" "$(displays_json)" ;;

    move)
      if do_move "$(jq -r '.x' <<<"$args")" "$(jq -r '.y' <<<"$args")"; then emit_okn "$id"
      else emit_err "$id" "no input tool available"; fi ;;
    click)
      if do_click "$(jq -r '.x' <<<"$args")" "$(jq -r '.y' <<<"$args")" "$(jq -r '.button // "left"' <<<"$args")"; then emit_okn "$id"
      else emit_err "$id" "no input tool available"; fi ;;
    doubleClick)
      if do_double_click "$(jq -r '.x' <<<"$args")" "$(jq -r '.y' <<<"$args")"; then emit_okn "$id"
      else emit_err "$id" "no input tool available"; fi ;;
    drag)
      if do_drag "$(jq -r '.startX' <<<"$args")" "$(jq -r '.startY' <<<"$args")" "$(jq -r '.endX' <<<"$args")" "$(jq -r '.endY' <<<"$args")"; then emit_okn "$id"
      else emit_err "$id" "no input tool available"; fi ;;
    scroll)
      if do_scroll "$(jq -r '.deltaX // 0' <<<"$args")" "$(jq -r '.deltaY // 0' <<<"$args")"; then emit_okn "$id"
      else emit_err "$id" "no input tool available"; fi ;;
    typeText)
      if do_type "$(jq -r '.text // ""' <<<"$args")" "$(jq -r '.delayMs // 12' <<<"$args")"; then emit_okn "$id"
      else emit_err "$id" "no input tool available"; fi ;;
    pressKeys)
      mapfile -t _keys < <(jq -r '.keys[]?' <<<"$args")
      if do_keys "${_keys[@]}"; then emit_okn "$id"
      else emit_err "$id" "no input tool available"; fi ;;
    pointer)
      if [ "$HAVE_XDOTOOL" -eq 1 ]; then
        eval "$(xdotool getmouselocation --shell 2>/dev/null)"
        emit_ok "$id" "$(jq -nc --argjson x "${X:-0}" --argjson y "${Y:-0}" '{x:$x,y:$y}')"
      else emit_err "$id" "xdotool required"; fi ;;

    activeWindow) emit_ok "$id" "$(active_window_json)" ;;
    runningApps)  emit_ok "$id" "$(running_apps_json)" ;;
    isFullscreen) emit_ok "$id" "$(is_fullscreen_json)" ;;
    openApp)
      n="$(jq -r '.name' <<<"$args")"
      if have gtk-launch; then
        if err="$(gtk-launch "$n" 2>&1 >/dev/null)"; then emit_okn "$id"
        else emit_err "$id" "gtk-launch '$n' failed: ${err:-unknown error}"; fi
      elif command -v "$n" >/dev/null 2>&1; then
        if have setsid; then setsid "$n" >/dev/null 2>&1 & disown
        else nohup "$n" >/dev/null 2>&1 & disown; fi
        emit_okn "$id"
      else
        emit_err "$id" "no desktop entry or executable for '$n'"
      fi ;;
    focusApp)
      n="$(jq -r '.name' <<<"$args")"
      if [ "$HAVE_WMCTRL" -eq 1 ] && wmctrl -x -a "$n" 2>/dev/null; then emit_okn "$id"
      elif [ "$HAVE_XDOTOOL" -eq 1 ]; then
        w="$(xdotool search --onlyvisible --classname "$n" 2>/dev/null | head -1)"
        [ -z "$w" ] && w="$(xdotool search --onlyvisible --name "$n" 2>/dev/null | head -1)"
        if [ -n "$w" ] && xdotool windowactivate "$w" 2>/dev/null; then emit_okn "$id"
        else emit_err "$id" "no window matching '$n'"; fi
      else emit_err "$id" "no window tool available"; fi ;;
    restoreFocus)
      wid="$(jq -r '.windowId // ""' <<<"$args")"
      pid="$(jq -r '.pid // ""' <<<"$args")"
      if [ -n "$wid" ] && [ "$wid" != "null" ] && [ "$HAVE_XDOTOOL" -eq 1 ]; then
        xdotool windowactivate "$wid" 2>/dev/null; emit_okn "$id"
      elif [ -n "$pid" ] && [ "$HAVE_XDOTOOL" -eq 1 ]; then
        w="$(xdotool search --pid "$pid" | head -1)"
        [ -n "$w" ] && xdotool windowactivate "$w" 2>/dev/null
        emit_okn "$id"
      else emit_okn "$id"; fi ;;

    primarySelection)
      txt="$(primary_selection)"
      emit_ok "$id" "$(jq -nc --arg t "$txt" '{text:($t|select(length>0)//null)}')" ;;

    startMonitor)
      if start_monitor; then emit_okn "$id"
      else emit_err "$id" "xinput not available"; fi ;;
    stopMonitor) stop_monitor; emit_okn "$id" ;;

    *) emit_err "$id" "unknown command '$cmd'" ;;
  esac
done
