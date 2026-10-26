import { sha256 } from '@crucible/crypto'; 
export type SwarmRole = 'coordinator' | 'worker' | 'critic' | 'integrator';  
export interface DagStep { id: string; role: SwarmRole; deps: string[]; maxIterations: number }  
export interface RoleContract { role: SwarmRole; allowedTools: string[]; messageBudget: number; contextScope: 'own' | 'team' | 'all' } 
export function validateRoleContract(c: RoleContract): string[] {  
  const errs: string[] = [];  
  if (c.messageBudget <= 0) errs.push('messageBudget must be positive');  
  if (c.allowedTools.length === 0) errs.push('allowedTools must be non-empty');  
  if (new Set(c.allowedTools).size !== c.allowedTools.length) errs.push('allowedTools must be unique');  
  return errs;  
} 
export function compileDag(steps: DagStep[]): string[] {  
  const byId = new Map(steps.map((s) => [s.id, s] as const));  
  for (const s of steps) {  
    if (s.maxIterations < 1) throw new Error('iteration cap must be at least 1: ' + s.id);  
    for (const d of s.deps) if (!byId.has(d)) throw new Error('unknown dep ' + d + ' for ' + s.id);  
  } 
  const done = new Set();  
  const order: string[] = [];  
  const sorted = [...steps].sort((a, b) => a.id.localeCompare(b.id));  
  let progressed = true;  
  while (order.length < steps.length && progressed) {  
    progressed = false;  
    for (const s of sorted) {  
      if (done.has(s.id)) continue;  
      if (s.deps.every((d) => done.has(d))) { done.add(s.id); order.push(s.id); progressed = true; }  
    }  
  } 
  if (order.length !== steps.length) throw new Error('cycle detected: no topological order');  
  return order;  
}  
export function stepKey(trialId: string, stepId: string, iteration: number): string {  
  return sha256(trialId + ':' + stepId + ':' + String(iteration));  
} 
export interface BusMessage { from: string; to: string; body: string; prev: string; hash: string }  
export function appendMessage(chain: BusMessage[], from: string, to: string, body: string, budget: number): BusMessage[] {  
  if (chain.length >= budget) throw new Error('message budget overrun is a mechanical fail');  
  const prev = chain.length === 0 ? 'genesis' : (chain[chain.length - 1] as BusMessage).hash;  
  const hash = sha256(prev + '|' + from + '|' + to + '|' + body);  
  return [...chain, { from, to, body, prev, hash }];  
}  
export function verifyChain(chain: BusMessage[]): boolean {  
  let prev = 'genesis';  
  for (const m of chain) {  
    if (m.prev !== prev) return false;  
    if (m.hash !== sha256(prev + '|' + m.from + '|' + m.to + '|' + m.body)) return false;  
    prev = m.hash;  
  }  
  return true;  
} 
export function validateSplits(splits: Record<string, number>): boolean {  
  const vals = Object.values(splits);  
  if (vals.some((v) => v < 0)) return false;  
  const sum = vals.reduce((a, b) => a + b, 0);  
  return Math.abs(sum - 1) < 1e-9;  
} 
export function shapley(n: number, v: (mask: number) => number): number[] {  
  if (n > 8) throw new Error('bounded Shapley: at most 8 members');  
  const phi = new Array(n).fill(0) as number[];  
  const fact = [1, 1, 2, 6, 24, 120, 720, 5040, 40320];  
  for (let i = 0; i < n; i++) {  
    for (let mask = 0; mask < (1 << n); mask++) {  
      if (mask & (1 << i)) continue;  
      let s = 0; for (let b = 0; b < n; b++) if (mask & (1 << b)) s++;  
      const w = ((fact[s] as number) * (fact[n - s - 1] as number)) / (fact[n] as number);  
      phi[i] = (phi[i] as number) + w * (v(mask | (1 << i)) - v(mask));  
    }  
  }  
  return phi as number[];  
} 
export function collusionScore(sharedFunding: number, messageOverlap: number): number {  
  const s = 0.5 * Math.min(1, Math.max(0, sharedFunding)) + 0.5 * Math.min(1, Math.max(0, messageOverlap));  
  return s;  
}  
export function claimOrder(claims: { principal: string; commitBlock: number }[]): string[] {  
  return [...claims].sort((a, b) => a.commitBlock - b.commitBlock || a.principal.localeCompare(b.principal)).map((c) => c.principal);  
}  
