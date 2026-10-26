export interface Rating { mu: number; sigma: number } 
export const DEFAULT_MU = 25; 
export const DEFAULT_SIGMA = 25 / 3; 
export const BETA = 25 / 6; 
export const TAU = 25 / 300; 
export function defaultRating(): Rating { return { mu: DEFAULT_MU, sigma: DEFAULT_SIGMA }; } 
export function conservative(r: Rating): number { return r.mu - 3 * r.sigma; } 
function pdf(x: number): number { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); } 
function cdf(x: number): number { return 1 / (1 + Math.exp(-1.702 * x)); } 
export function trueskillWin(w: Rating, l: Rating): [Rating, Rating] { 
  const wVar = w.sigma * w.sigma + TAU * TAU; 
  const lVar = l.sigma * l.sigma + TAU * TAU; 
  const c = Math.sqrt(2 * BETA * BETA + wVar + lVar); 
  const t = (w.mu - l.mu) / c; 
  const v = pdf(t) / Math.max(cdf(t), 1e-12); 
  const u = v * (v + t); 
  const wMu = w.mu + (wVar / c) * v; 
  const lMu = l.mu - (lVar / c) * v; 
  const wSigma = Math.sqrt(Math.max(wVar * (1 - (wVar / (c * c)) * u), 1e-9)); 
  const lSigma = Math.sqrt(Math.max(lVar * (1 - (lVar / (c * c)) * u), 1e-9)); 
  return [{ mu: wMu, sigma: wSigma }, { mu: lMu, sigma: lSigma }]; 
} 
export function decayRating(r: Rating, periods: number, halfLife: number): Rating { 
  if (periods <= 0) return { ...r }; 
  const keep = Math.pow(0.5, periods / Math.max(halfLife, 1e-9)); 
  const mu = DEFAULT_MU + (r.mu - DEFAULT_MU) * keep; 
  const sigma = Math.min(DEFAULT_SIGMA, r.sigma + (DEFAULT_SIGMA - r.sigma) * (1 - keep)); 
  return { mu, sigma }; 
} 
export type Tier = 0 | 1 | 2 | 3 | 4; 
export function tierFor(r: Rating): Tier { 
  const s = conservative(r); 
  if (s >= 40) return 4; 
  if (s >= 30) return 3; 
  if (s >= 20) return 2; 
  if (s >= 10) return 1; 
  return 0; 
} 
export interface SkillNode { id: string; prereqs: string[]; masteryMu: number; minTrials: number; recencyWindow: number } 
export interface SkillState { rating: Rating; trials: number; periodsSincePractice: number } 
export type NodeStatus = 'locked' | 'available' | 'earned' | 'dormant'; 
export function nodeStatus(node: SkillNode, state: SkillState, earned: ReadonlySet<string>): NodeStatus { 
  const prereqsMet = node.prereqs.every((p) => earned.has(p)); 
  if (!prereqsMet) return 'locked'; 
  const mastered = conservative(state.rating) >= node.masteryMu && state.trials >= node.minTrials; 
  if (!mastered) return 'available'; 
  if (state.periodsSincePractice > node.recencyWindow) return 'dormant'; 
  return 'earned'; 
} 
