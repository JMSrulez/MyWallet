// Provider valuations are not token quantities or EUR cash balances.
export function holdingValue(item) {
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
