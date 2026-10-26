import { describe, expect, it } from 'vitest';
import { defaultRating, conservative, trueskillWin, decayRating, tierFor, nodeStatus, type SkillNode } from '../src/ratings.js';
describe('ratings (gates 799, 812, 841, 855-858)', () => { 
  it('winner gains, loser drops, both sigmas shrink', () => { 
    const [w, l] = trueskillWin(defaultRating(), defaultRating()); 
    expect(w.mu).toBeGreaterThan(25); 
    expect(l.mu).toBeLessThan(25); 
    expect(w.sigma).toBeLessThan(defaultRating().sigma); 
    expect(l.sigma).toBeLessThan(defaultRating().sigma); 
  }); 
  it('upset moves rating more than expected win', () => { 
    const strong = { mu: 35, sigma: 3 }; 
    const weak = { mu: 15, sigma: 3 }; 
    const [w1] = trueskillWin(strong, weak); 
    const [w2, l2] = trueskillWin(weak, strong);
    expect(w2.mu - 15).toBeGreaterThan(w1.mu - 35);
    expect(w2.mu).toBeCloseTo(16.2, 1);
    expect(w2.sigma).toBeLessThan(3);
    expect(l2.sigma).toBeLessThan(3); 
  }); 
  it('decay pulls mu to prior and sigma up, never past default', () => { 
    const d = decayRating({ mu: 45, sigma: 2 }, 10, 10); 
    expect(d.mu).toBeCloseTo(35, 6); 
    expect(d.sigma).toBeGreaterThan(2); 
    expect(decayRating({ mu: 45, sigma: 2 }, 0, 10)).toEqual({ mu: 45, sigma: 2 }); 
  }); 
  it('tiers are conservative: high mu with wide sigma stays low', () => { 
    expect(tierFor({ mu: 50, sigma: 2 })).toBe(4); 
    expect(tierFor({ mu: 50, sigma: 20 })).toBe(0); 
    expect(conservative(defaultRating())).toBeCloseTo(0, 6); 
  }); 
  it('skill nodes: locked, available, earned, dormant', () => { 
    const node: SkillNode = { id: 'b', prereqs: ['a'], masteryMu: 20, minTrials: 3, recencyWindow: 5 }; 
    const strong = { rating: { mu: 30, sigma: 2 }, trials: 5, periodsSincePractice: 1 }; 
    expect(nodeStatus(node, strong, new Set())).toBe('locked'); 
    expect(nodeStatus(node, strong, new Set(['a']))).toBe('earned'); 
    expect(nodeStatus(node, { ...strong, periodsSincePractice: 9 }, new Set(['a']))).toBe('dormant'); 
    expect(nodeStatus(node, { ...strong, trials: 1 }, new Set(['a']))).toBe('available'); 
  }); 
}); 
