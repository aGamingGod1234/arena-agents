#!/bin/bash
# One-line readiness check before a game launch for $MODEL (default gpt-6.1-sol), low, default tier; pass only on an answer within 30 s.
out=$1;mkdir -p "$(dirname "$out")"
unset OPENAI_API_KEY ANTHROPIC_API_KEY CODEX_HOME CLAUDE_CONFIG_DIR
s=$(date +%s%3N)
r=$(cd /tmp && timeout 30 codex exec -m "${MODEL:-gpt-6.1-sol}" -c model_reasoning_effort=low -c service_tier=default --skip-git-repo-check "Reply with the single word ok." 2>/dev/null | tail -1)
ms=$(( $(date +%s%3N) - s ))
passed=false;case "${r,,}" in *ok*) [ "$ms" -le 30000 ]&&passed=true;;esac
printf '{"at":"%s","probe":"codex exec","model":"%s","effort":"low","serviceTier":"default","responseMs":%s,"passed":%s}\n' "$(date -Is)" "${MODEL:-gpt-6.1-sol}" "$ms" "$passed" > "$out"
cat "$out";[ "$passed" = true ]
