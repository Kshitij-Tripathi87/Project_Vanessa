export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export interface PromoCode {
  code: string;
  discountRate: number; // percentage (e.g. 10 for 10%)
}

export interface CheckoutResult {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  currency: string;
}

export function calculateTotal(items: CartItem[], promo?: PromoCode): CheckoutResult {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);

  // BUG (INC-842 Regression): Deliberate unhandled null/undefined reference
  // Accessing promo.discountRate directly without optional chaining or null check
  const discountRate = promo?.discountRate ?? 0;
  const discount = (subtotal * discountRate) / 100;

  const tax = Math.round((subtotal - discount) * 0.08 * 100) / 100;
  const total = Math.round((subtotal - discount + tax) * 100) / 100;

  return {
    subtotal,
    discount,
    tax,
    total,
    currency: "USD",
  };
}

export function processCheckout(items: CartItem[], promo?: PromoCode): { status: string; result?: CheckoutResult; error?: string } {
  try {
    const result = calculateTotal(items, promo);
    return { status: "success", result };
  } catch (err: any) {
    return { status: "failed", error: err.message };
  }
}
