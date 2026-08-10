#!/usr/bin/env bash
set -euo pipefail

# Run a Host Agent command with the operational AWS credential resolved through
# the canonical FORAGENTS README -> SSM bootstrap. Nothing is written to an AWS
# profile, Keychain, repository file, command line, or generated evidence.

find_foragents_readme() {
  local root candidate
  root=$(cd "$(dirname "$0")/../.." && pwd)
  for candidate in \
    "${FORAGENTS_README:-}" \
    "$root/../../expsite/zo-lab/notebooks/FORAGENTS/README.md" \
    "/tf/notebooks/FORAGENTS/README.md" \
    "/Users/zo/Projects/expsite/zo-lab/notebooks/FORAGENTS/README.md"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "AWS CLI가 필요합니다." >&2
  exit 1
fi

readme=$(find_foragents_readme) || {
  echo "FORAGENTS README를 찾지 못했습니다. FORAGENTS_README를 지정하세요." >&2
  exit 1
}
reader_block=$(sed -n \
  '/FORAGENTS_SSM_READER_CREDENTIALS_BEGIN/,/FORAGENTS_SSM_READER_CREDENTIALS_END/p' \
  "$readme")
reader_access_key=$(printf '%s\n' "$reader_block" | awk -F ' *= *' '$1 == "aws_access_key_id" { print $2; exit }')
reader_secret_key=$(printf '%s\n' "$reader_block" | awk -F ' *= *' '$1 == "aws_secret_access_key" { print $2; exit }')
if [[ -z "$reader_access_key" || -z "$reader_secret_key" ]]; then
  echo "FORAGENTS README의 SSM reader credential block이 유효하지 않습니다." >&2
  exit 1
fi

ssm_region="${FORAGENTS_SSM_REGION:-ap-northeast-2}"
ssm_secret() {
  env -u AWS_SESSION_TOKEN -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
    AWS_ACCESS_KEY_ID="$reader_access_key" \
    AWS_SECRET_ACCESS_KEY="$reader_secret_key" \
    aws ssm get-parameter --name "$1" --with-decryption \
      --query 'Parameter.Value' --output text --region "$ssm_region"
}

operational_access_key=$(ssm_secret '/zo-lab/FORAGENTS/secrets/aws/choewz-programming/access-key-id')
operational_secret_key=$(ssm_secret '/zo-lab/FORAGENTS/secrets/aws/choewz-programming/secret-access-key')
if [[ -z "$operational_access_key" || -z "$operational_secret_key" ]]; then
  echo "FORAGENTS SSM에서 운영 AWS credential을 확인하지 못했습니다." >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID="$operational_access_key"
export AWS_SECRET_ACCESS_KEY="$operational_secret_key"
export AWS_EC2_METADATA_DISABLED=true
export AGENTWORKS_CREDENTIAL_SOURCE=foragents-ssm
unset AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE
unset reader_block reader_access_key reader_secret_key operational_access_key operational_secret_key

# Verify the resolved principal without rendering credentials. The child gets
# only process-scoped environment variables and no persistent local credential.
aws sts get-caller-identity --output json >/dev/null
exec "$@"
