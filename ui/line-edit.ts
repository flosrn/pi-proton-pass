/**
 * Single-line text entry for the bordered popups.
 *
 * The popups used to borrow the host's `Editor` component from
 * `@earendil-works/pi-tui`. That shim re-exports OMP's own TUI, whose
 * `Editor` takes exactly one argument — an `EditorTheme` that requires a full
 * `symbols: SymbolTheme` — and pi-tui exports symbol themes as *types* only.
 * A plugin therefore cannot build a valid one, and the popup crashed the whole
 * session on its first render: `TypeError: undefined is not an object
 * (evaluating 'this.#theme.symbols.boxRound')`, uncaught, in-process, fatal.
 *
 * So this file owns the behaviour instead: a pure state transition with no host
 * coupling. Key decoding still comes from the host (`matchesKey`), because
 * terminal escape sequences are its problem, not ours.
 */

/** Caret glyph. Plain Unicode on purpose — no host symbol theme is reachable here. */
const CARET = "▌";

/** Anything that is not a C0/C1 control character is text the user typed or pasted. */
const PRINTABLE = /^[^\p{Cc}]+$/u;

export interface LineEditState {
	/** Value split into code points, so multi-byte input never splits. */
	readonly chars: readonly string[];
	/** Caret position, `0 … chars.length`. */
	readonly cursor: number;
}

export type LineEditOutcome =
	| { readonly kind: "edit"; readonly state: LineEditState }
	| { readonly kind: "submit"; readonly value: string }
	| { readonly kind: "cancel" };

/** Key decoder supplied by the caller (the host's `matchesKey`). */
export type KeyMatcher = (data: string, keyId: string) => boolean;

export function createLineEditState(initial = ""): LineEditState {
	const chars = [...initial];
	return { chars, cursor: chars.length };
}

/**
 * Apply one input chunk.
 *
 * Returns `submit`/`cancel` for the keys that close the popup, and `edit` with
 * the next state otherwise — including for input that changes nothing, so the
 * caller can repaint unconditionally without special cases.
 */
export function applyLineEdit(state: LineEditState, data: string, matches: KeyMatcher): LineEditOutcome {
	if (matches(data, "escape")) return { kind: "cancel" };
	if (matches(data, "enter")) return { kind: "submit", value: state.chars.join("") };

	if (matches(data, "backspace")) {
		if (state.cursor === 0) return { kind: "edit", state };
		const chars = [...state.chars];
		chars.splice(state.cursor - 1, 1);
		return { kind: "edit", state: { chars, cursor: state.cursor - 1 } };
	}
	if (matches(data, "delete")) {
		if (state.cursor >= state.chars.length) return { kind: "edit", state };
		const chars = [...state.chars];
		chars.splice(state.cursor, 1);
		return { kind: "edit", state: { chars, cursor: state.cursor } };
	}
	if (matches(data, "left")) {
		return { kind: "edit", state: { chars: state.chars, cursor: Math.max(0, state.cursor - 1) } };
	}
	if (matches(data, "right")) {
		return { kind: "edit", state: { chars: state.chars, cursor: Math.min(state.chars.length, state.cursor + 1) } };
	}
	if (matches(data, "home")) return { kind: "edit", state: { chars: state.chars, cursor: 0 } };
	if (matches(data, "end")) return { kind: "edit", state: { chars: state.chars, cursor: state.chars.length } };

	// Unrecognized control sequences (function keys, mouse reports, bracketed
	// paste markers) must never land in the value.
	if (!PRINTABLE.test(data)) return { kind: "edit", state };

	const typed = [...data];
	const chars = [...state.chars];
	chars.splice(state.cursor, 0, ...typed);
	return { kind: "edit", state: { chars, cursor: state.cursor + typed.length } };
}

/**
 * One display line for the current state.
 *
 * `mask` renders one bullet per code point and never returns the value, so a
 * secret cannot reach the screen — the reason the popup needs its own renderer
 * at all.
 */
export function renderLineEdit(state: LineEditState, options: { mask?: boolean } = {}): string {
	if (options.mask === true) return `${"•".repeat(state.chars.length)}${CARET}`;
	const before = state.chars.slice(0, state.cursor).join("");
	const after = state.chars.slice(state.cursor).join("");
	return `${before}${CARET}${after}`;
}
