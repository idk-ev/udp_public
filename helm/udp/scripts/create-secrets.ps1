<#
.SYNOPSIS
  UDP – Secrets für Produktion anlegen (secrets.create=false / Weg B).

.DESCRIPTION
  Erzeugt die beiden vom Chart erwarteten Secrets mit starken Zufallspasswörtern:
    - udp-db        (POSTGRES_USER, POSTGRES_PASSWORD)
    - udp-keycloak  (KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD)

  SICHERHEIT – ZIELCLUSTER: -Context ist PFLICHT. Das Skript wählt niemals
  implizit den "current-context" (Schutz vor versehentlichem Deploy auf den
  falschen Cluster) und zeigt vor jeder Änderung Cluster + Namespace zur
  Bestätigung an.

  IDEMPOTENT: existierende Secrets werden NICHT überschrieben (kein versehent-
  liches Rotieren eines Passworts, das die laufende DB bereits nutzt).
  Zum bewussten Rotieren: -Force.

.EXAMPLE
  ./create-secrets.ps1 -Context prod-cluster
.EXAMPLE
  ./create-secrets.ps1 -Context prod -Namespace udp-prod
.EXAMPLE
  ./create-secrets.ps1 -Context prod -Kubeconfig C:\kube\prod.yaml
.EXAMPLE
  ./create-secrets.ps1 -Context prod -Force      # Passwörter rotieren
.EXAMPLE
  ./create-secrets.ps1 -Context prod -Sealed     # SealedSecret-YAML
.EXAMPLE
  ./create-secrets.ps1 -Context prod -Yes        # ohne Rückfrage (CI)
#>
[CmdletBinding()]
param(
  # PFLICHT: Zielcluster-Kontext. Ohne Angabe wird gefragt – niemals implizit.
  [Parameter(Mandatory = $true)]
  [string]$Context,
  [string]$Kubeconfig = "",
  [string]$Namespace = "udp",
  [string]$DbSecret  = "udp-db",
  [string]$KcSecret  = "udp-keycloak",
  [string]$DbUser    = "udp",
  [string]$KcAdmin   = "admin",
  [int]$PwLen        = 28,
  [switch]$Force,
  [switch]$Sealed,
  [switch]$Yes,
  [string]$OutDir    = "./sealed"
)
$ErrorActionPreference = "Stop"

function Test-Cmd([string]$name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "'$name' nicht gefunden."
  }
}

# Kryptografisch sicheres Passwort, nur [A-Za-z0-9]. Alphanumerisch, weil das
# Postgres-Init-Skript das Passwort in einfachen Anführungszeichen in SQL
# einsetzt -> Sonderzeichen/Quotes vermeiden.
function New-Password([int]$len) {
  $chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  $bytes = [byte[]]::new($len)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

Test-Cmd kubectl
if ($Sealed) { Test-Cmd kubeseal }

# --- kubectl-Argumentpräfixe: immer mit explizitem Kontext ------------------
$KubeBase = @()
if ($Kubeconfig -ne "") { $KubeBase += @("--kubeconfig", $Kubeconfig) }   # ohne --context (für Kontextliste)
$Kube = $KubeBase + @("--context", $Context)                              # mit --context (für alle Operationen)

# --- Kontext validieren -----------------------------------------------------
$contexts = & kubectl @KubeBase config get-contexts -o name 2>$null
if ($LASTEXITCODE -ne 0 -or -not $contexts) {
  throw "Konnte Kontexte nicht lesen (kubeconfig korrekt?)."
}
if ($contexts -notcontains $Context) {
  Write-Host "FEHLER: Kontext '$Context' existiert nicht." -ForegroundColor Red
  Write-Host "Verfügbare Kontexte:"
  $contexts | ForEach-Object { Write-Host "  $_" }
  exit 2
}

# --- Zielcluster anzeigen + bestätigen --------------------------------------
$clusterName = & kubectl @KubeBase config view -o "jsonpath={.contexts[?(@.name=='$Context')].context.cluster}" 2>$null
$server      = & kubectl @Kube config view --minify -o "jsonpath={.clusters[0].cluster.server}" 2>$null
$mode = if ($Sealed) { "SealedSecret-YAML" } else { "im Cluster anlegen" }
if ($Force) { $mode += " + FORCE (rotieren)" }

Write-Host "============================================================"
Write-Host " Zielcluster-Kontext : $Context"
Write-Host " Cluster / API-Server: $clusterName  ($server)"
Write-Host " Namespace           : $Namespace"
Write-Host " Modus               : $mode"
Write-Host "============================================================"
if (-not $Yes -and -not $Sealed) {
  $answer = Read-Host "Auf DIESEN Cluster anwenden? [y/N]"
  if ($answer -notmatch '^(y|yes|j|ja)$') { Write-Host "Abgebrochen."; exit 1 }
}

# --- Namespace sicherstellen (nur beim direkten Anlegen) --------------------
if (-not $Sealed) {
  & kubectl @Kube get namespace $Namespace *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "Namespace '$Namespace' anlegen…"
    & kubectl @Kube create namespace $Namespace | Out-Null
  }
}

function Invoke-ApplySecret {
  param([string]$Name, [System.Collections.IDictionary]$Data)
  $createArgs = @("create","secret","generic",$Name,"-n",$Namespace,"--dry-run=client","-o","yaml")
  foreach ($k in $Data.Keys) { $createArgs += "--from-literal=$k=$($Data[$k])" }
  $manifest = & kubectl @Kube @createArgs
  if ($Sealed) {
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
    $target = Join-Path $OutDir "$Name.sealed.yaml"
    $sealArgs = $KubeBase + @("--context", $Context, "--format", "yaml")
    $manifest | & kubeseal @sealArgs | Out-File -FilePath $target -Encoding utf8
    Write-Host "  -> SealedSecret geschrieben: $target"
  } else {
    $manifest | & kubectl @Kube apply -f -
  }
}

function Confirm-EnsureSecret {
  param([string]$Name, [System.Collections.IDictionary]$Data)
  if (-not $Sealed -and -not $Force) {
    & kubectl @Kube get secret $Name -n $Namespace *> $null
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Secret '$Name' existiert bereits – übersprungen (-Force zum Rotieren)."
      return $false
    }
  }
  Invoke-ApplySecret -Name $Name -Data $Data
  return $true
}

Write-Host "== UDP-Secrets für Namespace '$Namespace' =="

$dbPass = New-Password $PwLen
$kcPass = New-Password $PwLen

$dbWritten = Confirm-EnsureSecret -Name $DbSecret -Data ([ordered]@{ POSTGRES_USER = $DbUser; POSTGRES_PASSWORD = $dbPass })
$kcWritten = Confirm-EnsureSecret -Name $KcSecret -Data ([ordered]@{ KEYCLOAK_ADMIN = $KcAdmin; KEYCLOAK_ADMIN_PASSWORD = $kcPass })

Write-Host ""
if ($Sealed) {
  Write-Host "Fertig. SealedSecrets in '$OutDir/' – ins Git-Repo committen und mit"
  Write-Host "  kubectl --context $Context apply -f '$OutDir/'  im Cluster ausrollen."
} else {
  Write-Host "Fertig. In values-prod.yaml sicherstellen:"
  Write-Host "  secrets.create: false"
  Write-Host "  db.existingSecret: `"$DbSecret`""
  Write-Host "  keycloak.existingSecret: `"$KcSecret`""
  Write-Host ""
  Write-Host "Passwörter jederzeit auslesbar:"
  Write-Host "  kubectl --context $Context -n $Namespace get secret $DbSecret -o jsonpath='{.data.POSTGRES_PASSWORD}' | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(`$_)) }"
  if ($kcWritten) {
    Write-Host ""
    Write-Host "Keycloak-Admin: $KcAdmin / $kcPass  (jetzt sicher notieren)"
  }
}
