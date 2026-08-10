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
$imageUrl = if ($env:AGENTWORKS_HYPERV_IMAGE_URL) { $env:AGENTWORKS_HYPERV_IMAGE_URL } else { 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64-azure.vhd.tar.gz' }

function Fail([string]$message) { throw "agentworks Hyper-V adapter: $message" }
function Valid-Name([string]$name) { return $name -match '^[a-z][a-z0-9-]{0,62}$' }
function Opt([string]$name) { $i=[Array]::IndexOf($argvCopy,$name); if ($i -ge 0 -and $i + 1 -lt $argvCopy.Count) { return [string]$argvCopy[$i+1] }; return $null }
function Instance-Dir([string]$name) { Join-Path (Join-Path $root 'instances') $name }
function Meta-Path([string]$name) { Join-Path (Instance-Dir $name) 'meta.json' }
function Read-Meta([string]$name) { $p=Meta-Path $name; if (Test-Path $p) { return Get-Content -Raw $p | ConvertFrom-Json }; return $null }
function Write-Meta([string]$name,$meta) { $meta | ConvertTo-Json -Depth 8 | Set-Content -NoNewline -Encoding utf8 (Meta-Path $name) }
function Vm-Name([string]$name) { "agentworks-$name" }
function Get-State($meta) { $vm=Get-VM -Name (Vm-Name $meta.name) -ErrorAction SilentlyContinue; if (!$vm) { return 'stopped' }; if ($vm.State -eq 'Running') { return 'running' }; return 'stopped' }
function Require-HyperV { if (!(Get-Command Get-VM -ErrorAction SilentlyContinue)) { Fail 'Hyper-V PowerShell module is unavailable; enable the Hyper-V role and restart Windows' } }
function Write-SeedIso([string]$directory,[string]$publicKey) {
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
"@
  Set-Content -NoNewline -Encoding utf8 (Join-Path $directory 'user-data') $userData
  Set-Content -NoNewline -Encoding utf8 (Join-Path $directory 'meta-data') "instance-id: $(Split-Path -Leaf $directory)`nlocal-hostname: $(Split-Path -Leaf $directory)`n"
  $fs = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  $fs.FileSystemsToCreate = 4 # ISO9660
  $fs.VolumeName = 'cidata'
  $fs.Root.AddTree($directory,$false)
  $image = $fs.CreateResultImage()
  if (-not ('Agentworks.ImapiStreamWriter' -as [type])) {
    Add-Type -CompilerOptions '/unsafe' -TypeDefinition @'
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
  $baseDir=Join-Path $root 'base'; $archive=Join-Path $baseDir 'ubuntu-24.04-azure.vhd.tar.gz'; $vhd=Join-Path $baseDir 'ubuntu-24.04-azure.vhd'
  New-Item -ItemType Directory -Force $baseDir | Out-Null
  if (!(Test-Path $vhd)) { Invoke-WebRequest -UseBasicParsing -Uri $imageUrl -OutFile $archive; & tar.exe -xzf $archive -C $baseDir; $candidate=Get-ChildItem $baseDir -Filter '*.vhd' | Select-Object -First 1; if (!$candidate) { Fail 'Ubuntu Azure VHD archive did not contain a VHD' }; Move-Item -Force $candidate.FullName $vhd }
  return $vhd
}
function Guest-Ip($meta) {
  $ips=@(Get-VMNetworkAdapter -VMName (Vm-Name $meta.name) | Select-Object -ExpandProperty IPAddresses | Where-Object { $_ -match '^\d{1,3}(\.\d{1,3}){3}$' -and $_ -notmatch '^169\.254\.' })
  if (!$ips.Count) { return $null }; return $ips[0]
}
function Wait-Guest($meta) { $until=(Get-Date).AddMinutes(8); do { $ip=Guest-Ip $meta; if ($ip -and (Test-NetConnection -ComputerName $ip -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue)) { return $ip }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $until); Fail "guest $($meta.name) did not become reachable over SSH" }
function Invoke-Guest($meta,[string[]]$command) { $ip=Wait-Guest $meta; & ssh.exe '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $meta.keyPath "$guestUser@$ip" @command; exit $LASTEXITCODE }

$command=[string]$argvCopy[0]
if ($command -eq 'list') { $dir=Join-Path $root 'instances'; $items=@(); if(Test-Path $dir){Get-ChildItem $dir -Directory | ForEach-Object {$m=Read-Meta $_.Name;if($m){$items += [pscustomobject]@{name=$m.name;status=(Get-State $m)}}}}; $items | ConvertTo-Json -Compress; exit 0 }
if ($command -eq 'create') {
  $name=Opt '--name'; if(!(Valid-Name $name)){Fail 'create requires a lowercase runtime name'}; if((Read-Meta $name)){exit 0}; Require-HyperV
  $dir=Instance-Dir $name; if(Test-Path $dir){Remove-Item -Recurse -Force $dir}; New-Item -ItemType Directory -Force $dir | Out-Null
  $cpus=[Math]::Max(1,[int](Opt '--cpus')); $memoryGiB=[Math]::Max(1,[int](Opt '--memory')); $diskGiB=[Math]::Max(8,[int](Opt '--disk'))
  $key=Join-Path $dir 'id_ed25519'; & ssh-keygen.exe -q -t ed25519 -N '""' -f $key; if($LASTEXITCODE -ne 0){Fail 'ssh-keygen failed'}
  Write-SeedIso $dir ((Get-Content -Raw "$key.pub").Trim()); $base=Ensure-BaseImage; $disk=Join-Path $dir 'disk.vhdx'; New-VHD -Path $disk -ParentPath $base -Differencing | Out-Null
  $switch=(Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue); if(!$switch){Fail 'Hyper-V Default Switch is unavailable'}
  $vm=New-VM -Name (Vm-Name $name) -Generation 1 -MemoryStartupBytes ($memoryGiB*1GB) -VHDPath $disk -Path $dir -SwitchName $switch.Name
  Set-VMProcessor -VMName $vm.Name -Count $cpus; Set-VMMemory -VMName $vm.Name -DynamicMemoryEnabled $false; Add-VMDvdDrive -VMName $vm.Name -Path (Join-Path $dir 'seed.iso') | Out-Null
  Write-Meta $name ([pscustomobject]@{name=$name;cpus=$cpus;memoryMiB=$memoryGiB*1024;diskGiB=$diskGiB;keyPath=$key;createdAt=(Get-Date).ToUniversalTime().ToString('o')}); exit 0
}
$rest=@($argvCopy | Select-Object -Skip 1 | Where-Object { $_ -ne '-y' })
if($command -eq 'copy'){ if($rest.Count -ne 2){Fail 'copy requires source and destination'}; $parts=$rest[1].Split(':',2); if($parts.Count -ne 2){Fail 'copy destination must be instance:/absolute/path'}; $m=Read-Meta $parts[0]; if(!$m -or (Get-State $m) -ne 'running'){Fail "$($parts[0]) is not running"}; $ip=Wait-Guest $m; & scp.exe '-q' '-o' 'StrictHostKeyChecking=no' '-o' 'UserKnownHostsFile=NUL' '-i' $m.keyPath $rest[0] "${guestUser}@${ip}:$($parts[1])"; exit $LASTEXITCODE }
$name=if($command -eq 'edit'){$rest[-1]}else{$rest[0]}; if(!(Valid-Name $name)){Fail "$command requires an instance name"}; $meta=Read-Meta $name; if(!$meta){Fail "unknown instance $name"}
if($command -eq 'start'){if((Get-State $meta) -ne 'running'){Start-VM -Name (Vm-Name $name)}; [void](Wait-Guest $meta); exit 0}
if($command -eq 'stop'){if((Get-State $meta) -eq 'running'){Stop-VM -Name (Vm-Name $name) -TurnOff -Force}; exit 0}
if($command -eq 'edit'){ $cpu=Opt '--cpus';$mem=Opt '--memory';if($cpu){$meta.cpus=[int]$cpu;Set-VMProcessor -VMName (Vm-Name $name) -Count $meta.cpus};if($mem){$meta.memoryMiB=[int]($mem -replace 'MiB$','');Set-VMMemory -VMName (Vm-Name $name) -DynamicMemoryEnabled $false -StartupBytes ($meta.memoryMiB*1MB)};Write-Meta $name $meta;exit 0 }
if($command -eq 'shell'){Invoke-Guest $meta ([string[]]@($rest | Select-Object -Skip 1))}
Fail "unsupported Hyper-V compatibility command: $command"
