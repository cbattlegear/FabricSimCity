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

console.log("release-policy tests passed");
