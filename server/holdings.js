// Provider valuations are not token quantities or EUR cash balances.
export function holdingValue(item) {
  if (item.valuationOnly === true) {
    if (
      item.asset !== "OKX_EARN" ||
      item.currency !== "EUR" ||
      !Number.isFinite(item.value) ||
      item.value < 0 ||
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
