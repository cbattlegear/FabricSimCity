export function takeInitialFamilyId(
  pending: { current: string | null },
  fallback: string | undefined,
): string | undefined {
  const selected = pending.current ?? fallback
  pending.current = null
  return selected
}
