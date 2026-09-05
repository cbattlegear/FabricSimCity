import assert from "node:assert/strict";
import {
  nextVersion,
  planRelease,
  selectMergedPrForSha,
  validateReleaseLabels,
} from "./release-policy.mjs";

assert.deepEqual(validateReleaseLabels(["bug", "release:minor"]), {
  ok: true,
  found: ["release:minor"],
  message: "Found release:minor.",
});

assert.equal(validateReleaseLabels(["bug"]).ok, false);
assert.match(validateReleaseLabels(["bug"]).message, /Missing release label/);

assert.equal(validateReleaseLabels(["release:minor", "release:patch"]).ok, false);
assert.match(
  validateReleaseLabels(["release:minor", "release:patch"]).message,
  /Multiple release labels/,
);

assert.equal(nextVersion("v1.5.0", "patch"), "1.5.1");
assert.equal(nextVersion("v1.5.0", "minor"), "1.6.0");
assert.equal(nextVersion("v1.5.0", "major"), "2.0.0");

assert.deepEqual(
  planRelease({
    mode: "auto",
    labels: ["release:skip", "release:minor"],
    latestTag: "v1.5.0",
  }),
  {
    action: "skip",
    reason: "Head pull request has release:skip; no release will be cut for this SHA.",
  },
);

assert.throws(
  () => planRelease({ mode: "auto", labels: [], latestTag: "v1.5.0" }),
  /missing labels no longer default to release:patch/i,
);

assert.deepEqual(
  planRelease({
    mode: "auto",
    labels: ["release:patch"],
    latestTag: "v1.5.0",
    pointingTags: ["v1.5.0"],
  }),
  {
    action: "skip",
    reason: "Target commit already has release tag(s): v1.5.0.",
  },
);

assert.deepEqual(
  planRelease({ mode: "dispatch", dispatchBump: "minor", latestTag: "v1.5.0" }),
  {
    action: "release",
    bump: "minor",
    version: "1.6.0",
    tag: "v1.6.0",
    reason: "Cutting minor release after v1.5.0.",
  },
);

assert.throws(
  () => planRelease({ mode: "dispatch", latestTag: "v1.5.0" }),
  /workflow_dispatch requires bump/,
);

assert.deepEqual(
  selectMergedPrForSha(
    [
      { number: 1, title: "old", merged_at: "2026-01-01T00:00:00Z", labels: [] },
      {
        number: 2,
        title: "target",
        merged_at: "2026-01-02T00:00:00Z",
        merge_commit_sha: "abc",
        labels: [{ name: "release:patch" }],
      },
    ],
    "abc",
  ),
  { number: 2, title: "target", labels: ["release:patch"] },
);

// A commit pushed straight to the branch has no pull request, and therefore nothing to release.
// This is reported as "no PR", not as an error: it is a legitimate state, and failing here would
// mark every direct push -- including a repository's first -- as broken.
assert.equal(selectMergedPrForSha([], "abc"), null);
assert.equal(
  selectMergedPrForSha([{ number: 1, title: "never merged", merged_at: null }], "abc"),
  null,
);

// Two merged pull requests for one commit stays an error. Their labels could disagree about the
// bump, and picking one is how a release ships understated.
assert.throws(
  () =>
    selectMergedPrForSha(
      [
        { number: 1, title: "a", merged_at: "2026-01-01T00:00:00Z", labels: [] },
        { number: 2, title: "b", merged_at: "2026-01-02T00:00:00Z", labels: [] },
      ],
      "abc",
    ),
  /found 2/,
);

// The skip must beat autoDecision, which refuses an unlabelled pull request. Both arrive with no
// labels; only the one that actually had a pull request is a mistake.
assert.deepEqual(planRelease({ mode: "auto", noPr: true, latestTag: "v1.5.0" }), {
  action: "skip",
  reason: "No merged pull request for this commit; nothing to read a release label from.",
});
assert.throws(() => planRelease({ mode: "auto", labels: [], latestTag: "v1.5.0" }), /missing labels/);

console.log("release-policy tests passed");
