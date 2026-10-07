import { describe, expect, it } from 'vitest';
import { analyzeChannels, availableChannelModes, resolveChannelMode } from '../channel-mix';
import type { AudioFeatures } from '../models';

const SR = 8000;
const tone = (freq: number, seconds: number, amp = .4, sign = 1) => Float32Array.from({ length: Math.floor(seconds * SR) }, (_, i) => amp * sign * Math.sin(2 * Math.PI * freq * i / SR));
const silence = (seconds: number) => new Float32Array(Math.floor(seconds * SR));
const featureKeys = Object.keys(analyzeChannels([tone(220, .1)], SR, .1, 'left')) as Array<keyof AudioFeatures>;

describe('channel modes', () => {
  it('offers only the choices that actually exist', () => {
    expect(availableChannelModes(1)).toEqual(['left']);
    expect(availableChannelModes(2)).toEqual(['left', 'right', 'dual']);
    expect(resolveChannelMode('dual', 1)).toBe('left');
    expect(resolveChannelMode('right', 1)).toBe('left');
    expect(resolveChannelMode('right', 2)).toBe('right');
  });
  it('falls back to the existing channel when dual is requested for mono audio', () => {
    const only = tone(220, 1);
    const dual = analyzeChannels([only], SR, 1, 'dual');
    const single = analyzeChannels([only], SR, 1, 'left');
    for (const key of featureKeys) expect(dual[key]).toBeCloseTo(single[key], 10);
  });
  it('matches single-channel analysis when both sides carry the same signal', () => {
    const channels = [tone(220, 2), tone(220, 2)];
    const dual = analyzeChannels(channels, SR, 2, 'dual');
    const single = analyzeChannels(channels, SR, 2, 'left');
    for (const key of featureKeys) expect(dual[key]).toBeCloseTo(single[key], 10);
  });
  it('does not cancel out-of-phase content by summing', () => {
    const channels = [tone(220, 2), tone(220, 2, .4, -1)];
    const dual = analyzeChannels(channels, SR, 2, 'dual');
    const single = analyzeChannels(channels, SR, 2, 'left');
    expect(dual.loudness).toBeCloseTo(single.loudness, 10);
    expect(dual.loudness).toBeGreaterThan(.2);
    expect(dual.pauseRatio).toBeLessThan(.1);
  });
  it('is not diluted by a silent side', () => {
    const channels = [tone(220, 2), silence(2)];
    const dual = analyzeChannels(channels, SR, 2, 'dual');
    const single = analyzeChannels(channels, SR, 2, 'left');
    for (const key of featureKeys) expect(dual[key]).toBeCloseTo(single[key], 10);
  });
  it('hears alternating speakers without phantom pauses and merges both sides by energy', () => {
    const channels = [Float32Array.from([...tone(200, 1), ...silence(1)]), Float32Array.from([...silence(1), ...tone(400, 1)])];
    const dual = analyzeChannels(channels, SR, 2, 'dual');
    const leftOnly = analyzeChannels(channels, SR, 2, 'left');
    const rightOnly = analyzeChannels(channels, SR, 2, 'right');
    expect(leftOnly.pauseRatio).toBeGreaterThan(.4);
    expect(rightOnly.pauseRatio).toBeGreaterThan(.4);
    expect(dual.pauseRatio).toBeLessThan(.1);
    expect(dual.pauseRatio).toBeLessThan(Math.min(leftOnly.pauseRatio, rightOnly.pauseRatio) / 4);
    expect(dual.pitch).toBeGreaterThan(leftOnly.pitch);
    expect(dual.pitch).toBeLessThan(rightOnly.pitch);
    expect(dual.loudness).toBeGreaterThan(0);
  });
});
