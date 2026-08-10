param([ValidateSet('prepare-host','setup-master','install','setup-worker','start','stop','restart','status','doctor','smoke')][string]$Command='status')
$ErrorActionPreference='Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = if($env:AGENTWORKS_STATE_DIR){$env:AGENTWORKS_STATE_DIR}else{Join-Path $Root '.agentworks'}
$EnvFile = Join-Path $StateDir 'config\master.env'
function Assert-Admin { $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if(!$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run Agentworks PowerShell as Administrator.'} }
function Bootstrap { New-Item -ItemType Directory -Force (Join-Path $StateDir 'config'),(Join-Path $StateDir 'postgres'),(Join-Path $StateDir 'logs'),(Join-Path $StateDir 'generated'),(Join-Path $StateDir 'master-agent-home'),(Join-Path $StateDir 'runtime') | Out-Null; & node.exe (Join-Path $Root 'scripts\bootstrap.mjs') }
function Quote-Sh([string]$Value) { return "'" + $Value.Replace("'", "'\"'\"'") + "'" }
function ConvertTo-WslPath([string]$Path) {
  $full=[IO.Path]::GetFullPath($Path)
  if ($full -notmatch '^([A-Za-z]):\\(.*)$') { throw "WSL Docker currently requires Agentworks on a local drive, got: $full" }
  return ('/mnt/' + $Matches[1].ToLowerInvariant() + '/' + ($Matches[2] -replace '\\','/'))
}
function Get-WslDistro {
  if (!(Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL is unavailable. Run .\agentworks.ps1 prepare-host, reboot, then rerun this command.' }
  $distros=@(& wsl.exe -l -q 2>$null | ForEach-Object { $_.Trim([char]0x00).Trim() } | Where-Object { $_ })
  if ($distros -notcontains 'Ubuntu') { throw 'WSL Ubuntu is not installed. Run .\agentworks.ps1 prepare-host, reboot if requested, then rerun this command.' }
  return 'Ubuntu'
}
function Invoke-WslRoot([string]$Script) { $distro=Get-WslDistro; & wsl.exe -d $distro -u root -- bash -lc $Script; if ($LASTEXITCODE -ne 0) { throw "WSL command failed ($LASTEXITCODE)." } }
function Setup-Master {
  Assert-Admin
  $distro=Get-WslDistro
  # Docker Desktop is not a dependency: Windows Server hosts the Linux Master
  # in its Ubuntu WSL2 distribution, while tenant VMs remain native Hyper-V VMs.
  Invoke-WslRoot 'export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin; (service docker start || true); if ! docker info >/dev/null 2>&1; then nohup dockerd >/var/log/agentworks-dockerd.log 2>&1 & for n in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; fi; docker info >/dev/null'
}
function Compose([string[]]$Arguments) {
  $wslRoot=ConvertTo-WslPath $Root
  $wslEnv=ConvertTo-WslPath $EnvFile
  $quotedArgs=($Arguments | ForEach-Object { Quote-Sh $_ }) -join ' '
  $script="cd $(Quote-Sh $wslRoot) && docker compose --project-directory $(Quote-Sh $wslRoot) --env-file $(Quote-Sh $wslEnv) -f $(Quote-Sh ($wslRoot + '/compose.yaml')) $quotedArgs"
  Invoke-WslRoot $script
}
function Prepare-Host {
  Assert-Admin
  if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) {
    $msi=Join-Path $env:TEMP 'agentworks-node-v22.17.0-x64.msi'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/v22.17.0/node-v22.17.0-x64.msi' -OutFile $msi
    Start-Process msiexec.exe -Wait -ArgumentList @('/i',$msi,'/qn','/norestart')
    $env:Path="$env:ProgramFiles\nodejs;$env:Path"
  }
  if (!(Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw 'WSL is not available on this Windows image.' }
  $distros=@(& wsl.exe -l -q 2>$null | ForEach-Object { $_.Trim([char]0x00).Trim() } | Where-Object { $_ })
  if ($distros -notcontains 'Ubuntu') {
    & wsl.exe --install -d Ubuntu --no-launch
    throw 'WSL Ubuntu was requested. Reboot Windows, complete the first Ubuntu launch once, then rerun .\agentworks.ps1 prepare-host.'
  }
  Setup-Master
}
function Setup-Worker {
  Assert-Admin
  if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required for the native Worker. Install it, then rerun .\agentworks.ps1 setup-worker.' }
  $role=Get-WindowsFeature -Name Hyper-V -ErrorAction SilentlyContinue
  if (!$role -or !$role.Installed) { Install-WindowsFeature -Name Hyper-V -IncludeManagementTools | Out-Null; throw 'Hyper-V was installed. Reboot Windows, then rerun .\agentworks.ps1 setup-worker.' }
  & npm.cmd install --prefix (Join-Path $Root 'worker') --omit=dev
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\install-windows-worker.ps1') -Root $Root -StateDir $StateDir
}
switch($Command) {
  'prepare-host' { Prepare-Host }
  'setup-master' { Setup-Master }
  'install' { Prepare-Host; Bootstrap; Compose @('up','-d','--build'); Setup-Worker; & $MyInvocation.MyCommand.Path status }
  'setup-worker' { Bootstrap; Setup-Worker }
  'start' { Setup-Master; Bootstrap; Compose @('up','-d'); Setup-Worker }
  'stop' { Stop-ScheduledTask -TaskName 'Agentworks LocalAgentWorker' -ErrorAction SilentlyContinue; Compose @('down') }
  'restart' { & $MyInvocation.MyCommand.Path stop; & $MyInvocation.MyCommand.Path start }
  'status' { Bootstrap; Compose @('ps'); Get-ScheduledTask -TaskName 'Agentworks LocalAgentWorker' -ErrorAction SilentlyContinue | Select-Object TaskName,State }
  'doctor' { Bootstrap; Write-Output "OS: $([Environment]::OSVersion.VersionString)"; node.exe --version; Get-WindowsFeature Hyper-V | Select-Object Name,Installed; Get-VM -ErrorAction SilentlyContinue | Select-Object Name,State; Compose @('ps') }
  'smoke' { throw 'Run the browser/API smoke after the Windows Worker reports two ready tenant VMs. This command is enabled by the Windows E2E harness.' }
}
