// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  window.localStorage.clear();
});

describe("Vitest localStorage setup", () => {
  it("provides the Web Storage contract used by canvas tests", () => {
    expect(localStorage).toBe(window.localStorage);
    expect(localStorage.length).toBe(0);

    localStorage.setItem("first", "one");
    localStorage.setItem("second", "two");
    localStorage.setItem("first", "updated");

    expect(localStorage.length).toBe(2);
    expect(localStorage.key(0)).toBe("first");
    expect(localStorage.key(1)).toBe("second");
    expect(localStorage.key(2)).toBeNull();
    expect(localStorage.getItem("first")).toBe("updated");
    expect(localStorage.getItem("missing")).toBeNull();

    localStorage.removeItem("first");
    expect(localStorage.getItem("first")).toBeNull();

    localStorage.clear();
    expect(localStorage.length).toBe(0);
  });
});
