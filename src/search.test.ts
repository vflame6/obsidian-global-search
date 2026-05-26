import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeTimeLabel, offsetToLineCh, buildSnippet, rankFields, headingPrefixLength, enabledFields, type SearchScope } from "./search.ts";

// Local-time constructor so the test is timezone-agnostic.
const at = (y: number, mo: number, d: number, h = 12): number =>
  new Date(y, mo, d, h, 0, 0, 0).getTime();

const now = at(2026, 4, 25); // 2026-05-25 12:00 local

test("relativeTimeLabel: same calendar day is Today", () => {
  assert.equal(relativeTimeLabel(at(2026, 4, 25, 9), now), "Today");
  assert.equal(relativeTimeLabel(at(2026, 4, 25, 23), now), "Today");
});

test("relativeTimeLabel: previous day is Yesterday", () => {
  assert.equal(relativeTimeLabel(at(2026, 4, 24, 23), now), "Yesterday");
});

test("relativeTimeLabel: within a week is Nd ago", () => {
  assert.equal(relativeTimeLabel(at(2026, 4, 22), now), "3d ago");
});

test("relativeTimeLabel: weeks then months", () => {
  assert.equal(relativeTimeLabel(at(2026, 4, 18), now), "1w ago"); // 7 days
  assert.equal(relativeTimeLabel(at(2026, 3, 25), now), "1mo ago"); // 30 days
});

test("offsetToLineCh: first line", () => {
  assert.deepEqual(offsetToLineCh("abc", 0), { line: 0, ch: 0 });
  assert.deepEqual(offsetToLineCh("abc", 2), { line: 0, ch: 2 });
});

test("offsetToLineCh: later lines", () => {
  assert.deepEqual(offsetToLineCh("ab\ncd", 3), { line: 1, ch: 0 });
  assert.deepEqual(offsetToLineCh("ab\ncd", 4), { line: 1, ch: 1 });
  assert.deepEqual(offsetToLineCh("a\nb\nc", 4), { line: 2, ch: 0 });
});

test("offsetToLineCh: offset past end is clamped", () => {
  assert.deepEqual(offsetToLineCh("ab", 99), { line: 0, ch: 2 });
});

test("buildSnippet: short line returned as-is", () => {
  const s = buildSnippet("hello world", 6, 5); // match = "world"
  assert.equal(s.text, "hello world");
  assert.equal(s.matchStart, 6);
  assert.equal(s.matchLength, 5);
  assert.equal(s.text.substr(s.matchStart, s.matchLength), "world");
});

test("buildSnippet: strips leading markdown noise", () => {
  const s = buildSnippet("## Title here", 3, 5); // match = "Title"
  assert.equal(s.text, "Title here");
  assert.equal(s.matchStart, 0);
  assert.equal(s.text.substr(s.matchStart, s.matchLength), "Title");
});

test("buildSnippet: uses only the matched line", () => {
  const content = "first line\nsecond match here\nthird";
  const s = buildSnippet(content, 18, 5); // match = "match"
  assert.equal(s.text, "second match here");
  assert.equal(s.text.substr(s.matchStart, s.matchLength), "match");
});

test("buildSnippet: long line is windowed with ellipses", () => {
  const line = "x".repeat(50) + "MATCH" + "y".repeat(50);
  const s = buildSnippet(line, 50, 5, 80);
  assert.ok(s.text.startsWith("… "));
  assert.ok(s.text.endsWith(" …"));
  assert.equal(s.text.substr(s.matchStart, s.matchLength), "MATCH");
});

test("rankFields: no fields returns null", () => {
  assert.equal(rankFields([]), null);
});

test("rankFields: single field returns its weighted score", () => {
  assert.deepEqual(rankFields([{ type: "content", score: 10 }]), {
    type: "content",
    score: 10, // content weight 1
  });
});

test("rankFields: title weight beats higher-raw content", () => {
  const best = rankFields([
    { type: "title", score: 5 }, // 5 * 3 = 15
    { type: "content", score: 10 }, // 10 * 1 = 10
  ]);
  assert.deepEqual(best, { type: "title", score: 15 });
});

test("rankFields: content can still win when much stronger", () => {
  const best = rankFields([
    { type: "heading", score: 4 }, // 4 * 2 = 8
    { type: "content", score: 9 }, // 9 * 1 = 9
  ]);
  assert.deepEqual(best, { type: "content", score: 9 });
});

test("headingPrefixLength: ATX heading with one space", () => {
  assert.equal(headingPrefixLength("# Title"), 2);
  assert.equal(headingPrefixLength("### Title"), 4);
});

test("headingPrefixLength: ATX heading with extra spaces", () => {
  assert.equal(headingPrefixLength("##   Title"), 5);
});

test("headingPrefixLength: setext heading text line has no prefix", () => {
  assert.equal(headingPrefixLength("My Heading"), 0);
});

test("buildSnippet: strips trailing CR from CRLF lines", () => {
  const content = "alpha\r\nbeta match\r\ngamma";
  const s = buildSnippet(content, 12, 5); // match = "match"
  assert.equal(s.text, "beta match"); // no trailing \r
  assert.equal(s.text.substr(s.matchStart, s.matchLength), "match");
});

test("buildSnippet: clamps matchLength so the highlight range stays within text", () => {
  const s = buildSnippet("short", 0, 100); // length far exceeds the line
  assert.equal(s.text, "short");
  assert.equal(s.matchStart, 0);
  assert.equal(s.matchLength, 5); // clamped to text length, not 100
  // The reported range must be valid (no overrun past the end of text):
  assert.ok(s.matchStart + s.matchLength <= s.text.length);
});

test("enabledFields: filenames scope enables only the title", () => {
  assert.deepEqual(enabledFields("filenames"), {
    title: true,
    heading: false,
    content: false,
  });
});

test("enabledFields: content scope enables only content", () => {
  assert.deepEqual(enabledFields("content"), {
    title: false,
    heading: false,
    content: true,
  });
});

test("enabledFields: both scope enables every field", () => {
  assert.deepEqual(enabledFields("both"), {
    title: true,
    heading: true,
    content: true,
  });
});

test("enabledFields: unknown scope falls back to both", () => {
  assert.deepEqual(enabledFields("nonsense" as SearchScope), {
    title: true,
    heading: true,
    content: true,
  });
});
