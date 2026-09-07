$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeMouse {
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    public static string ForegroundTitle() {
        StringBuilder sb = new StringBuilder(256);
        GetWindowText(GetForegroundWindow(), sb, sb.Capacity);
        return sb.ToString();
    }
}
"@

function Emit([string]$token) {
    [Console]::Out.WriteLine($token)
    [Console]::Out.Flush()
}

$leftDown = $false
$rightDown = $false
while ($true) {
    $left = ([NativeMouse]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
    $right = ([NativeMouse]::GetAsyncKeyState(0x02) -band 0x8000) -ne 0
    $skip = [NativeMouse]::ForegroundTitle().Contains("Klika")
    if ($left -and -not $leftDown -and -not $skip) { Emit "LC" }
    if ($right -and -not $rightDown -and -not $skip) { Emit "RC" }
    $leftDown = $left
    $rightDown = $right
    Start-Sleep -Milliseconds 8
}
