import { describe, expect, it } from 'vitest';
import { ManualClock } from './clock.ts';

describe('ManualClock', () => {
  const start = Date.parse('2026-01-01T00:00:00Z');

  it('stands still until advanced', () => {
    const clock = new ManualClock(start);
    expect(clock.now().getTime()).toBe(start);
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:30.000Z');
  });

  it('refuses to advance backwards, but can be set backwards', () => {
    const clock = new ManualClock(start);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    clock.set(Date.parse('1970-01-01T00:00:00Z'));
    expect(clock.now().getTime()).toBe(0);
  });

  it('hands out copies, so callers cannot move the clock', () => {
    const clock = new ManualClock(start);
    clock.now().setTime(0);
    expect(clock.now().getTime()).toBe(start);
  });

  it('rejects invalid times', () => {
    expect(() => new ManualClock(Number.NaN)).toThrow(RangeError);
    expect(() => new ManualClock(new Date('not a date'))).toThrow(RangeError);
  });
});
