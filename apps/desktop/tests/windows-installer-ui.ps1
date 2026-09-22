Add-Type -AssemblyName System.Drawing
if (-not ('InstallerCapture' -as [type])) {
    # Drawing's implementation and interface assemblies vary between .NET Framework and Core.
    $installerCaptureReferences = @(
        @([System.Drawing.Bitmap], [System.Drawing.Graphics], [System.Drawing.Color], [System.Text.RegularExpressions.Regex]) |
            ForEach-Object {
                $_.Assembly.Location
                $_.GetInterfaces() | ForEach-Object { $_.Assembly.Location }
            } | Where-Object { $_ -ne [object].Assembly.Location } | Sort-Object -Unique
    )
    # Core's compiler needs the Thread reference facade, not its runtime CoreLib implementation.
    if ($PSVersionTable.PSEdition -eq 'Core') {
        $installerThreadReference = Join-Path $PSHOME 'ref/System.Threading.Thread.dll'
        if (-not (Test-Path -LiteralPath $installerThreadReference -PathType Leaf)) { throw 'PowerShell Thread reference assembly is unavailable' }
        $installerCaptureReferences += $installerThreadReference
    }
    Add-Type -ReferencedAssemblies $installerCaptureReferences -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class InstallerCapture {
    public static string ProductName;
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    public static void Initialize() { SetProcessDPIAware(); }
    public delegate bool WindowCallback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr window, string name);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool RedrawWindow(IntPtr window, IntPtr rect, IntPtr region, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string name, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("dwmapi.dll")] static extern int DwmFlush();
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, string text);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wparam, IntPtr lparam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SetWindowText(IntPtr window, string text);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }

    public static string Bounds(IntPtr window) {
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Could not read window bounds");
        return rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom;
    }

    public static void MoveBy(IntPtr window, int x, int y) {
        Rect rect;
        if (!GetWindowRect(window, out rect) || !SetWindowPos(window, IntPtr.Zero, rect.Left + x, rect.Top + y, 0, 0, 0x15))
            throw new InvalidOperationException("Could not move window");
    }

    public static bool HasIncompleteWindow(int process) {
        bool incomplete = false;
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (owner == process && title.ToString().Contains(ProductName) && IsWindowVisible(window)
                && GetProp(window, "HarnessInstaller.Ready") == IntPtr.Zero) incomplete = true;
            return !incomplete;
        }, IntPtr.Zero);
        return incomplete;
    }

    public static IntPtr FindClass(IntPtr parent, string name) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr unused) {
            var kind = new StringBuilder(128);
            GetClassName(child, kind, kind.Capacity);
            if (kind.ToString() == name) result = child;
            return result == IntPtr.Zero;
        }, IntPtr.Zero);
        return result;
    }

    public static int Progress(IntPtr parent) {
        IntPtr window = FindClass(parent, "HarnessInstallerProgress");
        if (window == IntPtr.Zero) throw new InvalidOperationException("Progress page is missing");
        RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x101);
        var text = new StringBuilder(128);
        GetWindowText(window, text, text.Capacity);
        var percent = System.Text.RegularExpressions.Regex.Match(text.ToString(), @"\d+");
        if (!percent.Success) throw new InvalidOperationException("Progress caption is missing");
        return int.Parse(percent.Value);
    }

    public static IntPtr WaitForText(IntPtr parent, string expected, bool prefix) {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 15000) {
            IntPtr result = IntPtr.Zero;
            EnumChildWindows(parent, delegate(IntPtr child, IntPtr data) {
                var text = new StringBuilder(256);
                GetWindowText(child, text, text.Capacity);
                if (IsWindowVisible(child) && (prefix ? text.ToString().StartsWith(expected, StringComparison.Ordinal) : text.ToString() == expected)) result = child;
                return true;
            }, IntPtr.Zero);
            if (result != IntPtr.Zero) return result;
            System.Threading.Thread.Sleep(25);
        }
        throw new TimeoutException("Visible control did not appear: " + expected);
    }

    public static IntPtr FindText(int process, string expected) { return FindTextCore(process, expected, false); }
    public static IntPtr FindDialogText(int process, string expected) { return FindTextCore(process, expected, true); }
    public static string Text(IntPtr control) {
        var text = new StringBuilder(512);
        IntPtr result;
        if (SendMessageTimeout(control, 0xD, (IntPtr)text.Capacity, text, 0x2, 5000, out result) == IntPtr.Zero) {
            throw new InvalidOperationException("Could not read owned native control text");
        }
        return text.ToString();
    }
    // Dedicated running-application refusal; no ID scanning or generic button fallback.
    public sealed class RefusalElement {
        public IntPtr Handle, Root;
        public int ProcessId, ControlId;
        public string ClassName, Text;
        public bool Exists, Visible, Enabled, PushButton;
    }
    public sealed class RefusalAction {
        public IntPtr Root, Body, Button;
    }
    public static RefusalAction SelectRefusalAcknowledgement(int process, string title, string body, RefusalElement[] items) {
        if (process <= 0 || String.IsNullOrWhiteSpace(title) || String.IsNullOrWhiteSpace(body) || items == null || items.Length > 64)
            throw new InvalidOperationException("Invalid owned refusal selector");
        RefusalAction selected = null;
        foreach (var root in items) {
            if (!root.Exists || root.Handle == IntPtr.Zero || root.Handle != root.Root || root.ProcessId != process ||
                !root.Visible || !root.Enabled || root.ClassName != "#32770" || root.Text == null || root.Text.TrimEnd(' ') != title) continue;
            int bodies = 0, buttons = 0;
            RefusalElement message = null, button = null;
            foreach (var item in items) {
                if (!item.Exists || item.Handle == root.Handle || item.Root != root.Handle || !item.Visible || !item.Enabled) continue;
                if (item.ProcessId != process) throw new InvalidOperationException("Foreign refusal control");
                if (item.ClassName == "Static" && item.Text == body) { bodies++; message = item; }
                if (item.ClassName == "Button") { buttons++; button = item; }
            }
            if (bodies == 0) continue;
            if (selected != null || bodies != 1 || buttons != 1 || button == null || !button.PushButton || button.ControlId != 2 ||
                (button.Text != "OK" && button.Text != "&OK" && button.Text != "确定" && button.Text != "确定(&O)"))
                throw new InvalidOperationException("Ambiguous or invalid refusal acknowledgement");
            selected = new RefusalAction { Root = root.Handle, Body = message.Handle, Button = button.Handle };
        }
        if (selected == null) throw new InvalidOperationException("Owned refusal acknowledgement is missing");
        return selected;
    }
    public static void AssertSameRefusalAction(RefusalAction before, RefusalAction after, IntPtr prompt) {
        if (before == null || after == null || prompt == IntPtr.Zero || before.Body != prompt || after.Body != prompt ||
            before.Root != after.Root || before.Button != after.Button || before.Button == IntPtr.Zero)
            throw new InvalidOperationException("Owned refusal handles changed");
    }
    static RefusalElement[] ReadRefusalElements(int process) {
        var items = new RefusalElement[64];
        int count = 0;
        var timer = System.Diagnostics.Stopwatch.StartNew();
        Action<IntPtr, IntPtr> capture = delegate(IntPtr handle, IntPtr root) {
            if (count >= items.Length || timer.ElapsedMilliseconds >= 2000) throw new InvalidOperationException("Refusal observation limit reached");
            uint owner;
            GetWindowThreadProcessId(handle, out owner);
            if (!IsWindow(handle) || owner != process || TopLevel(handle) != root) throw new InvalidOperationException("Refusal control ownership changed");
            var kind = new StringBuilder(128);
            if (GetClassName(handle, kind, kind.Capacity) == 0) throw new InvalidOperationException("Refusal class unavailable");
            var text = new StringBuilder(2048);
            IntPtr result;
            if (SendMessageTimeout(handle, 0xD, (IntPtr)text.Capacity, text, 0x2, 50, out result) == IntPtr.Zero)
                throw new InvalidOperationException("Refusal text unavailable");
            GetWindowThreadProcessId(handle, out owner);
            if (!IsWindow(handle) || owner != process || TopLevel(handle) != root) throw new InvalidOperationException("Refusal control became stale");
            int buttonStyle = GetWindowLong(handle, -16) & 0xf;
            items[count++] = new RefusalElement { Handle = handle, Root = root, ProcessId = (int)owner,
                ControlId = GetDlgCtrlID(handle), ClassName = kind.ToString(), Text = text.ToString(), Exists = true,
                Visible = IsWindowVisible(handle), Enabled = IsWindowEnabled(handle), PushButton = buttonStyle == 0 || buttonStyle == 1 };
        };
        Exception failure = null;
        bool enumerated = EnumWindows(delegate(IntPtr root, IntPtr unused) {
            try {
                uint owner;
                GetWindowThreadProcessId(root, out owner);
                if (owner != process || !IsWindowVisible(root) || !IsWindowEnabled(root)) return true;
                var kind = new StringBuilder(128);
                if (GetClassName(root, kind, kind.Capacity) == 0) throw new InvalidOperationException("Refusal root class unavailable");
                if (kind.ToString() != "#32770") return true;
                capture(root, root);
                EnumChildWindows(root, delegate(IntPtr child, IntPtr data) {
                    try {
                        if (IsWindowVisible(child) && IsWindowEnabled(child)) capture(child, root);
                        return true;
                    } catch (Exception error) { failure = error; return false; }
                }, IntPtr.Zero);
                return failure == null;
            } catch (Exception error) { failure = error; return false; }
        }, IntPtr.Zero);
        if (failure != null) throw new InvalidOperationException("Owned refusal snapshot failed", failure);
        if (!enumerated) throw new InvalidOperationException("Refusal enumeration failed");
        Array.Resize(ref items, count);
        return items;
    }
    public static void AcknowledgeOwnedRefusal(int process, IntPtr prompt, string title, string body) {
        var before = SelectRefusalAcknowledgement(process, title, body, ReadRefusalElements(process));
        var after = SelectRefusalAcknowledgement(process, title, body, ReadRefusalElements(process));
        AssertSameRefusalAction(before, after, prompt);
        uint owner, rootOwner, bodyOwner;
        GetWindowThreadProcessId(after.Button, out owner);
        GetWindowThreadProcessId(after.Root, out rootOwner);
        GetWindowThreadProcessId(after.Body, out bodyOwner);
        if (owner != process || rootOwner != process || bodyOwner != process || !IsWindow(after.Body) ||
            TopLevel(after.Body) != after.Root || !IsWindow(after.Root) || !IsWindow(after.Button) ||
            !IsWindowVisible(after.Button) || !IsWindowEnabled(after.Button) || GetDlgCtrlID(after.Button) != 2 ||
            TopLevel(after.Button) != after.Root || !IsWindowVisible(after.Root) || !IsWindowEnabled(after.Root))
            throw new InvalidOperationException("Owned refusal action became stale");
        Click(after.Button);
    }

    public static IntPtr FindControlById(IntPtr parent, int id) {
        IntPtr result = IntPtr.Zero;
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr unused) {
            if (GetDlgCtrlID(child) == id && IsWindowVisible(child)) {
                if (result != IntPtr.Zero) throw new InvalidOperationException("Multiple visible controls share one expected stock ID");
                result = child;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
    public static IntPtr FindStockWindow(int process) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (owner == process && IsWindowVisible(window) && title.ToString().Contains(ProductName)) {
                if (result != IntPtr.Zero) throw new InvalidOperationException("Multiple stock installer windows in owned process");
                result = window;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
    public static IntPtr FindButton(int process, string expected) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                var text = new StringBuilder(256);
                var kind = new StringBuilder(64);
                GetWindowText(child, text, text.Capacity);
                GetClassName(child, kind, kind.Capacity);
                if (IsWindowVisible(child) && kind.ToString() == "Button" && text.ToString() == expected) result = child;
                return result == IntPtr.Zero;
            }, IntPtr.Zero);
            return result == IntPtr.Zero;
        }, IntPtr.Zero);
        return result;
    }

    static IntPtr FindTextCore(int process, string expected, bool dialogOnly) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            if (dialogOnly && !IsWindowVisible(GetDlgItem(window, 1)) && !IsWindowVisible(GetDlgItem(window, 2)) && !IsWindowVisible(GetDlgItem(window, 6))) return true;
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                var text = new StringBuilder(512);
                GetWindowText(child, text, text.Capacity);
                if (IsWindowVisible(child) && text.ToString().Contains(expected)) result = child;
                return result == IntPtr.Zero;
            }, IntPtr.Zero);
            return result == IntPtr.Zero;
        }, IntPtr.Zero);
        return result;
    }

    public static string VisibleText(int process) {
        var output = new StringBuilder();
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            output.AppendLine("WINDOW " + window + " OK=" + GetDlgItem(window, 1) + " YES=" + GetDlgItem(window, 6));
            EnumChildWindows(window, delegate(IntPtr child, IntPtr unused) {
                var text = new StringBuilder(1024);
                GetWindowText(child, text, text.Capacity);
                var kind = new StringBuilder(256);
                GetClassName(child, kind, kind.Capacity);
                Rect rect;
                GetWindowRect(child, out rect);
                if (IsWindowVisible(child)) output.AppendLine(kind + " " + child + " ID=" + GetDlgCtrlID(child) + " " + rect.Left + "," + rect.Top + "," + rect.Right + "," + rect.Bottom + " " + text.ToString());
                return true;
            }, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        return output.ToString();
    }

    public static IntPtr TopLevel(IntPtr child) { return GetAncestor(child, 2); }
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);

    public static void Click(IntPtr control) {
        if (!PostMessage(control, 0xF5, IntPtr.Zero, IntPtr.Zero)) throw new InvalidOperationException("Could not click native button");
    }

    public static IntPtr Find(int process) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (owner == process && title.ToString().Contains(ProductName) && GetProp(window, "HarnessInstaller.Ready") != IntPtr.Zero) {
                if (result != IntPtr.Zero) throw new InvalidOperationException("Multiple preview windows in test process");
                result = window;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static void Reveal(IntPtr window) {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (GetProp(window, "HarnessInstaller.Ready") == IntPtr.Zero) {
            if (timer.ElapsedMilliseconds > 10000) throw new TimeoutException("Native page did not finish creating controls");
            System.Threading.Thread.Sleep(10);
        }
        ShowWindow(window, 8);
        RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x181);
    }

    public static string Save(IntPtr window, string path) {
        Reveal(window);
        return CaptureWindow(window, path);
    }

    // Stock NSIS has no HarnessInstaller.Ready property. The pinned English MUI2 finish page
    // creates bitmap/title/text/run in order; nsDialogs assigns zero-based IDs starting at 1200.
    // https://github.com/kichik/nsis/blob/v304/Contrib/nsDialogs/nsDialogs.c
    // https://github.com/electron-userland/electron-builder-binaries/blob/nsis-3.0.4.1/nsis/Contrib/Modern%20UI%202/Pages/Finish.nsh
    public static string SaveStock(int process, IntPtr window, int pageControlId, string path) {
        if (pageControlId != 1019 && pageControlId != 1203) throw new ArgumentException("Unsupported stock installer page control");
        RequireStockWindow(process, window);
        if (pageControlId == 1203) StockRun(process, window);
        else RequireStockControl(process, window, 1019, "Edit");
        IntPtr action = RequireStockControl(process, window, 1, "Button");
        if (pageControlId == 1203 && Text(action) != "&Finish") throw new InvalidOperationException("Stock finish action caption differs");
        return CaptureWindow(window, path);
    }

    // Validate before toggling Run; a reboot radio can occupy the same numeric control ID.
    public static IntPtr StockRun(int process, IntPtr window) {
        RequireStockWindow(process, window);
        IntPtr control = RequireStockControl(process, window, 1203, "Button");
        if ((GetWindowLong(control, -16) & 0xf) != 3 || Text(control) != "&Run " + ProductName)
            throw new InvalidOperationException("Stock finish requires the expected Run auto-checkbox");
        return control;
    }

    static void RequireStockWindow(int process, IntPtr window) {
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        var kind = new StringBuilder(128);
        GetClassName(window, kind, kind.Capacity);
        var title = new StringBuilder(256);
        GetWindowText(window, title, title.Capacity);
        if (process <= 0 || owner != process || !IsWindow(window) || TopLevel(window) != window
            || !IsWindowVisible(window) || !IsWindowEnabled(window) || kind.ToString() != "#32770"
            || String.IsNullOrEmpty(ProductName) || !title.ToString().Contains(ProductName))
            throw new InvalidOperationException("Stock capture requires a live owned installer dialog");
    }

    static IntPtr RequireStockControl(int process, IntPtr window, int id, string expectedClass) {
        IntPtr control = FindControlById(window, id);
        uint owner;
        GetWindowThreadProcessId(control, out owner);
        var kind = new StringBuilder(128);
        GetClassName(control, kind, kind.Capacity);
        if (control == IntPtr.Zero || !IsWindow(control) || owner != process || TopLevel(control) != window
            || !IsWindowVisible(control) || !IsWindowEnabled(control) || kind.ToString() != expectedClass)
            throw new InvalidOperationException("Stock capture requires visible enabled " + expectedClass + " control " + id);
        return control;
    }

    // Failure evidence only, not page admission: owned windows, at most 64 entries and two seconds.
    // WM_GETTEXT is bounded so an unresponsive installer cannot block its eventual teardown.
    public static string DiagnosticText(int process) {
        if (process <= 0) throw new ArgumentException("Diagnostic process must be owned");
        var output = new StringBuilder();
        var timer = System.Diagnostics.Stopwatch.StartNew();
        int count = 0;
        IntPtr foreground = GetForegroundWindow();
        uint foregroundOwner;
        GetWindowThreadProcessId(foreground, out foregroundOwner);
        output.AppendLine("FOREGROUND=" + foreground + " PID=" + foregroundOwner);
        WindowCallback observe = delegate(IntPtr window, IntPtr unused) {
            if (count >= 64 || timer.ElapsedMilliseconds >= 2000) return false;
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != process) return true;
            count++;
            var text = new StringBuilder(256);
            var kind = new StringBuilder(64);
            GetClassName(window, kind, kind.Capacity);
            IntPtr result;
            bool read = SendMessageTimeout(window, 0xD, (IntPtr)text.Capacity, text, 0x2, 50, out result) != IntPtr.Zero;
            string check = "n/a";
            if (kind.ToString() == "Button" && timer.ElapsedMilliseconds < 2000)
                check = SendMessageTimeout(window, 0xF0, IntPtr.Zero, IntPtr.Zero, 0x2, 50, out result) != IntPtr.Zero ? result.ToString() : "<unresponsive>";
            output.AppendLine("HWND=" + window + " PID=" + owner + " ROOT=" + TopLevel(window)
                + " CLASS=" + kind + " ID=" + GetDlgCtrlID(window) + " VISIBLE=" + IsWindowVisible(window)
                + " ENABLED=" + IsWindowEnabled(window) + " STYLE=" + GetWindowLong(window, -16)
                + " CHECK=" + check + " TEXT=" + (read ? text.ToString() : "<unresponsive>"));
            return count < 64 && timer.ElapsedMilliseconds < 2000;
        };
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner == process) {
                if (!observe(window, IntPtr.Zero)) return false;
                EnumChildWindows(window, observe, IntPtr.Zero);
            }
            return count < 64 && timer.ElapsedMilliseconds < 2000;
        }, IntPtr.Zero);
        output.AppendLine("LIMIT_REACHED=" + (count >= 64 || timer.ElapsedMilliseconds >= 2000));
        return output.ToString();
    }

    static string CaptureWindow(IntPtr window, string path) {
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Could not read preview bounds");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.Clear(Color.White);
                IntPtr dc = graphics.GetHdc();
                try {
                    if (!PrintWindow(window, dc, 2)) throw new InvalidOperationException("PrintWindow failed");
                } finally { graphics.ReleaseHdc(dc); }
            }
            bitmap.Save(path, ImageFormat.Png);
        }
        return width + "x" + height;
    }

    // Capture only the test window and its own white backdrop, including DWM's external shadow.
    public static string SaveWithShadow(IntPtr window, string path) {
        Reveal(window);
        Rect rect;
        if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Could not read preview bounds");
        const int padding = 64;
        int x = rect.Left - padding, y = rect.Top - padding;
        int width = rect.Right - rect.Left + padding * 2, height = rect.Bottom - rect.Top + padding * 2;
        IntPtr foreground = GetForegroundWindow();
        bool wasTopmost = (GetWindowLong(window, -20) & 8) != 0;
        IntPtr backdrop = CreateWindowEx(0x08000088, "STATIC", "Installer Lab capture backdrop", 0x80000006,
                                        x, y, width, height, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (backdrop == IntPtr.Zero) throw new InvalidOperationException("Could not create owned capture backdrop");
        try {
            ShowWindow(backdrop, 8);
            RedrawWindow(backdrop, IntPtr.Zero, IntPtr.Zero, 0x181);
            SetWindowPos(window, new IntPtr(-1), 0, 0, 0, 0, 0x43);
            SetForegroundWindow(window);
            RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x181);
            DwmFlush();
            // Allow the system's activation/shadow animation to settle before the visual sample.
            System.Threading.Thread.Sleep(300);
            DwmFlush();
            using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
                using (var graphics = Graphics.FromImage(bitmap)) {
                    graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height));
                }
                bitmap.Save(path, ImageFormat.Png);
            }
        } finally {
            SetWindowPos(window, wasTopmost ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, 0x13);
            DestroyWindow(backdrop);
            if (foreground != IntPtr.Zero && IsWindow(foreground)) SetForegroundWindow(foreground);
        }
        return width + "x" + height;
    }
}
'@
}
