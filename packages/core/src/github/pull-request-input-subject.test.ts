import { describe, expect, it } from "vitest";
import { pullRequestInputSubject } from "./pull-request-input-subject.ts";

describe("pullRequestInputSubject", () => {
  it("finds the comment behind a new or edited comment's input, and nothing for reviews and checks", () => {
    expect(pullRequestInputSubject("github:comment:31")).toEqual({
      subject: "issue-comment",
      subjectId: 31,
    });
    expect(
      pullRequestInputSubject(
        "github:review-comment:21:edited:2026-11-07T09:20:00Z",
      ),
    ).toEqual({ subject: "review-comment", subjectId: 21 });
    expect(pullRequestInputSubject("github:review:11")).toBeUndefined();
    expect(pullRequestInputSubject("github:check-run:9")).toBeUndefined();
  });
});
