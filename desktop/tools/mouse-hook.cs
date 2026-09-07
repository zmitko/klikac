using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Program
{
    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_RBUTTONDOWN = 0x0204;

    private delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref MSG lpMsg);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    private static IntPtr hook = IntPtr.Zero;
    private static readonly LowLevelMouseProc proc = HookCallback;
    private static readonly object gate = new object();
    private static long lastEmitMs;
    private static string lastToken = "";
    private static StreamWriter log;

    private static void Main()
    {
        var stdout = Console.OpenStandardOutput();
        Console.SetOut(new StreamWriter(stdout, new UTF8Encoding(false), 16) { AutoFlush = true });

        var logDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "klikac");
        Directory.CreateDirectory(logDir);
        log = new StreamWriter(Path.Combine(logDir, "mouse-hook.log"), false, new UTF8Encoding(false))
        {
            AutoFlush = true
        };

        IntPtr hMod = GetModuleHandle("user32.dll");
        hook = SetWindowsHookEx(WH_MOUSE_LL, proc, hMod, 0);
        Log("hook=" + (hook != IntPtr.Zero) + " err=" + Marshal.GetLastWin32Error());
        Emit("READY");

        var poll = new Thread(PollLoop) { IsBackground = true };
        poll.Start();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessage(ref msg);
        }

        if (hook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(hook);
        }
    }

    private static void PollLoop()
    {
        bool leftDown = false;
        bool rightDown = false;
        while (true)
        {
            bool left = (GetAsyncKeyState(0x01) & 0x8000) != 0;
            bool right = (GetAsyncKeyState(0x02) & 0x8000) != 0;
            if (left && !leftDown)
            {
                TryEmit("LC");
            }
            if (right && !rightDown)
            {
                TryEmit("RC");
            }
            leftDown = left;
            rightDown = right;
            Thread.Sleep(8);
        }
    }

    private static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = wParam.ToInt32();
            if (msg == WM_LBUTTONDOWN)
            {
                TryEmit("LC");
            }
            else if (msg == WM_RBUTTONDOWN)
            {
                TryEmit("RC");
            }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }

    private static bool ForegroundIsKlikac()
    {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
        {
            return false;
        }
        var sb = new StringBuilder(256);
        GetWindowText(hwnd, sb, sb.Capacity);
        return sb.ToString().IndexOf("Klika", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static void TryEmit(string token)
    {
        if (ForegroundIsKlikac())
        {
            return;
        }
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        lock (gate)
        {
            if (token == lastToken && now - lastEmitMs < 40)
            {
                return;
            }
            lastToken = token;
            lastEmitMs = now;
        }
        Emit(token);
    }

    private static void Emit(string line)
    {
        Console.Out.WriteLine(line);
        Console.Out.Flush();
        Log(line);
    }

    private static void Log(string line)
    {
        if (log == null)
        {
            return;
        }
        try
        {
            log.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + line);
        }
        catch
        {
        }
    }
}
