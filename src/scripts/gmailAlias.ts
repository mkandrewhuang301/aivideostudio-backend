export function canonicalGmailAddress(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return null;
  // Intentionally normalize dots only. Plus-address consolidation is not part of this
  // narrowly authorized recovery and would need its own product/security decision.
  return `${local.replaceAll('.', '')}@gmail.com`;
}

