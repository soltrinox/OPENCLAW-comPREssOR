import { describe, expect, it } from "vitest";
import { graphRoot, sanitize } from "../src/ids.ts";

describe("ids.sanitize", () => {
  it("maps empty to unknown", () => {
    expect(sanitize("")).toBe("unknown");
    expect(sanitize(undefined)).toBe("unknown");
  });

  it("does not allow path escape from ../etc/passwd", () => {
    const out = sanitize("../etc/passwd");
    expect(out.includes("/")).toBe(false);
    expect(out.includes("..")).toBe(false);
    expect(out).toBe("etc_passwd");
  });

  it("does not emit dot path identities", () => {
    expect(sanitize(".")).toBe("unknown");
    expect(sanitize("..")).toBe("unknown");
    expect(sanitize(".hidden")).toBe("hidden");
  });

  it("graphRoot defaults to sessionKey", () => {
    expect(graphRoot("sess-1", "agent-9", false)).toBe("sess-1");
    expect(graphRoot("sess-1", "agent-9", true)).toBe("agent-9");
  });
});
