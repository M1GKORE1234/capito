// A tiny shopping cart, the kind of code an AI agent writes in seconds.
export const FREE_SHIPPING_THRESHOLD = 50;

export function bulkDiscount(qty) {
  if (qty >= 10) return 0.1;
  return 0;
}

export function shippingCost(subtotal, isMember) {
  if (subtotal >= FREE_SHIPPING_THRESHOLD || isMember) return 0;
  return 4.99;
}

export function cartTotal(items, { isMember = false } = {}) {
  let subtotal = 0;
  for (const item of items) {
    subtotal += item.price * item.qty * (1 - bulkDiscount(item.qty));
  }
  return Math.round((subtotal + shippingCost(subtotal, isMember)) * 100) / 100;
}

export function canCheckout(items, user) {
  return items.length > 0 && !!user && !user.banned;
}
