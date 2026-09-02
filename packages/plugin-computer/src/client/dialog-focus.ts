/** Return the wrapped focus target, or undefined when Tab stays in the dialog. */
export function dialogFocusWrapTarget<T>(
  controls: readonly T[],
  active: T | null,
  reverse: boolean,
): T | undefined {
  const first = controls[0];
  const last = controls.at(-1);
  if (!first || !last) return undefined;
  if (reverse && active === first) return last;
  if (!reverse && active === last) return first;
  return undefined;
}
