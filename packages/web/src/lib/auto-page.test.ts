import { describe, it, expect } from "vitest";
import { shouldAutoLoadMore } from "./auto-page.js";

describe("shouldAutoLoadMore", () => {
  it("loads more when an empty/short filtered list cannot scroll", () => {
    // The reported bug: active tab's rows all live on a later page, so the
    // filtered list is empty. No content ⇒ no scroll ⇒ must fetch proactively.
    expect(
      shouldAutoLoadMore({
        hasMore: true,
        loadingMore: false,
        scrollHeight: 0,
        clientHeight: 400,
      })
    ).toBe(true);

    // Short but non-empty and still not overflowing the container.
    expect(
      shouldAutoLoadMore({
        hasMore: true,
        loadingMore: false,
        scrollHeight: 120,
        clientHeight: 400,
      })
    ).toBe(true);
  });

  it("does not load when content overflows (scroll can drive pagination)", () => {
    expect(
      shouldAutoLoadMore({
        hasMore: true,
        loadingMore: false,
        scrollHeight: 800,
        clientHeight: 400,
      })
    ).toBe(false);
  });

  it("does not load when there are no more pages", () => {
    expect(
      shouldAutoLoadMore({
        hasMore: false,
        loadingMore: false,
        scrollHeight: 0,
        clientHeight: 400,
      })
    ).toBe(false);
  });

  it("does not load while a page is already in flight", () => {
    expect(
      shouldAutoLoadMore({
        hasMore: true,
        loadingMore: true,
        scrollHeight: 0,
        clientHeight: 400,
      })
    ).toBe(false);
  });
});
