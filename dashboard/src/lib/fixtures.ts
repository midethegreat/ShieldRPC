// Bundles the shared fixtures (data/fixtures/sample-transactions.json) into a
// typed TS object the dashboard can consume without a separate server route.

// Using Vite `?raw` + JSON.parse keeps bundler friendliness (works in dev and
// production build without any extra Vite plugins).
import fixturesRaw from '../../../data/fixtures/sample-transactions.json?raw';

export interface SampleFixture {
  id: string;
  label: string;
  category: string; // 'safe' | 'risk:unlimited_approval' | etc.
  notes: string;
  serializedTransaction: string;
}

export interface FixturesBundle {
  generatedAt: string;
  schemaVersion: number;
  tokenProgramId: string;
  fakeMint: string;
  samples: SampleFixture[];
}

export const fixtures: FixturesBundle = (() => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fixturesRaw);
  } catch (e) {
    console.error("fixtures: failed to parse sample-transactions.json raw bundle", e);
  }
  const obj =
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { samples?: unknown }).samples)
      ? (parsed as FixturesBundle)
      : null;
  if (!obj) {
    console.warn("fixtures: raw bundle invalid or missing samples array; falling back to empty safe bundle");
    return {
      generatedAt: new Date().toISOString(),
      schemaVersion: 1,
      tokenProgramId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      fakeMint: "11111111111111111111111111111111",
      samples: [],
    } satisfies FixturesBundle;
  }
  return obj;
})();

export const SAMPLE_CATEGORIES: { id: string; label: string; tone: 'safe' | 'warn' | 'bad' }[] = [
  { id: 'safe', label: 'Safe', tone: 'safe' },
  { id: 'risk:unlimited_approval', label: 'Unlimited approval', tone: 'bad' },
  { id: 'risk:authority_change', label: 'Authority change', tone: 'bad' },
  { id: 'risk:known_malicious_address', label: 'Malicious address', tone: 'bad' },
  { id: 'risk:fresh_program', label: 'Fresh program', tone: 'warn' },
];
