// Provider valuations are not token quantities or EUR cash balances.
export function holdingValue(item) {
  if (item.unpriced === true) {
    if (["gate", "gateeu"].includes(item.priceProvider) &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(item.asset) &&
        item.price === null && !item.valuationOnly &&
        Number.isFinite(item.quantity) && item.quantity > 0) return 0;
    if (!/^ERC20:0x[a-f0-9]{40}$/.test(item.asset) ||
        item.network !== "ethereum" || item.asset !== `ERC20:${item.contract}` ||
        item.price !== null || item.valuationOnly ||
        !(Number.isFinite(item.quantity) && item.quantity > 0 ||
          item.quantity === null && item.decimals === null && /^\d{1,78}$/.test(item.rawQuantity)))
      throw new Error("Invalid unpriced holding");
    return 0; // Excluded from the priced subtotal; explicitly flagged by the API/UI.
  }
  if (item.valuationOnly === true) {
    if (
      !["OKX_EARN", "OKX_RECONCILIATION"].includes(item.asset) ||
      item.currency !== "EUR" ||
      !Number.isFinite(item.value) ||
      (item.asset !== "OKX_RECONCILIATION" && item.value < 0) ||
      item.quantity !== undefined ||
      item.price !== undefined
    ) throw new Error("Invalid valuation");
    return item.value;
  }
  if (
    !Number.isFinite(item.quantity) ||
    !Number.isFinite(item.price) ||
    item.price < 0
  ) throw new Error("Invalid valuation");
  return item.quantity * item.price;
}
