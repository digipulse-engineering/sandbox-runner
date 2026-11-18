# Releasing

Maintainers publish `sandbox-runner-cli` to npm from GitHub Actions. Pushing a `v*` tag runs `.github/workflows/release.yml`. The workflow runs every test suite and checks the release. It then stages the package on npm with a provenance statement. A staged version stays private until a maintainer approves it with two-factor authentication.

## Release a version

1. On a branch, set the version with `npm version <version> --no-git-tag-version`. It updates `package.json` and `package-lock.json` together. Skip this step if both already hold the version, as for the first release.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## <version> - <date>` and start a new empty `## Unreleased` section above it.
3. Merge the change into `main` once CI passes.
4. Tag the merged commit on `main` and push the tag:

   ```sh
   git tag -a v<version> -m "Sandbox Runner <version>"
   git push origin v<version>
   ```

5. Wait for the `release` workflow. It refuses to stage when:
   - the tag is not `v` followed by the `package.json` version;
   - `package-lock.json` holds another version;
   - `CHANGELOG.md` has no section for the version;
   - the tagged commit is not on `main`.

6. Check the staged version before you approve it. Its provenance statement names the source commit: it must be the tagged commit, and that commit must be on `main`. Then approve it with 2FA, on npmjs.com under **Staged Packages** or from a terminal with npm 11.15.0 or later:

   ```sh
   npm stage list sandbox-runner-cli
   npm stage approve <stage-id>
   ```

A version such as `0.2.0-beta.1` is a prerelease. It goes to the `next` dist-tag, so `npm install sandbox-runner-cli` keeps installing the latest stable version. Any other version goes to `latest`.

A version number can be used only once on npm, staged or published. To fix a rejected or broken release, publish the next patch version.

## One-time setup

npm can only trust the workflow once the package exists. Publish the first version yourself, then hand releases to the workflow.

1. Enable two-factor authentication on the npm account.
2. Push the first tag as described above. The workflow runs the tests, then fails at the staging step because npm does not trust it yet. Once the tests pass, publish that version yourself from a clean checkout of the tag with `npm publish`. This first version has no provenance statement.
3. On npmjs.com, open the package settings and add a trusted publisher:
   - **Publisher:** GitHub Actions
   - **Organization or user:** `digipulse-engineering`
   - **Repository:** `sandbox-runner`
   - **Workflow filename:** `release.yml`
   - **Environment:** `npm`
   - **Allowed actions:** staged publishing only

   With npm 11.15.0 or later, the same configuration from a terminal is:

   ```sh
   npm trust github sandbox-runner-cli --file release.yml \
     --repo digipulse-engineering/sandbox-runner --env npm --allow-stage-publish
   ```

   npm does not check this configuration when you save it. A new trusted publisher must complete its first publish within two days, so push the next tag soon after saving it.
4. In the package's publishing access settings, select **Require two-factor authentication and disallow tokens**. Trusted publishing keeps working.
5. In the GitHub repository settings, open the `npm` environment and allow deployments from tags matching `v*` only. GitHub creates the environment on the first workflow run if it does not exist yet.
6. Add a tag ruleset for `v*` that lets only repository administrators create, update or delete those tags. The workflow runs from the tagged commit, so anyone who can push a `v*` tag can stage a package, and your approval would be the only check left.

`repository.url` in `package.json` must name this GitHub repository, or npm refuses the publish. Forks that publish their own package must change it.
