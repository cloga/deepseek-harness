# Execute the source discovery functions against fake native/UIA providers; never load real UIA or invoke a control.
param([Parameter(Mandatory = $true)][string]$SourceFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$tokens = $null
$parseErrors = $null
$source = [Management.Automation.Language.Parser]::ParseFile($SourceFile, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Native helper source failed PowerShell parsing' }
foreach ($name in @('Read-OwnedWindows', 'Read-OwnedConfirmation')) {
    $definitions = @($source.FindAll({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
    }, $true))
    if ($definitions.Count -ne 1) { throw "Expected exactly one source function: $name" }
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
public sealed class FakeNativeWindow {
    public string hwnd, owner = "1376584", rootOwner = "1376584", title = "Apply Plugin Change";
    public uint pid = 9000, livePid = 9000;
    public long liveRootOwner = 1376584;
    public int width = 400, height = 240;
    public bool visible = true, minimized = false;
}
public static class OwnedDialogWin32 {
    public static FakeNativeWindow[] Windows = new FakeNativeWindow[0];
    public static int Enumerations;
    public static FakeNativeWindow[] Enumerate(uint pid) { Enumerations++; return Windows; }
    private static FakeNativeWindow Find(IntPtr hwnd) {
        foreach (var value in Windows) if (value.hwnd == hwnd.ToInt64().ToString()) return value;
        return null;
    }
    public static bool IsWindow(IntPtr hwnd) { return Find(hwnd) != null; }
    public static uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid) {
        var value = Find(hwnd); pid = value == null ? 0 : value.livePid; return 1;
    }
    public static IntPtr GetAncestor(IntPtr hwnd, uint flags) {
        var value = Find(hwnd); return new IntPtr(value == null ? 0 : value.liveRootOwner);
    }
    public static int GetWindowText(IntPtr hwnd, StringBuilder text, int count) {
        var value = Find(hwnd); if (value == null) return 0;
        text.Append(value.title); return value.title.Length;
    }
}
namespace Windows.Automation {
    public enum TreeScope { Children, Descendants }
    public sealed class Condition { public static readonly Condition TrueCondition = new Condition(); }
    public sealed class ControlType {
        public string ProgrammaticName;
        private ControlType(string name) { ProgrammaticName = name; }
        public static readonly ControlType Button = new ControlType("ControlType.Button");
        public static readonly ControlType Text = new ControlType("ControlType.Text");
    }
    public sealed class CurrentValues {
        public int NativeWindowHandle, ProcessId = 9000;
        public string Name = "";
        public ControlType ControlType = ControlType.Text;
        public bool IsEnabled = true, IsOffscreen;
    }
    public sealed class AutomationElement {
        public CurrentValues Current = new CurrentValues();
        public AutomationElement[] Descendants = new AutomationElement[0];
        public static Dictionary<long, AutomationElement> Canonical = new Dictionary<long, AutomationElement>();
        public static int RootReads, CanonicalReads;
        // Reproduce the observed omission, rather than returning the native dialog through UIA discovery.
        public static AutomationElement RootElement { get { RootReads++; return new AutomationElement(); } }
        public static AutomationElement FromHandle(IntPtr hwnd) {
            CanonicalReads++; AutomationElement value;
            return Canonical.TryGetValue(hwnd.ToInt64(), out value) ? value : null;
        }
        public AutomationElement[] FindAll(TreeScope scope, Condition condition) { return Descendants; }
    }
}
'@

$mainProcess = [pscustomobject]@{ Id = 9000; HasExited = $false }
$diagnosticClock = [Diagnostics.Stopwatch]::StartNew()
$script:nextDiagnosticMs = [long]::MaxValue
function Write-Observation($value) { }
$passed = [Collections.Generic.List[string]]::new()
function New-Control([string]$name, [bool]$button) {
    $control = [Windows.Automation.AutomationElement]::new()
    $control.Current.Name = $name
    if ($button) { $control.Current.ControlType = [Windows.Automation.ControlType]::Button }
    return $control
}
function New-Dialog([int]$hwnd = 917860) {
    $window = [FakeNativeWindow]::new()
    $window.hwnd = $hwnd.ToString()
    $dialog = [Windows.Automation.AutomationElement]::new()
    $dialog.Current.NativeWindowHandle = $hwnd
    $dialog.Descendants = @(
        (New-Control 'Cancel' $true),
        (New-Control 'Apply and Restart Host' $true),
        (New-Control 'Restart the Desktop Host to apply this change?' $false)
    )
    [Windows.Automation.AutomationElement]::Canonical[$hwnd] = $dialog
    return $window
}
function Reset-Providers {
    [Windows.Automation.AutomationElement]::Canonical.Clear()
    [Windows.Automation.AutomationElement]::RootReads = 0
    [Windows.Automation.AutomationElement]::CanonicalReads = 0
    [OwnedDialogWin32]::Enumerations = 0
    [OwnedDialogWin32]::Windows = @((New-Dialog))
}
function Read-Actual { return Read-OwnedConfirmation 9000 ([IntPtr]1376584) }
function Expect-None([string]$name) {
    if ($null -ne (Read-Actual)) { throw "Unexpected discovery: $name" }
    $passed.Add($name)
}
function Expect-Error([string]$name, [string]$expected) {
    $failure = $null
    try { $null = Read-Actual } catch { $failure = $_.Exception.Message }
    if ($null -eq $failure -or !$failure.Contains($expected)) { throw "Expected rejection missing: $name" }
    $passed.Add($name)
}

Reset-Providers
$found = Read-Actual
if ($null -eq $found -or $found.hwnd -ne [IntPtr]917860 -or $found.cancel.Current.Name -cne 'Cancel') {
    throw 'Native dialog omitted by UIA root was not discovered'
}
if ([OwnedDialogWin32]::Enumerations -ne 1 -or [Windows.Automation.AutomationElement]::RootReads -ne 0 -or
    [Windows.Automation.AutomationElement]::CanonicalReads -ne 1) { throw 'Discovery did not use native enumeration and canonical UIA' }
$passed.Add('native-dialog-omitted-from-uia-root')

foreach ($case in @('wrong-pid', 'wrong-root-owner', 'main-hwnd')) {
    Reset-Providers
    switch ($case) {
        'wrong-pid' { [OwnedDialogWin32]::Windows[0].livePid = 9001 }
        'wrong-root-owner' { [OwnedDialogWin32]::Windows[0].liveRootOwner = 123 }
        'main-hwnd' { [OwnedDialogWin32]::Windows = @((New-Dialog 1376584)) }
    }
    Expect-None $case
    if ([Windows.Automation.AutomationElement]::CanonicalReads -ne 0) { throw 'Foreign/main candidate reached canonical control traversal' }
}

foreach ($case in @('missing-cancel', 'missing-apply', 'missing-message', 'wrong-case-cancel', 'not-a-button', 'duplicate-cancel')) {
    Reset-Providers
    $dialog = [Windows.Automation.AutomationElement]::Canonical[917860]
    switch ($case) {
        'missing-cancel' { $dialog.Descendants = @($dialog.Descendants[1], $dialog.Descendants[2]) }
        'missing-apply' { $dialog.Descendants = @($dialog.Descendants[0], $dialog.Descendants[2]) }
        'missing-message' { $dialog.Descendants = @($dialog.Descendants[0], $dialog.Descendants[1]) }
        'wrong-case-cancel' { $dialog.Descendants[0].Current.Name = 'cancel' }
        'not-a-button' { $dialog.Descendants[0].Current.ControlType = [Windows.Automation.ControlType]::Text }
        'duplicate-cancel' { $dialog.Descendants += (New-Control 'Cancel' $true) }
    }
    Expect-None $case
}

Reset-Providers
[Windows.Automation.AutomationElement]::Canonical[917860].Current.NativeWindowHandle = 917861
Expect-Error 'canonical-handle-mismatch' 'Cannot bind owned confirmation HWND'

Reset-Providers
[OwnedDialogWin32]::Windows += (New-Dialog 917861)
Expect-Error 'ambiguous-dialogs' 'Ambiguous owned confirmation'
[OwnedDialogWin32]::Windows = @([OwnedDialogWin32]::Windows[1], [OwnedDialogWin32]::Windows[0])
Expect-Error 'ambiguous-reversed-order' 'Ambiguous owned confirmation'

Reset-Providers
if ($null -eq (Read-Actual)) { throw 'First discovery unexpectedly absent' }
[OwnedDialogWin32]::Windows += (New-Dialog 917861)
Expect-Error 'reenumeration-observes-new-ambiguity' 'Ambiguous owned confirmation'
if ([OwnedDialogWin32]::Enumerations -ne 2) { throw 'Discovery cached candidates instead of re-enumerating' }

@{ passed = $passed.ToArray(); realGuiUsed = $false; nativeInvokeAvailable = $false } | ConvertTo-Json -Depth 4 -Compress
