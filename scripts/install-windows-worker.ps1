param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$StateDir
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$taskName = 'Agentworks LocalAgentWorker'
$keepaliveTaskName = 'Agentworks WSL Docker Keepalive'
$envFile = Join-Path $StateDir 'config\master.env'
$values = @{}
Get-Content $envFile | Where-Object { $_ -match '=' } | ForEach-Object { $i=$_.IndexOf('='); $values[$_.Substring(0,$i)]=$_.Substring($i+1) }
$port = if ($values.MASTER_PORT) { $values.MASTER_PORT } else { '8080' }
# Docker's published Windows port is stable across WSL2 VM restarts, whereas
# the distro's private IP is not.  The SYSTEM Hyper-V Worker must therefore
# use loopback rather than capture a per-boot WSL address in its launcher.
$masterHost = '127.0.0.1'
$workerScript = Join-Path $Root 'worker\src\worker.mjs'
$adapter = Join-Path $Root 'worker\runtime\hyperv-limactl.cmd'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
$description = 'Agentworks native Worker. Hyper-V and CLI credentials remain on the host; Master communicates only through its loopback WebSocket.'
$taskEnv = @{
  WORKER_ID = if ($env:WORKER_ID) { $env:WORKER_ID } else { 'windows-local' }
  WORKER_TOKEN = $values.WORKER_TOKEN
  MASTER_AGENT_TOKEN = $values.MASTER_AGENT_TOKEN
  MASTER_AGENT_URL = "http://${masterHost}:$port"
  AGENTWORKS_ROOT = $Root
  AGENTWORKS_STATE_DIR = $StateDir
  MASTER_WS_URL = "ws://${masterHost}:$port/ws/worker"
  HOST_RUNTIME = 'hyperv'
  LIMACTL_BIN = $adapter
  LIMA_HOME = (Join-Path $StateDir 'runtime')
  AUTO_PROVISION = 'true'
  AUTO_CELLS = 'aw-a1,aw-b1'
  AGENTWORKS_GUEST_USER = 'ubuntu'
  AGENTWORKS_GUEST_HOME = '/home/ubuntu'
}
# ScheduledTask has no portable Environment block. A private launcher writes
# the variables just before Node starts; it is deliberately state-owned.
$launcher = Join-Path $StateDir 'generated\start-windows-worker.cmd'
$workerLog = Join-Path $StateDir 'logs\worker.log'
New-Item -ItemType Directory -Force (Split-Path $launcher) | Out-Null
New-Item -ItemType Directory -Force (Split-Path $workerLog) | Out-Null
($taskEnv.GetEnumerator() | Sort-Object Name | ForEach-Object { "set `"$($_.Name)=$($_.Value)`"" }) + @("`"$node`" `"$workerScript`" >> `"$workerLog`" 2>&1") | Set-Content -Encoding ascii $launcher
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$launcher`"" -WorkingDirectory $Root
# A host worker must survive SSH/RDP logout.  SYSTEM has the Hyper-V privilege
# and access to the private state directory, so no interactive desktop session
# is required for the deterministic bridge and tenant lifecycle.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
# Re-registering a task does not terminate a child node.exe that Task Scheduler
# has already detached. Stop only the exact Worker script process so repeated
# setup-worker/upgrade remains single-instance without touching unrelated Node.
$workerPattern=[regex]::Escape($workerScript)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $workerPattern } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$keepaliveAction = New-ScheduledTaskAction -Execute $wsl -Argument '-d Ubuntu -u root -- bash -lc "while :; do sleep 3600; done"'
# WSL distributions are registered per Windows user, not per SYSTEM. S4U lets
# this background task use the installing administrator's Ubuntu distro without
# requiring an interactive RDP/SSH desktop session or persisting a password.
$wslPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Highest
$keepaliveTask = New-ScheduledTask -Action $keepaliveAction -Trigger $trigger -Settings $settings -Principal $wslPrincipal -Description 'Keeps the WSL2 Linux Docker engine alive for Agentworks Master.'
Unregister-ScheduledTask -TaskName $keepaliveTaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $keepaliveTaskName -InputObject $keepaliveTask -Force | Out-Null
Start-ScheduledTask -TaskName $keepaliveTaskName
Start-ScheduledTask -TaskName $taskName
Write-Output "Windows Host Worker installed: $taskName (with $keepaliveTaskName)"
