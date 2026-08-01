# Creates the identity that provisions the AGPL stack.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Run once, as a project owner. It creates one service account, grants it the
# roles Terraform needs, writes a key, and enables the APIs.
#
#   pwsh -File deploy\provision-setup.ps1
#
# Safe to run again: every step checks first, so a partial run can simply be
# repeated rather than unpicked.
#
# The account this creates can administer databases, secrets, networks and IAM.
# It exists to build the stack once. Delete it afterwards — the script prints the
# command — because leaving a project-admin credential on disk is the thing the
# narrow deploy account was created to avoid.

# Not 'Stop'. gcloud writes ordinary progress to stderr, and in Windows
# PowerShell that becomes a terminating error the moment it is redirected.
# Failures are checked explicitly instead, where they matter.
$ErrorActionPreference = 'Continue'

$Project   = 'causal-hour-502018-c8'
$Owner     = 'yair@scentic.com'
$Account   = "scentic-agpl-provisioner@$Project.iam.gserviceaccount.com"
$ConfigDir = if ($env:CLOUDSDK_CONFIG) { $env:CLOUDSDK_CONFIG } else { Join-Path $HOME '.gcloud-scentic' }
$KeyPath   = Join-Path $ConfigDir 'agpl-provisioner-key.json'

$Roles = @(
  'roles/cloudsql.admin'                    # the two databases
  'roles/secretmanager.admin'               # generated credentials
  'roles/compute.admin'                     # the MongoDB VM and its firewall rule
  'roles/run.admin'                         # the three services
  'roles/iam.serviceAccountAdmin'           # the services' own runtime identity
  'roles/iam.serviceAccountUser'            # letting Cloud Run run as it
  'roles/resourcemanager.projectIamAdmin'   # granting that identity its roles
)

$Apis = @(
  'sqladmin.googleapis.com'
  'compute.googleapis.com'
  'secretmanager.googleapis.com'
  'run.googleapis.com'
)

function Write-Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }

# --- 1. Act as an owner -----------------------------------------------------
#
# The deploy account cannot do any of this, deliberately. If it is the active
# one the whole script fails on the first call with a permission error that
# looks like a project problem, so it is checked up front and named.

Write-Step "Checking which account is active"
$active = (gcloud config get-value account 2>$null)
Write-Host "  active: $active"

if ($active -ne $Owner) {
  Write-Host "  switching to $Owner"
  gcloud config set account $Owner --verbosity=none | Out-Null
}

# A registered account is not necessarily a usable one — the credential may have
# expired. Proven by asking for a token rather than assumed.
$token = (gcloud auth print-access-token 2>$null)
if (-not $token) {
  Write-Host ""
  Write-Host "  $Owner has no usable credentials in this gcloud config." -ForegroundColor Yellow
  Write-Host "  A browser sign-in is needed, which this script cannot do for you:" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "      gcloud auth login $Owner" -ForegroundColor White
  Write-Host ""
  Write-Host "  Then run this script again."
  exit 1
}

gcloud config set project $Project --verbosity=none | Out-Null

# --- 2. Enable the APIs -----------------------------------------------------
#
# Before anything that uses them. Enabling is slow and asynchronous, and a
# Terraform apply against a disabled API fails in a way that reads like a
# permissions problem.

Write-Step "Enabling APIs"
foreach ($api in $Apis) {
  Write-Host "  $api"
}
gcloud services enable $Apis --project=$Project
if ($LASTEXITCODE -ne 0) {
  Write-Host "  could not enable the APIs - stopping." -ForegroundColor Red
  exit 1
}

# --- 3. The provisioning identity -------------------------------------------

Write-Step "Creating the provisioner service account"
$exists = (gcloud iam service-accounts list --project=$Project `
  --filter="email:$Account" --format='value(email)' 2>$null)

if ($exists) {
  Write-Host "  already exists, leaving it alone"
} else {
  gcloud iam service-accounts create 'scentic-agpl-provisioner' `
    --project=$Project `
    --display-name='AGPL stack provisioner' `
    --description='Builds the AGPL time-tracking and e-signature stack. Delete once the stack is up.'
  Write-Host "  created"
}

Write-Step "Granting roles"
foreach ($role in $Roles) {
  Write-Host "  $role"
  # --condition=None keeps this non-interactive; without it gcloud asks, and a
  # prompt in the middle of a loop is how half the roles end up granted.
  gcloud projects add-iam-policy-binding $Project `
    --member="serviceAccount:$Account" `
    --role=$role `
    --condition=None --verbosity=none | Out-Null
}

# --- 4. The key -------------------------------------------------------------

Write-Step "Writing the key"
if (-not (Test-Path $ConfigDir)) {
  New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
}

if (Test-Path $KeyPath) {
  Write-Host "  a key already exists at $KeyPath, keeping it"
} else {
  # Full path, not '~'. gcloud does not expand a tilde on Windows and fails with
  # "No such file or directory" against a literal ~ directory.
  gcloud iam service-accounts keys create $KeyPath --iam-account=$Account
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  could not create the key - stopping." -ForegroundColor Red
    exit 1
  }
  Write-Host "  written to $KeyPath"
}

# --- 5. What happens next ---------------------------------------------------

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host ""
Write-Host "The key is at:" -ForegroundColor White
Write-Host "  $KeyPath"
Write-Host ""
Write-Host "When the stack is up, delete this account — it can administer the whole"
Write-Host "project and has no reason to exist afterwards:" -ForegroundColor White
Write-Host "  gcloud iam service-accounts delete $Account --project=$Project"
Write-Host "  Remove-Item '$KeyPath'"
Write-Host ""

# Leave the shell on the narrow account rather than the owner, so a later
# command run by hand is not silently running with far more authority than it
# needs.
gcloud config set account "scentic-deploy@$Project.iam.gserviceaccount.com" --verbosity=none | Out-Null
Write-Host "Active account returned to scentic-deploy." -ForegroundColor DarkGray
