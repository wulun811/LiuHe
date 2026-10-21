# Windows parser build/deploy/start. Example: .\scripts\start-parser.ps1 -Build -Restart
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$Restart,
    [ValidateRange(1, 65535)][int]$Port = 31001,
    [string]$BinaryPath
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeDir = Join-Path $repoRoot '.malong\windows-parser'
$installedBin = Join-Path $repoRoot 'malong\bin\malong-parse.exe'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null

function Read-Exact($stream, [int]$count) {
    $buffer = New-Object byte[] $count
    $offset = 0
    while ($offset -lt $count) {
        $n = $stream.Read($buffer, $offset, $count - $offset)
        if ($n -eq 0) { throw 'Parser closed the health connection.' }
        $offset += $n
    }
    return ,$buffer
}
function Get-ParserHealth {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $pending.Wait(3000)) { throw 'Parser connection timed out.' }
        $stream = $client.GetStream()
        $stream.ReadTimeout = 3000
        $stream.WriteTimeout = 3000
        $body = [Text.Encoding]::UTF8.GetBytes('{"id":"windows-launcher","method":"health","params":{}}')
        $prefix = [BitConverter]::GetBytes([uint32]$body.Length)
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($prefix) }
        $stream.Write($prefix, 0, 4)
        $stream.Write($body, 0, $body.Length)
        $replyPrefix = Read-Exact $stream 4
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($replyPrefix) }
        $length = [BitConverter]::ToUInt32($replyPrefix, 0)
        if ($length -lt 1 -or $length -gt 16777216) { throw 'Invalid parser health frame.' }
        $reply = [Text.Encoding]::UTF8.GetString((Read-Exact $stream $length)) | ConvertFrom-Json
        if ($reply.error -or -not $reply.result) { throw 'Parser health request failed.' }
        return $reply.result
    } finally { $client.Dispose() }
}

if ($Build) {
    $savedCommit = $env:MALONG_GIT_COMMIT
    try {
        $env:MALONG_GIT_COMMIT = (& git -C $repoRoot rev-parse HEAD).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read build commit.' }
        # The build exe is never the running exe: future upgrades can build before stopping service.
        & cargo build --release --locked --manifest-path (Join-Path $repoRoot 'malong-parse\Cargo.toml') --target-dir (Join-Path $runtimeDir 'build')
        if ($LASTEXITCODE -ne 0) { throw 'Parser build failed; running service was left in place.' }
        $BinaryPath = Join-Path $runtimeDir 'build\release\malong-parse.exe'
    } finally { $env:MALONG_GIT_COMMIT = $savedCommit }
}
if (-not $BinaryPath) { $BinaryPath = $installedBin }
$sourceBin = (Resolve-Path -LiteralPath $BinaryPath).Path
$sourceHash = (Get-FileHash -LiteralPath $sourceBin -Algorithm SHA256).Hash
$listener = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
$oldExe = $null
$rollbackBin = $null
if ($listener.Count -gt 0) {
    $owner = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listener[0].OwningProcess)
    if (-not $owner -or [IO.Path]::GetFileName($owner.ExecutablePath) -ne 'malong-parse.exe') {
        throw "Port $Port belongs to another program; no process was stopped."
    }
    if (-not $Restart) {
        if ($owner.ExecutablePath -eq $installedBin -and (Get-FileHash -LiteralPath $installedBin).Hash -eq $sourceHash) {
            Get-ParserHealth | ConvertTo-Json -Depth 8
            return
        }
        throw "Parser already runs on port $Port. Use -Restart to switch the verified parser process."
    }
    $oldExe = $owner.ExecutablePath
    if ($oldExe -eq $installedBin) {
        $rollbackDir = Join-Path $runtimeDir 'rollback'
        New-Item -ItemType Directory -Path $rollbackDir -Force | Out-Null
        $rollbackBin = Join-Path $rollbackDir 'malong-parse.exe'
        Copy-Item -LiteralPath $oldExe -Destination $rollbackBin -Force
    }
    Stop-Process -Id $owner.ProcessId
    for ($i = 0; $i -lt 40; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }
}
$savedPort = $env:MALONG_PORT
$started = $null
try {
    $env:MALONG_PORT = [string]$Port
    New-Item -ItemType Directory -Path (Split-Path $installedBin) -Force | Out-Null
    if ($sourceBin -ne $installedBin) { Copy-Item -LiteralPath $sourceBin -Destination $installedBin -Force }
    if ((Get-FileHash -LiteralPath $installedBin).Hash -ne $sourceHash) { throw 'Installed binary checksum mismatch.' }
    $started = Start-Process -FilePath $installedBin -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeDir 'stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'stderr.log')
    $health = $null
    for ($i = 0; $i -lt 40; $i++) {
        try { $health = Get-ParserHealth; break } catch { Start-Sleep -Milliseconds 100 }
    }
    $healthPath = if ($health) { [string]$health.exe_path } else { '' }
    $extendedPrefix = -join ([char]92, [char]92, '?', [char]92)
    if ($healthPath.StartsWith($extendedPrefix)) { $healthPath = $healthPath.Substring(4) }
    if (-not $health -or $health.pid -ne $started.Id -or $healthPath -ne $installedBin) { throw 'Started parser did not return matching runtime identity.' }
    [pscustomobject]@{ port = $Port; sha256 = $sourceHash; health = $health } | ConvertTo-Json -Depth 8
} catch {
    if ($started) { Stop-Process -Id $started.Id -ErrorAction SilentlyContinue }
    if ($rollbackBin) { Copy-Item -LiteralPath $rollbackBin -Destination $installedBin -Force }
    if ($oldExe -and (Test-Path -LiteralPath $oldExe)) {
        Start-Process -FilePath $oldExe -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
        Write-Warning 'Previous parser restarted after failed deployment.'
    }
    throw
} finally { $env:MALONG_PORT = $savedPort }
