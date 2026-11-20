/** True while an IME is composing, when Enter and Escape belong to the candidate window rather than the field.
 * Safari can deliver compositionend before the confirming keydown, so keyCode 229 catches what isComposing misses. */
export function isImeComposing(event: { nativeEvent: { isComposing: boolean }; keyCode: number }) {
	return event.nativeEvent.isComposing || event.keyCode === 229;
}
