# Build Burley on Windows (PowerShell 7+ or Windows PowerShell 5.1).
#
#   ./scripts/build.ps1            # build web + bin/burley.exe
#   ./scripts/build.ps1 -Linux     # also emit bin/burley-linux-amd64
#   ./scripts/build.ps1 -Run       # build and serve ./demo-vault
#   ./scripts/build.ps1 -SkipWeb   # reuse the existing web/dist

param(
    [switch]$SkipWeb,
    [switch]$Linux,
    [switch]$Run,
    [string]$Root = "./demo-vault",
    [string]$Addr = "127.0.0.1:8080"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$web = Join-Path $repo "web"
$dist = Join-Path $repo "cmd/server/dist"
$bin = Join-Path $repo "bin"

if (-not $SkipWeb) {
    Push-Location $web
    try {
        if (-not (Test-Path (Join-Path $web "node_modules"))) {
            npm install
        }
        npm run build
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path (Join-Path $web "dist/index.html"))) {
    throw "web/dist/index.html not found - run the web build first."
}

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
New-Item -ItemType Directory -Path $dist | Out-Null
Copy-Item -Recurse (Join-Path $web "dist/*") $dist

New-Item -ItemType Directory -Force -Path $bin | Out-Null
# Version injected into the binary: nearest git tag (v0.0.2 -> 0.0.2).
$version = "0.0.0-dev"
$tag = (& git describe --tags --abbrev=0 2>$null)
if ($LASTEXITCODE -eq 0 -and $tag) {
    $version = ($tag.Trim() -replace '^[vV]', '')
    if (-not $version) { $version = "0.0.0-dev" }
}
$ldflags = "-s -w -X main.version=$version"
Push-Location $repo
try {
    go build -trimpath -ldflags $ldflags -o (Join-Path $bin "burley.exe") ./cmd/server
    if ($Linux) {
        $env:GOOS = "linux"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
        go build -trimpath -ldflags $ldflags -o (Join-Path $bin "burley-linux-amd64") ./cmd/server
        Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED
    }

    Write-Host ""
    Write-Host "Built $bin\burley.exe (v$version)" -ForegroundColor Green

    if ($Run) {
        & (Join-Path $bin "burley.exe") --root $Root --addr $Addr
    }
}
finally {
    Pop-Location
}
