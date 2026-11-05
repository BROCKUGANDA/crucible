import { describe, expect, it } from 'vitest';
import { buildEvalManifest } from '@crucible/smith';
import { rankBoard, rankBoardFull } from '../src/gates.js';

const HASH_A = '0x1111111111111111111111111111111111111111111111111111111111111111';
const HASH_B = '0x2222222222222222222222222222222222222222222222222222222222222222';
function manifest(overrides: Partial<Parameters<typeof buildEvalManifest>[0]> = {}) {
  return buildEvalManifest({
    taskDigest: HASH_A, datasetDigest: HASH_B, suiteDigest: HASH_A,
    evaluator: { id: 'argus', version: '1.0.0', rubricVersion: '1' },
    model: { provider: 'test', name: 'model-a', version: 'snapshot-a' },
    agent: { operator: 'operator-a', scaffold: 'runner/1.0.0' },
    environment: { imageDigest: HASH_A, isolation: 'container' },
    seed: 'fixed-seed',
    scoring: { feeSchedule: 'legacy-v1', feeScheduleVersion: '1', decision: 'deterministic-suite' },
    startedAt: '2026-11-01T00:00:00.000Z', finishedAt: '2026-11-01T00:01:00.000Z',
    ...overrides,
  });
}

describe('manifest cohort ranking', () => {
  it('keeps model variants together, separates incompatible conditions, and leaves missing manifests unranked', () => {
    const first = manifest();
    const second = manifest({ model: { provider: 'test', name: 'model-b', version: 'snapshot-b' }, startedAt: '2026-11-02T00:00:00.000Z', finishedAt: '2026-11-02T00:01:00.000Z' });
    const other = manifest({ suiteDigest: HASH_B });
    const result = rankBoardFull([
      { agent: 'a', rating: { mu: 30, sigma: 2 }, funder: 'f1', manifest: first },
      { agent: 'b', rating: { mu: 35, sigma: 2 }, funder: 'f1', manifest: second },
      { agent: 'c', rating: { mu: 40, sigma: 2 }, funder: 'f2', manifest: other },
      { agent: 'legacy', rating: { mu: 50, sigma: 2 }, funder: 'f3' },
    ]);
    expect(result.cohorts).toHaveLength(2);
    expect(result.cohorts.find((cohort) => cohort.entries.some((entry) => entry.agent === 'a'))?.entries.map((entry) => entry.agent)).toEqual(['b', 'a']);
    expect(result.unranked.map((entry) => entry.agent)).toEqual(['legacy']);
    expect(() => rankBoard([
      { agent: 'a', rating: { mu: 30, sigma: 2 }, funder: 'f1', manifest: first },
      { agent: 'c', rating: { mu: 40, sigma: 2 }, funder: 'f2', manifest: other },
    ])).toThrow(/missing or incompatible evaluation manifests/);
  });
});
