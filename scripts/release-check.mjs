#!/usr/bin/env node
// Checks a release tag against package.json, package-lock.json and CHANGELOG.md
// before the release workflow stages the package on npm.
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Semantic Versioning 2.0.0 without build metadata, which npm does not keep.
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export function checkRelease({ tag, packageJson, packageLock, changelog }) {
  const { version } = packageJson;
  if (typeof version !== "string" || !semver.test(version)) {
    throw new Error("package.json must hold a semantic version without build metadata.");
  }
  if (tag !== `v${version}`) throw new Error(`Tag ${tag} does not match package.json version ${version}; expected v${version}.`);
  if (packageLock.version !== version || packageLock.packages?.[""]?.version !== version) {
    throw new Error(`package-lock.json does not hold version ${version}. Set the version with npm version.`);
  }
  const escaped = version.replace(/[.+-]/g, "\\$&");
  if (!new RegExp(`^## ${escaped}(?:[ \\t]|$)`, "m").test(changelog)) {
    throw new Error(`CHANGELOG.md has no "## ${version}" section.`);
  }
  // Prereleases go to "next" so that a plain install keeps the latest stable version.
  return { version, distTag: version.includes("-") ? "next" : "latest" };
}

function main([tag], directory = process.cwd()) {
  const read = name => readFileSync(join(directory, name), "utf8");
  try {
    const result = checkRelease({
      tag, packageJson: JSON.parse(read("package.json")), packageLock: JSON.parse(read("package-lock.json")),
      changelog: read("CHANGELOG.md"),
    });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ndist-tag=${result.distTag}\n`);
    }
    console.log(`Release ${result.version} will be staged on npm under the "${result.distTag}" dist-tag.`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

// Compare real paths: a symlinked script path must still run the checks.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
