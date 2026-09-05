import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";

export const releaseLabels = [
  "release:major",
  "release:minor",
  "release:patch",
  "release:skip",
];

const bumpOrder = new Map([
  ["patch", 0],
  ["minor", 1],
  ["major", 2],
]);

function unique(values) {
  return [...new Set(values)];
}

function releaseLabelNames(labels) {
  return unique(labels.map(String).filter((label) => releaseLabels.includes(label)));
}

export function validateReleaseLabels(labels) {
  const found = releaseLabelNames(labels);
  if (found.length === 1) {
    return { ok: true, found, message: `Found ${found[0]}.` };
  }

  const message =
    found.length === 0
      ? `Missing release label. Add exactly one of ${releaseLabels.join(", ")}.`
      : `Multiple release labels found (${found.join(", ")}). Keep exactly one.`;

  return { ok: false, found, message };
}

function parseSemverTag(tag) {
  if (!tag) {
    return { major: 0, minor: 0, patch: 0 };
  }

  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  assert(match, `Latest tag "${tag}" is not a vMAJOR.MINOR.PATCH tag.`);

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

export function nextVersion(latestTag, bump) {
  assert(bumpOrder.has(bump), `Unknown release bump "${bump}".`);

  const version = parseSemverTag(latestTag);
  if (bump === "major") {
    version.major += 1;
    version.minor = 0;
    version.patch = 0;
  } else if (bump === "minor") {
    version.minor += 1;
    version.patch = 0;
  } else {
    version.patch += 1;
  }

  return `${version.major}.${version.minor}.${version.patch}`;
}

function autoDecision(labels) {
  const found = releaseLabelNames(labels);

  // Keep this first deliberately: the old release job let `release:skip` suppress any bump label.
  // The separate pull request check prevents mixed labels before merge; this preserves the
  // historical safety valve if one still reaches main.
  if (found.includes("release:skip")) {
    return {
      action: "skip",
      reason: "Head pull request has release:skip; no release will be cut for this SHA.",
    };
  }

  if (found.length === 0) {
    throw new Error(
      `Missing release label on the merged pull request. Add exactly one of ${releaseLabels.join(
        ", ",
      )}; missing labels no longer default to release:patch.`,
    );
  }

  if (found.length > 1) {
    throw new Error(`Multiple release labels found (${found.join(", ")}). Keep exactly one.`);
  }

  return { action: "release", bump: found[0].replace("release:", "") };
}

export function planRelease({
  mode,
  labels = [],
  dispatchBump,
  latestTag,
  pointingTags = [],
  noPr = false,
}) {
  const tagsAtHead = pointingTags.filter(Boolean);
  if (tagsAtHead.length > 0) {
    return {
      action: "skip",
      reason: `Target commit already has release tag(s): ${tagsAtHead.join(", ")}.`,
    };
  }

  /*
   * Checked before autoDecision, which is what refuses an unlabelled pull request. The two cases
   * look the same from here -- both arrive with no labels -- but only one is a mistake. A commit
   * with no pull request has nowhere to carry a label, so it skips.
   */
  if (mode === "auto" && noPr) {
    return {
      action: "skip",
      reason: "No merged pull request for this commit; nothing to read a release label from.",
    };
  }

  const decision =
    mode === "dispatch"
      ? dispatchDecision(dispatchBump)
      : mode === "auto"
        ? autoDecision(labels)
        : (() => {
            throw new Error(`Unknown release mode "${mode}".`);
          })();

  if (decision.action === "skip") {
    return decision;
  }

  const version = nextVersion(latestTag, decision.bump);
  return {
    action: "release",
    bump: decision.bump,
    version,
    tag: `v${version}`,
    reason: `Cutting ${decision.bump} release after ${latestTag || "no prior release tag"}.`,
  };
}

function dispatchDecision(dispatchBump) {
  if (!["major", "minor", "patch", "skip"].includes(dispatchBump)) {
    throw new Error('workflow_dispatch requires bump to be one of "major", "minor", "patch", or "skip".');
  }

  if (dispatchBump === "skip") {
    return { action: "skip", reason: "workflow_dispatch requested skip." };
  }

  return { action: "release", bump: dispatchBump };
}

export function selectMergedPrForSha(prs, sha) {
  const exact = prs.filter((pr) => pr.merged_at && pr.merge_commit_sha === sha);
  const candidates = exact.length > 0 ? exact : prs.filter((pr) => pr.merged_at);

  /*
   * No merged pull request is a legitimate state, not a misconfiguration: the commit was pushed
   * straight to the branch. There is no label to read and therefore nothing to release, so the
   * caller skips. Erroring here instead would put a red X on every direct push -- including the
   * one that bootstraps a repository -- and a release guard that cries wolf is one people learn
   * to ignore.
   *
   * More than one stays an error. That is genuinely ambiguous: two labels could disagree about
   * the bump, and guessing which one wins is how a release ships understated.
   */
  if (candidates.length === 0) {
    return null;
  }

  if (candidates.length > 1) {
    throw new Error(
      `Expected at most one merged pull request for ${sha}; found ${candidates.length}.`,
    );
  }

  const pr = candidates[0];
  return {
    number: pr.number,
    title: pr.title,
    labels: (pr.labels ?? []).map((label) => label.name),
  };
}

function jsonArrayFromEnv(name, fallback = []) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = JSON.parse(raw);
  assert(Array.isArray(parsed), `${name} must be a JSON array.`);
  return parsed.map(String);
}

function linesFromEnv(name) {
  return (process.env[name] ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeOutput(values) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value ?? "").replace(/\r?\n/g, " ")}`)
    .join("\n");
  appendFileSync(outputPath, `${body}\n`);
}

function runCheckLabels() {
  const labels = jsonArrayFromEnv("RELEASE_LABELS_JSON");
  const result = validateReleaseLabels(labels);
  console.log(result.message);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

function runPlanRelease() {
  const plan = planRelease({
    mode: process.env.RELEASE_MODE,
    labels: jsonArrayFromEnv("RELEASE_LABELS_JSON"),
    dispatchBump: process.env.RELEASE_DISPATCH_BUMP,
    latestTag: process.env.RELEASE_LATEST_TAG,
    pointingTags: linesFromEnv("RELEASE_POINTING_TAGS"),
    noPr: process.env.RELEASE_NO_PR === "true",
  });

  console.log(JSON.stringify(plan, null, 2));
  writeOutput(plan);
}

function runSelectPr() {
  const prs = JSON.parse(readFileSync(process.env.RELEASE_PRS_JSON_FILE, "utf8"));
  const selected = selectMergedPrForSha(prs, process.env.RELEASE_HEAD_SHA);

  if (selected === null) {
    console.log(`No merged pull request for ${process.env.RELEASE_HEAD_SHA}; nothing to release.`);
    writeOutput({ no_pr: "true", labels_json: "[]" });
    return;
  }

  console.log(`Selected PR #${selected.number}: ${selected.title}`);
  writeOutput({
    no_pr: "false",
    pr_number: selected.number,
    pr_title: selected.title,
    labels_json: JSON.stringify(selected.labels),
  });
}

const command = process.argv[2];
if (command === "check-labels") {
  runCheckLabels();
} else if (command === "plan-release") {
  runPlanRelease();
} else if (command === "select-pr") {
  runSelectPr();
} else if (command) {
  throw new Error(`Unknown command "${command}".`);
}
