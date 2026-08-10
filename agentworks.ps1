param([ValidateSet('prepare-host','setup-master','install','setup-worker','start','stop','restart','status','doctor','smoke')][string]$Command='status')
$ErrorActionPreference='Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDir = if($env:AGENTWORKS_STATE_DIR){$env:AGENTWORKS_STATE_DIR}else{Join-Path $Root '.agentworks'}
$EnvFile = Join-Path $StateDir 'config\master.env'
function Assert-Admin { $p=New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if(!$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run Agentworks PowerShell as Administrator.'} }
function Bootstrap {
  New-Item -ItemType Directory -Force (Join-Path $StateDir 'config'),(Join-Path $StateDir 'postgres'),(Join-Path $StateDir 'logs'),(Join-Path $StateDir 'generated'),(Join-Path $StateDir 'master-agent-home'),(Join-Path $StateDir 'runtime') | Out-Null
  $previous=$env:AGENTWORKS_STATE_DIR
  try { $env:AGENTWORKS_STATE_DIR=$StateDir; & node.exe (Join-Path $Root 'scripts\bootstrap.mjs'); if($LASTEXITCODE -ne 0){throw "Bootstrap failed ($LASTEXITCODE)."} }
  finally { $env:AGENTWORKS_STATE_DIR=$previous }
}
function Quote-Sh([string]$Value) {
  $apostrophe=([char]39).ToString()
  $quote=([char]34).ToString()
  return $apostrophe + $Value.Replace($apostrophe, $apostrophe + $quote + $apostrophe + $quote + $apostrophe) + $apostrophe
}
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
function Invoke-WslRoot([string]$Script) {
  $distro=Get-WslDistro
  # Passing a compound shell string through wsl.exe is lossy on some Server
  # images (notably redirections such as 2>&1).  A compact base64 payload
  # keeps the WSL command boundary deterministic without a temporary script.
  $payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Script))
  $runner="echo $payload | base64 -d | bash"
  & wsl.exe -d $distro -u root -- bash -lc $runner
  if ($LASTEXITCODE -ne 0) { throw "WSL command failed ($LASTEXITCODE)." }
}
function Setup-Master {
  Assert-Admin
  $distro=Get-WslDistro
  # Docker Desktop is not a dependency: Windows Server hosts the Linux Master
  # in its Ubuntu WSL2 distribution, while tenant VMs remain native Hyper-V VMs.
  Invoke-WslRoot 'export DEBIAN_FRONTEND=noninteractive; apt-get update; (apt-get install -y docker.io docker-compose-v2 || apt-get install -y docker.io docker-compose-plugin); apt-get install -y qemu-utils; (service docker start || true); if ! docker info >/dev/null 2>&1; then nohup dockerd >/var/log/agentworks-dockerd.log 2>&1 & for n in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done; fi; docker info >/dev/null'
}
function Ensure-HypervBaseImage {
  # The generic Ubuntu cloud image is UEFI/GPT and must be booted as a
  # Generation-2 VM. Hyper-V Generation 2 accepts VHDX, not the legacy VHD
  # format. Do this conversion here under the installing Administrator's WSL
  # identity; the runtime worker deliberately runs as SYSTEM and cannot rely
  # on an interactive user's WSL registration.
  $base=Join-Path $StateDir 'runtime\hyperv\base'
  $source=Join-Path $base 'ubuntu-24.04-generic.img'
  $vhdx=Join-Path $base 'ubuntu-24.04-generic.vhdx'
  if(Test-Path $vhdx){ return }
  New-Item -ItemType Directory -Force $base | Out-Null
  if(!(Test-Path $source)) {
    $partial="$source.partial"
    Remove-Item -Force $partial -ErrorAction SilentlyContinue
    & "$env:SystemRoot\System32\curl.exe" '--fail' '--location' '--retry' '3' '--connect-timeout' '30' '--output' $partial 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img'
    if($LASTEXITCODE -ne 0){throw "Unable to download the Ubuntu Hyper-V base image (curl exit $LASTEXITCODE)."}
    Move-Item -Force $partial $source
  }
  $sourceWsl=ConvertTo-WslPath $source
  $vhdxWsl=ConvertTo-WslPath $vhdx
  Invoke-WslRoot "command -v qemu-img >/dev/null && qemu-img convert -p -f qcow2 -O vhdx $(Quote-Sh $sourceWsl) $(Quote-Sh $vhdxWsl)"
  if(!(Test-Path $vhdx)){throw 'qemu-img did not create the Hyper-V VHDX base image.'}
  & compact.exe /U /Q $vhdx | Out-Null
  if($LASTEXITCODE -ne 0){throw "Unable to uncompress the Hyper-V VHDX base image (compact exit $LASTEXITCODE)."}
  & cipher.exe /D /Q $vhdx | Out-Null
  if($LASTEXITCODE -ne 0){throw "Unable to decrypt the Hyper-V VHDX base image (cipher exit $LASTEXITCODE)."}
  & fsutil.exe sparse setflag $vhdx 0 | Out-Null
  if($LASTEXITCODE -ne 0){throw "Unable to clear the sparse flag on the Hyper-V VHDX base image (fsutil exit $LASTEXITCODE)."}
}
function Compose([string[]]$Arguments) {
  $wslRoot=ConvertTo-WslPath $Root
  $wslEnv=ConvertTo-WslPath $EnvFile
  $quotedArgs=($Arguments | ForEach-Object { Quote-Sh $_ }) -join ' '
  # WSL2's native worker reaches the Master through the WSL VM address; make
  # the published Docker port visible to that host-side bridge only.
  $script="cd $(Quote-Sh $wslRoot) && MASTER_BIND_HOST=0.0.0.0 docker compose --project-directory $(Quote-Sh $wslRoot) --env-file $(Quote-Sh $wslEnv) -f $(Quote-Sh ($wslRoot + '/compose.yaml')) -f $(Quote-Sh ($wslRoot + '/compose.windows.yaml')) $quotedArgs"
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
  $restartRequired=$false
  foreach($feature in @('Microsoft-Windows-Subsystem-Linux','VirtualMachinePlatform')) {
    $state=(Get-WindowsOptionalFeature -Online -FeatureName $feature).State
    if($state -ne 'Enabled') {
      & dism.exe /online /enable-feature "/featurename:$feature" /all /norestart
      if($LASTEXITCODE -notin @(0,3010)){throw "Unable to enable $feature (DISM exit $LASTEXITCODE)."}
      $restartRequired=$true
    }
  }
  if($restartRequired){throw 'Windows WSL features were enabled. Reboot Windows, then rerun .\agentworks.ps1 prepare-host.'}
  # EC2 Server images often include the inbox wsl.exe but not the current WSL
  # package. Install the signed Microsoft WSL MSI from its official release so
  # this path does not depend on Microsoft Store availability.
  $wslProbe=& wsl.exe --version 2>&1
  if($LASTEXITCODE -ne 0) {
    $release=Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/microsoft/WSL/releases/latest'
    $asset=@($release.assets | Where-Object { $_.name -match '^wsl\..*\.x64\.msi$' } | Select-Object -First 1)
    if(!$asset){throw 'Could not locate the official x64 WSL release asset.'}
    $msi=Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $msi
    Start-Process msiexec.exe -Wait -ArgumentList @('/i',$msi,'/qn','/norestart')
  }
  $distros=@(& wsl.exe -l -q 2>$null | ForEach-Object { $_.Trim([char]0x00).Trim() } | Where-Object { $_ })
  if ($distros -notcontains 'Ubuntu') {
    & wsl.exe --install -d Ubuntu --web-download --no-launch
    if($LASTEXITCODE -ne 0){throw "Unable to install Ubuntu for WSL (exit $LASTEXITCODE)."}
  }
  Setup-Master
}
function Setup-Worker {
  Assert-Admin
  if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required for the native Worker. Install it, then rerun .\agentworks.ps1 setup-worker.' }
  $role=Get-WindowsFeature -Name Hyper-V -ErrorAction SilentlyContinue
  if (!$role -or !$role.Installed) { Install-WindowsFeature -Name Hyper-V -IncludeManagementTools | Out-Null; throw 'Hyper-V was installed. Reboot Windows, then rerun .\agentworks.ps1 setup-worker.' }
  Setup-Master
  Ensure-HypervBaseImage
  $workerDir=Join-Path $Root 'worker'
  & npm.cmd --prefix $workerDir install --omit=dev
  if($LASTEXITCODE -ne 0){throw "Unable to install Worker dependencies (npm exit $LASTEXITCODE)."}
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
