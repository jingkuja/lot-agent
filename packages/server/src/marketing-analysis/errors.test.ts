import { describe, expect, it } from "vitest";
import { classifyDownloadError } from "./errors.js";

describe("video download error classification", () => {
  it.each([
    ["ERROR: [Douyin] 7658289800398589193: Fresh cookies (not necessarily logged in) are needed", "PLATFORM_SESSION_REQUIRED"],
    ["ERROR: Cookies are required to access this video", "PLATFORM_SESSION_REQUIRED"],
    ["ERROR: Login required. Use --cookies to provide authentication", "AUTH_REQUIRED"],
    ["ERROR: Please log in to access this video", "AUTH_REQUIRED"],
    ["ERROR: This video is only available to registered users", "AUTH_REQUIRED"],
    ["ERROR: HTTP Error 401: Unauthorized", "AUTH_REQUIRED"],
    ["ERROR: HTTP Error 403: Forbidden", "PLATFORM_ACCESS_DENIED"],
    ["ERROR: Access denied", "PLATFORM_ACCESS_DENIED"],
    ["ERROR: Captcha verification required. Provide fresh cookies", "CHALLENGE_REQUIRED"],
    ["ERROR: HTTP Error 404: Not Found", "SOURCE_UNAVAILABLE"],
    ["ERROR: No video formats found. See the --cookies documentation", "UNSUPPORTED_SOURCE"],
    ["ERROR: Unable to download webpage. See https://example.test/login and --cookies help", "DOWNLOAD_FAILED"],
    ["ERROR: [Douyin] 7658289800403404193: Unable to download webpage: timed out", "DOWNLOAD_FAILED"],
    ["ERROR: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed", "DOWNLOAD_FAILED"],
    ["WARNING: Cookies expired\nERROR: Unable to download webpage: timed out", "DOWNLOAD_FAILED"],
    ["WARNING: HTTP Error 403: Forbidden\nERROR: Fresh cookies (not necessarily logged in) are needed", "PLATFORM_SESSION_REQUIRED"],
  ])("classifies %s as %s", (diagnostic, expected) => {
    expect(classifyDownloadError(diagnostic)).toBe(expected);
  });
});
