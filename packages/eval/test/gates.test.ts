import { describe, expect, it } from 'vitest';  
import { compileDag, validateRoleContract, stepKey, appendMessage, verifyChain, validateSplits, shapley, collusionScore, claimOrder } from '../src/orchestration.js';  
import { rankBoard, verifyRanking, applyCaps, commissionInBand, circuitFrozen, lintRagDocs, retrieveAt, appendCheckpoint, verifyCheckpoints, leafFor, merkleRoot, merkleProof, verifyMerkle, sybilAdjust, abstentionScore, EventGateway, assertPiiFree } from '../src/gates.js';
describe('orchestration gates 820, 848-854', () => {  
  it('DAG compiles deterministically and rejects cycles', () => {  
    const steps = [{ id: 'b', role: 'worker' as const, deps: ['a'], maxIterations: 1 }, { id: 'a', role: 'coordinator' as const, deps: [], maxIterations: 1 }];  
    expect(compileDag(steps)).toEqual(['a', 'b']);  
    expect(() => compileDag([{ id: 'a', role: 'worker' as const, deps: ['a'], maxIterations: 1 }])).toThrow();  
  }); 
  it('message bus is hash-chained and budget is a mechanical fail', () => {  
    let chain = appendMessage([], 'a', 'b', 'hi', 2);  
    chain = appendMessage(chain, 'b', 'a', 'yo', 2);  
    expect(verifyChain(chain)).toBe(true);  
    expect(() => appendMessage(chain, 'a', 'b', 'x', 2)).toThrow();  
    expect(verifyChain([{ ...chain[0], body: 'tampered' }, chain[1]])).toBe(false);  
  }); 
  it('splits sum to one and Shapley sums to grand coalition value', () => {  
    expect(validateSplits({ a: 0.5, b: 0.5 })).toBe(true);  
    expect(validateSplits({ a: 0.5 })).toBe(false);  
    const phi = shapley(2, (m) => (m === 3 ? 10 : 0));  
    expect(phi[0] + phi[1]).toBeCloseTo(10, 6);  
    expect(claimOrder([{ principal: 'z', commitBlock: 2 }, { principal: 'a', commitBlock: 1 }])).toEqual(['a', 'z']);  
  });  
  it('role contracts reject an empty tool list, duplicate tools and a zero budget', () => {  
    const base = { role: 'worker' as const, allowedTools: ['read'], messageBudget: 1, contextScope: 'own' as const };  
    expect(validateRoleContract(base)).toEqual([]);  
    expect(validateRoleContract({ ...base, allowedTools: [] })).toContain('allowedTools must be non-empty');  
    expect(validateRoleContract({ ...base, allowedTools: ['read', 'read'] })).toContain('allowedTools must be unique');  
    expect(validateRoleContract({ ...base, messageBudget: 0 })).toContain('messageBudget must be positive');  
  });  
  it('step keys are deterministic and change with the iteration', () => {  
    const key = stepKey('t1', 's1', 0);  
    expect(stepKey('t1', 's1', 0)).toBe(key);  
    expect(key).toMatch(/^[0-9a-f]{64}$/);  
    expect(stepKey('t1', 's1', 1)).not.toBe(key);  
    expect(stepKey('t2', 's1', 0)).not.toBe(key);  
  });  
  it('collusion score is bounded and clamps its inputs', () => {  
    expect(collusionScore(0, 0)).toBe(0);  
    expect(collusionScore(1, 1)).toBe(1);  
    expect(collusionScore(0.5, 0.5)).toBe(0.5);  
    expect(collusionScore(-1, 2)).toBe(0.5);  
    expect(collusionScore(2, -1)).toBe(0.5);  
  });  
}); 
describe('board, caps, rag, checkpoints, airdrop, gateway', () => {  
  it('ranking is conservative and verifiable, sybil weight splits by funder', () => {  
    const entries = [{ agent: 'a', rating: { mu: 30, sigma: 2 }, funder: 'f1' }, { agent: 'b', rating: { mu: 30, sigma: 2 }, funder: 'f1' }, { agent: 'c', rating: { mu: 35, sigma: 2 }, funder: 'f2' }];  
    const ranked = rankBoard(entries);  
    expect(ranked[0].agent).toBe('c');  
    expect(ranked.find((r) => r.agent === 'a')?.weight).toBeCloseTo(0.5, 6);  
    expect(verifyRanking(entries, ranked.map((r) => r.agent))).toBe(true);  
    expect(verifyRanking(entries, ['a', 'b', 'c'])).toBe(false);  
  }); 
  it('caps clamp or reject, fee band holds 500, breaker freezes on move', () => {  
    const caps = { perTx: 10n, perTrial: 5n, epochRemaining: 100n };  
    expect(applyCaps(9n, caps, 'clamp')).toBe(5n);  
    expect(() => applyCaps(9n, caps, 'reject')).toThrow();  
    expect(commissionInBand(500)).toBe(true);  
    expect(commissionInBand(1500)).toBe(false);  
    expect(circuitFrozen(100, 130)).toBe(true);  
    expect(circuitFrozen(100, 110)).toBe(false);  
  }); 
  it('holdout content sequester: RAG corpora are screened against holdout prompts, not just ids', () => {
    const holdout = [{ probeId: 'hp-1', prompt: 'Explain why the clear daytime sky appears blue using Rayleigh scattering physics' }];
    const shortHoldout = [{ probeId: 'hp-2', prompt: 'Name the capital of France' }];
    const freshIdLeak = [{ id: 'doc-fresh', version: 'v1', text: 'Notes: Explain why the clear daytime sky appears blue using Rayleigh scattering physics, discussed at length.', byo: true }];
    expect(() => lintRagDocs(freshIdLeak, new Set(), holdout)).toThrow(/hp-1/);
    const shingleLeak = [{ id: 'doc-shingle', version: 'v1', text: 'filler words here the clear daytime sky appears blue using Rayleigh plus trailing analysis', byo: true }];
    expect(() => lintRagDocs(shingleLeak, new Set(), holdout)).toThrow(/hp-1/);
    const trainDoc = [{ id: 'doc-train', version: 'v1', text: 'Explain why the clear daytime sky appears green using photosynthesis pigment absorption', byo: true }];
    expect(() => lintRagDocs(trainDoc, new Set(), holdout)).not.toThrow();
    const shortLeak = [{ id: 'doc-short', version: 'v1', text: 'Quiz answers. Name the capital of France. More text follows here.', byo: true }];
    expect(() => lintRagDocs(shortLeak, new Set(), shortHoldout)).toThrow(/hp-2/);
    expect(() => retrieveAt(freshIdLeak, 'v1', 'Notes', { ids: new Set(), content: holdout })).toThrow(/hp-1/);
  });
  it('RAG lints holdout and BYO, retrieves only at pinned version', () => {  
    const docs = [{ id: 'd1', version: 'v1', text: 'Hello World', byo: true }, { id: 'h1', version: 'v1', text: 'secret', byo: true }];  
    expect(() => lintRagDocs(docs, new Set(['h1']))).toThrow();  
    expect(retrieveAt(docs, 'v1', 'hello').map((d) => d.id)).toEqual(['d1']);  
    expect(retrieveAt(docs, 'v2', 'hello')).toEqual([]);  
  }); 
  it('checkpoints verify regardless of wall clock, merkle proofs verify', () => {  
    let cp = appendCheckpoint([], 's1', 100);  
    cp = appendCheckpoint(cp, 's2', 999999);  
    expect(verifyCheckpoints(cp)).toBe(true);  
    expect(verifyCheckpoints([{ ...cp[0], wallClock: 1 }, cp[1]])).toBe(true);  
    const leaves = [leafFor('a', 10n), leafFor('b', 20n), leafFor('c', 30n)];  
    const root = merkleRoot(leaves);  
    expect(verifyMerkle(leaves[1], merkleProof(leaves, leaves[1]), root)).toBe(true);  
    expect(verifyMerkle(leaves[1], merkleProof(leaves, leaves[1]), merkleRoot([leafFor('x', 1n)]))).toBe(false);  
    expect(sybilAdjust([{ agent: 'a', funder: 'f', amount: 100n }, { agent: 'b', funder: 'f', amount: 100n }])[0].amount).toBe(50n);  
  }); 
  it('gateway replays from cursor and diffs after snapshot, payloads PII-free', () => {  
    const gw = new EventGateway();  
    gw.publish('trial', 'one'); gw.publish('trial', 'two');  
    const snap = gw.snapshot();  
    gw.publish('trial', 'three');  
    expect(snap.seq).toBe(2);  
    expect(gw.diff(snap.seq).map((e) => e.data)).toEqual(['three']);  
    expect(gw.replay(2).map((e) => e.data)).toEqual(['two', 'three']);  
    expect(() => assertPiiFree({ phone: '123' })).toThrow();  
    expect(() => assertPiiFree({ trial: 't1' })).not.toThrow();  
  });  
}); 

/**
 * Gate 824's per-probe reward primitive. The aggregate lives in @crucible/grader now; this shape
 * is still the thing a training loop scores one outcome with, so it gets its own assertions rather
 * than being exported and trusted. A confident wrong answer is the worst outcome, a hedged
 * abstention is better than a guess, and a correct answer earns its stated confidence.
 */
describe('abstention reward primitive', () => {
  it('orders correct, hedged abstention and confident wrong answers', () => {
    expect(abstentionScore('correct', 0.9)).toBe(0.9);
    expect(abstentionScore('abstain', 0.5)).toBe(0.5);
    expect(abstentionScore('abstain', 0.9)).toBe(0.3);
    expect(abstentionScore('wrong', 0.9)).toBe(-0.9);
    expect(abstentionScore('correct', 0.9)).toBeGreaterThan(abstentionScore('abstain', 0.5));
    expect(abstentionScore('abstain', 0.5)).toBeGreaterThan(abstentionScore('wrong', 0.9));
  });
});
