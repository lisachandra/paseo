$ErrorActionPreference = "Stop"
# Windows: Git Bash / PowerShell have no HOME (USERPROFILE instead), so
# .mise.toml's "{{ env.HOME }}" template fails with "Variable env.HOME not
# found" on every mise/npx invocation — and dev-win doesn't need Android
# anyway. Export HOME from USERPROFILE for this process tree and disable
# the broken vfox android-sdk plugin.
if (-not $env:HOME -and $env:USERPROFILE) { $env:HOME = $env:USERPROFILE }
$env:MISE_DISABLE_TOOLS = "android-sdk"
# Use prod Paseo home so workspaces/settings survive dev reloads. The default
# dev.ps1 isolates to packages/desktop/.dev/paseo-home which is empty. Prod
# home is C:\Users\PC\.paseo -> D:\Saves\User\.paseo (junction).
# Also need to fix CORS for the dev Metro port: dev.ps1 only seeds the
# isolated home, so when PASEO_HOME is prod we patch config.json ourselves
# (add "*" to allowedOrigins, keep existing ones) — otherwise the dev
# Metro origin is rejected by the prod daemon's "https://app.paseo.sh"-only
# allowlist. This is dev-only, like dev.ps1's own "*" seeding.
if (-not $env:PASEO_HOME) {
  $ProdHome = "D:\Saves\User\.paseo"
  if (Test-Path $ProdHome) { $env:PASEO_HOME = $ProdHome }
}
if ($env:PASEO_HOME -eq "D:\Saves\User\.paseo" -or $env:PASEO_HOME -eq "C:\Users\PC\.paseo") {
  $ProdCfg = Join-Path $env:PASEO_HOME "config.json"
  if (Test-Path $ProdCfg) {
    try {
      $cfgRaw = Get-Content $ProdCfg -Raw
      # Strip BOM that PowerShell Set-Content -Encoding UTF8 may have introduced earlier
      if ($cfgRaw.Length -gt 0 -and [int][char]$cfgRaw[0] -eq 0xFEFF) { $cfgRaw = $cfgRaw.Substring(1) }
      $cfg = $cfgRaw | ConvertFrom-Json
      if (-not $cfg.daemon) { $cfg | Add-Member -NotePropertyName daemon -NotePropertyValue @{} }
      if (-not $cfg.daemon.cors) { $cfg.daemon | Add-Member -NotePropertyName cors -NotePropertyValue @{} }
      $origins = @($cfg.daemon.cors.allowedOrigins)
      if ("*" -notin $origins) {
        $cfg.daemon.cors.allowedOrigins = @($origins + "*")
        # Write via Node to avoid BOM (PowerShell Set-Content UTF8 writes BOM)
        $tmpJson = $cfg | ConvertTo-Json -Depth 10 -Compress
        node -e "const fs=require('fs'); const p=process.argv[1]; const obj=JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')||'{}'); let raw=process.argv[2]; let j=JSON.parse(raw); fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n','utf8')" $ProdCfg $tmpJson
        Write-Host "  (patched $ProdCfg allowedOrigins to include '*' for dev Metro)"
      }
    } catch { Write-Warning "  (could not patch $ProdCfg for dev CORS: $_)" }
  }
  # Also ensure PASEO_LISTEN matches prod config (6767) not dev default 6788,
  # so Electron's daemon-manager probes the right port via config.json.
  if (-not $env:PASEO_LISTEN) { $env:PASEO_LISTEN = "127.0.0.1:6767" }
}
# Ensure npm --prefix resolves even when shortcut's WorkingDirectory is repo root
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Desktop dev launches the daemon from packages/server/dist — the Electron app prefers the
# compiled supervisor whenever it exists — so daemon-side edits need a rebuild before launch.
# Set PASEO_SKIP_DEV_DAEMON_BUILD=1 for fast restarts that don't touch server or protocol code.
if (-not $env:PASEO_SKIP_DEV_DAEMON_BUILD) {
  $RepoRoot = (Resolve-Path "$ScriptDir\..\..\..").Path
  Write-Host "  (building daemon workspace packages: npm run build:server)"
  npm --prefix $RepoRoot run build:server
  if ($LASTEXITCODE -ne 0) { throw "npm run build:server failed with exit code $LASTEXITCODE" }
}
Push-Location $ScriptDir\..
try {
  & "$ScriptDir\dev.ps1" @args
} finally {
  Pop-Location
}
