#!/bin/sh
#
# Install this repository's git hooks.
#
#   ./scripts/setup-hooks.sh
#
# WHY core.hooksPath, AND NOT A COPY INTO .git/hooks/
#
# `.git/` is not part of the repository, so a hook copied into `.git/hooks/`
# exists only on the machine that copied it. A fresh clone has no protection, the
# file can be deleted without `git status` noticing, and nothing in code review
# shows what the hook actually does. Pointing git at the committed `.githooks/`
# directory instead makes the hooks versioned, reviewable files that every clone
# installs identically — and changing them is an ordinary commit.
#
# Idempotent: re-running changes nothing the second time. `.git/hooks/` is never
# touched, so any hook already there is left alone.

set -eu

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "error: not inside a git repository." >&2
  exit 1
}
cd "$repo_root"

hooks_dir=.githooks

if [ ! -d "$hooks_dir" ]; then
  echo "error: $hooks_dir/ is missing from this checkout." >&2
  exit 1
fi

# `--local` on purpose: the setting belongs to this clone, not to the user's
# global git config, so it cannot leak into unrelated repositories.
previous=$(git config --local --get core.hooksPath || true)

if [ "$previous" = "$hooks_dir" ]; then
  echo "core.hooksPath is already $hooks_dir — nothing to change."
else
  git config --local core.hooksPath "$hooks_dir"
  if [ -n "$previous" ]; then
    echo "core.hooksPath: $previous -> $hooks_dir"
  else
    echo "core.hooksPath: (unset) -> $hooks_dir"
  fi
fi

# Git only runs a hook file that is executable. The bit survives a clone, but
# restoring it here is free and repairs a checkout made on a filesystem that
# dropped it.
for hook in commit-msg pre-commit; do
  if [ -f "$hooks_dir/$hook" ]; then
    chmod +x "$hooks_dir/$hook"
    echo "enabled: $hooks_dir/$hook"
  else
    echo "warning: $hooks_dir/$hook is missing." >&2
  fi
done

echo
echo "Git now runs hooks from $hooks_dir/. Verify with: git config --local core.hooksPath"
echo "To opt out again: git config --local --unset core.hooksPath"
