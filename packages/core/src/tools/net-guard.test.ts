import { describe, it, expect } from "vitest";
import { assertPublicUrl, isPrivateAddress, SsrfError } from "./net-guard.js";

describe("isPrivateAddress", () => {
  it("flags RFC1918 and loopback IPv4 ranges", () => {
    expect(isPrivateAddress("10.0.0.5", 4)).toBe(true);
    expect(isPrivateAddress("172.16.0.1", 4)).toBe(true);
    expect(isPrivateAddress("172.31.255.255", 4)).toBe(true);
    expect(isPrivateAddress("192.168.1.1", 4)).toBe(true);
    expect(isPrivateAddress("127.0.0.1", 4)).toBe(true);
    expect(isPrivateAddress("169.254.169.254", 4)).toBe(true); // cloud metadata
  });

  it("does not flag public IPv4 addresses or adjacent-but-public ranges", () => {
    expect(isPrivateAddress("8.8.8.8", 4)).toBe(false);
    expect(isPrivateAddress("93.184.216.34", 4)).toBe(false);
    expect(isPrivateAddress("172.32.0.1", 4)).toBe(false); // just outside 172.16/12
  });

  it("flags IPv6 loopback and unique-local/link-local ranges", () => {
    expect(isPrivateAddress("::1", 6)).toBe(true);
    expect(isPrivateAddress("fd00::1", 6)).toBe(true);
    expect(isPrivateAddress("fe80::1", 6)).toBe(true);
  });

  it("does not flag a public IPv6 address", () => {
    expect(isPrivateAddress("2001:4860:4860::8888", 6)).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("rejects a hostname that resolves to a private address", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      assertPublicUrl("http://internal.example/", { resolve })
    ).rejects.toThrow(SsrfError);
  });

  it("allows a hostname that resolves to a public address", async () => {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 }];
    await expect(
      assertPublicUrl("http://example.com/", { resolve })
    ).resolves.toBeUndefined();
  });

  it("allows a private-resolving hostname when explicitly allow-listed", async () => {
    const resolve = async () => [{ address: "127.0.0.1", family: 4 }];
    await expect(
      assertPublicUrl("http://internal.local/", {
        resolve,
        allowHosts: ["internal.local"],
      })
    ).resolves.toBeUndefined();
  });

  it("rejects when the resolver returns no addresses", async () => {
    const resolve = async () => [];
    await expect(
      assertPublicUrl("http://nowhere.invalid/", { resolve })
    ).rejects.toThrow(SsrfError);
  });
});
