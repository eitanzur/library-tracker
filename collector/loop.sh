#!/usr/bin/env bash
# Take a snapshot every 15 minutes until the deadline, committing each one to the
# data branch checked out at ./store. Used by .github/workflows/collect.yml.
# A failed snapshot or push never ends the loop.
set -u
DURATION=${DURATION:-19800}   # 5.5 h; the job limit is 6 h
INTERVAL=${INTERVAL:-900}     # 15 min
end=$(( $(date +%s) + DURATION ))

cd store
git config user.name "library-tracker-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

while :; do
  start=$(date +%s)
  git pull -q --rebase origin data || echo "warn: pull failed"
  python ../src/collector/collect.py . || echo "warn: collector exited $?"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -q -m "snapshot $(date -u +%Y-%m-%dT%H:%MZ)"
    for i in 1 2 3; do
      git pull -q --rebase origin data && git push -q origin data && break
      echo "warn: push attempt $i failed"; sleep 5
    done
  fi
  next=$(( start + INTERVAL ))
  [ "$next" -ge "$end" ] && break
  sleep $(( next - $(date +%s) > 0 ? next - $(date +%s) : 0 ))
done
echo "loop finished"
