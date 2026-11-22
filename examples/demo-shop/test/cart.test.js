import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bulkDiscount, shippingCost, cartTotal, canCheckout } from '../src/cart.js';

test('bulk discount for big orders', () => {
  assert.equal(bulkDiscount(12), 0.1);
  assert.equal(bulkDiscount(2), 0);
});

test('shipping', () => {
  assert.equal(shippingCost(60, false), 0);
  assert.equal(shippingCost(10, false), 4.99);
  assert.equal(shippingCost(10, true), 0);
});

test('cart total', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }]), 24.99);
});

test('checkout needs items and a user', () => {
  assert.equal(canCheckout([], { name: 'Ada' }), false);
  assert.equal(canCheckout([{ price: 1, qty: 1 }], { name: 'Ada' }), true);
});
