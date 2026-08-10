param([ValidateSet('install','setup-worker','start','stop','restart','status','doctor','smoke')][string]$Command='status')
$ErrorActionPreference='Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = if($env:AGENTWORKS_STATE_DIR){$env:AGENTWORKS_STATE_DIR}else{Join-Path $Root '.agentworks'}
$EnvFile = Join-Path $StateDir 'config\master.env'
function Assert-Admin { $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if(!$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run Agentworks PowerShell as Administrator.'} }
function Bootstrap { New-Item -ItemType Directory -Force (Join-Path $StateDir 'config'),(Join-Path $StateDir 'postgres'),(Join-Path $StateDir 'logs'),(Join-Path $StateDir 'generated'),(Join-Path $StateDir 'master-agent-home'),(Join-Path $StateDir 'runtime') | Out-Null; & node.exe (Join-Path $Root 'scripts\bootstrap.mjs') }
function Compose([string[]]$Arguments) { & docker.exe compose --project-directory $Root --env-file $EnvFile -f (Join-Path $Root 'compose.yaml') @Arguments }
function Setup-Worker {
  Assert-Admin
  if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required for the native Worker. Install it, then rerun .\agentworks.ps1 setup-worker.' }
  $role=Get-WindowsFeature -Name Hyper-V -ErrorAction SilentlyContinue
  if (!$role -or !$role.Installed) { Install-WindowsFeature -Name Hyper-V -IncludeManagementTools | Out-Null; throw 'Hyper-V was installed. Reboot Windows, then rerun .\agentworks.ps1 setup-worker.' }
  if (!(Get-Command docker.exe -ErrorAction SilentlyContinue) -or ((docker.exe version --format '{{.Server.Os}}' 2>$null) -ne 'linux')) { throw 'A running Docker engine in Linux-container mode is required for the Master.' }
  & npm.cmd install --prefix (Join-Path $Root 'worker') --omit=dev
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'scripts\install-windows-worker.ps1') -Root $Root -StateDir $StateDir
}
switch($Command) {
  'install' { Bootstrap; Compose @('up','-d','--build'); Setup-Worker; & $MyInvocation.MyCommand.Path status }
  'setup-worker' { Bootstrap; Setup-Worker }
  'start' { Bootstrap; Compose @('up','-d'); Setup-Worker }
  'stop' { Stop-ScheduledTask -TaskName 'Agentworks LocalAgentWorker' -ErrorAction SilentlyContinue; Compose @('down') }
  'restart' { & $MyInvocation.MyCommand.Path stop; & $MyInvocation.MyCommand.Path start }
  'status' { Bootstrap; Compose @('ps'); Get-ScheduledTask -TaskName 'Agentworks LocalAgentWorker' -ErrorAction SilentlyContinue | Select-Object TaskName,State }
  'doctor' { Bootstrap; Write-Output "OS: $([Environment]::OSVersion.VersionString)"; docker.exe version --format 'Docker: {{.Server.Version}} {{.Server.Os}}'; node.exe --version; Get-WindowsFeature Hyper-V | Select-Object Name,Installed; Get-VM -ErrorAction SilentlyContinue | Select-Object Name,State; Compose @('ps') }
  'smoke' { throw 'Run the browser/API smoke after the Windows Worker reports two ready tenant VMs. This command is enabled by the Windows E2E harness.' }
}
