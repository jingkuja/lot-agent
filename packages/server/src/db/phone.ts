/** Return a display-safe phone number while retaining enough digits to help a
 * user recognize which account is bound. The local database and public API
 * should only carry this masked representation. */
export function maskPhone(phone: string | null | undefined): string | null {
  const value = phone?.trim();
  if (!value) return null;
  if (value.length <= 7) return `${value.slice(0, 3)}****`;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
