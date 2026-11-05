import { sha256 } from '@crucible/crypto';  
import { conservative, defaultRating, type Rating } from './ratings.js';  
import type { EvalManifest } from '@crucible/smith';  
import { scoresComparable, compareManifests as compareManifestsImport } from '@crucible/smith';  
export interface BoardEntry { agent: string; rating: Rating; funder: string; manifest?: EvalManifest }  
export interface RankingExclusion { agent: string; reason: string; incompatibleWith: string[] }  

export interface RankingResult {  
  ranked: { agent: string; score: number; weight: number }[];  
  excluded: RankingExclusion[];  
}  

export function rankBoard(entries: BoardEntry[]): { agent: string; score: number; weight: number }[] {  
  return rankBoardFull(entries).ranked;  
}  

export function rankBoardFull(entries: BoardEntry[]): RankingResult {  
  const clusters = new Map();  
  for (const e of entries) clusters.set(e.funder, (clusters.get(e.funder) ?? 1) + 0);  
  // Build funder clusters  
  const funderCounts = new Map<string, number>();  
  for (const e of entries) funderCounts.set(e.funder, (funderCounts.get(e.funder) ?? 0) + 1);  

  const excluded: RankingExclusion[] = [];  
  const compatible: BoardEntry[] = [];  

  for (let i = 0; i < entries.length; i++) {  
    const entry = entries[i]!;  
    if (!entry.manifest) {  
      // No manifest: backward-compatible — rank without comparability check.  
      compatible.push(entry);  
      continue;  
    }  
    // Check comparability against all other entries that have manifests  
    const incompatibleWith: string[] = [];  
    let hasIncompatible = false;  
    for (let j = 0; j < entries.length; j++) {  
      if (i === j) continue;  
      const other = entries[j]!;  
      if (!other.manifest) continue;  
      if (!scoresComparable(entry.manifest, other.manifest)) {  
        hasIncompatible = true;  
        incompatibleWith.push(other.agent);  
      }  
    }  
    // An entry is excluded only if it is incompatible with ALL other entries  
    // (i.e., it forms its own group). Otherwise it stays in the main ranking.  
    if (hasIncompatible && incompatibleWith.length === entries.filter((e, idx) => idx !== i && e.manifest).length) {  
      excluded.push({ agent: entry.agent, reason: 'incompatible evaluation conditions: ' + compareManifestPaths(entry.manifest, entries.filter((e, idx) => idx !== i && e.manifest)[0]?.manifest), incompatibleWith });  
      continue;  
    }  
    compatible.push(entry);  
  }  

  const ranked = compatible.map((e) => ({ agent: e.agent, score: conservative(e.rating), weight: 1 / (funderCounts.get(e.funder) ?? 1) })).sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));  
  return { ranked, excluded };  
}  

function compareManifestPaths(left: EvalManifest | undefined, right: EvalManifest | undefined): string {  
  if (!left || !right) return 'unknown';  
  const diffs = compareManifestsImport(left, right);  
  return diffs.map((d) => d.path).join(', ');  
} 
export function verifyRanking(entries: BoardEntry[], claimed: string[]): boolean {  
  const actual = rankBoard(entries).map((r) => r.agent);  
  return actual.length === claimed.length && actual.every((a, i) => a === claimed[i]);  
}  
export function coldStart(): Rating { return defaultRating(); }  
export function targetDifficulty(r: Rating, accuracy = 0.7): number {  
  const theta = conservative(r) / 10;  
  return theta + Math.log(accuracy / (1 - accuracy));  
} 
export const FEE_BPS_CANONICAL = 500;  
export const FEE_BAND_MIN = 100;  
export const FEE_BAND_MAX = 1000;  
export function commissionInBand(bps: number): boolean { return bps >= FEE_BAND_MIN && bps <= FEE_BAND_MAX; }  
export function applyCaps(amount: bigint, caps: { perTx: bigint; perTrial: bigint; epochRemaining: bigint }, mode: 'reject' | 'clamp'): bigint {  
  const cap = [caps.perTx, caps.perTrial, caps.epochRemaining].reduce((a, b) => (a < b ? a : b));  
  if (amount <= cap) return amount;  
  if (mode === 'reject') throw new Error('ceiling cap exceeded');  
  return cap;  
} 
export function circuitFrozen(pinnedPrice: number, currentPrice: number, threshold = 0.2): boolean {  
  if (pinnedPrice <= 0) throw new Error('pinned price must be positive');  
  return Math.abs(currentPrice - pinnedPrice) / pinnedPrice > threshold;  
}  
export function gasInBand(gas: number, ceiling: number): boolean { return gas > 0 && gas <= ceiling; } 
export interface RagDoc { id: string; version: string; text: string; byo: boolean }  
/** A holdout probe's identity + prompt, fingerprinted for content screening (gate 899). */
export interface HoldoutFingerprint { probeId: string; prompt: string }
const SHINGLE_WORDS = 8;
function ragTokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
}
function ragShingles(tokens: string[]): Set<string> {
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length <= SHINGLE_WORDS) { out.add(tokens.join(' ')); return out; }
  for (let i = 0; i + SHINGLE_WORDS <= tokens.length; i++) out.add(tokens.slice(i, i + SHINGLE_WORDS).join(' '));
  return out;
}
export function lintRagDocs(docs: RagDoc[], holdoutIds: ReadonlySet<string>, holdoutContent: readonly HoldoutFingerprint[] = []): void {  
  for (const d of docs) {  
    if (holdoutIds.has(d.id)) throw new Error('holdout doc in retrieval corpus: ' + d.id);  
    if (!d.byo) throw new Error('BYO declaration missing: ' + d.id);  
    if (!d.version) throw new Error('unpinned doc version: ' + d.id);  
  }  
  // Content sequester (gate 899): an id check alone cannot stop a fresh-id doc
  // that quotes a holdout prompt. Screen normalized text: any shared 8-word
  // shingle (or whole-prompt containment for short prompts) is a leak.
  if (holdoutContent.length > 0) {
    const prints = holdoutContent.map((h) => {
      const tokens = ragTokens(h.prompt);
      return { probeId: h.probeId, joined: tokens.join(' '), shingles: ragShingles(tokens) };
    });
    for (const d of docs) {
      const tokens = ragTokens(d.text);
      const joined = tokens.join(' ');
      const docShingles = ragShingles(tokens);
      for (const p of prints) {
        if (p.joined.length > 0 && joined.includes(p.joined)) throw new Error('holdout content in retrieval corpus: ' + d.id + ' leaks ' + p.probeId);
        for (const s of p.shingles) {
          if (docShingles.has(s)) throw new Error('holdout content in retrieval corpus: ' + d.id + ' leaks ' + p.probeId);
        }
      }
    }
  }
}  
export function retrieveAt(docs: RagDoc[], version: string, query: string, holdout?: { ids: ReadonlySet<string>; content?: readonly HoldoutFingerprint[] }): RagDoc[] {  
  if (holdout) lintRagDocs(docs, holdout.ids, holdout.content ?? []);
  const q = query.toLowerCase();  
  return docs.filter((d) => d.version === version && d.text.toLowerCase().includes(q));  
} 
export interface Checkpoint { state: string; prev: string; hash: string; wallClock: number }  
export function appendCheckpoint(chain: Checkpoint[], state: string, wallClock: number): Checkpoint[] {  
  const prev = chain.length === 0 ? 'genesis' : (chain[chain.length - 1] as Checkpoint).hash;  
  const hash = sha256(prev + '|' + state);  
  return [...chain, { state, prev, hash, wallClock }];  
}  
export function verifyCheckpoints(chain: Checkpoint[]): boolean {  
  let prev = 'genesis';  
  for (const c of chain) { if (c.prev !== prev || c.hash !== sha256(prev + '|' + c.state)) return false; prev = c.hash; }  
  return true;  
} 
export function abstentionScore(outcome: 'correct' | 'wrong' | 'abstain', confidence: number): number {  
  if (outcome === 'correct') return confidence;  
  if (outcome === 'abstain') return 0.5 * (1 - Math.abs(confidence - 0.5));  
  return -confidence;  
} 
export function leafFor(agent: string, amount: bigint): string { return sha256(agent + ':' + amount.toString()); }  
export function merkleRoot(leaves: string[]): string {  
  if (leaves.length === 0) throw new Error('empty allocation');  
  let level = [...leaves].sort();  
  while (level.length > 1) {  
    const next: string[] = [];  
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i] as string, (level[i + 1] ?? level[i]) as string));  
    level = next;  
  }  
  return level[0] as string;  
} 
export function merkleProof(leaves: string[], leaf: string): string[] {  
  let level = [...leaves].sort();  
  let idx = level.indexOf(leaf);  
  if (idx < 0) throw new Error('leaf not in tree');  
  const proof: string[] = [];  
  while (level.length > 1) {  
    const sib = (idx % 2 === 0 ? (level[idx + 1] ?? level[idx]) : level[idx - 1]) as string;  
    proof.push(sib);  
    const next: string[] = [];  
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i] as string, (level[i + 1] ?? level[i]) as string));  
    level = next; idx = Math.floor(idx / 2);  
  }  
  return proof;  
} 
export function pairHash(a: string, b: string): string { return a < b ? sha256(a + b) : sha256(b + a); }  
export function verifyMerkle(leaf: string, proof: string[], root: string): boolean {  
  let h = leaf;  
  for (const sib of proof) h = pairHash(h, sib);  
  return h === root;  
}  
export function sybilAdjust(raw: { agent: string; funder: string; amount: bigint }[]): { agent: string; amount: bigint }[] {  
  const clusters = new Map();  
  for (const r of raw) clusters.set(r.funder, (clusters.get(r.funder) ?? 0) + 1);  
  return raw.map((r) => ({ agent: r.agent, amount: r.amount / BigInt(clusters.get(r.funder) ?? 1) }));  
} 
export interface GatewayEvent { seq: number; kind: string; data: string }  
// In-memory model of the replay/snapshot contract, exercised by the gate test. It is NOT the
// live gateway: that is apps/api/src/app.ts `/stream` + `/snapshot` (SSE, one shared tick). Do
// not wire this beside it; one gateway is the rule.
export class EventGateway {  
  private events: GatewayEvent[] = [];  
  publish(kind: string, data: string): GatewayEvent {  
    const ev = { seq: this.events.length + 1, kind, data };  
    this.events.push(ev); return ev;  
  }  
  replay(fromSeq: number): GatewayEvent[] { return this.events.filter((e) => e.seq >= fromSeq); }  
  snapshot(): { seq: number; events: GatewayEvent[] } { return { seq: this.events.length, events: [...this.events] }; }  
  diff(sinceSeq: number): GatewayEvent[] { return this.replay(sinceSeq + 1); }  
} 
export function assertPiiFree(payload: Record<string, unknown>): void {  
  for (const k of Object.keys(payload)) {  
    const key = k.toLowerCase();  
    if (key.includes('phone') || key.includes('whatsapp') || key.includes('email')) throw new Error('PII field not allowed: ' + k);  
  }  
}  
