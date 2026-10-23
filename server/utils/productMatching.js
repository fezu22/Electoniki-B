export const normalizeKey = (value) => String(value ?? '').trim().toLowerCase();

// Scanner codes take priority over names; never select a partial match on Enter.
export function matchProduct(products, { productId, name, code, barcode } = {}) {
  const codes = [code, barcode].map(normalizeKey).filter(Boolean);
  return (productId && products.find((product) => String(product.id) === String(productId))) ||
    products.find((product) => codes.some((key) => key === normalizeKey(product.code) || key === normalizeKey(product.barcode))) ||
    products.find((product) => normalizeKey(name) && normalizeKey(product.name) === normalizeKey(name)) || null;
}
