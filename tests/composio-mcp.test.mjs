import test from "node:test";
import assert from "node:assert/strict";
import {
  normaliseToolkitSlug,
  normaliseInstalledToolRecord,
  normaliseToolSlugToken,
  inferToolkitFromSlug,
} from "../src/composio-mcp.js";

// ═════════════════════════════════════════════════════════════════════════════
// normaliseToolkitSlug
// ═════════════════════════════════════════════════════════════════════════════

test("normaliseToolkitSlug uppercases and strips special characters", () => {
  assert.equal(normaliseToolkitSlug("gmail"), "GMAIL");
  assert.equal(normaliseToolkitSlug("google-calendar"), "GOOGLE_CALENDAR");
  assert.equal(normaliseToolkitSlug("Google Calendar"), "GOOGLE_CALENDAR");
});

test("normaliseToolkitSlug collapses multiple underscores and trims", () => {
  assert.equal(normaliseToolkitSlug("__GMAIL__"), "GMAIL");
  assert.equal(normaliseToolkitSlug("google___calendar"), "GOOGLE_CALENDAR");
});

test("normaliseToolkitSlug handles empty/null input", () => {
  assert.equal(normaliseToolkitSlug(""), "");
  assert.equal(normaliseToolkitSlug(null), "");
  assert.equal(normaliseToolkitSlug(undefined), "");
});

test("normaliseToolkitSlug preserves underscores between tokens", () => {
  assert.equal(normaliseToolkitSlug("SLACK_WEBHOOK"), "SLACK_WEBHOOK");
});

// ═════════════════════════════════════════════════════════════════════════════
// normaliseInstalledToolRecord
// ═════════════════════════════════════════════════════════════════════════════

test("normaliseInstalledToolRecord returns normalised record from valid input", () => {
  const result = normaliseInstalledToolRecord({
    slug: "GMAIL_SEND_EMAIL",
    label: "Send Email",
    enabled: true,
    installState: "installed",
  });
  assert.equal(result.slug, "GMAIL_SEND_EMAIL");
  assert.equal(result.label, "Send Email");
  assert.equal(result.enabled, true);
  assert.equal(result.installState, "installed");
  assert.equal(result.lastError, "");
  assert.equal(result.connectionId, "");
  assert.ok(Number.isFinite(result.updatedAt));
});

test("normaliseInstalledToolRecord applies defaults for missing fields", () => {
  const result = normaliseInstalledToolRecord({ slug: "TODOIST" });
  assert.equal(result.slug, "TODOIST");
  assert.equal(result.label, "TODOIST"); // falls back to slug
  assert.equal(result.enabled, true); // default
  assert.equal(result.installState, "installed"); // default
});

test("normaliseInstalledToolRecord returns null for missing/empty slug", () => {
  assert.equal(normaliseInstalledToolRecord({}), null);
  assert.equal(normaliseInstalledToolRecord({ slug: "" }), null);
  assert.equal(normaliseInstalledToolRecord({ slug: "  " }), null);
  assert.equal(normaliseInstalledToolRecord(null), null);
});

test("normaliseInstalledToolRecord trims slug and label", () => {
  const result = normaliseInstalledToolRecord({ slug: "  GMAIL  ", label: "  Gmail  " });
  assert.equal(result.slug, "GMAIL");
  assert.equal(result.label, "Gmail");
});

// ═════════════════════════════════════════════════════════════════════════════
// normaliseToolSlugToken
// ═════════════════════════════════════════════════════════════════════════════

test("normaliseToolSlugToken uppercases and strips non-alphanumeric chars", () => {
  assert.equal(normaliseToolSlugToken("gmail"), "GMAIL");
  assert.equal(normaliseToolSlugToken("google-calendar"), "GOOGLECALENDAR");
  assert.equal(normaliseToolSlugToken("google calendar"), "GOOGLECALENDAR");
  assert.equal(normaliseToolSlugToken("Google_Calendar"), "GOOGLECALENDAR");
});

test("normaliseToolSlugToken handles empty/null input", () => {
  assert.equal(normaliseToolSlugToken(""), "");
  assert.equal(normaliseToolSlugToken(null), "");
});

// ═════════════════════════════════════════════════════════════════════════════
// inferToolkitFromSlug
// ═════════════════════════════════════════════════════════════════════════════

test("inferToolkitFromSlug extracts toolkit prefix from underscore-separated slugs", () => {
  assert.equal(inferToolkitFromSlug("GMAIL_SEND_EMAIL"), "GMAIL");
  assert.equal(inferToolkitFromSlug("TODOIST_CREATE_TASK"), "TODOIST");
  assert.equal(inferToolkitFromSlug("SLACK_SEND_MESSAGE"), "SLACK");
});

test("inferToolkitFromSlug handles Google-prefixed toolkits", () => {
  assert.equal(inferToolkitFromSlug("GOOGLECALENDAR_CREATE_EVENT"), "GOOGLECALENDAR");
  assert.equal(inferToolkitFromSlug("GOOGLEDOCS_READ"), "GOOGLEDOCS");
});

test("inferToolkitFromSlug returns full slug when no underscore", () => {
  assert.equal(inferToolkitFromSlug("GMAIL"), "GMAIL");
  assert.equal(inferToolkitFromSlug("todoist"), "TODOIST");
});

test("inferToolkitFromSlug handles empty/null input", () => {
  assert.equal(inferToolkitFromSlug(""), "");
  assert.equal(inferToolkitFromSlug(null), "");
});
