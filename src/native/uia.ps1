$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class GrabUia {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }

  public static void Init() { SetThreadDpiAwarenessContext(new IntPtr(-4)); }

  static string Esc(string s) {
    if (s == null) return "";
    var b = new StringBuilder();
    foreach (var c in s) {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 32) b.Append(' ');
      else if (c > 126) b.Append("\\u" + ((int)c).ToString("x4"));
      else b.Append(c);
      if (b.Length > 80) break;
    }
    return b.ToString();
  }

  public static string Windows(int excludePid) {
    var items = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || IsIconic(h)) return true;
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == excludePid) return true;
      RECT r; if (DwmGetWindowAttribute(h, 9, out r, 16) != 0) return true;
      if (r.R - r.L < 24 || r.B - r.T < 24) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      var c = new StringBuilder(128); GetClassName(h, c, 128);
      var cls = c.ToString();
      if (t.Length == 0 && cls != "Progman" && cls != "WorkerW") return true;
      items.Add(string.Format("{{\"h\":{0},\"x\":{1},\"y\":{2},\"w\":{3},\"hgt\":{4},\"t\":\"{5}\",\"c\":\"{6}\"}}",
        h.ToInt64(), r.L, r.T, r.R - r.L, r.B - r.T, Esc(t.ToString()), Esc(cls)));
      return true;
    }, IntPtr.Zero);
    return "[" + string.Join(",", items) + "]";
  }

  public static string Elements(long hwnd, int max) {
    var root = AutomationElement.FromHandle(new IntPtr(hwnd));
    var cr = new CacheRequest();
    cr.Add(AutomationElement.BoundingRectangleProperty);
    cr.Add(AutomationElement.ControlTypeProperty);
    cr.Add(AutomationElement.NameProperty);
    cr.Add(AutomationElement.IsOffscreenProperty);
    cr.TreeFilter = Automation.ControlViewCondition;
    cr.AutomationElementMode = AutomationElementMode.None;
    var items = new List<string>();
    using (cr.Activate()) {
      var all = root.FindAll(TreeScope.Descendants, Automation.ControlViewCondition);
      foreach (AutomationElement e in all) {
        if (items.Count >= max) break;
        try {
          if ((bool)e.GetCachedPropertyValue(AutomationElement.IsOffscreenProperty)) continue;
          var r = (System.Windows.Rect)e.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
          if (r.IsEmpty || r.Width < 8 || r.Height < 8) continue;
          var ct = (ControlType)e.GetCachedPropertyValue(AutomationElement.ControlTypeProperty);
          var n = (string)e.GetCachedPropertyValue(AutomationElement.NameProperty);
          items.Add(string.Format("{{\"x\":{0},\"y\":{1},\"w\":{2},\"hgt\":{3},\"k\":\"{4}\",\"n\":\"{5}\"}}",
            (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height, ct.ProgrammaticName.Replace("ControlType.", ""), Esc(n)));
        } catch { }
      }
    }
    return "[" + string.Join(",", items) + "]";
  }
}
'@
[GrabUia]::Init()
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $req = $line | ConvertFrom-Json
    if ($req.op -eq 'windows') { $out = [GrabUia]::Windows([int]$req.pid) }
    elseif ($req.op -eq 'elements') { $out = [GrabUia]::Elements([long]$req.hwnd, 6000) }
    else { $out = 'null' }
    [Console]::Out.WriteLine('{"id":' + $req.id + ',"data":' + $out + '}')
  } catch {
    [Console]::Out.WriteLine('{"id":' + $req.id + ',"error":"' + ($_.Exception.Message -replace '["\\\r\n]', ' ') + '"}')
  }
  [Console]::Out.Flush()
}
