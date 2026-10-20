import { calculateTotal, CartItem, PromoCode } from "../src/checkout.js";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ TEST FAILED: ${message}`);
    process.exit(1);
  }
}

console.log("=== RUNNING CHECKOUT SERVICE REGRESSION TEST SUITE ===");

// Test 1: Checkout with valid promo code
console.log("▶ Test 1: Calculate total with valid 10% promo");
const itemsWithPromo: CartItem[] = [
  { id: "item-1", name: "Engineering Laptop Stand", price: 50, quantity: 2 }, // $100
  { id: "item-2", name: "Mechanical Keyboard", price: 100, quantity: 1 }, // $100
];
const promo: PromoCode = { code: "SPRING10", discountRate: 10 };
const res1 = calculateTotal(itemsWithPromo, promo);
assert(res1.subtotal === 200, `Expected subtotal 200, got ${res1.subtotal}`);
assert(res1.discount === 20, `Expected discount 20, got ${res1.discount}`);
assert(res1.total === 194.4, `Expected total 194.4, got ${res1.total}`);
console.log("✅ Test 1 PASSED: Discount calculated correctly");

// Test 2: Checkout with NO promo code (Regression test for INC-842)
console.log("▶ Test 2: Calculate total without promo code (standard checkout)");
const itemsNoPromo: CartItem[] = [
  { id: "item-1", name: "USB-C Hub", price: 40, quantity: 1 },
];
const res2 = calculateTotal(itemsNoPromo); // Undefined promo
assert(res2.subtotal === 40, `Expected subtotal 40, got ${res2.subtotal}`);
assert(res2.discount === 0, `Expected discount 0, got ${res2.discount}`);
assert(res2.total === 43.2, `Expected total 43.2, got ${res2.total}`);
console.log("✅ Test 2 PASSED: Checkout without promo operates without error");

console.log("🎉 ALL REGRESSION TESTS PASSED (2/2)");
process.exit(0);
