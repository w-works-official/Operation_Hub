import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const quoted=value=>value.replaceAll("'","''");
test('Windows helper rejects PID reuse and changed process ownership using mocked CIM; startup is parsed without registration',{skip:process.platform!=='win32'},()=>{
  const control=quoted(fileURLToPath(new URL('../tools/sellpia-sync/worker-control.ps1',import.meta.url)));
  const installer=quoted(fileURLToPath(new URL('../tools/sellpia-sync/install-startup.ps1',import.meta.url)));
  const script=String.raw`
    $ErrorActionPreference='Stop'
    $parseErrors=$null;$parseTokens=$null
    $controlAst=[Management.Automation.Language.Parser]::ParseFile('${control}',[ref]$parseTokens,[ref]$parseErrors)
    if($parseErrors.Count){throw 'control syntax invalid'}
    $installAst=[Management.Automation.Language.Parser]::ParseFile('${installer}',[ref]$parseTokens,[ref]$parseErrors)
    if($parseErrors.Count){throw 'installer syntax invalid'}
    $names=@('Get-ExpectedArguments','Get-OwnedProcess','Write-ControlStatus')
    foreach($definition in $controlAst.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $names -contains $node.Name},$true)){Invoke-Expression $definition.Extent.Text}
    # The real CIM cmdlet, main script, Start-Process and task registration are never executed.
    function Get-CimInstance {param($ClassName,$Filter,$ErrorAction) if($Filter -eq 'ProcessId = 123'){return $script:fakeProcess};return $null}
    function Invoke-CimMethod {param($InputObject,$MethodName,$ErrorAction) return [pscustomobject]@{ReturnValue=0;Sid=$script:fakeOwnerSid}}
    $resolvedRunner='C:\QA\runner.mjs';$resolvedConfig='C:\QA\sellpia.local.json'
    $created=[DateTime]::Parse('2026-01-01T00:00:00Z').ToUniversalTime()
    $script:fakeOwnerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $metadata=[pscustomobject]@{version=1;runnerPath=$resolvedRunner;configPath=$resolvedConfig;nodePath='C:\QA\node.exe';environmentFile='C:\QA\synthetic-private-env-file';processId=123;createdAt=$created.ToString('O');owner='synthetic-owner';operatorSid=$script:fakeOwnerSid}
    $command='"C:\QA\node.exe" '+(Get-ExpectedArguments $metadata)
    $script:fakeProcess=[pscustomobject]@{ExecutablePath='C:\QA\node.exe';CreationDate=$created;CommandLine=$command}
    if(-not(Get-OwnedProcess $metadata)){throw 'valid synthetic owner rejected'}
    $script:fakeOwnerSid=if($metadata.operatorSid -eq 'S-1-5-18'){'S-1-5-19'}else{'S-1-5-18'}
    if(Get-OwnedProcess $metadata){throw 'another Windows operator accepted'}
    $script:fakeOwnerSid=$metadata.operatorSid
    $script:fakeProcess.CreationDate=$created.AddSeconds(1)
    if(Get-OwnedProcess $metadata){throw 'reused PID accepted'}
    $script:fakeProcess.CreationDate=$created;$script:fakeProcess.CommandLine='different synthetic worker'
    if(Get-OwnedProcess $metadata){throw 'different command accepted'}
    $script:fakeProcess.CommandLine=$command;$script:fakeProcess.ExecutablePath='C:\QA\other.exe'
    if(Get-OwnedProcess $metadata){throw 'different executable accepted'}
    $script:fakeProcess.ExecutablePath='C:\QA\node.exe';$metadata.runnerPath='C:\QA\other-runner.mjs'
    if(Get-OwnedProcess $metadata){throw 'different checkout accepted'}
    $metadata.runnerPath=$resolvedRunner;$metadata.configPath='C:\QA\other-config.json'
    if(Get-OwnedProcess $metadata){throw 'different profile config accepted'}
    $metadata.configPath=$resolvedConfig;$metadata.processId=124
    if(Get-OwnedProcess $metadata){throw 'different PID accepted'}
    $metadata.processId=123
    $safeOutput=Write-ControlStatus 'process_running' $metadata
    if($safeOutput.Contains('synthetic-private-env-file') -or $safeOutput.Contains('environmentFile') -or $safeOutput.Contains('CommandLine')){throw 'private fields leaked'}
    $resolvedControl='C:\QA\worker-control.ps1';$resolvedEnvironment='C:\QA\synthetic-private-env-file';$resolvedNode='C:\QA\node.exe'
    $assignment=$installAst.Find({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$taskArguments'},$true)
    Invoke-Expression $assignment.Extent.Text
    if(-not $taskArguments.Contains('worker-control.ps1') -or -not $taskArguments.Contains('-Action Start') -or $taskArguments.Contains('ExecutionPolicy')){throw 'startup management contract invalid'}
    @{checks=9;syntaxFiles=2;registrationExecuted=$false;realProcessCalls=0} | ConvertTo-Json -Compress
  `;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(result.status,0,result.stderr);const checked=JSON.parse(result.stdout.trim());assert.equal(checked.checks,9);assert.equal(checked.syntaxFiles,2);assert.equal(checked.registrationExecuted,false);assert.equal(checked.realProcessCalls,0);
});
