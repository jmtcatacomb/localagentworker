param(
  [Parameter(Mandatory=$true)][string]$Root,
  [Parameter(Mandatory=$true)][string]$StateDir
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$taskName = 'Agentworks LocalAgentWorker'
$envFile = Join-Path $StateDir 'config\master.env'
$values = @{}
Get-Content $envFile | Where-Object { $_ -match '=' } | ForEach-Object { $i=$_.IndexOf('='); $values[$_.Substring(0,$i)]=$_.Substring($i+1) }
$port = if ($values.MASTER_PORT) { $values.MASTER_PORT } else { '8080' }
$workerScript = Join-Path $Root 'worker\src\worker.mjs'
$adapter = Join-Path $Root 'worker\runtime\hyperv-limactl.cmd'
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365)
$description = 'Agentworks native Worker. Hyper-V and CLI credentials remain on the host; Master communicates only through its loopback WebSocket.'
$taskEnv = @{
  WORKER_ID = if ($env:WORKER_ID) { $env:WORKER_ID } else { 'windows-local' }
  WORKER_TOKEN = $values.WORKER_TOKEN
  MASTER_AGENT_TOKEN = $values.MASTER_AGENT_TOKEN
  MASTER_AGENT_URL = "http://127.0.0.1:$port"
  AGENTWORKS_ROOT = $Root
  AGENTWORKS_STATE_DIR = $StateDir
  MASTER_WS_URL = "ws://127.0.0.1:$port/ws/worker"
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
New-Item -ItemType Directory -Force (Split-Path $launcher) | Out-Null
($taskEnv.GetEnumerator() | Sort-Object Name | ForEach-Object { "set `"$($_.Name)=$($_.Value)`"" }) + @("`"$node`" `"$workerScript`"") | Set-Content -Encoding ascii $launcher
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/d /c `"$launcher`"" -WorkingDirectory $Root
# A host worker must survive SSH/RDP logout.  SYSTEM has the Hyper-V privilege
# and access to the private state directory, so no interactive desktop session
# is required for the deterministic bridge and tenant lifecycle.
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "Windows Host Worker installed: $taskName"
