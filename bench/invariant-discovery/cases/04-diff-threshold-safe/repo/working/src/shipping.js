// Shipping and handling rules for checkout.
const FREE_SHIPPING_THRESHOLD = 50;
const FLAT_RATE = 5.99;

export function shippingFor(cart) {
  let shipping = FLAT_RATE;
  if (cart.total >= FREE_SHIPPING_THRESHOLD) {
    shipping = 0;
  }
  return shipping;
}

// Bulk handling: nothing on the checkout page drives it.
export function handlingFor(order) {
  let handling = 2.5;
  if (order.quantity >= 10) {
    handling = 0;
  }
  return handling;
}
