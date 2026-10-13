[CmdletBinding()]
param(
    [switch] $Install,
    [Parameter(Mandatory = $true)][string] $ConfigPath,
    [Parameter(Mandatory = $true)][string] $WorkerEnvironmentFile,
    [string] $NodePath = (Get-Command node -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
if (-not $Install) {
    throw 'No task was installed. Supply -Install only after reviewing the runner and setting up the dedicated profile.'
}

function Resolve-TaskFile([string] $Value) {
    $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).Path
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf) -or $resolved.Contains('"') -or $resolved.Contains("`r") -or $resolved.Contains("`n")) {
        throw 'A valid absolute file path is required.'
    }
    return $resolved
}

$resolvedNode = Resolve-TaskFile $NodePath
$resolvedConfig = Resolve-TaskFile $ConfigPath
$resolvedEnvironment = Resolve-TaskFile $WorkerEnvironmentFile
$resolvedRunner = Resolve-TaskFile (Join-Path $PSScriptRoot 'runner.mjs')
if ([IO.Path]::GetFileName($resolvedNode) -ne 'node.exe') { throw 'The runner requires the reviewed Node.js executable.' }

# The environment file is passed to Node without reading or printing its contents.
# Keep it outside Git, restrict its ACL to this operator, and provision only the
# narrowly scoped worker secret; never put a Sellpia password or cookies here.
$repositoryDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$repositoryPrefix = $repositoryDirectory.TrimEnd('\') + '\'
if ($resolvedEnvironment.StartsWith($repositoryPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The worker environment file must be outside the repository.'
}

& $resolvedNode $resolvedRunner check-config --config $resolvedConfig
if ($LASTEXITCODE -ne 0) { throw 'Runner configuration validation failed.' }
$configuration = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json
if ($configuration.verifiedReady -ne $true) { throw 'Official collection contract is not verified. No startup task was installed.' }

# Use the verified headed persistent-context path. The operator authenticates
# directly only if required, then all jobs reuse that same live context.
$taskArguments = '--env-file="{0}" "{1}" worker --login --config "{2}"' -f $resolvedEnvironment, $resolvedRunner, $resolvedConfig
$taskAction = New-ScheduledTaskAction -Execute $resolvedNode -Argument $taskArguments -WorkingDirectory $PSScriptRoot
$currentOperator = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentOperator
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $currentOperator -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)

# Register only. Do not start a task or store the operator's Windows password.
$taskName = 'OperationHub Sellpia Readonly Collector'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    throw 'An existing task has this name. Review it manually; this installer does not overwrite it.'
}
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Collects official Sellpia source downloads. Never applies a Hub production snapshot.' | Out-Null
Write-Output 'Startup task registered for the current operator. It was not started.'
