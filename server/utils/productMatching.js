export const normalizeKey = (value) => String(value ?? '').trim().toLowerCase();

// Scanner codes take priority over names; never select a partial match on Enter.
export function matchProduct(products, { productId, name, code, barcode } = {}) {
  const codes = [code, barcode].map(normalizeKey).filter(Boolean);
  return (productId && products.find((p) => String(p.id) === String(productId))) ||
    products.find((p) => codes.some((key) => key === normalizeKey(p.code) || key === normalizeKey(p.barcode))) ||
    products.find((p) => normalizeKey(name) && normalizeKey(p.name) === normalizeKey(name)) || null;
}
