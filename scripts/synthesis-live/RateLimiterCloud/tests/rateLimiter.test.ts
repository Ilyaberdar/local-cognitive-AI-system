import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "../src/rateLimiter.ts";

// A clock the test moves by hand: the limiter must take time only from options.now().
const clock = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test("starts full", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.available(), 5);
});

test("takes tokens while they last", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(2), true);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.available(), 0);
});

test("refills with the time that passed", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 4, refillPerSecond: 2, now: time.now });
  assert.equal(limiter.tryAcquire(4), true);
  time.advance(1000);
  assert.equal(limiter.available(), 2);
  time.advance(500);
  assert.equal(limiter.tryAcquire(3), true);
});

test("never holds more than its capacity", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 10, now: time.now });
  time.advance(60_000);
  assert.equal(limiter.available(), 2);
});

test("a refused request takes nothing", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.tryAcquire(5), false);
  assert.equal(limiter.available(), 3);
});

test("rejects invalid settings and requests", () => {
  const time = clock();
  assert.throws(() => new RateLimiter({ capacity: 0, refillPerSecond: 1, now: time.now }), RangeError);
  assert.throws(() => new RateLimiter({ capacity: 1, refillPerSecond: Number.NaN, now: time.now }), RangeError);
  const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: time.now });
  assert.throws(() => limiter.tryAcquire(0), RangeError);
  assert.throws(() => limiter.tryAcquire(1.5), RangeError);
});
