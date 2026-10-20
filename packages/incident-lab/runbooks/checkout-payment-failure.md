# Runbook: Checkout Payment & Calculation Failure (RB-CHK-04)

## Service Overview
- **Service**: Checkout & Payment Calculation Service (`packages/incident-lab/src/checkout.ts`)
- **Severity**: P1 / High
- **Owner**: Commerce Core Team

## Symptoms
- HTTP 500 Internal Server Error during `POST /api/v1/checkout`
- Sentry alert: `TypeError: Cannot read properties of undefined (reading 'discountRate')`
- Customers unable to complete checkout when no discount/promo code is applied

## Root Cause Analysis (Historical INC-842)
- In commit updating promo code banner, `calculateTotal` was refactored to compute discount rates.
- The `promo` parameter is optional (`promo?: PromoCode`).
- When a user checks out without entering a promo code, `promo` is `undefined`.
- Unchecked property access `promo.discountRate` causes immediate runtime crash in Node.js runtime.

## Recovery & Remediation Procedure
1. **Source Inspection**: Inspect `packages/incident-lab/src/checkout.ts` around `calculateTotal`.
2. **Patch**: Apply optional chaining and default fallback:
   ```typescript
   const discountRate = promo?.discountRate ?? 0;
   const discount = (subtotal * discountRate) / 100;
   ```
3. **Verification**: Execute regression test suite:
   ```bash
   pnpm --filter @vanessa/incident-lab test
   ```
4. **Safety Policy**:
   - MUST test in isolated branch (`fix/checkout-incident`).
   - DO NOT deploy directly to production without human review and CI gate verification.
