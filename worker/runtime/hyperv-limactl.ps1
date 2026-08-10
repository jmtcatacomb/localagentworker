# Hyper-V adapter for the Worker create/start/stop/edit/shell/copy/list contract.
# It intentionally creates a real Hyper-V VM per tenant, never a WSL distro.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$ErrorActionPreference = 'Stop'
$argvCopy = @($args)
if (!$argvCopy.Count) { throw 'agentworks Hyper-V adapter: missing command' }
$runtimeHome = [Environment]::GetEnvironmentVariable('LIMA_HOME')
if (!$runtimeHome) { $runtimeHome = Join-Path (Get-Location) '.agentworks\runtime' }
$root = Join-Path $runtimeHome 'hyperv'
$guestUser = if ($env:AGENTWORKS_GUEST_USER) { $env:AGENTWORKS_GUEST_USER } else { 'ubuntu' }

function Fail([string]$message) { throw "agentworks Hyper-V adapter: $message" }
function Valid-Name([string]$name) { return $name -match '^[a-z][a-z0-9-]{0,62}$' }
function Opt([string]$name) { $i=[Array]::IndexOf($argvCopy,$name); if ($i -ge 0 -and $i + 1 -lt $argvCopy.Count) { return [string]$argvCopy[$i+1] }; return $null }
function Instance-Dir([string]$name) { Join-Path (Join-Path $root 'instances') $name }
function Meta-Path([string]$name) { Join-Path (Instance-Dir $name) 'meta.json' }
function Read-Meta([string]$name) { $p=Meta-Path $name; if (Test-Path $p) { return Get-Content -Raw $p | ConvertFrom-Json }; return $null }
function Write-Meta([string]$name,$meta) { $meta | ConvertTo-Json -Depth 8 | Set-Content -NoNewline -Encoding utf8 (Meta-Path $name) }
function Vm-Name([string]$name) { "agentworks-$name" }
function Resolve-VM($meta) {
  if ($meta.vmId) { return Get-VM -Id ([guid]$meta.vmId) -ErrorAction SilentlyContinue }
  $matches=@(Get-VM -Name (Vm-Name $meta.name) -ErrorAction SilentlyContinue)
  if($matches.Count -eq 1){return $matches[0]}
  # Legacy metadata lacked a GUID. Never fan a lifecycle command out to every
  # duplicate display name; use one deterministic object until it is repaired.
  return @($matches | Sort-Object Id | Select-Object -First 1)[0]
}
function Get-State($meta) { $vm=Resolve-VM $meta; if (!$vm) { return 'stopped' }; if ($vm.State -eq 'Running') { return 'running' }; return 'stopped' }
function Require-HyperV { if (!(Get-Command Get-VM -ErrorAction SilentlyContinue)) { Fail 'Hyper-V PowerShell module is unavailable; enable the Hyper-V role and restart Windows' } }
function Ensure-AgentworksSwitch {
  # Server/EC2 images may lack Hyper-V's desktop-only Default Switch.
  $name='Agentworks NAT'; $prefix='172.28.0.0/16'; $gateway='172.28.0.1'
  $switch=Get-VMSwitch -Name $name -ErrorAction SilentlyContinue
  if (!$switch) { $switch=New-VMSwitch -Name $name -SwitchType Internal }
  $adapter=Get-NetAdapter -Name "vEthernet ($name)" -ErrorAction SilentlyContinue
  if (!$adapter) { Fail "Hyper-V NAT adapter for $name is unavailable" }
  $ip=Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -eq $gateway }
  if (!$ip) { New-NetIPAddress -InterfaceIndex $adapter.ifIndex -IPAddress $gateway -PrefixLength 16 | Out-Null }
  if (!(Get-NetNat -Name 'AgentworksNAT' -ErrorAction SilentlyContinue)) { New-NetNat -Name 'AgentworksNAT' -InternalIPInterfaceAddressPrefix $prefix | Out-Null }
  return $switch
}
function Guest-StaticIp([string]$name) {
  $bytes=[System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($name))
  return "172.28.$(2 + ($bytes[0] % 252)).$(2 + ($bytes[1] % 252))"
}
function Guest-StaticMac([string]$name) {
  $bytes=[System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($name))
  return ('00:15:5d:{0:x2}:{1:x2}:{2:x2}' -f $bytes[2],$bytes[3],$bytes[4])
}
function Write-SeedIso([string]$directory,[string]$publicKey,[string]$guestIp,[string]$guestMac) {
  New-Item -ItemType Directory -Force $directory | Out-Null
  $userData = @"
#cloud-config
users:
  - name: $guestUser
    groups: [sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $publicKey
ssh_pwauth: false
package_update: false
growpart:
  mode: auto
  devices: [/]
resize_rootfs: true
"@
  # Windows PowerShell's UTF-8 encoding adds a BOM. NoCloud requires the
  # marker filenames/content to be plain text, so these intentionally use
  # ASCII (all generated values, including OpenSSH public keys, are ASCII).
  Set-Content -NoNewline -Encoding ascii (Join-Path $directory 'user-data') $userData
  Set-Content -NoNewline -Encoding ascii (Join-Path $directory 'meta-data') "instance-id: $(Split-Path -Leaf $directory)`nlocal-hostname: $(Split-Path -Leaf $directory)`n"
  # Match the Hyper-V synthetic NIC by its deterministic MAC address rather
  # than assuming Ubuntu's generated interface name. Network config v2 is
  # consumed by current cloud-init/netplan images consistently.
  $networkConfig = @"
version: 2
ethernets:
  eth0:
    match:
      macaddress: "$guestMac"
    set-name: eth0
    addresses: [$guestIp/16]
    routes:
      - to: default
        via: 172.28.0.1
    nameservers:
      addresses: [1.1.1.1, 8.8.8.8]
"@
  Set-Content -NoNewline -Encoding ascii (Join-Path $directory 'network-config') $networkConfig
  $fs = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  # 1 = ISO9660 and 2 = Joliet. UDF-only media is mountable by Linux but is
  # not considered a NoCloud seed datasource by cloud-init.
  $fs.FileSystemsToCreate = 3
  $fs.VolumeName = 'cidata'
  $fs.Root.AddTree($directory,$false)
  $image = $fs.CreateResultImage()
  if (-not ('Agentworks.ImapiStreamWriter' -as [type])) {
    $compiler = New-Object CodeDom.Compiler.CompilerParameters
    $compiler.CompilerOptions = '/unsafe'
    $compiler.GenerateInMemory = $true
    Add-Type -CompilerParameters $compiler -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices.ComTypes;
namespace Agentworks {
  public static class ImapiStreamWriter {
    public static void Write(object source, string destination) {
      IStream input = source as IStream;
      if (input == null) throw new InvalidOperationException("IMAPI did not return an IStream.");
      using (var output = File.Create(destination)) {
        int read;
        do { var buffer = Read(input, 32768, out read); if (read > 0) output.Write(buffer, 0, read); } while (read > 0);
      }
    }
    unsafe static byte[] Read(IStream stream, int length, out int read) {
      var buffer = new byte[length]; int actual = 0; int* pointer = &actual;
      stream.Read(buffer, length, (IntPtr)pointer); read = actual; return buffer;
    }
  }
}
'@
  }
  # ImageStream is an IMAPI IStream COM object, not a .NET Stream. The CLR
  # can cast it to ComTypes.IStream even though PowerShell itself cannot.
  [Agentworks.ImapiStreamWriter]::Write($image.ImageStream, (Join-Path $directory 'seed.iso'))
}
function Ensure-BaseImage {
  $vhdx=Join-Path (Join-Path $root 'base') 'ubuntu-24.04-generic.vhdx'
  # The setup script performs the QCOW2 -> VHDX conversion before installing
  # the SYSTEM worker. This keeps the runtime deterministic and avoids trying
  # to access an interactive user's WSL distribution from the service account.
  if (!(Test-Path $vhdx)) { Fail 'Hyper-V base VHDX is missing; run .\agentworks.ps1 setup-worker as Administrator' }
  return $vhdx
}
function Guest-Ip($meta) {
  $vm=Resolve-VM $meta
  $ips=@(if($vm){Get-VMNetworkAdapter -VM $vm | Select-Object -ExpandProperty IPAddresses | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notmatch '^169\.254\.' }})
  if ($ips.Count) { return $ips[0] }; return $meta.guestIp
}
function Wait-Guest($meta) { $until=(Get-Date).AddMinutes(8); do { $ip=Guest-Ip $meta; if ($ip -and (Test-NetConnection -ComputerName $ip -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue)) { return $ip }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $until); Fail "guest $($meta.name) did not become reachable over SSH" }
function Quote-Remote([string]$value) {
  $quote=([char]39).ToString(); $double=([char]34).ToString()
  return $quote + $value.Replace($quote, $quote+$double+$quote+$double+$quote) + $quote
}
function Invoke-Guest($meta,[string[]]$command) {
  $ip=Wait-Guest $meta
  if($command.Count -ge 3 -and $command[0] -eq 'python3' -and $command[1] -eq '-c') {
    $localScript=Join-Path (Instance-Dir $meta.name) ("command-"+[guid]::NewGuid().ToString('N')+".py")
    $remoteScript="/tmp/$(Split-Path -Leaf $localScript)"
    [IO.File]::WriteAllText($localScript,[string]$command[2],(New-Object Text.UTF8Encoding($false)))
    try {
      & scp.exe '-q' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $meta.keyPath $localScript "${guestUser}@${ip}:$remoteScript"
      if($LASTEXITCODE -ne 0){Fail 'failed to transfer guest Python command'}
      $tail=@($command | Select-Object -Skip 3 | ForEach-Object { Quote-Remote ([string]$_) })
      $remoteCommand="python3 $remoteScript" + $(if($tail.Count){' '+($tail -join ' ')}else{''}) + "; rc=`$?; rm -f $remoteScript; exit `$rc"
      & ssh.exe '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $meta.keyPath "$guestUser@$ip" $remoteCommand
    } finally { Remove-Item -Force $localScript -ErrorAction SilentlyContinue }
    exit $LASTEXITCODE
  }
  if($command.Count -ge 3 -and $command[0] -eq 'bash' -and $command[1] -eq '-lc') {
    # Windows cmd/PowerShell and OpenSSH all reparse a remote command string.
    # Transfer a short-lived script instead: only a fixed `bash /tmp/file`
    # command crosses SSH, while the original program stays byte-for-byte.
    $tail=@($command | Select-Object -Skip 3 | ForEach-Object { [string]$_ })
    # Individual arguments may themselves contain newlines (managed MCP
    # instructions do).  Serialize the argv array as JSON and restore it with
    # NUL separators, rather than treating newline as an argument boundary.
    $argumentJson=ConvertTo-Json -Compress -InputObject $tail
    $argumentPayload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argumentJson))
    # The first native bash -lc argument is $0, so restore only tail[1..] as
    # positional parameters for compatibility with the Linux adapter contract.
    $stdinProgram=@'
__aw_b64='__AGENTWORKS_ARGS__'
if [ -n "$__aw_b64" ]; then
  mapfile -d '' -t __aw_args < <(printf '%s' "$__aw_b64" | base64 -d | python3 -c 'import json,sys; values=json.load(sys.stdin); sys.stdout.buffer.write(b"\0".join(str(value).encode() for value in values)+b"\0")')
  set -- "${__aw_args[@]:1}"
fi
'@.Replace('__AGENTWORKS_ARGS__',$argumentPayload) + "`n" + [string]$command[2]
    $localScript=Join-Path (Instance-Dir $meta.name) ("command-"+[guid]::NewGuid().ToString('N')+".sh")
    $remoteScript="/tmp/$(Split-Path -Leaf $localScript)"
    [IO.File]::WriteAllText($localScript,$stdinProgram,(New-Object Text.UTF8Encoding($false)))
    try {
      & scp.exe '-q' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $meta.keyPath $localScript "${guestUser}@${ip}:$remoteScript"
      if($LASTEXITCODE -ne 0){Fail 'failed to transfer guest command script'}
      & ssh.exe '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $meta.keyPath "$guestUser@$ip" "bash $remoteScript; rc=`$?; rm -f $remoteScript; exit `$rc"
    } finally { Remove-Item -Force $localScript -ErrorAction SilentlyContinue }
    exit $LASTEXITCODE
  }
  # OpenSSH joins every command argument with spaces before giving it to the
  # guest shell. Quote each original argv value first, otherwise `bash -lc`
  # loses its program (and semicolons/newlines become host-shell syntax).
  $quoted=@($command | ForEach-Object { Quote-Remote ([string]$_) })
  $remoteCommand=$quoted -join ' '
  & ssh.exe '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $meta.keyPath "$guestUser@$ip" $remoteCommand
  exit $LASTEXITCODE
}

$command=[string]$argvCopy[0]
if ($command -eq 'list') { $dir=Join-Path $root 'instances'; $items=@(); if(Test-Path $dir){Get-ChildItem $dir -Directory | ForEach-Object {$m=Read-Meta $_.Name;if($m){$items += [pscustomobject]@{name=$m.name;status=(Get-State $m)}}}}; $items | ConvertTo-Json -Compress; exit 0 }
if ($command -eq 'create') {
  $name=Opt '--name'; if(!(Valid-Name $name)){Fail 'create requires a lowercase runtime name'}; if((Read-Meta $name)){exit 0}; Require-HyperV
  $dir=Instance-Dir $name; if(Test-Path $dir){Remove-Item -Recurse -Force $dir}; New-Item -ItemType Directory -Force $dir | Out-Null
  $cpus=[Math]::Max(1,[int](Opt '--cpus')); $memoryGiB=[Math]::Max(1,[int](Opt '--memory')); $diskGiB=[Math]::Max(8,[int](Opt '--disk'))
  $key=Join-Path $dir 'id_ed25519'
  # Windows PowerShell drops a direct empty native argument. Start-Process
  # preserves ssh-keygen's required quoted empty passphrase value.
  $emptyQuoted=([char]34).ToString()+([char]34).ToString()
  $keygen=Start-Process -FilePath ssh-keygen.exe -ArgumentList @('-q','-t','ed25519','-N',$emptyQuoted,'-f',$key) -Wait -PassThru -NoNewWindow
  if($keygen.ExitCode -ne 0){Fail 'ssh-keygen failed'}
  # Generation-2 requires VHDX. A differencing child also keeps each tenant's
  # changes separate from the immutable generic Ubuntu base image.
  $guestIp=Guest-StaticIp $name; $base=Ensure-BaseImage; $disk=Join-Path $dir 'disk.vhdx'; New-VHD -Path $disk -ParentPath $base -Differencing | Out-Null
  $switch=Ensure-AgentworksSwitch
  # The generic Ubuntu cloud image is a UEFI/GPT disk, so Hyper-V must use
  # Generation 2 rather than the BIOS-only Generation 1 profile.
  $vm=New-VM -Name (Vm-Name $name) -Generation 2 -MemoryStartupBytes ($memoryGiB*1GB) -VHDPath $disk -Path $dir -SwitchName $switch.Name
  # Create the ISO from a staging directory. The instance root now contains
  # Hyper-V's locked VM configuration files, which must never be added to it.
  $seedDir=Join-Path $dir 'seed-input'; $guestMac=Guest-StaticMac $name; Set-VMNetworkAdapter -VM $vm -StaticMacAddress ($guestMac -replace ':',''); Write-SeedIso $seedDir ((Get-Content -Raw "$key.pub").Trim()) $guestIp $guestMac
  Set-VMProcessor -VM $vm -Count $cpus; Set-VMMemory -VM $vm -DynamicMemoryEnabled $false
  # New-VM defaults Generation-2 firmware to the Microsoft Windows secure-boot
  # database. Generic Ubuntu cloud images are signed by the Microsoft UEFI CA.
  Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate 'MicrosoftUEFICertificateAuthority'
  Add-VMDvdDrive -VM $vm -Path (Join-Path $seedDir 'seed.iso') | Out-Null
  Write-Meta $name ([pscustomobject]@{name=$name;vmId=$vm.Id.ToString();cpus=$cpus;memoryMiB=$memoryGiB*1024;diskGiB=$diskGiB;guestIp=$guestIp;keyPath=$key;createdAt=(Get-Date).ToUniversalTime().ToString('o')}); exit 0
}
$rest=@($argvCopy | Select-Object -Skip 1 | Where-Object { $_ -ne '-y' })
if($command -eq 'copy'){ if($rest.Count -ne 2){Fail 'copy requires source and destination'}; $parts=$rest[1].Split(':',2); if($parts.Count -ne 2){Fail 'copy destination must be instance:/absolute/path'}; $m=Read-Meta $parts[0]; if(!$m -or (Get-State $m) -ne 'running'){Fail "$($parts[0]) is not running"}; $ip=Wait-Guest $m; & scp.exe '-q' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $m.keyPath $rest[0] "${guestUser}@${ip}:$($parts[1])"; exit $LASTEXITCODE }
$name=if($command -eq 'edit'){$rest[-1]}else{$rest[0]}; if(!(Valid-Name $name)){Fail "$command requires an instance name"}; $meta=Read-Meta $name; if(!$meta){Fail "unknown instance $name"}
if($command -eq 'start'){if((Get-State $meta) -ne 'running'){$vm=Resolve-VM $meta;if(!$vm){Fail "Hyper-V VM for $name is missing"};Start-VM -VM $vm}; [void](Wait-Guest $meta); exit 0}
if($command -eq 'stop'){if((Get-State $meta) -eq 'running'){Stop-VM -VM (Resolve-VM $meta) -TurnOff -Force}; exit 0}
if($command -eq 'edit'){ $vm=Resolve-VM $meta;if(!$vm){Fail "Hyper-V VM for $name is missing"};$cpu=Opt '--cpus';$mem=Opt '--memory';if($cpu){$meta.cpus=[int]$cpu;Set-VMProcessor -VM $vm -Count $meta.cpus};if($mem){$meta.memoryMiB=[int]($mem -replace 'MiB$','');Set-VMMemory -VM $vm -DynamicMemoryEnabled $false -StartupBytes ($meta.memoryMiB*1MB)};Write-Meta $name $meta;exit 0 }
if($command -eq 'shell'){
  $guestCommand=[string[]]@($rest | Select-Object -Skip 1)
  if($guestCommand.Count -eq 2 -and $guestCommand[0] -eq '--agentworks-command-json-base64') {
    try {
      $encoded=$guestCommand[1].Replace('-','+').Replace('_','/')
      $encoded=$encoded + ('=' * ((4 - ($encoded.Length % 4)) % 4))
      $decoded=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
      $guestCommand=[string[]]@($decoded | ForEach-Object { [string]$_ })
      if(!$guestCommand.Count){Fail 'shell received an empty encoded command'}
    }
    catch { Fail 'shell received an invalid encoded command' }
  }
  elseif($guestCommand.Count -ge 2 -and $guestCommand[0] -in @('--agentworks-bash-base64','--agentworks-python-base64')) {
    try {
      $encoded=$guestCommand[1].Replace('-','+').Replace('_','/')
      $encoded=$encoded + ('=' * ((4 - ($encoded.Length % 4)) % 4))
      $program=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
    }
    catch { Fail 'shell received an invalid encoded bash program' }
    $tail=@($guestCommand | Select-Object -Skip 2)
    if($guestCommand[0] -eq '--agentworks-python-base64') {$guestCommand=@('python3','-c',$program)+$tail}
    else {$guestCommand=@('bash','-lc',$program)+$tail}
  }
  Invoke-Guest $meta $guestCommand
}
Fail "unsupported Hyper-V compatibility command: $command"
