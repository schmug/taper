// Locale-independent string ordering: every sort in core goes through here so output order is a
// pure function of ids.

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const byId = <T extends { readonly id: string }>(a: T, b: T): number => cmp(a.id, b.id);
