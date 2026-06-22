<#
LocalWindowsHelper.ps1 — long-lived NDJSON helper for Kai on Windows.

Protocol (matches electron/platform/helper-process.ts):
  stdin  : one JSON object per line: { "id": <int>, "cmd": "<name>", "args": <any> }
  stdout : { "id": <int>, "ok": <bool>, "data"?: <any>, "error"?: <string> }
           or unsolicited events: { "event": "input", ... }

The C# block is compiled once via Add-Type and provides UI Automation, screen
capture, and SendInput. PowerShell handles dispatch and JSON.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -ReferencedAssemblies @(
  'System.Drawing',
  'System.Windows.Forms',
  'UIAutomationClient',
  'UIAutomationTypes'
) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

public static class Kai
{
    // ---------------------------------------------------------------------
    // P/Invoke
    // ---------------------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUTUNION u; }

    const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int idx);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("kernel32.dll")] public static extern uint GetTickCount();
    [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr mod, uint tid);
    [DllImport("user32.dll")] public static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
    public delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    static void Send(params INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

    // ---------------------------------------------------------------------
    // Pointer / mouse
    // ---------------------------------------------------------------------
    static INPUT MouseAbs(int x, int y)
    {
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
        int vw = Math.Max(1, GetSystemMetrics(78)), vh = Math.Max(1, GetSystemMetrics(79));
        var i = new INPUT { type = INPUT_MOUSE };
        i.u.mi.dx = (int)(((double)(x - vx) * 65535.0) / (vw - 1));
        i.u.mi.dy = (int)(((double)(y - vy) * 65535.0) / (vh - 1));
        i.u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        return i;
    }
    static INPUT MouseFlag(uint f) { var i = new INPUT { type = INPUT_MOUSE }; i.u.mi.dwFlags = f; return i; }
    static INPUT MouseFlag(uint f, int data) { var i = MouseFlag(f); i.u.mi.mouseData = (uint)data; return i; }

    public static void Move(int x, int y, int durationMs)
    {
        if (durationMs <= 0) { Send(MouseAbs(x, y)); return; }
        POINT p; GetCursorPos(out p);
        int steps = Math.Max(1, durationMs / 12);
        for (int s = 1; s <= steps; s++)
        {
            int cx = p.X + (x - p.X) * s / steps;
            int cy = p.Y + (y - p.Y) * s / steps;
            Send(MouseAbs(cx, cy));
            Thread.Sleep(durationMs / steps);
        }
    }

    static void ButtonFlags(string button, out uint down, out uint up)
    {
        if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
        else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
        else { down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; }
    }

    public static void Click(int x, int y, string button)
    {
        uint d, u; ButtonFlags(button, out d, out u);
        Send(MouseAbs(x, y)); Thread.Sleep(20);
        Send(MouseFlag(d)); Thread.Sleep(20); Send(MouseFlag(u));
    }

    public static void DoubleClick(int x, int y)
    {
        Send(MouseAbs(x, y)); Thread.Sleep(20);
        Send(MouseFlag(MOUSEEVENTF_LEFTDOWN)); Thread.Sleep(20); Send(MouseFlag(MOUSEEVENTF_LEFTUP));
        Thread.Sleep(60);
        Send(MouseFlag(MOUSEEVENTF_LEFTDOWN)); Thread.Sleep(20); Send(MouseFlag(MOUSEEVENTF_LEFTUP));
    }

    public static void Drag(int sx, int sy, int ex, int ey, int durationMs)
    {
        Send(MouseAbs(sx, sy)); Thread.Sleep(30);
        Send(MouseFlag(MOUSEEVENTF_LEFTDOWN)); Thread.Sleep(30);
        Move(ex, ey, Math.Max(60, durationMs));
        Thread.Sleep(30); Send(MouseFlag(MOUSEEVENTF_LEFTUP));
    }

    public static void Scroll(int dx, int dy)
    {
        if (dy != 0) Send(MouseFlag(MOUSEEVENTF_WHEEL, -dy * 120));
        if (dx != 0) Send(MouseFlag(MOUSEEVENTF_HWHEEL, dx * 120));
    }

    public static int[] Pointer() { POINT p; GetCursorPos(out p); return new[] { p.X, p.Y }; }

    // ---------------------------------------------------------------------
    // Keyboard
    // ---------------------------------------------------------------------
    static INPUT KeyVk(ushort vk, bool up)
    {
        var i = new INPUT { type = INPUT_KEYBOARD };
        i.u.ki.wVk = vk; i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        return i;
    }
    static INPUT KeyUnicode(char c, bool up)
    {
        var i = new INPUT { type = INPUT_KEYBOARD };
        i.u.ki.wScan = c; i.u.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        return i;
    }

    public static void TypeText(string text, int delayMs)
    {
        foreach (char c in text)
        {
            if (c == '\n' || c == '\r') { Send(KeyVk(0x0D, false), KeyVk(0x0D, true)); }
            else if (c == '\t') { Send(KeyVk(0x09, false), KeyVk(0x09, true)); }
            else { Send(KeyUnicode(c, false), KeyUnicode(c, true)); }
            if (delayMs > 0) Thread.Sleep(delayMs);
        }
    }

    static readonly Dictionary<string, ushort> KeyMap = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase)
    {
        {"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"option",0x12},
        {"win",0x5B},{"super",0x5B},{"meta",0x5B},{"cmd",0x11},{"command",0x11},
        {"enter",0x0D},{"return",0x0D},{"tab",0x09},{"escape",0x1B},{"esc",0x1B},
        {"space",0x20},{"backspace",0x08},{"delete",0x2E},
        {"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},
        {"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},
        {"f1",0x70},{"f2",0x71},{"f3",0x72},{"f4",0x73},{"f5",0x74},{"f6",0x75},
        {"f7",0x76},{"f8",0x77},{"f9",0x78},{"f10",0x79},{"f11",0x7A},{"f12",0x7B},
    };

    static ushort ResolveKey(string key)
    {
        ushort vk;
        if (KeyMap.TryGetValue(key, out vk)) return vk;
        if (key.Length == 1)
        {
            short s = VkKeyScan(key[0]);
            if (s != -1) return (ushort)(s & 0xFF);
        }
        return 0;
    }

    public static void PressKeys(string[] keys, int delayMs)
    {
        var vks = new List<ushort>();
        foreach (var k in keys) { var v = ResolveKey(k); if (v != 0) vks.Add(v); }
        foreach (var v in vks) { Send(KeyVk(v, false)); Thread.Sleep(8); }
        if (delayMs > 0) Thread.Sleep(delayMs);
        for (int i = vks.Count - 1; i >= 0; i--) { Send(KeyVk(vks[i], true)); Thread.Sleep(8); }
    }

    // ---------------------------------------------------------------------
    // Window / process
    // ---------------------------------------------------------------------
    public static IntPtr ForegroundHwnd() { return GetForegroundWindow(); }

    public static string WindowTitle(IntPtr hwnd)
    {
        var sb = new StringBuilder(1024);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    public static int WindowPid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return (int)pid; }

    public static int[] WindowBounds(IntPtr hwnd)
    {
        RECT r; if (!GetWindowRect(hwnd, out r)) return null;
        return new[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
    }

    public static bool IsFullscreen()
    {
        var hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return false;
        RECT r; if (!GetWindowRect(hwnd, out r)) return false;
        var screen = Screen.FromHandle(hwnd).Bounds;
        return r.Left <= screen.Left && r.Top <= screen.Top && r.Right >= screen.Right && r.Bottom >= screen.Bottom;
    }

    public static bool Restore(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return false;
        ShowWindow(hwnd, 9);
        return SetForegroundWindow(hwnd);
    }

    // ---------------------------------------------------------------------
    // Screenshot
    // ---------------------------------------------------------------------
    static string CaptureRect(int x, int y, int w, int h)
    {
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(bmp))
        using (var ms = new MemoryStream())
        {
            g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            bmp.Save(ms, ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
        }
    }

    public static string[] ScreenshotDisplay(int index)
    {
        var screens = Screen.AllScreens;
        if (index < 0 || index >= screens.Length) index = 0;
        var b = screens[index].Bounds;
        return new[] { CaptureRect(b.X, b.Y, b.Width, b.Height), b.Width.ToString(), b.Height.ToString() };
    }

    public static string[] ScreenshotWindow(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) hwnd = GetForegroundWindow();
        var r = WindowBounds(hwnd);
        if (r == null || r[2] <= 0 || r[3] <= 0)
        {
            var b = Screen.PrimaryScreen.Bounds;
            return new[] { CaptureRect(b.X, b.Y, b.Width, b.Height), b.Width.ToString(), b.Height.ToString() };
        }
        return new[] { CaptureRect(r[0], r[1], r[2], r[3]), r[2].ToString(), r[3].ToString() };
    }

    // ---------------------------------------------------------------------
    // UI Automation (run on a dedicated STA thread to avoid COM stalls)
    // ---------------------------------------------------------------------
    static T OnSta<T>(Func<T> fn)
    {
        T result = default(T); Exception err = null;
        var t = new Thread(() => { try { result = fn(); } catch (Exception e) { err = e; } });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
        if (!t.Join(8000)) { try { t.Abort(); } catch { } throw new TimeoutException("UIA call exceeded 8s"); }
        if (err != null) throw err;
        return result;
    }

    public static Dictionary<string, object> ReadFocusedTextField()
    {
        return OnSta(() =>
        {
            var el = AutomationElement.FocusedElement;
            if (el == null) return null;
            string sig = ElementSignature(el);
            string role = el.Current.ControlType != null ? el.Current.ControlType.ProgrammaticName : null;
            object pat;
            if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat))
            {
                var tp = (TextPattern)pat;
                string value = tp.DocumentRange.GetText(-1);
                int selStart = 0, selEnd = 0;
                var sel = tp.GetSelection();
                if (sel != null && sel.Length > 0)
                {
                    var pre = tp.DocumentRange.Clone();
                    pre.MoveEndpointByRange(TextPatternRangeEndpoint.End, sel[0], TextPatternRangeEndpoint.Start);
                    selStart = pre.GetText(-1).Length;
                    selEnd = selStart + sel[0].GetText(-1).Length;
                }
                return new Dictionary<string, object> {
                    {"value", value}, {"selectionStart", selStart}, {"selectionEnd", selEnd},
                    {"elementSignature", sig}, {"role", role}
                };
            }
            // ValuePattern alone exposes no caret/selection. Returning a
            // snapshot with a fabricated caret would make the dictation
            // splice path insert at the wrong location, so report null and
            // let callers fall back to keyboard insertion at the real cursor.
            return null;
        });
    }

    public static bool WriteFocusedTextField(string value, int caret)
    {
        return OnSta(() =>
        {
            var el = AutomationElement.FocusedElement;
            if (el == null) return false;
            object pat;
            bool wrote = false;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat))
            {
                var vp = (ValuePattern)pat;
                if (!vp.Current.IsReadOnly) { vp.SetValue(value); wrote = true; }
            }
            if (!wrote && el.TryGetCurrentPattern(TextPattern.Pattern, out pat))
            {
                PressKeys(new[] {"ctrl", "a"}, 20);
                Thread.Sleep(20);
                TypeText(value, 0);
                wrote = true;
            }
            if (!wrote) return false;
            if (caret >= 0 && caret <= value.Length && el.TryGetCurrentPattern(TextPattern.Pattern, out pat))
            {
                try
                {
                    var tp = (TextPattern)pat;
                    var range = tp.DocumentRange.Clone();
                    range.MoveEndpointByRange(TextPatternRangeEndpoint.End, tp.DocumentRange, TextPatternRangeEndpoint.Start);
                    range.Move(TextUnit.Character, caret);
                    range.MoveEndpointByRange(TextPatternRangeEndpoint.End, range, TextPatternRangeEndpoint.Start);
                    range.Select();
                }
                catch { }
            }
            return true;
        });
    }

    public static string SelectedText()
    {
        return OnSta(() =>
        {
            var el = AutomationElement.FocusedElement;
            if (el == null) return null;
            object pat;
            if (el.TryGetCurrentPattern(TextPattern.Pattern, out pat))
            {
                var sel = ((TextPattern)pat).GetSelection();
                if (sel != null && sel.Length > 0) return sel[0].GetText(-1);
            }
            return null;
        });
    }

    static string ElementSignature(AutomationElement el)
    {
        try
        {
            var rid = el.GetRuntimeId();
            return el.Current.ProcessId + ":" + (el.Current.AutomationId ?? "") + ":" + string.Join(".", Array.ConvertAll(rid, x => x.ToString()));
        }
        catch { return el.Current.ProcessId + ":" + (el.Current.Name ?? ""); }
    }

    public static Dictionary<string, object> UiTree(int maxDepth, long targetHwnd)
    {
        return OnSta(() =>
        {
            var hwnd = targetHwnd != 0 ? new IntPtr(targetHwnd) : GetForegroundWindow();
            if (hwnd == IntPtr.Zero) return null;
            var root = AutomationElement.FromHandle(hwnd);
            return root == null ? null : Walk(root, 0, Math.Max(1, maxDepth));
        });
    }

    static Dictionary<string, object> Walk(AutomationElement el, int depth, int maxDepth)
    {
        var node = new Dictionary<string, object>();
        try
        {
            node["role"] = el.Current.ControlType != null ? el.Current.ControlType.ProgrammaticName : "Unknown";
            var name = el.Current.Name; if (!string.IsNullOrEmpty(name)) node["name"] = name;
            var r = el.Current.BoundingRectangle;
            if (!r.IsEmpty) node["bounds"] = new Dictionary<string, object> {
                {"x", (int)r.X}, {"y", (int)r.Y}, {"width", (int)r.Width}, {"height", (int)r.Height}
            };
            object vp;
            if (el.TryGetCurrentPattern(ValuePattern.Pattern, out vp))
            {
                var v = ((ValuePattern)vp).Current.Value;
                if (!string.IsNullOrEmpty(v) && v.Length <= 512) node["value"] = v;
            }
        }
        catch { }
        if (depth < maxDepth)
        {
            var kids = new List<object>();
            try
            {
                var walker = TreeWalker.ControlViewWalker;
                var child = walker.GetFirstChild(el);
                int count = 0;
                while (child != null && count < 64)
                {
                    kids.Add(Walk(child, depth + 1, maxDepth));
                    child = walker.GetNextSibling(child);
                    count++;
                }
            }
            catch { }
            if (kids.Count > 0) node["children"] = kids;
        }
        return node;
    }

    // ---------------------------------------------------------------------
    // Low-level input monitor (takeover detection)
    // ---------------------------------------------------------------------
    static IntPtr _kbHook = IntPtr.Zero, _msHook = IntPtr.Zero;
    static HookProc _kbProc, _msProc;
    static Thread _hookThread;
    static volatile bool _hookRun;

    public static void StartMonitor(Action<string> emit)
    {
        if (_hookThread != null) return;
        _hookRun = true;
        _hookThread = new Thread(() =>
        {
            var mod = GetModuleHandle(null);
            _kbProc = (code, w, l) =>
            {
                if (code >= 0)
                {
                    int vk = Marshal.ReadInt32(l);
                    int flags = Marshal.ReadInt32(l, 8);
                    // LLKHF_INJECTED (0x10) marks SendInput-generated events;
                    // ignore them so the harness's own keystrokes don't
                    // register as a manual takeover.
                    if ((flags & 0x10) == 0)
                    {
                        POINT p; GetCursorPos(out p);
                        emit("{\"event\":\"input\",\"kind\":\"keyboard\",\"eventType\":\"" + ((int)w) +
                             "\",\"keyCode\":" + vk + ",\"x\":" + p.X + ",\"y\":" + p.Y +
                             ",\"timestampMs\":" + GetTickCount() + "}");
                    }
                }
                return CallNextHookEx(_kbHook, code, w, l);
            };
            _msProc = (code, w, l) =>
            {
                if (code >= 0)
                {
                    int x = Marshal.ReadInt32(l, 0), y = Marshal.ReadInt32(l, 4);
                    int flags = Marshal.ReadInt32(l, 12);
                    // LLMHF_INJECTED (0x01) — see keyboard hook above.
                    if ((flags & 0x01) == 0)
                    {
                        emit("{\"event\":\"input\",\"kind\":\"mouse\",\"eventType\":\"" + ((int)w) +
                             "\",\"x\":" + x + ",\"y\":" + y + ",\"timestampMs\":" + GetTickCount() + "}");
                    }
                }
                return CallNextHookEx(_msHook, code, w, l);
            };
            _kbHook = SetWindowsHookEx(13, _kbProc, mod, 0);
            _msHook = SetWindowsHookEx(14, _msProc, mod, 0);
            while (_hookRun) { Application.DoEvents(); Thread.Sleep(16); }
            if (_kbHook != IntPtr.Zero) UnhookWindowsHookEx(_kbHook);
            if (_msHook != IntPtr.Zero) UnhookWindowsHookEx(_msHook);
            _kbHook = IntPtr.Zero; _msHook = IntPtr.Zero;
        });
        _hookThread.SetApartmentState(ApartmentState.STA);
        _hookThread.IsBackground = true;
        _hookThread.Start();
    }

    public static void StopMonitor()
    {
        _hookRun = false;
        if (_hookThread != null) { _hookThread.Join(500); _hookThread = null; }
    }
}
'@

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------

$writeLock = New-Object Object

function Emit-Line([string]$line) {
  [System.Threading.Monitor]::Enter($writeLock)
  try { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }
  finally { [System.Threading.Monitor]::Exit($writeLock) }
}

function Respond([int]$id, [bool]$ok, $data, [string]$err) {
  $obj = [ordered]@{ id = $id; ok = $ok }
  if ($ok -and $null -ne $data) { $obj.data = $data }
  if (-not $ok) { $obj.error = if ($err) { $err } else { 'unknown error' } }
  Emit-Line (ConvertTo-Json -InputObject $obj -Depth 32 -Compress)
}

function As-Int($v, [int]$def = 0) { if ($null -eq $v) { $def } else { [int]$v } }

function Hwnd-From($v) {
  if ($null -eq $v -or $v -eq '') { return [IntPtr]::Zero }
  return [IntPtr][long]$v
}

function Get-DisplayList() {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $i = 0
  $list = @()
  foreach ($s in $screens) {
    $list += [ordered]@{
      displayId    = $s.DeviceName
      name         = $s.DeviceName
      pixelWidth   = $s.Bounds.Width
      pixelHeight  = $s.Bounds.Height
      logicalWidth = $s.Bounds.Width
      logicalHeight= $s.Bounds.Height
      globalX      = $s.Bounds.X
      globalY      = $s.Bounds.Y
      scaleFactor  = 1
      isPrimary    = $s.Primary
      displayIndex = $i
    }
    $i++
  }
  return ,$list
}

function Get-ActiveWindowInfo() {
  $hwnd = [Kai]::ForegroundHwnd()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  $procId = [Kai]::WindowPid($hwnd)
  $title = [Kai]::WindowTitle($hwnd)
  $b = [Kai]::WindowBounds($hwnd)
  $proc = $null
  try { $proc = Get-Process -Id $procId -ErrorAction Stop } catch { }
  $bounds = $null
  if ($null -ne $b) { $bounds = @{ x = $b[0]; y = $b[1]; width = $b[2]; height = $b[3] } }
  return [ordered]@{
    appName     = if ($proc) { $proc.ProcessName } else { '' }
    windowTitle = $title
    ownerId     = if ($proc) { $proc.Path } else { $null }
    pid         = $procId
    bounds      = $bounds
    windowId    = [string]([long]$hwnd)
    url         = $null
  }
}

# -----------------------------------------------------------------------------
# Dispatch
# -----------------------------------------------------------------------------

$emitDelegate = [Action[string]]{ param($s) Emit-Line $s }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }

  try { $req = ConvertFrom-Json -InputObject $line } catch { continue }
  $id = As-Int $req.id
  $cmd = [string]$req.cmd
  $a = $req.args

  try {
    switch ($cmd) {
      'ping' { Respond $id $true @{ pong = $true } $null }

      'screenshotDisplay' {
        $r = [Kai]::ScreenshotDisplay((As-Int $a.displayIndex 0))
        Respond $id $true @{ imageBase64 = $r[0]; width = [int]$r[1]; height = [int]$r[2] } $null
      }
      'screenshotWindow' {
        $r = [Kai]::ScreenshotWindow((Hwnd-From $a.hwnd))
        Respond $id $true @{ imageBase64 = $r[0]; width = [int]$r[1]; height = [int]$r[2] } $null
      }
      'displays' { Respond $id $true @{ displays = (Get-DisplayList) } $null }

      'move'        { [Kai]::Move((As-Int $a.x), (As-Int $a.y), (As-Int $a.durationMs 0)); Respond $id $true $null $null }
      'click'       { [Kai]::Click((As-Int $a.x), (As-Int $a.y), [string]$a.button); Respond $id $true $null $null }
      'doubleClick' { [Kai]::DoubleClick((As-Int $a.x), (As-Int $a.y)); Respond $id $true $null $null }
      'drag'        { [Kai]::Drag((As-Int $a.startX), (As-Int $a.startY), (As-Int $a.endX), (As-Int $a.endY), (As-Int $a.durationMs 200)); Respond $id $true $null $null }
      'scroll'      { [Kai]::Scroll((As-Int $a.deltaX), (As-Int $a.deltaY)); Respond $id $true $null $null }
      'typeText'    { [Kai]::TypeText([string]$a.text, (As-Int $a.delayMs 5)); Respond $id $true $null $null }
      'pressKeys'   { [Kai]::PressKeys([string[]]@($a.keys), (As-Int $a.delayMs 30)); Respond $id $true $null $null }
      'pointer'     { $p = [Kai]::Pointer(); Respond $id $true @{ x = $p[0]; y = $p[1] } $null }

      'activeWindow' { Respond $id $true (Get-ActiveWindowInfo) $null }
      'captureFocus' {
        $info = Get-ActiveWindowInfo
        if ($info) { Respond $id $true @{ appName = $info.appName; ownerId = $info.ownerId; pid = $info.pid; windowId = $info.windowId } $null }
        else { Respond $id $true $null $null }
      }
      'restoreFocus' {
        $hwnd = Hwnd-From $a.hwnd
        if ($hwnd -eq [IntPtr]::Zero -and $a.pid) {
          try { $hwnd = (Get-Process -Id ([int]$a.pid) -ErrorAction Stop).MainWindowHandle } catch { }
        }
        Respond $id ([Kai]::Restore($hwnd)) $null $null
      }
      'runningApps' {
        $apps = @()
        foreach ($p in (Get-Process | Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle -ne [IntPtr]::Zero })) {
          $apps += @{ name = $p.ProcessName; ownerId = $p.Path; pid = $p.Id }
        }
        Respond $id $true $apps $null
      }
      'isFullscreen'   { Respond $id $true @{ fullscreen = [Kai]::IsFullscreen() } $null }
      'exitFullscreen' { [Kai]::PressKeys(@('f11'), 30); Respond $id $true $null $null }
      'openApp'        { Start-Process -FilePath ([string]$a.name) | Out-Null; Respond $id $true $null $null }
      'focusApp' {
        $p = Get-Process -Name ([string]$a.name) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($p) { [Kai]::Restore($p.MainWindowHandle) | Out-Null; Respond $id $true $null $null }
        else { Respond $id $false $null "process '$($a.name)' not found" }
      }

      'readTextField' {
        $r = [Kai]::ReadFocusedTextField()
        if ($r) { Respond $id $true $r $null } else { Respond $id $false $null 'no focused text field' }
      }
      'writeTextField' {
        $caret = if ($null -ne $a.selectionStart) { [int]$a.selectionStart } else { -1 }
        Respond $id $true @{ ok = [Kai]::WriteFocusedTextField([string]$a.value, $caret) } $null
      }
      'selectedText' { Respond $id $true @{ text = [Kai]::SelectedText() } $null }
      'uiTree'       {
        $hwnd = 0L
        if ($null -ne $a.windowId -and $a.windowId -ne '') { [void][long]::TryParse([string]$a.windowId, [ref]$hwnd) }
        Respond $id $true @{ root = [Kai]::UiTree((As-Int $a.maxDepth 4), $hwnd) } $null
      }

      'startMonitor' { [Kai]::StartMonitor($emitDelegate); Respond $id $true $null $null }
      'stopMonitor'  { [Kai]::StopMonitor(); Respond $id $true $null $null }

      default { Respond $id $false $null "unknown command '$cmd'" }
    }
  } catch {
    Respond $id $false $null $_.Exception.Message
  }
}

[Kai]::StopMonitor()
