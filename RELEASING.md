# Releasing tsadwyn to npm

Releases are **tag-triggered**: bump `package.json` version, commit, push a
`vX.Y.Z` tag on `main`, and `.github/workflows/release.yml` publishes to npm
with a provenance attestation and creates a GitHub Release.

## One-time setup (already done or do-now list)

### 1. First publish (manual, from your laptop)

The automated workflow uses npm **trusted publishing** (OIDC), which
requires the package to exist on npm first. Cut v0.1.0 by hand:

```bash
# Sanity-check the tarball contents
npm pack --dry-run

# Log in if you haven't — uses browser-based auth by default
npm login

# Publish. `publishConfig.access: "public"` in package.json makes this
# publish as an unscoped public package.
npm publish
```

This claims the `tsadwyn` name on npm and makes v0.1.0 installable.

### 2. Configure trusted publisher on npmjs.com

After the first publish:

1. Go to `https://www.npmjs.com/package/tsadwyn/access`
2. Click **"Trusted Publisher"** → **"GitHub Actions"**
3. Fill in:
   - **Organization or user:** `mahmoudimus`
   - **Repository:** `tsadwyn`
   - **Workflow filename:** `release.yml`
   - **Environment name:** `npm-publish`

This permanently authorizes the release workflow to publish without any
long-lived `NPM_TOKEN` secret. If you later move the repo or rename the
workflow file, update this config.

### 3. (Optional) Create the `npm-publish` environment in GitHub

`Settings → Environments → New environment → npm-publish`. This lets you:
- Add required reviewers before a publish can run (belt-and-suspenders
  against accidental tag pushes).
- Restrict which branches/tags can trigger the environment (e.g., only
  tags pushed to `main`).

The workflow references `environment: npm-publish` even if the environment
doesn't exist yet (GitHub auto-creates a permissionless one). Configuring
it explicitly lets you add the above safety rails.

## Cutting a release

```bash
# 1. Make sure you're on main and up to date.
git checkout main
git pull

# 2. Bump the version in package.json. `npm version` updates package.json
#    AND creates a git tag AND creates a commit, all in one step.
npm version patch        # 0.1.0 → 0.1.1
# or
npm version minor        # 0.1.0 → 0.2.0
# or
npm version major        # 0.1.0 → 1.0.0
# or
npm version 1.2.3-beta.1 # explicit semver (pre-release tags are supported)

# 3. Push the commit AND the tag. Don't forget `--follow-tags` or push the
#    tag explicitly — without the tag, the release workflow doesn't fire.
git push --follow-tags

# 4. Watch the Release workflow at
#    https://github.com/mahmoudimus/tsadwyn/actions
#    Once it goes green:
#      - npm: https://www.npmjs.com/package/tsadwyn
#      - GitHub Release: https://github.com/mahmoudimus/tsadwyn/releases
```

### What the workflow does

1. Checks that the git tag matches `package.json` version (catches
   `npm version` forgotten / tagged-wrong-commit mistakes).
2. `npm run typecheck` + `npm test` + `npm run build` — a failing test
   blocks the publish.
3. `npm publish --provenance --access public` — publishes the tarball
   with a **provenance attestation** that cryptographically links the
   tarball on npm to the exact GitHub Actions run that built it. Consumers
   can verify it via `npm audit signatures`.
4. Creates a GitHub Release with auto-generated notes (commits since the
   previous tag).

## Pre-releases

Semver pre-release identifiers work transparently:

```bash
npm version 0.2.0-beta.1
git push --follow-tags
```

The workflow detects the `-` in the tag name and marks the GitHub Release
as a pre-release. npm's dist-tag defaults to `latest`; if you want a
pre-release to NOT be the default install target:

```bash
# After the automated publish lands, manually re-tag on npm:
npm dist-tag add tsadwyn@0.2.0-beta.1 next
npm dist-tag rm  tsadwyn@0.2.0-beta.1 latest   # only if already latest
```

(Future improvement: teach the workflow to parse pre-release tags and
pass `--tag next` automatically. Skipped for now — low frequency.)

## Rolling back a bad release

npm doesn't really allow unpublishes after 72 hours, and even inside 72h
it's discouraged. The correct fix is **deprecate + publish the next patch**:

```bash
# 1. Mark the bad version as deprecated so installers see a warning.
npm deprecate tsadwyn@0.1.3 "Regression — use 0.1.4 or newer"

# 2. Fix the bug on main.
# 3. Cut 0.1.4 normally (npm version patch + push tag).
```

## Skipping the workflow

If a tag was pushed but you want to skip automation for some reason
(emergency, broken CI), delete the tag locally and remotely:

```bash
git tag -d v0.1.1
git push origin :refs/tags/v0.1.1
```

Then re-tag when ready.

## CI vs release — two separate workflows

- `.github/workflows/ci.yml` — runs on every push to `main` + every PR.
  Tests Node 20/22/24 matrix, dependency review. Gates merges.
- `.github/workflows/release.yml` — runs only on `v*` tag pushes.
  Publishes the package. Gated by its own typecheck/test/build before
  publish (so a release doesn't slip through even if CI was green on
  a stale commit).

They don't share state. Release re-runs the tests on Node 22 specifically
because npm publishing only needs one Node version; the matrix stays on
CI where it catches cross-version bugs before they land on main.
