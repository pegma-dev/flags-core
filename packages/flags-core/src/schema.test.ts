import { describe, expect, it } from "vitest";

import { declareFlags, flag, isJsonValue } from "./schema.js";

class Boxed {
  readonly n = 1;
}

describe("isJsonValue", () => {
  it("accepts JSON-round-trippable plain data", () => {
    expect(isJsonValue(null)).toBe(true);
    expect(isJsonValue({ experiment: "on", nested: [1, false] })).toBe(true);
    expect(isJsonValue(Object.create(null))).toBe(true);
  });

  it("rejects Date, class instances, and other non-plain objects", () => {
    expect(isJsonValue(new Date("2026-08-15T12:00:00.000Z"))).toBe(false);
    expect(isJsonValue({ when: new Date("2026-08-15T12:00:00.000Z") })).toBe(
      false,
    );
    expect(isJsonValue(new Boxed())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    const sparse: unknown[] = [];
    sparse[1] = 2;
    expect(isJsonValue(sparse)).toBe(false);
  });
});

describe("declareFlags", () => {
  it("rejects a Date as a json default", () => {
    expect(() =>
      declareFlags({
        when: flag.json({ defaultValue: new Date() }),
      }),
    ).toThrow("JSON-compatible");
  });
});
