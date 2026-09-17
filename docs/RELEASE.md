# Release checklist

Run in order. Do not skip a step because it "obviously" passes.

1. `git checkout main && git pull`. Working tree clean.
2. `scripts/release-audit.sh` prints `ALL CHECKS PASSED`.
3. Read `README.md` top to bottom. Every command runs as printed. Every number cites the run that produced it.
4. `CHANGELOG.md`: move Unreleased into a dated version section. Version matches `package.json` and `python/pyproject.toml`.
5. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.
6. npm: `npm login` (maintainer), then `npm publish --access public`. `prepublishOnly` runs typecheck, tests, and build.
7. PyPI: `cd python && uv build && uv publish` with a PyPI token.
8. Verify from a clean directory: `npx tiershift@X.Y.Z check` and `uvx tiershift@X.Y.Z check`.
9. GitHub release from the tag with the changelog section as the body.

Rules: no Co-Authored-By lines on commits. No provider spend in CI. Benchmarks are run by hand and their results are committed with the date.
