#!/usr/bin/env bash
# verify_deployed_bundle.sh — INS-008/009/010 regression triage step 1
#
# PURPOSE
#   The 2026-04-07 user feedback re-reported three defects (mobile UI,
#   markdown rendering, auto-grow input) that were already marked
#   shipped+verified on 2026-04-06. Before re-implementing anything, we
#   need to determine whether the DEPLOYED bundle on orrgate actually
#   contains the 2026-04-06 fixes or whether the deploy never rolled out.
#
# STRATEGY
#   Each 2026-04-06 fix left a telltale string in the bundled JS:
#     - react-markdown         → INS-002 markdown rendering
#     - remark-gfm             → INS-002 (GFM support, blockquote parsing)
#     - rehype-sanitize        → INS-002 (XSS sanitization)
#     - AccountSheet           → INS-001 mobile logout sheet
#     - concord-mobile-nav     → INS-001 floating BottomNav redesign
#     - concord-message-body   → INS-001 mobile text wrap rule (in CSS, not JS)
#   If ALL of these strings are present in the deployed bundle, the
#   deploy is current and any user-visible regression is either
#   (a) a client cache issue, (b) a genuine second-order regression not
#   caught by string matching, or (c) a misunderstanding of acceptance.
#   If ANY are missing, the deploy is stale — redeploy + close as
#   duplicates.
#
# USAGE
#   scripts/verify_deployed_bundle.sh [orrgate-host]
#
#   orrgate-host defaults to `orrgate`. Override if your ssh config uses
#   a different alias. The script REQUIRES ssh access to the target; no
#   alternative transport is implemented.
#
# OUTPUT
#   Prints a table to stdout with one row per expected string:
#     STRING                  FOUND  FILE
#     react-markdown          PASS   index-abc123.js
#     ...
#   Exit code 0 iff all strings are present. Exit code 1 if any are
#   missing. Exit code 2 if ssh itself failed.
#
# IDEMPOTENCY
#   Pure read — never modifies files on orrgate. Safe to run repeatedly.
#
# WHY THIS FILE LIVES IN scripts/
#   It's a one-off diagnostic, not a permanent CI job. Goes here rather
#   than .github/workflows/ so it stays close to the feedback it
#   investigates. If the regression is real, we'll remove the script
#   after the triage concludes; if the deploy is stale, we'll keep it as
#   the template for future "is the deploy actually the commit we think
#   it is" checks.

set -euo pipefail

ORRGATE_HOST="${1:-orrgate}"
REMOTE_DIST_DIR="/docker/stacks/concord/client/dist"

# The exact strings we expect to find in the bundled output. Each entry
# is "needle|where-to-look" where where-to-look is either "js" (any .js
# file under dist/assets/) or "css" (any .css file). We distinguish so
# missing-from-JS and missing-from-CSS report cleanly.
#
# Adding a new string? Put it in commit order (oldest fix first), and
# include a short comment so the next maintainer knows why the string
# matters.
EXPECTED=(
    # INS-002 markdown: react-markdown bundle marker. Minified as a
    # function/variable reference; the literal import path survives as
    # a string in production builds too.
    "react-markdown|js"

    # INS-002 markdown: remark-gfm adds GFM support including blockquote
    # parsing. A separate package from react-markdown — if it's absent,
    # the build didn't bundle it and `>` syntax renders as literal text.
    "remark-gfm|js"

    # INS-002 markdown: rehype-sanitize is the XSS guard. Absence would
    # be a security regression, not just a missing feature.
    "rehype-sanitize|js"

    # INS-001 mobile logout: the AccountSheet component name survives
    # minification as a class/function declaration and as a display
    # name used in React devtools strings.
    "AccountSheet|js"

    # INS-001 mobile nav: the floating BottomNav replacement uses a CSS
    # utility class that's emitted into the CSS bundle unchanged.
    "concord-mobile-nav|css"

    # INS-001 mobile wrap: global word-wrap rule for chat bodies on
    # mobile. CSS-only, class-based.
    "concord-message-body|css"
)

# --- Helpers ---------------------------------------------------------

die() {
    printf 'error: %s\n' "$*" >&2
    exit 2
}

# Check ssh reachability before burning time on greps against a host
# that's going to refuse the connection.
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$ORRGATE_HOST" true 2>/dev/null; then
    die "cannot reach $ORRGATE_HOST via ssh (BatchMode, 5s timeout). Check ssh config + key auth."
fi

# Verify the remote dir exists. A missing dir means the deploy layout
# is different from what PLAN.md describes and we should stop before
# reporting a false negative.
if ! ssh "$ORRGATE_HOST" "test -d $REMOTE_DIST_DIR" 2>/dev/null; then
    die "remote directory does not exist: $ORRGATE_HOST:$REMOTE_DIST_DIR"
fi

# --- Main scan -------------------------------------------------------

# Print header. Pad columns so the table lines up in a 120-column
# terminal but stays readable in a 100-column terminal too.
printf '%-24s  %-6s  %s\n' "STRING" "FOUND" "FIRST MATCH"
printf '%-24s  %-6s  %s\n' "------------------------" "------" "-----------"

all_ok=1

for entry in "${EXPECTED[@]}"; do
    needle="${entry%|*}"
    where="${entry#*|}"

    # Pick the glob based on where we expect the string. Using a remote
    # `find | xargs grep` is intentional: bundled asset filenames have
    # content hashes so we can't hardcode them. We ask the remote to
    # walk its own dist dir.
    remote_cmd=""
    case "$where" in
        js)
            remote_cmd="find $REMOTE_DIST_DIR/assets -maxdepth 2 -name '*.js' -print0 2>/dev/null | xargs -0 grep -l -F -- '$needle' 2>/dev/null | head -n 1"
            ;;
        css)
            remote_cmd="find $REMOTE_DIST_DIR/assets -maxdepth 2 -name '*.css' -print0 2>/dev/null | xargs -0 grep -l -F -- '$needle' 2>/dev/null | head -n 1"
            ;;
        *)
            die "unknown where-to-look: $where (internal bug in script)"
            ;;
    esac

    match=""
    match=$(ssh "$ORRGATE_HOST" "$remote_cmd" 2>/dev/null || true)

    if [[ -n "$match" ]]; then
        # Strip the remote prefix to keep the table narrow.
        display="${match#$REMOTE_DIST_DIR/}"
        printf '%-24s  %-6s  %s\n' "$needle" "PASS" "$display"
    else
        printf '%-24s  %-6s  %s\n' "$needle" "FAIL" "(not found)"
        all_ok=0
    fi
done

# --- Git commit embedded in bundle -----------------------------------

# Vite can embed a build-time VITE_GIT_SHA if the build script sets it.
# If we find one, print it — useful when the deploy appears "current"
# but the hash reveals it's actually several commits behind main.
printf '\nScanning bundled JS for embedded git SHA ...\n'
sha_scan=$(ssh "$ORRGATE_HOST" "grep -oE '[0-9a-f]{40}' $REMOTE_DIST_DIR/assets/*.js 2>/dev/null | sort -u | head -n 3" || true)
if [[ -n "$sha_scan" ]]; then
    printf 'Potential SHA matches (first 3):\n'
    printf '%s\n' "$sha_scan" | sed 's/^/  /'
else
    printf '  (no 40-char hex strings found — build did not embed a VITE_GIT_SHA)\n'
fi

# --- Verdict ---------------------------------------------------------

printf '\n'
if [[ $all_ok -eq 1 ]]; then
    printf 'VERDICT: deployed bundle contains all INS-001/002/003 strings.\n'
    printf '  Interpretation: the deploy IS current. If the user is still\n'
    printf '  seeing the defects, the cause is likely client-side cache\n'
    printf '  (step 2 of the triage) or a second-order regression not\n'
    printf '  caught by string matching (step 3 of the triage).\n'
    exit 0
else
    printf 'VERDICT: deployed bundle is MISSING one or more INS-001/002/003 strings.\n'
    printf '  Interpretation: the deploy is stale. The user is seeing the\n'
    printf '  ORIGINAL (pre-fix) code. Action: rebuild + redeploy from\n'
    printf '  current main; close INS-008/009/010 as duplicates.\n'
    exit 1
fi
