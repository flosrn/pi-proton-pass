import { describe, expect, it } from "vitest";
import { applyLineEdit, createLineEditState, type KeyMatcher, renderLineEdit } from "./line-edit.js";

/**
 * Stand-in for the host's `matchesKey`. The popup receives already-decoded
 * terminal input, so the tests name keys directly and treat anything else as
 * literal text — which is exactly the contract `applyLineEdit` relies on.
 */
const NAMED_KEYS: Record<string, string> = {
  "\x1b": "escape",
  "\r": "enter",
  "\x7f": "backspace",
  "\x1b[3~": "delete",
  "\x1b[D": "left",
  "\x1b[C": "right",
  "\x1b[H": "home",
  "\x1b[F": "end",
};

const matches: KeyMatcher = (data, keyId) => NAMED_KEYS[data] === keyId;

/** Feed a sequence and return the final state, failing loudly if the popup closed. */
function type(initial: string, ...chunks: string[]) {
  let state = createLineEditState(initial);
  for (const chunk of chunks) {
    const outcome = applyLineEdit(state, chunk, matches);
    if (outcome.kind !== "edit") throw new Error(`unexpected ${outcome.kind} on ${JSON.stringify(chunk)}`);
    state = outcome.state;
  }
  return state;
}

describe("applyLineEdit", () => {
  it("starts with the caret after the default value", () => {
    const state = createLineEditState("GH_TOKEN");
    expect(state.cursor).toBe(8);
    expect(renderLineEdit(state)).toBe("GH_TOKEN▌");
  });

  it("inserts typed text at the caret", () => {
    const state = type("", "G", "H", "_", "T");
    expect(state.chars.join("")).toBe("GH_T");
  });

  it("inserts a multi-character paste as one chunk", () => {
    const state = type("", "pass://Vault/Item/password");
    expect(state.chars.join("")).toBe("pass://Vault/Item/password");
    expect(state.cursor).toBe(26);
  });

  it("edits mid-value with arrows, backspace and delete", () => {
    const state = type("ABCD", "\x1b[D", "\x1b[D", "\x7f", "X", "\x1b[3~");
    expect(state.chars.join("")).toBe("AXD");
  });

  it("clamps caret movement and ignores backspace at the start", () => {
    const state = type("A", "\x1b[D", "\x1b[D", "\x7f", "\x1b[C", "\x1b[C");
    expect(state.chars.join("")).toBe("A");
    expect(state.cursor).toBe(1);
  });

  it("jumps to both ends", () => {
    const start = type("abc", "\x1b[H");
    expect(start.cursor).toBe(0);
    expect(type("abc", "\x1b[H", "\x1b[F").cursor).toBe(3);
  });

  it("treats one code point as one character", () => {
    const state = type("", "é", "🔑", "\x7f");
    expect(state.chars.join("")).toBe("é");
  });

  it("drops unrecognized control sequences instead of inserting them", () => {
    const state = type("ok", "\x1b[15~", "\x1b[<0;1;1M");
    expect(state.chars.join("")).toBe("ok");
  });

  it("submits the current value and cancels on escape", () => {
    expect(applyLineEdit(createLineEditState("GH_TOKEN"), "\r", matches)).toEqual({
      kind: "submit",
      value: "GH_TOKEN",
    });
    expect(applyLineEdit(createLineEditState("x"), "\x1b", matches)).toEqual({ kind: "cancel" });
  });
});

describe("renderLineEdit", () => {
  it("never returns the value in masked mode", () => {
    const state = createLineEditState("super-secret");
    const rendered = renderLineEdit(state, { mask: true });
    expect(rendered).not.toContain("secret");
    expect(rendered).toBe(`${"•".repeat(12)}▌`);
  });

  it("draws the caret at the caret position", () => {
    expect(renderLineEdit(type("abc", "\x1b[D"))).toBe("ab▌c");
  });
});
