[CmdletBinding()]
param(
    [Parameter(Position = 0, Mandatory = $true)][ValidateSet('Start','Stop','Status')][string] $Action,
    [Parameter(Mandatory = $true)][string] $ConfigPath,
    [string] $WorkerEnvironmentFile,
    [string] $NodePath = (Get-Command node -ErrorAction Stop).Source,
    [ValidateRange(5,60)][int] $StopTimeoutSeconds = 30,
    [switch] $ForceStop
)

$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This management script requires Windows.' }
if ($ForceStop -and $Action -ne 'Stop') { throw 'ForceStop is only valid with Stop.' }

function Resolve-ReviewedFile([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'An existing file path is required.' }
    $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf) -or $resolved.Contains('"') -or $resolved.Contains("`r") -or $resolved.Contains("`n")) { throw 'A valid file path is required.' }
    return $resolved
}
function Set-PrivateAcl([string] $Target) {
    $acl = Get-Acl -LiteralPath $Target
    $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetOwner($operatorSid)
    $inheritance = if (Test-Path -LiteralPath $Target -PathType Container) { [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($identity in @($operatorSid,$systemSid)) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inheritance,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))
    }
    Set-Acl -LiteralPath $Target -AclObject $acl
}
function Get-ExpectedArguments($Metadata) {
    return '--env-file="{0}" "{1}" worker --login --config "{2}"' -f $Metadata.environmentFile,$Metadata.runnerPath,$Metadata.configPath
}
function Get-OwnedProcess($Metadata) {
    if (-not $Metadata -or $Metadata.version -ne 1 -or $Metadata.runnerPath -ne $resolvedRunner -or $Metadata.configPath -ne $resolvedConfig) { return $null }
    $managedProcessId = 0
    if (-not [int]::TryParse([string]$Metadata.processId,[ref]$managedProcessId) -or $managedProcessId -le 0) { return $null }
    foreach ($value in @($Metadata.nodePath,$Metadata.environmentFile,$Metadata.runnerPath,$Metadata.configPath)) {
        if (-not [IO.Path]::IsPathRooted([string]$value) -or ([string]$value).Contains('"') -or ([string]$value).Contains("`r") -or ([string]$value).Contains("`n")) { return $null }
    }
    $candidate = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $managedProcessId) -ErrorAction SilentlyContinue
    if (-not $candidate -or -not $candidate.ExecutablePath -or -not $candidate.CreationDate -or -not $candidate.CommandLine) { return $null }
    if (-not ([string]$candidate.ExecutablePath).Equals([string]$Metadata.nodePath,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName([string]$candidate.ExecutablePath) -ne 'node.exe') { return $null }
    if ($candidate.CreationDate.ToUniversalTime().ToString('O') -ne $Metadata.createdAt) { return $null }
    if (-not ([string]$candidate.CommandLine).EndsWith((Get-ExpectedArguments $Metadata),[StringComparison]::Ordinal)) { return $null }
    return $candidate
}
function Write-ControlStatus([string] $Status, $Metadata) {
    # Never emit command lines, environment contents, URLs, credentials or logs.
    @{status=$Status;processId=if ($Metadata) {$Metadata.processId} else {$null};createdAt=if ($Metadata) {$Metadata.createdAt} else {$null};authentication='check_hub_availability'} | ConvertTo-Json -Compress
}

$resolvedConfig = Resolve-ReviewedFile $ConfigPath
$resolvedRunner = Resolve-ReviewedFile (Join-Path $PSScriptRoot 'runner.mjs')
$repositoryDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')).TrimEnd('\')
$repositoryPrefix = $repositoryDirectory + '\'
if ($resolvedConfig.StartsWith($repositoryPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'The local configuration must be outside the repository.' }
$configuration = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json
$workerDirectory = if ($configuration.workDirectory) { [IO.Path]::GetFullPath([string]$configuration.workDirectory) } else { Join-Path $env:LOCALAPPDATA 'OperationHubSellpiaSync\runs' }
if (-not [IO.Path]::IsPathRooted($workerDirectory) -or $workerDirectory.Equals($repositoryDirectory,[StringComparison]::OrdinalIgnoreCase) -or $workerDirectory.StartsWith($repositoryPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'The work directory must be an absolute private path outside the repository.' }
$metadataPath = Join-Path $workerDirectory 'worker-control.json'
$lockPath = Join-Path $workerDirectory 'runner.lock'
$stopRequestPath = Join-Path $workerDirectory 'stop-request.json'
$metadata = if (Test-Path -LiteralPath $metadataPath -PathType Leaf) { Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json } else { $null }
$ownedProcess = Get-OwnedProcess $metadata

if ($Action -eq 'Status') {
    Write-ControlStatus $(if ($ownedProcess) {'process_running'} elseif ($metadata) {'stopped_or_identity_changed'} else {'not_managed'}) $metadata
    return
}
if ($Action -eq 'Stop') {
    if (-not $ownedProcess) { Write-ControlStatus 'no_verified_owned_process' $metadata; return }
    $lock = if (Test-Path -LiteralPath $lockPath -PathType Leaf) { Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } else { $null }
    if (-not $lock -or $lock.pid -ne $metadata.processId -or $lock.owner -ne $metadata.owner) { throw 'The active worker ownership lock does not match. No stop was sent.' }
    $request = @{pid=$metadata.processId;owner=$metadata.owner;requestedAt=[DateTime]::UtcNow.ToString('O')} | ConvertTo-Json -Compress
    if (Test-Path -LiteralPath $stopRequestPath -PathType Leaf) {
        $existing = Get-Content -LiteralPath $stopRequestPath -Raw | ConvertFrom-Json
        if ($existing.pid -ne $metadata.processId -or $existing.owner -ne $metadata.owner) { throw 'A different stop request exists. It was not overwritten.' }
    } else {
        $stream = [IO.File]::Open($stopRequestPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $bytes=[Text.UTF8Encoding]::new($false).GetBytes($request);$stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
        Set-PrivateAcl $stopRequestPath
    }
    $deadline = [DateTime]::UtcNow.AddSeconds($StopTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $ownedProcess = Get-OwnedProcess $metadata
    } while ($ownedProcess -and [DateTime]::UtcNow -lt $deadline)
    if ($ownedProcess -and $ForceStop) {
        # Recheck exact process identity immediately before explicit force.
        if (Get-OwnedProcess $metadata) { Stop-Process -Id $metadata.processId -Force }
        Write-ControlStatus 'force_stop_sent' $metadata
    } elseif ($ownedProcess) { Write-ControlStatus 'graceful_stop_pending' $metadata }
    else { Write-ControlStatus 'stopped' $metadata }
    return
}

if ($ownedProcess) { Write-ControlStatus 'already_running' $metadata; return }
if (Test-Path -LiteralPath $lockPath) { throw 'A runner lock exists. Review the existing runner before starting another process.' }
if (Test-Path -LiteralPath $stopRequestPath) { throw 'An earlier stop request exists. Review it before starting a new worker.' }
$resolvedNode = Resolve-ReviewedFile $NodePath
$resolvedEnvironment = Resolve-ReviewedFile $WorkerEnvironmentFile
if ([IO.Path]::GetFileName($resolvedNode) -ne 'node.exe') { throw 'The reviewed Node.js executable is required.' }
if ($resolvedEnvironment.StartsWith($repositoryPrefix,[StringComparison]::OrdinalIgnoreCase)) { throw 'The worker environment file must be outside the repository.' }
if ($configuration.verifiedReady -ne $true) { throw 'The official collection contract must be verified before startup.' }
& $resolvedNode $resolvedRunner check-config --config $resolvedConfig
if ($LASTEXITCODE -ne 0) { throw 'Runner configuration validation failed.' }
$logDirectory = Join-Path $workerDirectory 'worker-logs'
[void][IO.Directory]::CreateDirectory($logDirectory)
Set-PrivateAcl $logDirectory
$instance = [Guid]::NewGuid().ToString()
if ($metadata) { Move-Item -LiteralPath $metadataPath -Destination (Join-Path $logDirectory ('worker-control-{0}.json' -f $instance)) }
$launchMetadata = @{version=1;runnerPath=$resolvedRunner;configPath=$resolvedConfig;environmentFile=$resolvedEnvironment;nodePath=$resolvedNode}
$launchArguments = Get-ExpectedArguments $launchMetadata
$started = Start-Process -FilePath $resolvedNode -ArgumentList $launchArguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDirectory ($instance+'-stdout.log')) -RedirectStandardError (Join-Path $logDirectory ($instance+'-stderr.log')) -PassThru
$ownershipDeadline = [DateTime]::UtcNow.AddSeconds(10)
do {
    Start-Sleep -Milliseconds 100
    $started.Refresh()
    if ($started.HasExited) { throw 'The worker exited during startup. Review its private local log.' }
    $lock = if (Test-Path -LiteralPath $lockPath -PathType Leaf) { Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } else { $null }
} while ((-not $lock -or $lock.pid -ne $started.Id) -and [DateTime]::UtcNow -lt $ownershipDeadline)
if (-not $lock -or $lock.pid -ne $started.Id -or -not $lock.owner) { throw 'Worker ownership was not confirmed. No other process was stopped.' }
$actualProcess = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $started.Id)
$launchMetadata.processId=$started.Id;$launchMetadata.createdAt=$actualProcess.CreationDate.ToUniversalTime().ToString('O');$launchMetadata.owner=$lock.owner
if (-not (Get-OwnedProcess $launchMetadata)) { throw 'The new worker identity could not be verified.' }
[IO.File]::WriteAllText($metadataPath,($launchMetadata | ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
Set-PrivateAcl $metadataPath
Write-ControlStatus 'started' $launchMetadata
