<#
.SYNOPSIS
  UDP – Secrets für Produktion anlegen (secrets.create=false / Weg B).

.DESCRIPTION
  Erzeugt die vom Chart erwarteten Secrets mit starken Zufallspasswörtern:
    - udp-db        (POSTGRES_USER, POSTGRES_PASSWORD)
    - udp-keycloak  (KEYCLOAK_ADMIN, KEYCLOAK_ADMIN_PASSWORD)
    - timescale-role-<user>, timescale-role-ckan-ro  (CNPG-Rollen, basic-auth,
      username/password – Passwort IMMER identisch mit udp-db)

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

# Emits a finished manifest: as SealedSecret file (-Sealed) or directly via
# kubectl apply.
function Write-Manifest {
  param([string]$Name, $Manifest)
  if ($Sealed) {
    if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
    $target = Join-Path $OutDir "$Name.sealed.yaml"
    $sealArgs = $KubeBase + @("--context", $Context, "--format", "yaml")
    $Manifest | & kubeseal @sealArgs | Out-File -FilePath $target -Encoding utf8
    Write-Host "  -> SealedSecret geschrieben: $target"
  } else {
    # Out-Host: keep kubectl output out of the pipeline (functions return bools).
    $Manifest | & kubectl @Kube apply -f - | Out-Host
  }
}

function Invoke-ApplySecret {
  param([string]$Name, [System.Collections.IDictionary]$Data)
  $createArgs = @("create","secret","generic",$Name,"-n",$Namespace,"--dry-run=client","-o","yaml")
  foreach ($k in $Data.Keys) { $createArgs += "--from-literal=$k=$($Data[$k])" }
  $manifest = & kubectl @Kube @createArgs
  Write-Manifest -Name $Name -Manifest $manifest
}

function ConvertTo-B64([string]$s) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

# Reads one data key of an existing secret (decoded); $null if missing/empty.
# The value is only returned, never printed.
function Read-SecretKey([string]$Name, [string]$Key) {
  try {
    $raw = & kubectl @Kube get secret $Name -n $Namespace -o "jsonpath={.data.$Key}" 2>$null
  } catch { return $null }
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return $null }
  [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(("$raw").Trim()))
}

# CNPG role secret name: timescale-role-<role> with "_" -> "-".
function Get-RoleSecretName([string]$Role) { "timescale-role-" + $Role.Replace("_", "-") }

# Writes a CNPG role secret (basic-auth). Label + annotation are required by the
# chart: without cnpg.io/passwordPassthrough CNPG stores a SCRAM hash and
# Orion-LD (libpq without SCRAM) cannot log in.
function Invoke-ApplyRoleSecret {
  param([string]$Name, [string]$User, [string]$Pass)
  $manifest = @(
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    "  name: $Name",
    "  namespace: $Namespace",
    "  labels:",
    "    cnpg.io/reload: `"true`"",
    "  annotations:",
    "    cnpg.io/passwordPassthrough: `"enabled`"",
    "type: kubernetes.io/basic-auth",
    "data:",
    "  username: $(ConvertTo-B64 $User)",
    "  password: $(ConvertTo-B64 $Pass)"
  )
  Write-Manifest -Name $Name -Manifest $manifest
}

# Role secret: always written when udp-db was (re)written (passwords must match);
# otherwise only created if missing. An existing one with a different password
# is reported (without printing it).
function Confirm-EnsureRoleSecret {
  param([string]$Role, [string]$Pass, [bool]$Rewrite)
  $name = Get-RoleSecretName $Role
  if (-not $Sealed -and -not $Rewrite) {
    & kubectl @Kube get secret $name -n $Namespace *> $null
    if ($LASTEXITCODE -eq 0) {
      $cur = Read-SecretKey $name "password"
      if ($cur -ceq $Pass) {
        Write-Host "Secret '$name' existiert bereits – übersprungen."
      } else {
        Write-Host "WARNUNG: Secret '$name' existiert, Passwort weicht von '$DbSecret' ab!" -ForegroundColor Yellow
        Write-Host "  Löschen und Skript erneut ausführen (wird dann aus '$DbSecret' neu erzeugt)." -ForegroundColor Yellow
      }
      return
    }
  }
  Invoke-ApplyRoleSecret -Name $name -User $Role -Pass $Pass
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

# --- CNPG role secrets: credentials always taken from udp-db ----------------
if ($dbWritten) {
  $roleUser = $DbUser; $rolePass = $dbPass
} else {
  $roleUser = Read-SecretKey $DbSecret "POSTGRES_USER"
  $rolePass = Read-SecretKey $DbSecret "POSTGRES_PASSWORD"
  if (-not $roleUser -or -not $rolePass) {
    throw "POSTGRES_USER/POSTGRES_PASSWORD aus Secret '$DbSecret' nicht lesbar."
  }
}
Confirm-EnsureRoleSecret -Role $roleUser -Pass $rolePass -Rewrite ([bool]$dbWritten)
Confirm-EnsureRoleSecret -Role "ckan_ro"  -Pass $rolePass -Rewrite ([bool]$dbWritten)
$rolePass = $null; $dbPass = $null

Write-Host ""
if ($Sealed) {
  Write-Host "Fertig. SealedSecrets in '$OutDir/' – ins Git-Repo committen und mit"
  Write-Host "  kubectl --context $Context apply -f '$OutDir/'  im Cluster ausrollen."
} else {
  Write-Host "Fertig. In values-prod.yaml sicherstellen:"
  Write-Host "  secrets.create: false"
  Write-Host "  db.user: `"$roleUser`""
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
