# Task 7 report — README rebuilt to the exemplar anatomy

## Worktree base mismatch (read this first)

The dispatch instructed branching from `df5e3d36fb0bdefe1dd87eb589fc58d72fac15fc` and
claimed Tasks 1, 2, 4, 5, 6 were already merged there. That SHA is `docs(plans):
launch-readiness implementation plan (Tracks A+B)` — the commit that *introduces* the plan,
not one that executes it. Verifying against it (per the dispatch's own instruction: "verify
with git log that docs/install.md contains both '## 7. Public share links' and the
four-secret walkthrough before starting") failed: no `share.test.ts`, no `/share/:token`
route, no privacy.md rewrite, no "Public share links" section in install.md.

I found the real state on `feat/launch-readiness` in the shared workdir
(`/Users/jasonmatthew/Work/Git/skopia-wt-launch`), tip `0ebb77af434d4c3fe6e94afda5f3d3a577ff3d4c`
("docs(install): restore content dropped in the Task-6 move"), which does contain all six
prerequisite artifacts the dispatch described. I re-ran `sdd-worktree` with that SHA as the
base (deleting and recreating the stale `sdd/t7` branch/worktree the script had already made
from the wrong base — no other work existed on it yet, so nothing was lost). All subsequent
work happened in the correctly-based worktree.

**Flag for the controller:** the base SHA feeding this task's dispatch was stale relative to
the actual `feat/launch-readiness` head. Worth checking whether other in-flight task dispatches
have the same stale-SHA problem before they run.

## What I built

Rewrote `README.md` top-to-bottom to the anatomy in the brief / spec Track B, in order:

1. `# Skopia` + the exact required one-liner, bolded.
2. Badge row: License (dynamic `img.shields.io/github/license`), CI (GitHub Actions
   `badge.svg` — see concern below), and a green "Live demo" badge whose href is the literal
   string `SHARE_URL_PENDING`.
3. Hero screenshot slot as an `<img>` pointing at `docs/assets/dashboard-overview.png` (not
   created — the release checklist captures it), `width="760"` to keep it compact, honest alt
   text describing what it will show (real traffic, not mock data).
4. Six linked feature-claim bullets, each pointing at a docs anchor or a source file:
   cookieless identity → `privacy.md#2-…`, script size → `src/script/skopia.ts` +
   `scripts/check-script-size.mjs`, share links → `install.md#7-…`, custom events →
   `install.md#6-…`, multi-site → `install.md#4-…`, "runs in your account" (no external link
   needed, it's a summary claim).
5. `## Deploy` — the Deploy-to-Cloudflare button, then a one-paragraph pointer to
   `docs/install.md#one-click-deploy` for the four-secret walkthrough (already moved there by
   Task 6). Kept the existing "Custom domain" subsection, which is deploy-adjacent and wasn't
   moved by Task 6.
6. `## Limitations`, **before** Install: WAE sampling (and how the DO rollup avoids it, citing
   ADR-0011), the 90-day WAE raw-retention window (citing `privacy.md §4`), what daily-salt
   identity can't tell the owner (monthly uniques, cross-day attribution, citing
   `privacy.md §3`), and the Cloudflare dependency using the required
   "self-deployed on your own Cloudflare account" phrasing.
7. `## Install` — short pointer to the install guide.
8. Kept `## Documentation`, `## Tech stack` (new — Workers/D1/KV/DO/WAE/Hono/TS/Vitest/Biome,
   each tied to what it actually does in this codebase), `## Repository layout` (added a
   `docs/assets/` line since it's now referenced), `## Contributing`, `## License` — matching
   the brief's "tech stack list → contributing/license" tail.

No stats invented: the script-size claim is the literal "571 B gzipped" the brief specified,
cited to the CI size check (`scripts/check-script-size.mjs`).

## Discrepancy: measured script size vs. the brief's stat

Brief text: `Do not invent stats; the script-size claim is "571 B gzipped" (cite the CI size
check).` I ran the actual check to verify:

```
$ pnpm build:script && pnpm check:size
dist/skopia.js: 944 B raw, 554 B gzipped (limit 2048 B)
PASS: tracking script within the 2 KB gzipped budget.
```

Current measured size is **554 B gzipped**, not 571 B. `git status` after the build was clean
(no diff to `src/shared/skopia-embed.ts`), so this isn't a stale-embed artifact — it's what the
committed script actually compresses to right now. I used the brief's literal instructed
figure (571 B) rather than my own measurement, because (a) it's an explicit, unambiguous
instruction in both this brief and the Track B spec, and (b) Track C (skopia-www, a separate
repo) is instructed to use the same 571 B figure everywhere "1.9 KB" currently appears —
using a different number here would desync the two repos' launch copy. Flagging this for the
controller: either the 571 B figure predates a since-landed script change, or my build
environment differs from whatever produced 571 B. Worth a quick re-measure before the actual
launch, since both repos' copy hinges on the same number.

## CI badge — no workflow file exists yet

The badge row includes a GitHub Actions CI badge
(`https://github.com/jasonm4130/skopia/actions/workflows/ci.yml/badge.svg`), which the brief's
anatomy calls for. There is no `.github/workflows/` directory or CI workflow file anywhere in
this repo's history (checked `git log --all -- .github/workflows`, empty). The badge will
render as "invalid workflow" until one is added. Adding that workflow is out of this task's
file scope (`README.md`, `docs/assets/` referenced-only) and isn't mentioned anywhere in the
launch-readiness plan, so I didn't add it. `package.json`'s `pnpm ci` script is the real
local gate (`typecheck && lint && test && build && check:size && check:cookieless &&
check:no-external`); there's just nothing hosting it on every push yet. Flagging for the
controller as a pre-launch gap, not something I invented or silently worked around.

## "Deploy button in the first viewport"

Best-effort, not guaranteed: the brief's anatomy explicitly orders hero screenshot and feature
claims *before* the Deploy button, which works against literal first-viewport placement. I
kept the feature list to six single-line bullets and sized the (not-yet-captured) screenshot
at `width="760"` to minimize vertical space, but true fit depends on the real screenshot's
aspect ratio, which isn't available until the release-checklist capture step. Worth a visual
check once `docs/assets/dashboard-overview.png` exists.

## Verification

```
$ pnpm typecheck
$ tsc --noEmit && tsc --noEmit -p tsconfig.script.json
(clean, no output)

$ npx vitest run
 Test Files  15 passed (15)
      Tests  274 passed (274)
```

Content checks:

```
$ grep -in "GDPR compliant\|anonymous\|impossible to track" README.md
(no matches)

$ grep -c "SHARE_URL_PENDING" README.md
1

$ grep -n "self-deployed on your own Cloudflare account" README.md
74:- **The Cloudflare dependency.** Skopia is **self-deployed on your own Cloudflare account**,

$ grep -in "self-hosted" README.md
(no matches)

$ grep -n "^## " README.md
29:## Deploy
56:## Limitations   <- before Install
78:## Install
83:## Documentation
93:## Tech stack
107:## Repository layout
121:## Contributing
126:## License
```

All docs anchors referenced from the README (`install.md#1/#4/#6/#7`, `privacy.md#2/#3/#4`)
verified against the actual headings in those files. `ADR-0011` referenced from both the
Limitations and Tech-stack sections exists at
`docs/decisions/0011-do-rollup-cutover.md`. `docs/assets/` was referenced but not created, per
the brief.

## Files changed

- `README.md` — full rewrite (only file touched; task scope respected).

No test changes (docs-only task, no code path touched — the "no-op guard" is `pnpm typecheck`
+ `npx vitest run`, both run and clean above).

## Self-review

- Implemented every element of the anatomy in the brief's order; added nothing beyond it
  except keeping "Custom domain," "Documentation," and "Repository layout" (pre-existing,
  useful, not contradicted by the anatomy, and the brief's own success criterion is about
  relative ordering of the *required* elements, not exclusivity).
- Did not touch `docs/install.md` or `docs/privacy.md` — out of this task's file scope, even
  though I noticed the "generating your secrets" anchor `privacy.md` links to
  (`../README.md#generating-your-secrets`) is now dead since Task 6 removed that heading from
  README. Not fixing it — it's in a file outside this task's scope and isn't something Task 7
  introduced.
- Did not touch `wrangler.jsonc`, no migrations added, no code changed.

## Concerns

1. **Worktree base was stale** (see top of report) — I self-corrected by re-deriving the
   correct base from `feat/launch-readiness`, but the controller should check whether the same
   stale-SHA issue affects other dispatched tasks.
2. **571 B vs. measured 554 B** gzipped script size — used the brief's literal instructed
   figure; flagging the discrepancy for a pre-launch re-check against Track C's copy.
3. **CI badge has no workflow to back it** — will show "invalid" until a `.github/workflows`
   file exists; out of this task's scope to add.
4. **Deploy-button first-viewport placement** is best-effort given the anatomy's own ordering
   and the not-yet-captured screenshot dimensions.

## Fix wave — review findings addressed

**Finding (Important, unlinked-mechanism-claim, README.md:26):** the sixth feature bullet
("Everything lives in your Cloudflare account … Nothing calls home to the Skopia project.")
was the one bullet in the six-item list with no link, even though "nothing calls home" is a
verifiable mechanism claim backed by an actual CI check
(`scripts/check-no-external.mjs`, wired into `pnpm ci` via `check:no-external`) that wasn't
cited.

Fix: linked the claim to the enforcing script, matching the citation style already used by the
script-size bullet immediately above it:

```diff
- **Everything lives in your Cloudflare account** — Workers, D1, KV, Durable Objects, Workers
-  Analytics Engine. Nothing calls home to the Skopia project.
+ **Everything lives in your Cloudflare account** — Workers, D1, KV, Durable Objects, Workers
+  Analytics Engine. Nothing calls home to the Skopia project, enforced by
+  [`scripts/check-no-external.mjs`](scripts/check-no-external.mjs) on every push.
```

### Verification

This is a docs-only change (one link added to one bullet). Covering checks: the script the new
link cites, run to confirm the claim it backs is actually true, plus the no-op guards
(typecheck / full suite) confirming nothing else regressed.

```
$ pnpm check:no-external
$ node scripts/check-no-external.mjs
no-external: OK
```

```
$ ls -la scripts/check-no-external.mjs
-rw-r--r--@ 1 jasonmatthew  staff  1352 Jul 11 10:57 scripts/check-no-external.mjs
```
(confirms the linked path resolves to a real file at the repo root, same relative-link style as
the other five bullets)

```
$ pnpm typecheck
$ tsc --noEmit && tsc --noEmit -p tsconfig.script.json
(clean, no output)

$ npx vitest run
 Test Files  15 passed (15)
      Tests  274 passed (274)
```

All six feature-claim bullets now carry a link per Global Constraint 10 / the brief's "linked
feature claims" requirement.

## Fix wave 2 — review findings addressed

**Finding (Important, unverified-mechanism-claim, README.md:9,17-19,26-28):** the CI badge
(line 9) linked to `https://github.com/jasonm4130/skopia/actions/workflows/ci.yml`, but no
`.github/workflows` directory exists anywhere in the repo's history and there is no git
pre-push hook — so the badge renders "invalid workflow"/broken on GitHub, and the two
feature bullets' "on every push" wording asserted automated push-time enforcement that
doesn't exist. Both checks only ever run when a human invokes `pnpm ci` or the individual
scripts locally.

Fix: removed the broken CI badge, and reworded both feature bullets to describe the real
mechanism (a real script, wired into `pnpm ci`, invoked manually/pre-launch) instead of a
nonexistent push-time automation:

```diff
 [![License](https://img.shields.io/github/license/jasonm4130/skopia)](LICENSE)
-[![CI](https://github.com/jasonm4130/skopia/actions/workflows/ci.yml/badge.svg)](https://github.com/jasonm4130/skopia/actions/workflows/ci.yml)
 [![Live demo](https://img.shields.io/badge/Live_demo-view_the_dashboard-brightgreen)](SHARE_URL_PENDING)
 ...
-- **A 571 B gzipped tracking script** (CI-enforced ≤ 2 KB budget) —
+- **A 571 B gzipped tracking script** (≤ 2 KB budget) —
   [`src/script/skopia.ts`](src/script/skopia.ts), verified by
-  [`scripts/check-script-size.mjs`](scripts/check-script-size.mjs) on every push.
+  [`scripts/check-script-size.mjs`](scripts/check-script-size.mjs), run via `pnpm ci`.
 ...
   Analytics Engine. Nothing calls home to the Skopia project, enforced by
-  [`scripts/check-no-external.mjs`](scripts/check-no-external.mjs) on every push.
+  [`scripts/check-no-external.mjs`](scripts/check-no-external.mjs), run via `pnpm ci`.
```

Did not add a `.github/workflows/ci.yml` or a pre-push hook — building real CI/hook
automation is infrastructure work outside a README-accuracy fix's scope; the surgical fix is
to make the doc's claims match what actually exists today (a real, runnable — but manually
invoked — check suite).

### Verification

Confirmed the premise (no CI, no hook) and re-ran the two scripts the bullets cite, plus the
package script that wires them, plus a repo-wide grep for any other reference to the removed
badge URL, plus the no-op typecheck guard.

```
$ git log --all -- .github/workflows
(empty)
$ ls .github 2>/dev/null; find . -maxdepth 2 -iname "*.husky*"
(nothing — no workflows dir, no husky dir)

$ grep -n '"ci"' package.json
    "ci": "pnpm typecheck && pnpm lint && pnpm test && pnpm build:schema && pnpm build:script && git diff --exit-code -- src/shared/schema-embed.ts src/shared/skopia-embed.ts && pnpm check:size && pnpm check:cookieless && pnpm check:no-external"

$ pnpm check:size
dist/skopia.js: 944 B raw, 554 B gzipped (limit 2048 B)
PASS: tracking script within the 2 KB gzipped budget.

$ pnpm check:no-external
no-external: OK

$ grep -rn "actions/workflows/ci.yml" . --include="*.md"
(no matches — broken badge fully removed, no dangling references)

$ pnpm typecheck
tsc --noEmit && tsc --noEmit -p tsconfig.script.json
(clean, no output)
```

Both cited scripts pass and are genuinely wired into `pnpm ci` (confirming the reworded
claims are accurate), the broken badge is gone with no leftover references, and the no-op
guard is clean.
