import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "../src/rateLimiter.ts";

// A clock the test moves by hand: the limiter must take time only from options.now().
const clock = () => {
  let now = 0;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
};

test("[C1][C2] starts full", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 5, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.available(), 5);
});

test("[C3] takes tokens while they last", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(2), true);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.available(), 0);
});

test("[C3] a refused request takes nothing", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: time.now });
  assert.equal(limiter.tryAcquire(5), false);
  assert.equal(limiter.available(), 3);
});

test("[C4] refills with the time that passed", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 4, refillPerSecond: 2, now: time.now });
  assert.equal(limiter.tryAcquire(4), true);
  time.advance(1000);
  assert.equal(limiter.available(), 2);
  time.advance(500);
  assert.equal(limiter.tryAcquire(3), true);
});

test("[C4] never holds more than its capacity", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 10, now: time.now });
  time.advance(60_000);
  assert.equal(limiter.available(), 2);
});

test("[C5] accepts fractional settings", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 2.5, refillPerSecond: 0.5, now: time.now });
  assert.equal(limiter.available(), 2.5);
  assert.equal(limiter.tryAcquire(2), true);
  time.advance(1000);
  assert.equal(limiter.available(), 1);
});

test("[C5] rejects invalid settings", () => {
  const time = clock();
  for (const [capacity, refillPerSecond] of [[0, 1], [-1, 1], [1, Number.NaN], [Number.POSITIVE_INFINITY, 1], [1, 0]]) {
    assert.throws(() => new RateLimiter({ capacity, refillPerSecond, now: time.now }), RangeError);
  }
});

test("[C6] rejects requests that are not positive integers", () => {
  const time = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: time.now });
  for (const tokens of [0, -1, 1.5, Number.NaN]) assert.throws(() => limiter.tryAcquire(tokens), RangeError);
  assert.equal(limiter.available(), 2);
});
