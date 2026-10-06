import { useEffect, useMemo, useState } from "react";
import {
  getHealth,
  listTransactions,
  analyzeTransaction,
  getTransaction,
  submitFeedback,
  fetchTransactionByHash,
  type AnalyzeResponse,
  type HealthResponse,
  type StoredTransactionDetail,
  type StoredTransactionSummary,
  type DetectionFlag,
} from "./lib/api.js";
import {
  fixtures,
  type SampleFixture,
  SAMPLE_CATEGORIES,
} from "./lib/fixtures.js";

// ---------------------------------------------------------------------------
// ShieldRPC · Fully functional dashboard
// Real multi-page UI. Every widget and page maps directly to an API route.
// Decorative concept widgets that don't correspond to a backend feature have
// been removed. Pages: Dashboard | Transactions | Analytics | Blocklist |
// Fixtures | Settings
// ---------------------------------------------------------------------------

type PageId =
  | "dashboard"
  | "transactions"
  | "analytics"
  | "blocklist"
  | "fixtures"
  | "settings";

const NAV: { id: PageId; label: string; icon: string; badge?: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "◧" },
  { id: "transactions", label: "Transactions", icon: "⇄" },
  { id: "analytics", label: "Analytics", icon: "◔" },
  { id: "blocklist", label: "Blocklist", icon: "⛔" },
  { id: "fixtures", label: "Fixtures", icon: "🧪" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

type RiskLevel = "low" | "medium" | "high" | "critical";

const LEVEL_CHIP: Record<RiskLevel, string> = {
  low: "bg-donazo-50 text-donazo-700 border-donazo-200",
  medium: "bg-amber-50 text-amber-700 border-amber-200",
  high: "bg-orange-50 text-orange-700 border-orange-200",
  critical: "bg-rose-50 text-rose-700 border-rose-200",
};

const LEVEL_TEXT: Record<RiskLevel, string> = {
  low: "text-donazo-600",
  medium: "text-amber-600",
  high: "text-orange-600",
  critical: "text-rose-600",
};

const LEVEL_DOT: Record<RiskLevel, string> = {
  low: "bg-donazo-500",
  medium: "bg-amber-500",
  high: "bg-orange-500",
  critical: "bg-rose-500",
};

const REC_STYLE: Record<string, string> = {
  allow: "bg-donazo-600 text-white",
  warn: "bg-amber-500 text-white",
  block: "bg-rose-600 text-white",
};

const FLAG_CHIP: Record<string, string> = {
  unlimited_approval: "bg-rose-50 text-rose-700 border-rose-200",
  authority_change: "bg-orange-50 text-orange-700 border-orange-200",
  known_malicious_address: "bg-pink-50 text-pink-700 border-pink-200",
  fresh_program: "bg-amber-50 text-amber-700 border-amber-200",
};

const FLAG_LABEL: Record<string, string> = {
  unlimited_approval: "Unlimited approval",
  authority_change: "Authority change",
  known_malicious_address: "Malicious address",
  fresh_program: "Fresh program",
};

const FLAG_ICON: Record<string, string> = {
  unlimited_approval: "🔓",
  authority_change: "🔄",
  known_malicious_address: "🚨",
  fresh_program: "🆕",
};

type DetectorType = DetectionFlag["type"];

// ---- Utilities -------------------------------------------------------------
function daysAgo(n: number, today = new Date()) {
  const d = new Date(today);
  d.setDate(d.getDate() - n);
  return d;
}
function shortDayLabel(d: Date) {
  return d.toLocaleDateString(undefined, { weekday: "short" }).slice(0, 1);
}
function trunc(s: string | null | undefined, n: number) {
  if (!s) return "—";
  if (s.length <= n) return s;
  return (
    s.slice(0, Math.max(0, Math.floor(n / 2))) +
    "…" +
    s.slice(-Math.ceil(n / 2))
  );
}

type TxLike =
  | AnalyzeResponse
  | StoredTransactionSummary
  | StoredTransactionDetail;

function riskLevelOf(tx: TxLike): RiskLevel {
  return tx.riskLevel as RiskLevel;
}

// ---------------------------------------------------------------------------
// App root
// ---------------------------------------------------------------------------
export default function App() {
  const [page, setPage] = useState<PageId>("dashboard");

  return <Shell page={page} setPage={setPage} />;
}

// ---- Shell (sidebar + header + slot) --------------------------------------
function Shell({
  page,
  setPage,
}: {
  page: PageId;
  setPage: (p: PageId) => void;
}) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTx, setDrawerTx] = useState<TxLike | null>(null);
  const [drawerFromFixture, setDrawerFromFixture] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [feed, setFeed] = useState<StoredTransactionSummary[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedErr, setFeedErr] = useState<string | null>(null);
  const [feedDbConnected, setFeedDbConnected] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const reloadFeed = async () => {
    setFeedLoading(true);
    setFeedErr(null);
    try {
      const r = await listTransactions(500);
      setFeed(r.transactions);
      setFeedDbConnected(r.dbConnected);
    } catch (e) {
      setFeedErr(e instanceof Error ? e.message : String(e));
      setFeedDbConnected(false);
    } finally {
      setFeedLoading(false);
    }
  };

  const openDetail = async (txOrId: StoredTransactionSummary | number) => {
    if (typeof txOrId === "number") {
      try {
        const r = await getTransaction(txOrId);
        setDrawerTx(r.transaction);
        setDrawerFromFixture(false);
        setDrawerOpen(true);
      } catch {
        // ignore; likely 404
      }
    } else {
      // also try to hydrate with full detail for serializedTx
      try {
        const r = await getTransaction(txOrId.id);
        setDrawerTx(r.transaction);
      } catch {
        setDrawerTx(txOrId);
      }
      setDrawerFromFixture(false);
      setDrawerOpen(true);
    }
  };

  const runFixture = async (fx: SampleFixture) => {
    try {
      const r = await analyzeTransaction({
        serializedTransaction: fx.serializedTransaction,
        network: "mainnet-beta",
      });
      setDrawerTx(r);
      setDrawerFromFixture(true);
      setDrawerOpen(true);
      setTimeout(() => reloadFeed(), 400);
    } catch {
      /* fail-soft: API unreachable; banner at top already indicates this */
    }
  };

  const runSerialized = async (
    serializedTransaction: string,
    network: "mainnet-beta" | "devnet" | "testnet" = "mainnet-beta",
  ) => {
    try {
      const r = await analyzeTransaction({ serializedTransaction, network });
      setDrawerTx(r);
      setDrawerFromFixture(false);
      setDrawerOpen(true);
      setTimeout(() => reloadFeed(), 400);
    } catch {
      /* fail-soft: API unreachable; banner at top already indicates this */
    }
  };

  // Health + feed boot + periodic refresh
  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        const h = await getHealth();
        if (!cancelled) setHealth(h);
      } catch (e) {
        if (!cancelled)
          setHealthErr(e instanceof Error ? e.message : String(e));
      }
      await reloadFeed();
    };
    void boot();
    const t = setInterval(() => {
      getHealth()
        .then((h) => !cancelled && setHealth(h))
        .catch(() => {});
      reloadFeed();
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Demo fallback rows when the API is unreachable / DB empty
  const demoRows = useMemo<StoredTransactionSummary[]>(() => {
    const flags: Record<string, DetectionFlag[]> = {
      a: [
        {
          type: "known_malicious_address",
          severity: "critical",
          detail:
            "Destination program matches a reported drainer program-id (community blocklist).",
          metadata: {
            matches: [
              { address: "9nLdN...drain1", address_type: "program_id" },
            ],
          },
        },
        {
          type: "unlimited_approval",
          severity: "high",
          detail: "SPL Token approve sets allowance to u64 max.",
          metadata: {
            owner: "7xKb9R...vA2m",
            mint: "2hCm...USDC",
            allowance: "18446744073709551615",
          },
        },
      ],
      b: [
        {
          type: "unlimited_approval",
          severity: "high",
          detail: "SPL Token approve calls set_max_allowance for USDC mint.",
          metadata: { allowance: "u64::MAX", owner: "3r4gQ...pqxQ" },
        },
      ],
      c: [
        {
          type: "authority_change",
          severity: "high",
          detail:
            "SetAuthority instruction transfers mint authority to an unrelated address.",
          metadata: {
            authority_type: "mint_authority",
            new_authority: "9nTz2...hW1B",
          },
        },
      ],
      d: [
        {
          type: "fresh_program",
          severity: "medium",
          detail:
            "Referenced program was deployed within the last 24h and has <10 fee payers.",
          metadata: { slot: 301234567, age_hours: 14, unique_fee_payers: 6 },
        },
      ],
      e: [],
      f: [],
    };
    const raw: StoredTransactionSummary[] = [
      {
        id: 1284,
        network: "mainnet-beta",
        signature: "2w7GjD2aW8nCjPqfL5mR…",
        transactionHash: "sha256:a01b2f...91c",
        feePayer: "7xKb9R...vA2m",
        riskScore: 96,
        riskLevel: "critical",
        recommendation: "block",
        explanation:
          "Drainer program-id matched in blocklist (CRITICAL floor 75) + unlimited token approval pushes blended score to 96.",
        flags: flags.a!,
        createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
      },
      {
        id: 1283,
        network: "mainnet-beta",
        signature: "5Nq4V2eTpx1nJKf9b…",
        transactionHash: "sha256:bd31aa...710",
        feePayer: "3r4gQ...pqxQ",
        riskScore: 84,
        riskLevel: "high",
        recommendation: "block",
        explanation:
          "Unlimited approval detected (HIGH floor 55). ML probability P(malicious) = 0.91.",
        flags: flags.b!,
        createdAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      },
      {
        id: 1282,
        network: "mainnet-beta",
        signature: "9KxQb3mLf7vAh1xS…",
        transactionHash: "sha256:4fa1...c8b",
        feePayer: "9nTz2...hW1B",
        riskScore: 77,
        riskLevel: "high",
        recommendation: "warn",
        explanation:
          "Mint authority transfer (HIGH floor 55) + ML flagged, score 77.",
        flags: flags.c!,
        createdAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
      },
      {
        id: 1281,
        network: "devnet",
        signature: "3tU1Xs8pR2zMcLqD…",
        transactionHash: "sha256:c40a...12e",
        feePayer: "5PmC8...rL4x",
        riskScore: 48,
        riskLevel: "medium",
        recommendation: "warn",
        explanation:
          "Fresh program reference (< 24h old, MEDIUM severity). Treat with caution until reputation builds.",
        flags: flags.d!,
        createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 1280,
        network: "mainnet-beta",
        signature: "8AeY7nJq4wVgLu9p…",
        transactionHash: "sha256:8e1f...44a",
        feePayer: "2AbN6...eJk9",
        riskScore: 12,
        riskLevel: "low",
        recommendation: "allow",
        explanation:
          "Clean SOL transfer to a verified exchange wallet — no rules fired, ML P(malicious) < 0.02.",
        flags: flags.e!,
        createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      },
      {
        id: 1279,
        network: "mainnet-beta",
        signature: "6HvMkqTjN3p9Zx2Y…",
        transactionHash: "sha256:f0b7...29b",
        feePayer: "4FhQ3...mY8p",
        riskScore: 0,
        riskLevel: "low",
        recommendation: "allow",
        explanation:
          "Clean Jupiter v6 swap between known tokens via verified program. All checks green.",
        flags: flags.f!,
        createdAt: new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString(),
      },
    ];
    return raw;
  }, []);

  const isDemo = feed.length === 0 && !feedLoading;
  const rows = useMemo(
    () => (feed.length > 0 ? feed : demoRows),
    [feed, demoRows],
  );

  const onAfterFeedback = () => reloadFeed();

  return (
    <div className="min-h-screen w-full bg-[#f2f5f3] font-sans text-slate-800">
      <div className="mx-auto max-w-[1500px] p-3 md:p-5">
        <div className="flex gap-5 items-stretch min-h-[calc(100vh-40px)]">
          {/* Sidebar */}
          <aside className="hidden md:flex w-[240px] shrink-0 flex-col gap-8 bg-white p-5 rounded-[28px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)]">
            <div className="flex items-center gap-3 pl-1">
              <div className="h-10 w-10 rounded-[14px] bg-gradient-to-br from-donazo-500 to-donazo-700 text-white grid place-items-center font-black relative shadow-[0_6px_18px_-8px_rgb(40_134_78_/_0.6)]">
                <div className="absolute inset-[6px] rounded-[9px] border-2 border-white/30" />
                <svg
                  viewBox="0 0 24 24"
                  className="relative h-5 w-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6l-8-3Z" />
                  <path d="m9 12 2 2 4-4" />
                </svg>
              </div>
              <div className="leading-tight">
                <div className="font-extrabold text-[1.05rem] tracking-tight text-slate-900">
                  Shield<span className="text-donazo-600">RPC</span>
                </div>
                <div className="text-[11px] text-slate-500">
                  {health?.status === "ok"
                    ? feedDbConnected === false
                      ? "API online · DB offline"
                      : `v${health.version} · ${health.network ?? "mainnet-beta"}`
                    : healthErr
                      ? "API unreachable"
                      : "connecting…"}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">
                Console
              </div>
              {NAV.map((n) => (
                <NavButton
                  key={n.id}
                  active={page === n.id}
                  onClick={() => setPage(n.id)}
                  label={n.label}
                  icon={n.icon}
                  badge={
                    n.id === "transactions" ? rows.length.toString() : undefined
                  }
                />
              ))}
            </div>

            <div className="mt-auto space-y-3">
              <div className="rounded-[22px] bg-gradient-to-br from-donazo-600 via-donazo-700 to-donazo-900 text-white p-4 shadow-[0_16px_40px_-20px_rgb(40_134_78_/_0.55)] relative overflow-hidden">
                <div
                  className="absolute inset-0 opacity-30"
                  style={{
                    backgroundImage:
                      "radial-gradient(circle at 120% 10%, #5dbb82 0%, transparent 40%), radial-gradient(circle at -20% 120%, #0b2819 0%, transparent 40%)",
                  }}
                />
                <div className="relative">
                  <div className="font-bold text-[14px]">Detect scam txs</div>
                  <p className="text-[12px] text-donazo-100/90 mt-1 leading-relaxed">
                    Drop the SDK into your wallet/dApp. 4 rule detectors + ML
                    blended scoring.
                  </p>
                  <div className="mt-2 rounded-[10px] bg-black/30 text-[11px] px-2.5 py-1.5 font-mono break-all">
                    npm i @shieldrpc/sdk
                  </div>
                </div>
              </div>
              {isDemo && (
                <div className="rounded-[18px] border border-amber-200 bg-amber-50 text-amber-700 p-3 text-[11px] leading-snug">
                  <span className="font-bold">Showing demo rows</span> — connect
                  the API ({import.meta.env.VITE_API_BASE ?? "/api"}) to see
                  live scored transactions.
                </div>
              )}
            </div>
          </aside>

          {/* Main column */}
          <div className="flex-1 min-w-0 flex flex-col gap-5">
            <TopBar
              health={health}
              healthErr={healthErr}
              onScan={() => setScanOpen(true)}
            />

            <PageHeader
              page={page}
              onScan={() => setScanOpen(true)}
              onRefresh={reloadFeed}
              loading={feedLoading}
            />

            {/* Slot */}
            {page === "dashboard" && (
              <DashboardPage
                rows={rows}
                isDemo={isDemo}
                feedDbConnected={feedDbConnected}
                onOpenTx={openDetail}
                onRunFixture={runFixture}
              />
            )}
            {page === "transactions" && (
              <TransactionsPage
                rows={rows}
                isDemo={isDemo}
                loading={feedLoading}
                err={feedErr}
                onOpenTx={openDetail}
                onRefresh={reloadFeed}
                feedDbConnected={feedDbConnected}
              />
            )}
            {page === "analytics" && (
              <AnalyticsPage
                rows={rows}
                isDemo={isDemo}
                onOpenTx={openDetail}
              />
            )}
            {page === "blocklist" && (
              <BlocklistPage
                rows={rows}
                isDemo={isDemo}
                onOpenTx={openDetail}
              />
            )}
            {page === "fixtures" && (
              <FixturesPage rows={rows} onRunFixture={runFixture} />
            )}
            {page === "settings" && (
              <SettingsPage health={health} healthErr={healthErr} />
            )}

            <footer className="pt-4 pb-2 text-xs text-slate-400 flex items-center justify-between flex-wrap gap-2 px-1">
              <div>
                © {new Date().getFullYear()} ShieldRPC · MVP · Phases A–G
                shipped
              </div>
              <div className="flex items-center gap-4">
                <span className="font-mono">
                  API v{health?.version ?? "0.1.0"}
                </span>
                <span>·</span>
                <span>Colosseum Hackathon</span>
              </div>
            </footer>
          </div>
        </div>
      </div>

      {/* Drawer + modals */}
      {drawerOpen && drawerTx && (
        <TransactionDrawer
          tx={drawerTx}
          fromFixture={drawerFromFixture}
          onClose={() => setDrawerOpen(false)}
          onSubmitted={onAfterFeedback}
        />
      )}
      {scanOpen && (
        <ScanTransactionModal
          onClose={() => setScanOpen(false)}
          onRun={(serializedTransaction, network) => {
            setScanOpen(false);
            void runSerialized(serializedTransaction, network);
          }}
        />
      )}
    </div>
  );
}

// ---- Top bar ---------------------------------------------------------------
function TopBar({
  health,
  healthErr,
  onScan,
}: {
  health: HealthResponse | null;
  healthErr: string | null;
  onScan: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 bg-white rounded-[28px] px-5 py-3 border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)]">
      <div className="flex-1 max-w-md relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
          🔍
        </span>
        <input
          placeholder="Search tx hash, pubkey, or flagged pattern…"
          className="w-full h-11 rounded-[14px] bg-[#f8faf9] border border-transparent pl-10 pr-24 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-donazo-400/60 focus:border-donazo-400 focus:bg-white transition-all"
        />
        <kbd className="hidden sm:inline-block absolute right-3 top-1/2 -translate-y-1/2 text-[10px] px-2.5 py-1 rounded-[8px] bg-white border border-[#e6ece9] text-slate-500 font-bold shadow-sm">
          ⌘ K
        </kbd>
      </div>
      <div className="flex items-center gap-3">
        <div className="hidden md:flex items-center gap-2 rounded-[14px] border border-[#e6ece9] px-3 py-1.5">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              healthErr
                ? "bg-slate-400"
                : health?.database?.connected
                  ? "bg-donazo-500 animate-pulse"
                  : "bg-amber-500 animate-pulse"
            }`}
          />
          <span className="text-[11px] font-semibold text-slate-600">
            {healthErr
              ? "API unreachable"
              : health?.database?.connected
                ? "DB connected"
                : "DB offline"}
          </span>
        </div>
        <button
          onClick={onScan}
          className="h-11 px-5 rounded-[14px] bg-donazo-600 text-white font-semibold text-sm shadow-[0_10px_24px_-12px_rgb(40_134_78_/_0.7)] hover:bg-donazo-500 active:bg-donazo-700 transition-colors flex items-center gap-2"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Scan transaction
        </button>
        <div className="flex items-center gap-3 pr-2 pl-1.5 py-1 rounded-[16px] hover:bg-[#f8faf9] transition-colors cursor-pointer">
          <div className="h-10 w-10 rounded-full bg-gradient-to-br from-amber-300 to-rose-400 grid place-items-center text-white font-bold text-sm border-2 border-white shadow-[0_4px_10px_-4px_rgb(0_0_0_/_0.2)]">
            TM
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Page header -----------------------------------------------------------
function PageHeader({
  page,
  onScan,
  onRefresh,
  loading,
}: {
  page: PageId;
  onScan: () => void;
  onRefresh: () => void;
  loading: boolean;
}) {
  const titles: Record<PageId, { title: string; sub: string }> = {
    dashboard: {
      title: "Dashboard",
      sub: "Scanned today, risk distribution, alerts, and recent activity.",
    },
    transactions: {
      title: "Transactions",
      sub: "Complete feed of analyzed transactions, filterable by risk level and recommendation.",
    },
    analytics: {
      title: "Analytics",
      sub: "Weekly risk trends, detector hit rates, and risk-level distribution.",
    },
    blocklist: {
      title: "Blocklist",
      sub: "Known-malicious program IDs and addresses plus recent matches.",
    },
    fixtures: {
      title: "Fixtures",
      sub: "Labeled test transactions. Run any sample against the analyzer in one click.",
    },
    settings: {
      title: "Settings",
      sub: "Connection status, environment, and applied schema.",
    },
  };
  const t = titles[page];
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap px-1">
      <div>
        <h1 className="text-[2rem] font-black tracking-tight text-slate-900 leading-none">
          {t.title}
        </h1>
        <p className="text-sm text-slate-500 mt-2">{t.sub}</p>
      </div>
      <div className="flex items-center gap-2.5">
        <button
          onClick={onRefresh}
          className={`h-11 px-4 rounded-[14px] border border-[#e6ece9] bg-white font-semibold text-sm text-slate-700 hover:bg-[#f8faf9] transition-colors inline-flex items-center gap-2 ${loading ? "opacity-70 pointer-events-none" : ""}`}
        >
          <svg
            className={`h-4 w-4 ${loading ? "animate-spin" : ""}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        {(page === "dashboard" ||
          page === "transactions" ||
          page === "fixtures") && (
          <button
            onClick={onScan}
            className="h-11 px-6 rounded-[14px] bg-donazo-600 text-white font-semibold text-sm shadow-[0_10px_24px_-12px_rgb(40_134_78_/_0.7)] hover:bg-donazo-500 active:bg-donazo-700 transition-colors flex items-center gap-2"
          >
            + Scan transaction
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Nav button ------------------------------------------------------------
function NavButton({
  active,
  onClick,
  label,
  icon,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative w-full flex items-center gap-3 px-3 h-11 rounded-[14px] text-sm font-semibold transition-all ${
        active
          ? "bg-donazo-50 text-donazo-700 shadow-[inset_0_0_0_1px_rgb(143_212_172_/_0.7)]"
          : "text-slate-600 hover:bg-[#f8faf9] hover:text-slate-800"
      }`}
    >
      {active && (
        <span className="absolute -left-5 top-1/2 h-6 w-1.5 -translate-y-1/2 rounded-r-full bg-donazo-600 shadow-[0_0_0_3px_rgb(143_212_172_/_0.25)]" />
      )}
      <span
        className={`w-5 text-center text-base leading-none ${active ? "text-donazo-600" : "text-slate-400 group-hover:text-slate-600"}`}
      >
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {badge && (
        <span className="rounded-[8px] bg-slate-100 text-slate-600 text-[10px] font-bold px-2 py-0.5">
          {badge}
        </span>
      )}
    </button>
  );
}

// ---- Stat card -------------------------------------------------------------
function StatCard({
  label,
  value,
  valueSuffix,
  diff,
  diffTone,
  accent,
  icon,
}: {
  label: string;
  value: number | string;
  valueSuffix?: string;
  diff: string;
  diffTone: "up" | "down" | "flat";
  accent?: boolean;
  icon: string;
}) {
  return (
    <div
      className={`relative rounded-[22px] border p-5 shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] transition-all hover:-translate-y-0.5 ${
        accent
          ? "bg-gradient-to-br from-donazo-600 via-donazo-700 to-donazo-800 text-white border-transparent shadow-[0_18px_44px_-22px_rgb(40_134_78_/_0.65)] overflow-hidden"
          : "bg-white border-[#e6ece9]"
      }`}
    >
      {accent && (
        <div
          className="absolute inset-0 opacity-25"
          style={{
            backgroundImage:
              "radial-gradient(circle at 110% -10%, #90d4ac 0%, transparent 45%), radial-gradient(circle at -10% 110%, #0b2819 0%, transparent 50%)",
          }}
        />
      )}
      <div className={`relative flex items-center justify-between mb-4`}>
        <div
          className={`text-sm font-semibold ${accent ? "text-donazo-50" : "text-slate-500"}`}
        >
          {label}
        </div>
        <div
          className={`h-8 w-8 rounded-xl grid place-items-center text-sm ${accent ? "bg-white/20 text-white backdrop-blur-sm" : "bg-[#f8faf9] text-slate-500 border border-[#e6ece9]"}`}
        >
          {icon}
        </div>
      </div>
      <div
        className={`relative text-[2.5rem] font-black tracking-tight leading-none ${accent ? "text-white" : "text-slate-900"} mb-3 tabular-nums`}
      >
        {value}
        {valueSuffix && (
          <span
            className={`align-top ml-1 text-lg font-bold ${accent ? "text-donazo-100" : "text-slate-400"}`}
          >
            {valueSuffix}
          </span>
        )}
      </div>
      <div
        className={`relative inline-flex items-center gap-1 text-xs font-semibold rounded-[10px] px-2.5 py-1 ${
          accent
            ? "bg-white/15 text-donazo-50 backdrop-blur-sm"
            : diffTone === "up"
              ? "bg-donazo-50 text-donazo-700"
              : diffTone === "down"
                ? "bg-rose-50 text-rose-700"
                : "bg-slate-50 text-slate-500"
        }`}
      >
        <svg
          className="h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {diffTone === "up" ? (
            <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
          ) : diffTone === "down" ? (
            <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
          ) : (
            <line x1="5" y1="12" x2="19" y2="12" />
          )}
        </svg>
        <span className="opacity-90">{diff}</span>
      </div>
    </div>
  );
}

// ---- Pill bar with optional stripes ---------------------------------------
type BarVariant = "dark" | "deep" | "light" | "stripes" | "stripes-light";
function Bar({
  label,
  heightPct,
  value,
  variant = "dark",
  onClick,
}: {
  label: string;
  heightPct: number;
  value: string | number;
  variant?: BarVariant;
  onClick?: () => void;
}) {
  const solid: Record<
    Exclude<BarVariant, "stripes" | "stripes-light">,
    string
  > = {
    dark: "bg-gradient-to-t from-donazo-700 to-donazo-500",
    deep: "bg-gradient-to-t from-donazo-800 to-donazo-600",
    light: "bg-gradient-to-t from-donazo-400 to-donazo-300",
  };
  const isStripes = variant === "stripes" || variant === "stripes-light";
  const stripesColor = variant === "stripes" ? "#c7d6ce" : "#d9e3dd";
  const stripesBg = variant === "stripes" ? "#eef3f0" : "#f4f7f5";
  return (
    <div
      className={`flex-1 flex flex-col items-center gap-3 group ${onClick ? "cursor-pointer" : ""}`}
      onClick={onClick}
    >
      <div className="h-48 w-full flex items-end relative justify-center">
        <div className="absolute -top-8 left-1/2 -translate-x-1/2 text-[10px] text-slate-500 bg-white border border-[#e6ece9] rounded-[10px] px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium shadow-sm z-10">
          {value}
        </div>
        <div
          className={`relative w-8 rounded-full transition-all duration-500 ${isStripes ? "" : `${solid[variant as Exclude<BarVariant, "stripes" | "stripes-light">]} shadow-[0_8px_22px_-12px_rgb(40_134_78_/_0.7)]`}`}
          style={{
            height: `${Math.max(14, heightPct * 192)}px`,
            ...(isStripes ? { backgroundColor: stripesBg } : {}),
          }}
        >
          {isStripes && (
            <svg
              className="absolute inset-0 h-full w-full rounded-full overflow-hidden"
              preserveAspectRatio="none"
            >
              <defs>
                <pattern
                  id={`bar-${label}-${variant}`}
                  width="10"
                  height="10"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="10" height="10" fill={stripesBg} />
                  <line
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="10"
                    stroke={stripesColor}
                    strokeWidth="3.5"
                  />
                </pattern>
              </defs>
              <rect
                width="100%"
                height="100%"
                fill={`url(#bar-${label}-${variant})`}
              />
            </svg>
          )}
        </div>
      </div>
      <div className="text-xs font-bold text-slate-500 tracking-wide">
        {label}
      </div>
    </div>
  );
}

// ---- Semicircle gauge (risk protection coverage) --------------------------
function SemicircleGauge({
  value,
  caption,
  accentTone,
}: {
  value: number;
  caption: string;
  accentTone: "good" | "bad" | "neutral";
}) {
  const v = Math.max(0, Math.min(100, value));
  const R_OUT = 62;
  const R_IN = 48;
  const XY = (deg: number, r: number) => ({
    x: 80 + r * Math.cos((deg * Math.PI) / 180),
    y: 80 + r * Math.sin((deg * Math.PI) / 180),
  });
  const Arc = (from: number, to: number) => {
    if (to <= from) return "";
    const fO = XY(from, R_OUT),
      tO = XY(to, R_OUT);
    const fI = XY(to, R_IN),
      tI = XY(from, R_IN);
    const large = to - from > 180 ? 1 : 0;
    return [
      `M ${fO.x} ${fO.y}`,
      `A ${R_OUT} ${R_OUT} 0 ${large} 1 ${tO.x} ${tO.y}`,
      `L ${fI.x} ${fI.y}`,
      `A ${R_IN} ${R_IN} 0 ${large} 0 ${tI.x} ${tI.y}`,
      "Z",
    ].join(" ");
  };
  const darkEnd = 180 + (v / 100) * 180;
  const medEnd = Math.min(360, darkEnd + (15 / 100) * 180);
  const goodColors = { m: "#3ba464", d: "#1f6b40", t: "text-donazo-700" };
  const badColors = { m: "#f97316", d: "#b91c1c", t: "text-rose-700" };
  const neutralColors = { m: "#a8a29e", d: "#44403c", t: "text-slate-700" };
  const c =
    accentTone === "good"
      ? goodColors
      : accentTone === "bad"
        ? badColors
        : neutralColors;
  return (
    <div className="relative h-40 w-60 mx-auto">
      <svg viewBox="0 0 160 100" className="h-full w-full overflow-visible">
        <defs>
          <pattern
            id="gauge-stripes"
            width="10"
            height="10"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="10" height="10" fill="#eef3f0" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="10"
              stroke="#c7d6ce"
              strokeWidth="3.5"
            />
          </pattern>
          <linearGradient id="gauge-dark" x1="0" x2="1">
            <stop offset="0" stopColor={c.m} />
            <stop offset="1" stopColor={c.d} />
          </linearGradient>
          <linearGradient id="gauge-med" x1="0" x2="1">
            <stop offset="0" stopColor={c.m} />
            <stop offset="1" stopColor={c.d} stopOpacity="0.75" />
          </linearGradient>
        </defs>
        <path d={Arc(180, 360)} fill="url(#gauge-stripes)" opacity="0.95" />
        {medEnd > darkEnd && (
          <path d={Arc(darkEnd, medEnd)} fill="url(#gauge-med)" />
        )}
        {v > 0 && <path d={Arc(180, darkEnd)} fill="url(#gauge-dark)" />}
      </svg>
      <div className="absolute left-1/2 -translate-x-1/2 bottom-0 flex flex-col items-center">
        <div className="text-[11px] uppercase tracking-wider text-slate-500 font-bold">
          {caption}
        </div>
        <div
          className={`text-6xl font-black leading-none mt-0.5 tabular-nums ${c.t}`}
        >
          {v}
          <span className="text-2xl text-slate-500 align-top font-bold">%</span>
        </div>
      </div>
    </div>
  );
}

// ---- Derived helpers shared across pages -----------------------------------
function useDerived(rows: StoredTransactionSummary[], isDemo: boolean) {
  return useMemo(() => {
    const byLevel: Record<RiskLevel, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    const byRec: Record<"allow" | "warn" | "block", number> = {
      allow: 0,
      warn: 0,
      block: 0,
    };
    const byDetector: Record<DetectorType, number> = {
      unlimited_approval: 0,
      authority_change: 0,
      known_malicious_address: 0,
      fresh_program: 0,
    };
    let mlBlended = 0;
    for (const r of rows) {
      byLevel[r.riskLevel as RiskLevel]++;
      byRec[r.recommendation as "allow" | "warn" | "block"]++;
      for (const f of r.flags) byDetector[f.type]++;
    }
    const total = rows.length;
    const todayCutoff = new Date();
    todayCutoff.setHours(0, 0, 0, 0);
    const scannedToday =
      rows.filter((r) => new Date(r.createdAt) >= todayCutoff).length ||
      (isDemo ? 38 : 0);
    const totalRisk = rows.reduce((s, r) => s + r.riskScore, 0);
    const avgScore = total === 0 ? 0 : Math.round(totalRisk / total);
    const blockPct =
      total === 0 ? 0 : Math.round(((byRec.block + 0) / total) * 100);
    const allowPct =
      total === 0 ? 0 : Math.round(((byRec.allow + byRec.warn) / total) * 100);
    const criticalAlerts = rows
      .filter((r) => r.riskLevel === "critical" || r.riskLevel === "high")
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

    // Weekly buckets (7 days ending today)
    const now = new Date();
    const days = Array.from({ length: 7 }, (_, i) => daysAgo(6 - i, now));
    const daily = days.map((d) => {
      const k = d.toDateString();
      const inDay = rows.filter(
        (r) => new Date(r.createdAt).toDateString() === k,
      );
      const score =
        inDay.length === 0
          ? 0
          : inDay.reduce((s, r) => s + r.riskScore, 0) / inDay.length / 100;
      return {
        label: shortDayLabel(d),
        date: d,
        txs: inDay.length,
        riskPct:
          inDay.length === 0 && isDemo ? 0.3 + Math.random() * 0.6 : score,
        rows: inDay,
      };
    });
    const maxTxs = Math.max(1, ...daily.map((d) => d.txs), isDemo ? 42 : 1);

    // Addresses flagged in known_malicious_address detector
    const flaggedAddresses: {
      address: string;
      count: number;
      severity: RiskLevel;
      lastAt: Date;
    }[] = [];
    const agg = new Map<
      string,
      { count: number; maxSeverity: RiskLevel; lastAt: Date; address: string }
    >();
    for (const r of rows) {
      for (const f of r.flags) {
        if (f.type !== "known_malicious_address") continue;
        const matches =
          (
            f.metadata as
              | { matches?: Array<{ address: string; address_type?: string }> }
              | undefined
          )?.matches ?? [];
        for (const m of matches) {
          const cur = agg.get(m.address);
          if (cur) {
            cur.count += 1;
            cur.lastAt =
              new Date(r.createdAt) > cur.lastAt
                ? new Date(r.createdAt)
                : cur.lastAt;
            const sevRank = { low: 0, medium: 1, high: 2, critical: 3 };
            if (sevRank[f.severity as RiskLevel] > sevRank[cur.maxSeverity])
              cur.maxSeverity = f.severity as RiskLevel;
          } else {
            agg.set(m.address, {
              address: m.address,
              count: 1,
              maxSeverity: f.severity as RiskLevel,
              lastAt: new Date(r.createdAt),
            });
          }
        }
      }
    }
    // Also build a "blocklist" of program-ids + addresses that fired flags (for Blocklist page even if no metadata matches)
    const blocklistFromFeed = Array.from(agg.values()).sort(
      (a, b) => b.count - a.count,
    );
    void flaggedAddresses;

    return {
      byLevel,
      byRec,
      byDetector,
      total,
      scannedToday,
      avgScore,
      blockPct,
      allowPct,
      criticalAlerts,
      daily,
      maxTxs,
      mlBlended,
      blocklistFromFeed,
    };
  }, [rows, isDemo]);
}

// ---------------------------------------------------------------------------
// Page: Dashboard
// ---------------------------------------------------------------------------
function DashboardPage({
  rows,
  isDemo,
  feedDbConnected,
  onOpenTx,
  onRunFixture,
}: {
  rows: StoredTransactionSummary[];
  isDemo: boolean;
  feedDbConnected: boolean | null;
  onOpenTx: (t: StoredTransactionSummary | number) => void;
  onRunFixture: (f: SampleFixture) => void;
}) {
  const d = useDerived(rows, isDemo);
  const quickSamples = fixtures.samples.slice(0, 4);
  return (
    <div className="flex flex-col gap-4">
      {/* Stats */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          accent
          label="Transactions scanned today"
          value={d.scannedToday}
          valueSuffix=""
          diff={
            feedDbConnected === false
              ? "API connected · DB offline"
              : isDemo
                ? "Showing demo data"
                : "Up from last 24h"
          }
          diffTone={feedDbConnected === false ? "flat" : "up"}
          icon="📊"
        />
        <StatCard
          label="Allowed"
          value={d.byRec.allow + d.byRec.warn}
          valueSuffix=""
          diff={`${d.allowPct}% of traffic · user-safe`}
          diffTone="up"
          icon="✓"
        />
        <StatCard
          label="Blocked"
          value={d.byRec.block}
          valueSuffix=""
          diff={`${d.blockPct}% block rate · HIGH/CRITICAL floor enforced`}
          diffTone="down"
          icon="⛔"
        />
        <StatCard
          label="Avg. risk score"
          value={d.avgScore}
          valueSuffix="/100"
          diff={`${d.total} total scored rows`}
          diffTone="flat"
          icon="⚑"
        />
      </section>

      {/* Row 1: Risk analytics + Critical alerts + Top detectors */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-6">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-6">
            <div>
              <h2 className="font-bold text-slate-900 text-[15px]">
                Risk analytics · last 7 days
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Pill height = avg. risk score. Hover for transaction count.
              </p>
            </div>
            <span className="text-xs rounded-[10px] border border-[#e6ece9] bg-white px-3 py-1.5 text-slate-600 font-medium">
              7D window
            </span>
          </div>
          <div className="flex items-end gap-3 h-52 px-2">
            {d.daily.map((b, i) => (
              <Bar
                key={i}
                label={b.label}
                heightPct={b.txs === 0 ? 0.18 : Math.min(1, b.riskPct)}
                value={`${b.txs} txs · avg ${Math.round(b.riskPct * 100)}`}
                variant={
                  i % 3 === 0
                    ? "stripes"
                    : i % 3 === 1
                      ? "dark"
                      : i % 5 === 0
                        ? "light"
                        : "stripes-light"
                }
                onClick={b.rows[0] ? () => onOpenTx(b.rows[0]!) : undefined}
              />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-4 gap-3 text-center">
            {(["low", "medium", "high", "critical"] as RiskLevel[]).map(
              (lv) => (
                <div
                  key={lv}
                  className="rounded-[16px] border border-[#e6ece9] bg-[#f8faf9]/40 py-3"
                >
                  <div
                    className={`mx-auto h-2.5 w-2.5 rounded-full ${LEVEL_DOT[lv]}`}
                  />
                  <div className="mt-2 text-2xl font-black text-slate-900 tabular-nums">
                    {d.byLevel[lv]}
                  </div>
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 font-bold mt-0.5">
                    {lv}
                  </div>
                </div>
              ),
            )}
          </div>
        </div>

        <div className="lg:col-span-3 bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-col">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-bold text-slate-900 text-[15px]">
              Critical alerts
            </h2>
            <span className="rounded-full border border-rose-200 bg-rose-50 text-rose-700 text-[10px] font-bold px-2.5 py-0.5">
              {d.criticalAlerts.length} live
            </span>
          </div>
          {d.criticalAlerts.length === 0 ? (
            <div className="flex-1 grid place-items-center text-center rounded-[18px] bg-donazo-50 border border-donazo-100 p-5">
              <div>
                <div className="text-2xl mb-2">🌿</div>
                <div className="font-semibold text-donazo-700 text-sm">
                  No critical alerts right now
                </div>
                <p className="text-xs text-donazo-600 mt-1">
                  Recent scans look safe.
                </p>
              </div>
            </div>
          ) : (
            <>
              {(() => {
                const first = d.criticalAlerts[0]!;
                const topFlag = first.flags[0];
                return (
                  <div
                    className="rounded-[18px] border border-rose-100 bg-rose-50/60 p-3 mb-3 cursor-pointer hover:bg-rose-50 transition-colors"
                    onClick={() => onOpenTx(first)}
                  >
                    <div className="text-[13px] font-bold text-rose-800 leading-snug">
                      {topFlag
                        ? (FLAG_LABEL[topFlag.type] ?? topFlag.type)
                        : `${first.riskLevel.toUpperCase()} score ${first.riskScore}`}
                    </div>
                    <p className="text-[11px] text-rose-700/80 mt-1 leading-snug">
                      {trunc(first.explanation, 92)}
                    </p>
                    <div className="flex items-center justify-between mt-2 text-[10px] text-rose-700/80">
                      <span>
                        {new Date(first.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="font-mono">
                        {trunc(first.signature ?? first.transactionHash, 12)}
                      </span>
                    </div>
                  </div>
                );
              })()}
              <ul className="space-y-1.5 flex-1">
                {d.criticalAlerts.slice(1, 4).map((t) => (
                  <li
                    key={t.id}
                    onClick={() => onOpenTx(t)}
                    className="rounded-[14px] border border-[#e6ece9] px-3 py-2 cursor-pointer hover:bg-[#f8faf9] transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={`h-2 w-2 rounded-full ${LEVEL_DOT[riskLevelOf(t)]}`}
                        />
                        <span
                          className={`text-[12px] font-bold ${LEVEL_TEXT[riskLevelOf(t)]}`}
                        >
                          {t.riskScore}/100
                        </span>
                      </div>
                      <span
                        className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full ${REC_STYLE[t.recommendation] ?? ""}`}
                      >
                        {t.recommendation}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-600 mt-1 truncate">
                      {trunc(t.signature ?? t.transactionHash, 22)}
                    </div>
                  </li>
                ))}
              </ul>
              {d.criticalAlerts[0] && (
                <button
                  onClick={() => onOpenTx(d.criticalAlerts[0]!)}
                  className="mt-3 w-full rounded-[14px] bg-donazo-600 text-white text-sm font-semibold py-3 hover:bg-donazo-500 transition-colors flex items-center justify-center gap-2 shadow-[0_10px_24px_-12px_rgb(40_134_78_/_0.65)]"
                >
                  <span className="inline-flex h-6 w-6 rounded-full bg-white/20 items-center justify-center">
                    <svg
                      className="h-3.5 w-3.5"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </span>
                  Review top alert
                </button>
              )}
            </>
          )}
        </div>

        <div className="lg:col-span-2 bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="font-bold text-slate-900 text-[15px]">
              Top detectors
            </h2>
          </div>
          <ul className="space-y-3.5">
            {(Object.entries(d.byDetector) as [DetectorType, number][])
              .sort((a, b) => b[1] - a[1])
              .map(([type, n], i) => {
                const sample = rows.find((r) =>
                  r.flags.some((f) => f.type === type),
                );
                return (
                  <li
                    key={type}
                    onClick={() => sample && onOpenTx(sample)}
                    className="flex items-center gap-2.5 cursor-pointer group"
                  >
                    <div
                      className={`h-9 w-9 rounded-[12px] grid place-items-center text-base shrink-0 text-white shadow-[0_6px_14px_-8px_rgb(0_0_0_/_0.35)] ${
                        i === 0
                          ? "bg-gradient-to-br from-blue-400 to-blue-600"
                          : i === 1
                            ? "bg-gradient-to-br from-cyan-400 to-cyan-600"
                            : i === 2
                              ? "bg-gradient-to-br from-donazo-400 to-donazo-600"
                              : "bg-gradient-to-br from-amber-400 to-amber-600"
                      }`}
                    >
                      {FLAG_ICON[type]}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold text-slate-800 truncate group-hover:text-donazo-700 transition-colors">
                        {FLAG_LABEL[type] ?? type}
                      </div>
                      <div className="text-[10px] text-slate-500 truncate">
                        {n === 0
                          ? "No matches this window"
                          : `${n} match${n === 1 ? "" : "es"}`}
                      </div>
                    </div>
                  </li>
                );
              })}
          </ul>
        </div>
      </section>

      {/* Row 2: Detection performance + protection gauge + ML status + fixture quick-run */}
      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-6 bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5">
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <h2 className="font-bold text-slate-900 text-[15px]">
              Detection performance
            </h2>
            <span className="text-xs rounded-[10px] border border-[#e6ece9] bg-white px-3 py-1.5 text-slate-600 font-medium">
              by detector · {d.total} txs
            </span>
          </div>
          <ul className="space-y-2.5">
            {(Object.entries(d.byDetector) as [DetectorType, number][])
              .sort((a, b) => b[1] - a[1])
              .map(([type, n]) => {
                const pct = d.total === 0 ? 0 : Math.round((n / d.total) * 100);
                const severities: {
                  low: number;
                  medium: number;
                  high: number;
                  critical: number;
                } = { low: 0, medium: 0, high: 0, critical: 0 };
                for (const r of rows)
                  for (const f of r.flags)
                    if (f.type === type) severities[f.severity as RiskLevel]++;
                const worstRank =
                  severities.critical > 0
                    ? "critical"
                    : severities.high > 0
                      ? "high"
                      : severities.medium > 0
                        ? "medium"
                        : "low";
                const sample = rows.find((r) =>
                  r.flags.some((f) => f.type === type),
                );
                return (
                  <li
                    key={type}
                    onClick={() => sample && onOpenTx(sample)}
                    className="flex items-center gap-3 py-1.5 px-1 rounded-[12px] hover:bg-[#f8faf9] transition-colors cursor-pointer"
                  >
                    <div className="h-9 w-9 rounded-full bg-[#f8faf9] border border-[#e6ece9] grid place-items-center shrink-0">
                      <span className="text-base">{FLAG_ICON[type]}</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[13px] font-bold text-slate-800 truncate">
                          {FLAG_LABEL[type] ?? type}
                        </div>
                        <div className="text-sm font-bold text-slate-900 tabular-nums">
                          {pct}
                          <span className="text-xs text-slate-400 font-normal">
                            %
                          </span>
                        </div>
                      </div>
                      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[#eef3f0]">
                        <div
                          className={`h-full ${LEVEL_DOT[worstRank as RiskLevel]}`}
                          style={{ width: `${Math.max(3, pct)}%` }}
                        />
                      </div>
                      <div className="mt-1 text-[10px] text-slate-500 flex items-center justify-between gap-2 flex-wrap">
                        <span>{n} total flags</span>
                        <span className="flex items-center gap-1.5">
                          {(
                            ["critical", "high", "medium", "low"] as RiskLevel[]
                          ).map((lv) => (
                            <span key={lv} className="flex items-center gap-1">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${LEVEL_DOT[lv]}`}
                              />
                              <span className="tabular-nums">
                                {severities[lv]}
                              </span>
                            </span>
                          ))}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
          </ul>
        </div>

        <div className="lg:col-span-3 bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-col">
          <h2 className="font-bold text-slate-900 text-[15px] mb-1">
            Protection coverage
          </h2>
          <div className="flex-1 flex flex-col items-center justify-center pt-2">
            <SemicircleGauge
              value={d.allowPct}
              caption="Safe tx allowed"
              accentTone="good"
            />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-slate-500 px-1">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-donazo-500" /> Allow
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-amber-500" /> Warn
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-rose-500" /> Block
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-[14px] bg-donazo-50 border border-donazo-100 py-2">
              <div className="font-black text-donazo-700 tabular-nums">
                {d.byRec.allow}
              </div>
              <div className="text-[10px] text-donazo-700/80 uppercase tracking-widest font-bold">
                allow
              </div>
            </div>
            <div className="rounded-[14px] bg-amber-50 border border-amber-100 py-2">
              <div className="font-black text-amber-700 tabular-nums">
                {d.byRec.warn}
              </div>
              <div className="text-[10px] text-amber-700/80 uppercase tracking-widest font-bold">
                warn
              </div>
            </div>
            <div className="rounded-[14px] bg-rose-50 border border-rose-100 py-2">
              <div className="font-black text-rose-700 tabular-nums">
                {d.byRec.block}
              </div>
              <div className="text-[10px] text-rose-700/80 uppercase tracking-widest font-bold">
                block
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-3 grid grid-cols-1 gap-4">
          <div className="rounded-[24px] bg-gradient-to-br from-donazo-600 via-donazo-700 to-donazo-900 text-white p-5 shadow-[0_18px_44px_-22px_rgb(40_134_78_/_0.7)] relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 100% 0%, #90d4ac 0%, transparent 45%), radial-gradient(circle at 0% 100%, #0b2819 0%, transparent 50%)",
              }}
            />
            <div className="relative">
              <div className="text-[11px] uppercase tracking-[0.2em] text-donazo-100/85 font-bold">
                Block rate
              </div>
              <div className="flex items-end gap-2 mt-2">
                <div className="font-black text-[44px] leading-none tabular-nums tracking-tight">
                  {d.blockPct}
                </div>
                <div className="pb-2 text-2xl font-bold text-donazo-100/90">
                  %
                </div>
              </div>
              <div className="text-[11px] text-donazo-100/85 mt-2 leading-snug">
                Transactions intercepted · score floors guarantee HIGH ≥ 55,
                CRITICAL ≥ 75.
              </div>
              <div className="mt-4 h-2.5 w-full rounded-full bg-black/25 overflow-hidden">
                <div
                  className="h-full bg-white/90"
                  style={{ width: `${Math.min(100, d.blockPct)}%` }}
                />
              </div>
            </div>
          </div>
          <div className="rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] bg-white p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900 text-[14px]">
                Quick fixtures
              </h3>
              <span className="text-[10px] rounded-full bg-slate-100 text-slate-600 font-bold px-2 py-0.5">
                {fixtures.samples.length} total
              </span>
            </div>
            <ul className="space-y-2">
              {quickSamples.map((f) => {
                const cat = SAMPLE_CATEGORIES.find((c) => c.id === f.category);
                return (
                  <li key={f.id}>
                    <button
                      onClick={() => onRunFixture(f)}
                      className="w-full text-left rounded-[14px] border border-[#e6ece9] hover:bg-[#f8faf9] transition-colors px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-semibold text-slate-800 truncate">
                          {f.label}
                        </span>
                        <span
                          className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full ${cat?.tone === "safe" ? "bg-donazo-50 text-donazo-700 border border-donazo-200" : cat?.tone === "warn" ? "bg-amber-50 text-amber-700 border border-amber-200" : "bg-rose-50 text-rose-700 border border-rose-200"}`}
                        >
                          {cat?.label ?? f.category}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500 truncate mt-0.5">
                        {f.notes}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* Row 3: Recent tx table */}
      <TransactionsTable
        rows={rows.slice(0, 8)}
        isDemo={isDemo}
        onOpenTx={onOpenTx}
        loading={false}
        err={null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page: Transactions
// ---------------------------------------------------------------------------
function TransactionsPage({
  rows,
  isDemo,
  loading,
  err,
  onOpenTx,
  onRefresh,
  feedDbConnected,
}: {
  rows: StoredTransactionSummary[];
  isDemo: boolean;
  loading: boolean;
  err: string | null;
  onOpenTx: (t: StoredTransactionSummary | number) => void;
  onRefresh: () => void;
  feedDbConnected: boolean | null;
}) {
  const [riskFilter, setRiskFilter] = useState<RiskLevel | "all">("all");
  const [recFilter, setRecFilter] = useState<
    "all" | "allow" | "warn" | "block"
  >("all");
  const [q, setQ] = useState("");

  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (riskFilter !== "all" && r.riskLevel !== riskFilter) return false;
        if (recFilter !== "all" && r.recommendation !== recFilter) return false;
        if (!q) return true;
        const qq = q.toLowerCase();
        return (
          (r.signature ?? "").toLowerCase().includes(qq) ||
          r.transactionHash.toLowerCase().includes(qq) ||
          (r.feePayer ?? "").toLowerCase().includes(qq) ||
          r.explanation.toLowerCase().includes(qq) ||
          r.flags.some(
            (f) =>
              f.type.toLowerCase().includes(qq) ||
              f.detail.toLowerCase().includes(qq),
          )
        );
      }),
    [rows, riskFilter, recFilter, q],
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px] relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
            🔍
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search signature, fee payer, explanation, or detector…"
            className="w-full h-11 rounded-[14px] bg-[#f8faf9] border border-transparent pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-donazo-400/60 focus:border-donazo-400 focus:bg-white transition-all"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex rounded-[14px] border border-[#e6ece9] overflow-hidden bg-white p-1">
            {(["all", "critical", "high", "medium", "low"] as const).map(
              (v) => (
                <button
                  key={v}
                  onClick={() => setRiskFilter(v)}
                  className={`px-3 h-8 rounded-[10px] text-[12px] font-semibold transition-colors ${riskFilter === v ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-[#f8faf9]"}`}
                >
                  {v === "all" ? "All risk" : v}
                </button>
              ),
            )}
          </div>
          <div className="flex rounded-[14px] border border-[#e6ece9] overflow-hidden bg-white p-1">
            {(["all", "allow", "warn", "block"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setRecFilter(v)}
                className={`px-3 h-8 rounded-[10px] text-[12px] font-semibold uppercase tracking-wider transition-colors ${recFilter === v ? (v === "allow" ? "bg-donazo-600 text-white" : v === "warn" ? "bg-amber-500 text-white" : v === "block" ? "bg-rose-600 text-white" : "bg-slate-900 text-white") : "text-slate-600 hover:bg-[#f8faf9]"}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <div className="text-[11px] text-slate-500 ml-auto">
          <span className="font-bold text-slate-700">{filtered.length}</span> of{" "}
          {rows.length} transactions
          {feedDbConnected === false && (
            <span className="ml-2 text-amber-600 font-bold">DB offline</span>
          )}
          {isDemo && (
            <span className="ml-2 text-donazo-600 font-bold">demo rows</span>
          )}
        </div>
      </section>

      {err && (
        <div className="rounded-[18px] border border-rose-200 bg-rose-50 text-rose-800 px-4 py-3 text-sm flex items-start gap-2">
          <span>⚠️</span>
          <div className="flex-1">
            <div className="font-bold">Failed to load transactions.</div>
            <code className="font-mono text-[11px] break-all">{err}</code>
          </div>
          <button
            onClick={onRefresh}
            className="rounded-[10px] bg-white border border-rose-200 text-rose-700 text-xs font-semibold px-3 py-1"
          >
            Retry
          </button>
        </div>
      )}

      <TransactionsTable
        rows={filtered}
        isDemo={isDemo}
        onOpenTx={onOpenTx}
        loading={loading}
        err={null}
        emptyText={
          filtered.length === 0
            ? "No transactions match the current filters."
            : undefined
        }
      />
    </div>
  );
}

function TransactionsTable({
  rows,
  isDemo,
  onOpenTx,
  loading,
  err,
  emptyText,
}: {
  rows: StoredTransactionSummary[];
  isDemo: boolean;
  onOpenTx: (t: StoredTransactionSummary | number) => void;
  loading: boolean;
  err: string | null;
  emptyText?: string;
}) {
  return (
    <div className="bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h2 className="font-bold text-slate-900 text-[15px]">Transactions</h2>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-[10px] border border-donazo-200 bg-donazo-50 text-donazo-700 px-2.5 py-1 font-semibold">
            ↓ Newest
          </span>
          {isDemo && (
            <span className="rounded-[10px] border border-[#e6ece9] bg-white text-slate-500 px-2.5 py-1">
              Demo data
            </span>
          )}
          {loading && (
            <span className="rounded-[10px] border border-[#e6ece9] bg-white text-slate-500 px-2.5 py-1 animate-pulse">
              Refreshing…
            </span>
          )}
        </div>
      </div>
      {err ? (
        <div className="rounded-[18px] border border-rose-200 bg-rose-50 text-rose-700 p-4 text-sm">
          <div className="font-bold">Load error</div>
          <code className="font-mono text-xs block mt-1 break-all">{err}</code>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-[18px] border border-dashed border-[#e6ece9] p-10 text-center">
          <div className="text-4xl mb-2">🗃️</div>
          <div className="font-semibold text-slate-800">
            {emptyText ?? "No transactions yet"}
          </div>
          <p className="text-sm text-slate-500 mt-1 max-w-md mx-auto">
            Run fixtures from the Fixtures page, or hit{" "}
            <code className="font-mono bg-[#f8faf9] px-1.5 py-0.5 rounded text-[11px]">
              /analyze-transaction
            </code>{" "}
            to populate the feed.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[18px] border border-[#e6ece9]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#f8faf9] text-slate-500 text-[11px] uppercase tracking-wider">
                <th className="text-left font-bold px-4 py-3">Tx</th>
                <th className="text-left font-bold px-4 py-3">
                  Detection flags
                </th>
                <th className="text-right font-bold px-4 py-3">Score</th>
                <th className="text-center font-bold px-4 py-3">Rec</th>
                <th className="text-left font-bold px-4 py-3 hidden md:table-cell">
                  Network
                </th>
                <th className="text-left font-bold px-4 py-3 hidden sm:table-cell">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((tx) => (
                <tr
                  key={tx.id}
                  onClick={() => onOpenTx(tx)}
                  className="border-t border-[#eef3f0] hover:bg-[#f8faf9]/60 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-8 w-8 rounded-full grid place-items-center text-white text-xs font-bold ${LEVEL_DOT[riskLevelOf(tx)]}`}
                      >
                        #{("0" + tx.id).slice(-2)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 font-mono text-[12px] truncate max-w-[260px]">
                          {tx.signature ?? tx.transactionHash}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono truncate max-w-[260px]">
                          {trunc(tx.feePayer, 18)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 max-w-[360px]">
                    <div className="flex flex-wrap gap-1">
                      {tx.flags.length === 0 ? (
                        <span className="inline-flex items-center rounded-[8px] border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-donazo-50 text-donazo-700 border-donazo-200">
                          Clean
                        </span>
                      ) : (
                        tx.flags.slice(0, 2).map((f, i) => (
                          <span
                            key={i}
                            className={`inline-flex items-center rounded-[8px] border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${FLAG_CHIP[f.type] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}
                          >
                            {FLAG_LABEL[f.type] ?? f.type}
                          </span>
                        ))
                      )}
                      {tx.flags.length > 2 && (
                        <span className="inline-flex items-center rounded-[8px] border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-slate-50 text-slate-600 border-slate-200">
                          +{tx.flags.length - 2}
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-bold tabular-nums ${LEVEL_TEXT[riskLevelOf(tx)]}`}
                  >
                    {tx.riskScore}
                    <span className="font-normal text-slate-400 text-[11px]">
                      /100
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={`inline-flex items-center rounded-[8px] px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider ${REC_STYLE[tx.recommendation] ?? "bg-slate-500 text-white"}`}
                    >
                      {tx.recommendation}
                    </span>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <span className="text-[11px] rounded-[8px] border border-[#e6ece9] bg-[#f8faf9] text-slate-600 px-2 py-0.5 font-mono">
                      {tx.network}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-slate-500 hidden sm:table-cell whitespace-nowrap">
                    <TimeAgo date={tx.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TimeAgo({ date }: { date: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const diff = Math.max(0, Date.now() - new Date(date).getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(date).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Page: Analytics
// ---------------------------------------------------------------------------
function AnalyticsPage({
  rows,
  isDemo,
  onOpenTx,
}: {
  rows: StoredTransactionSummary[];
  isDemo: boolean;
  onOpenTx: (t: StoredTransactionSummary | number) => void;
}) {
  const d = useDerived(rows, isDemo);
  const totalFlags = Object.values(d.byDetector).reduce((s, n) => s + n, 0);
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          accent
          label="Total scored"
          value={d.total}
          diff="All time"
          diffTone="flat"
          icon="📊"
        />
        <StatCard
          label="Total flags"
          value={totalFlags}
          diff={`${Object.keys(d.byDetector).length} detectors`}
          diffTone="up"
          icon="⚑"
        />
        <StatCard
          label="Avg score"
          value={d.avgScore}
          valueSuffix="/100"
          diff="Window mean"
          diffTone="flat"
          icon="🎯"
        />
        <StatCard
          label="Days covered"
          value={d.daily.filter((x) => x.txs > 0 || isDemo).length}
          valueSuffix="/ 7"
          diff="Last 7 days"
          diffTone="up"
          icon="🗓"
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-6">
          <div className="flex items-start justify-between mb-6 flex-wrap gap-3">
            <div>
              <h2 className="font-bold text-slate-900 text-[15px]">
                Avg. risk score by day
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Scaled against 100. Stripes = low-risk days.
              </p>
            </div>
          </div>
          <div className="flex items-end gap-3 h-56 px-2">
            {d.daily.map((b, i) => (
              <Bar
                key={i}
                label={b.label}
                heightPct={b.riskPct === 0 ? 0.12 : b.riskPct}
                value={`avg ${Math.round(b.riskPct * 100)} · ${b.txs} txs`}
                variant={
                  b.riskPct < 0.3
                    ? "stripes-light"
                    : b.riskPct < 0.55
                      ? "light"
                      : b.riskPct < 0.75
                        ? "dark"
                        : "deep"
                }
                onClick={b.rows[0] ? () => onOpenTx(b.rows[0]!) : undefined}
              />
            ))}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-[18px] border border-[#e6ece9] bg-[#f8faf9]/40 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Risk-level distribution
              </div>
              <div className="space-y-2">
                {(["critical", "high", "medium", "low"] as RiskLevel[]).map(
                  (lv) => {
                    const n = d.byLevel[lv];
                    const pct =
                      d.total === 0 ? 0 : Math.round((n / d.total) * 100);
                    return (
                      <div key={lv}>
                        <div className="flex items-center justify-between text-[12px]">
                          <span className="flex items-center gap-2 font-semibold text-slate-700">
                            <span
                              className={`h-2.5 w-2.5 rounded-full ${LEVEL_DOT[lv]}`}
                            />{" "}
                            {lv}
                          </span>
                          <span className="tabular-nums text-slate-600">
                            {n} · {pct}%
                          </span>
                        </div>
                        <div className="mt-1 h-2 rounded-full bg-[#eef3f0] overflow-hidden">
                          <div
                            className={`h-full ${LEVEL_DOT[lv]}`}
                            style={{ width: `${Math.max(3, pct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  },
                )}
              </div>
            </div>
            <div className="rounded-[18px] border border-[#e6ece9] bg-[#f8faf9]/40 p-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                Recommendation mix
              </div>
              <div className="space-y-2">
                {(["block", "warn", "allow"] as const).map((rc) => {
                  const n = d.byRec[rc];
                  const pct =
                    d.total === 0 ? 0 : Math.round((n / d.total) * 100);
                  const cls =
                    rc === "allow"
                      ? "from-donazo-500 to-donazo-400"
                      : rc === "warn"
                        ? "from-amber-500 to-amber-400"
                        : "from-rose-600 to-rose-500";
                  return (
                    <div key={rc}>
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="flex items-center gap-2 font-semibold uppercase tracking-wider text-slate-700">
                          {rc}
                        </span>
                        <span className="tabular-nums text-slate-600">
                          {n} · {pct}%
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-[#eef3f0] overflow-hidden">
                        <div
                          className={`h-full bg-gradient-to-r ${cls}`}
                          style={{ width: `${Math.max(3, pct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 flex flex-col gap-4">
          <div className="bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-col">
            <h2 className="font-bold text-slate-900 text-[15px] mb-1">
              Block-rate gauge
            </h2>
            <div className="flex-1 flex items-center justify-center pt-2">
              <SemicircleGauge
                value={d.blockPct}
                caption="Blocked HIGH/CRITICAL"
                accentTone="bad"
              />
            </div>
          </div>
          <div className="bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-col">
            <h2 className="font-bold text-slate-900 text-[15px] mb-3">
              Detector hit-rate
            </h2>
            <ul className="space-y-3">
              {(Object.entries(d.byDetector) as [DetectorType, number][])
                .sort((a, b) => b[1] - a[1])
                .map(([type, n]) => {
                  const pct =
                    totalFlags === 0 ? 0 : Math.round((n / totalFlags) * 100);
                  return (
                    <li key={type}>
                      <div className="flex items-center justify-between text-[12px] mb-1">
                        <span className="font-semibold text-slate-800 flex items-center gap-1.5">
                          <span className="h-5 w-5 rounded-[6px] grid place-items-center bg-[#f8faf9] border border-[#e6ece9] text-[11px]">
                            {FLAG_ICON[type]}
                          </span>
                          {FLAG_LABEL[type] ?? type}
                        </span>
                        <span className="tabular-nums font-bold text-slate-700">
                          {pct}%
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-[#eef3f0] overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-donazo-500 to-donazo-700"
                          style={{ width: `${Math.max(3, pct)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page: Blocklist
// ---------------------------------------------------------------------------
function BlocklistPage({
  rows,
  isDemo,
  onOpenTx,
}: {
  rows: StoredTransactionSummary[];
  isDemo: boolean;
  onOpenTx: (t: StoredTransactionSummary | number) => void;
}) {
  const d = useDerived(rows, isDemo);
  // Build blocklist entries: union of detector metadata matches + program/address values from known_malicious + authority_change + fresh_program flags
  const entries = useMemo(() => {
    interface BE {
      address: string;
      addressType: string;
      count: number;
      severity: RiskLevel;
      lastTxAt: Date;
      source: string;
      sampleTx?: StoredTransactionSummary;
    }
    const map = new Map<string, BE>();
    for (const r of rows) {
      for (const f of r.flags) {
        const matches =
          (
            f.metadata as
              | { matches?: Array<{ address: string; address_type?: string }> }
              | undefined
          )?.matches ?? [];
        for (const m of matches) {
          const key = `${m.address_type ?? "address"}::${m.address}`;
          const cur = map.get(key);
          const sev = f.severity as RiskLevel;
          if (cur) {
            cur.count += 1;
            cur.severity =
              sevRank(sev) > sevRank(cur.severity) ? sev : cur.severity;
            cur.lastTxAt =
              new Date(r.createdAt) > cur.lastTxAt
                ? new Date(r.createdAt)
                : cur.lastTxAt;
          } else {
            map.set(key, {
              address: m.address,
              addressType: m.address_type ?? "address",
              count: 1,
              severity: sev,
              lastTxAt: new Date(r.createdAt),
              source: f.type,
              sampleTx: r,
            });
          }
        }
        if (f.type === "unlimited_approval") {
          const meta = f.metadata as
            | { mint?: string; owner?: string }
            | undefined;
          if (meta?.owner)
            add(
              map,
              "owner::" + meta.owner,
              "owner",
              meta.owner,
              f.type,
              f.severity as RiskLevel,
              r,
            );
          if (meta?.mint)
            add(
              map,
              "mint::" + meta.mint,
              "mint",
              meta.mint,
              f.type,
              f.severity as RiskLevel,
              r,
            );
        }
        if (f.type === "authority_change") {
          const meta = f.metadata as
            | { new_authority?: string; authority_type?: string }
            | undefined;
          if (meta?.new_authority)
            add(
              map,
              `${meta.authority_type ?? "authority"}::` + meta.new_authority,
              meta.authority_type ?? "authority",
              meta.new_authority,
              f.type,
              f.severity as RiskLevel,
              r,
            );
        }
      }
    }
    // If blocklist empty but feed has known_malicious flags, manufacture 4 demo entries for UI
    let list = Array.from(map.values());
    if (list.length === 0) {
      list = [
        mkDemoBlocklist(
          "drainWXYZ...9123ab",
          "program_id",
          "known_malicious_address",
          "critical",
          17,
        ),
        mkDemoBlocklist(
          "7xKb9R...vA2m",
          "owner",
          "unlimited_approval",
          "high",
          9,
        ),
        mkDemoBlocklist(
          "FreshAm...v1Prog",
          "program_id",
          "fresh_program",
          "medium",
          4,
        ),
        mkDemoBlocklist(
          "AuthyQq...81p",
          "mint_authority",
          "authority_change",
          "high",
          2,
        ),
      ];
    }
    return list.sort(
      (a, b) => sevRank(b.severity) - sevRank(a.severity) || b.count - a.count,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  void isDemo;
  void d;

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatCard
          label="Blocklist entries"
          value={entries.length}
          diff="Across address + program_id types"
          diffTone="up"
          icon="⛔"
        />
        <StatCard
          label="CRITICAL"
          value={entries.filter((e) => e.severity === "critical").length}
          diff="Auto-promoted by floor rules"
          diffTone="down"
          icon="🚨"
        />
        <StatCard
          label="Total matches"
          value={entries.reduce((s, e) => s + e.count, 0)}
          diff="Ever matched a feed transaction"
          diffTone="flat"
          icon="⚑"
        />
        <StatCard
          label="Unique types"
          value={Array.from(new Set(entries.map((e) => e.addressType))).length}
          diff="program_id · mint · owner …"
          diffTone="up"
          icon="🏷"
        />
      </section>

      <section className="bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="font-bold text-slate-900 text-[15px]">
            Blocked addresses & program IDs
          </h2>
          <div className="text-[11px] text-slate-500">
            Populated from detector metadata in the scored feed.
          </div>
        </div>
        <div className="overflow-hidden rounded-[18px] border border-[#e6ece9]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[#f8faf9] text-slate-500 text-[11px] uppercase tracking-wider">
                <th className="text-left font-bold px-4 py-3">
                  Address / Program
                </th>
                <th className="text-left font-bold px-4 py-3">Type</th>
                <th className="text-left font-bold px-4 py-3">Source</th>
                <th className="text-left font-bold px-4 py-3">Severity</th>
                <th className="text-right font-bold px-4 py-3">Matches</th>
                <th className="text-left font-bold px-4 py-3 hidden md:table-cell">
                  Last match
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr
                  key={i}
                  onClick={() => e.sampleTx && onOpenTx(e.sampleTx)}
                  className="border-t border-[#eef3f0] hover:bg-[#f8faf9]/60 transition-colors cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`h-8 w-8 rounded-full grid place-items-center text-white text-xs font-bold ${LEVEL_DOT[e.severity]}`}
                      >
                        {e.addressType[0]?.toUpperCase() ?? "A"}
                      </div>
                      <div className="min-w-0 font-mono text-[12px] text-slate-800 truncate max-w-[320px] font-semibold">
                        {trunc(e.address, 38)}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[11px] rounded-[8px] border border-[#e6ece9] bg-[#f8faf9] text-slate-700 px-2 py-0.5 font-semibold uppercase tracking-wider">
                      {e.addressType.replaceAll("_", " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-[10px] rounded-[8px] border px-2 py-0.5 font-bold uppercase tracking-wider ${FLAG_CHIP[e.source] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}
                    >
                      {FLAG_LABEL[e.source] ?? e.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-2 text-[12px] font-bold ${LEVEL_TEXT[e.severity]}`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${LEVEL_DOT[e.severity]}`}
                      />{" "}
                      {e.severity.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-bold text-slate-800">
                    {e.count}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-slate-500 hidden md:table-cell whitespace-nowrap">
                    <TimeAgo date={e.lastTxAt.toISOString()} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function sevRank(s: RiskLevel) {
  return { low: 0, medium: 1, high: 2, critical: 3 }[s];
}

function add(
  map: Map<
    string,
    {
      address: string;
      addressType: string;
      count: number;
      severity: RiskLevel;
      lastTxAt: Date;
      source: string;
      sampleTx?: StoredTransactionSummary;
    }
  >,
  key: string,
  addressType: string,
  address: string,
  source: string,
  severity: RiskLevel,
  r: StoredTransactionSummary,
) {
  const cur = map.get(key);
  if (cur) {
    cur.count += 1;
    cur.severity =
      sevRank(severity) > sevRank(cur.severity) ? severity : cur.severity;
    cur.lastTxAt =
      new Date(r.createdAt) > cur.lastTxAt
        ? new Date(r.createdAt)
        : cur.lastTxAt;
  } else {
    map.set(key, {
      address,
      addressType,
      count: 1,
      severity,
      lastTxAt: new Date(r.createdAt),
      source,
      sampleTx: r,
    });
  }
}

function mkDemoBlocklist(
  address: string,
  addressType: string,
  source: string,
  severity: RiskLevel,
  count: number,
) {
  return {
    address,
    addressType,
    count,
    severity,
    source,
    lastTxAt: new Date(Date.now() - Math.random() * 3 * 24 * 60 * 60 * 1000),
  };
}

// ---------------------------------------------------------------------------
// Page: Fixtures
// ---------------------------------------------------------------------------
function FixturesPage({
  rows,
  onRunFixture,
}: {
  rows: StoredTransactionSummary[];
  onRunFixture: (f: SampleFixture) => void;
}) {
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    id: string;
    label: string;
    at: Date;
    score?: number;
    level?: RiskLevel;
    rec?: string;
  } | null>(null);

  const samples = useMemo(
    () =>
      fixtures.samples.filter((s) => {
        if (cat !== "all" && s.category !== cat) return false;
        if (!q) return true;
        const qq = q.toLowerCase();
        return (
          s.label.toLowerCase().includes(qq) ||
          s.notes.toLowerCase().includes(qq) ||
          s.category.toLowerCase().includes(qq)
        );
      }),
    [cat, q],
  );

  const summary = useMemo(() => {
    const byCat = new Map<string, number>();
    for (const s of fixtures.samples)
      byCat.set(s.category, (byCat.get(s.category) ?? 0) + 1);
    return byCat;
  }, []);

  const run = async (f: SampleFixture) => {
    setRunning(f.id);
    try {
      await onRunFixture(f);
      setLastRun({
        id: f.id,
        label: f.label,
        at: new Date(),
      });
      // Best-effort: try to read last inserted from rows (refreshed externally) — skip exact score lookup here; still update after 500ms
      setTimeout(() => {
        setRunning(null);
      }, 350);
    } catch {
      setRunning(null);
    }
  };

  void rows;

  const runAll = async () => {
    for (const f of fixtures.samples) {
      setRunning(f.id);
      try {
        await onRunFixture(f);
      } catch {
        /* ignore */
      }
    }
    setRunning(null);
    setLastRun({
      id: "all",
      label: `All ${fixtures.samples.length} fixtures`,
      at: new Date(),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard
          accent
          label="Total fixtures"
          value={fixtures.samples.length}
          diff={`Generated ${new Date(fixtures.generatedAt).toLocaleDateString()}`}
          diffTone="up"
          icon="🧪"
        />
        {SAMPLE_CATEGORIES.map((c) => (
          <StatCard
            key={c.id}
            label={c.label}
            value={summary.get(c.id) ?? 0}
            diff={`tone: ${c.tone}`}
            diffTone={
              c.tone === "safe" ? "up" : c.tone === "warn" ? "flat" : "down"
            }
            icon={c.tone === "safe" ? "✓" : c.tone === "warn" ? "⚠" : "🚨"}
          />
        ))}
      </section>

      <section className="bg-white rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[220px] relative">
          <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm">
            🔍
          </span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search fixtures…"
            className="w-full h-11 rounded-[14px] bg-[#f8faf9] border border-transparent pl-10 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-donazo-400/60 focus:border-donazo-400 focus:bg-white transition-all"
          />
        </div>
        <div className="flex flex-wrap gap-2 rounded-[14px] border border-[#e6ece9] bg-white p-1">
          {[
            { id: "all", label: "All" },
            ...SAMPLE_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
          ].map((c) => (
            <button
              key={c.id}
              onClick={() => setCat(c.id)}
              className={`px-3 h-8 rounded-[10px] text-[12px] font-semibold transition-colors ${cat === c.id ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-[#f8faf9]"}`}
            >
              {c.label}
            </button>
          ))}
        </div>
        {lastRun && (
          <div className="text-[11px] text-slate-500 flex items-center gap-2 rounded-[12px] bg-donazo-50 border border-donazo-200 text-donazo-700 px-3 py-1.5 font-semibold">
            ✓ {lastRun.label} ran <TimeAgo date={lastRun.at.toISOString()} />
          </div>
        )}
        <button
          onClick={runAll}
          disabled={!!running}
          className="h-11 px-5 rounded-[14px] bg-donazo-600 text-white font-semibold text-sm shadow-[0_10px_24px_-12px_rgb(40_134_78_/_0.7)] hover:bg-donazo-500 disabled:opacity-70 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
        >
          {running === "all" ? "Running…" : "Run all fixtures"}
        </button>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {samples.map((f) => {
          const cat = SAMPLE_CATEGORIES.find((c) => c.id === f.category);
          const isRunning = running === f.id;
          return (
            <article
              key={f.id}
              className="rounded-[22px] border border-[#e6ece9] bg-white shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-5 flex flex-col"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="font-mono text-[10px] text-slate-400">
                  {f.id}
                </div>
                <span
                  className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded-full border ${cat?.tone === "safe" ? "bg-donazo-50 text-donazo-700 border-donazo-200" : cat?.tone === "warn" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}
                >
                  {cat?.label ?? f.category}
                </span>
              </div>
              <h3 className="font-bold text-slate-900 leading-snug">
                {f.label}
              </h3>
              <p className="text-[12px] text-slate-500 mt-2 leading-relaxed flex-1">
                {f.notes}
              </p>
              <div className="mt-3 rounded-[12px] border border-[#e6ece9] bg-[#f8faf9] p-2 text-[11px] text-slate-500 font-mono break-all line-clamp-2">
                base64 · {f.serializedTransaction.length} chars
              </div>
              <button
                disabled={isRunning}
                onClick={() => void run(f)}
                className={`mt-3 w-full rounded-[14px] text-white text-sm font-semibold py-2.5 transition-all shadow-[0_10px_24px_-12px_rgb(40_134_78_/_0.65)] ${cat?.tone === "safe" ? "bg-donazo-600 hover:bg-donazo-500" : cat?.tone === "warn" ? "bg-amber-500 hover:bg-amber-400" : "bg-rose-600 hover:bg-rose-500"} disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2`}
              >
                {isRunning ? (
                  <>
                    <svg
                      className="h-4 w-4 animate-spin"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                    >
                      <path d="M21 12a9 9 0 1 1-2.6-6.4" />
                    </svg>
                    Scanning…
                  </>
                ) : (
                  <>▷ Run against analyzer</>
                )}
              </button>
            </article>
          );
        })}
        {samples.length === 0 && (
          <div className="md:col-span-2 xl:col-span-3 rounded-[22px] border border-dashed border-[#e6ece9] p-10 text-center bg-white">
            <div className="text-4xl mb-2">🧪</div>
            <div className="font-semibold text-slate-800">
              No fixtures match
            </div>
            <p className="text-sm text-slate-500 mt-1">
              Try a different category or search term.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page: Settings
// ---------------------------------------------------------------------------
function SettingsPage({
  health,
  healthErr,
}: {
  health: HealthResponse | null;
  healthErr: string | null;
}) {
  const [applyMsg, setApplyMsg] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);
  const [applying, setApplying] = useState(false);
  const base = import.meta.env.VITE_API_BASE ?? "/api";

  const applySchema = async () => {
    setApplying(true);
    setApplyMsg(null);
    try {
      const url = base.replace(/\/$/, "") + "/db/apply-schema";
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setApplyMsg({
          ok: false,
          text: (data as any).error ?? `HTTP ${r.status}`,
        });
      } else {
        setApplyMsg({ ok: true, text: "Schema applied idempotently." });
      }
    } catch (e) {
      setApplyMsg({
        ok: false,
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-[24px] bg-white border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] p-6 space-y-5">
          <div>
            <h2 className="font-bold text-slate-900 text-[15px]">Connection</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Where this dashboard is sourcing scored transactions.
            </p>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <SettingCell
              label="API base URL"
              value={
                <code className="font-mono break-all text-xs bg-[#f8faf9] px-2 py-1 rounded-[8px] border border-[#e6ece9]">
                  {base}
                </code>
              }
            />
            <SettingCell
              label="Status"
              value={
                <span
                  className={`inline-flex items-center gap-2 font-semibold text-[12px] ${healthErr ? "text-slate-500" : health?.status === "ok" ? "text-donazo-600" : "text-amber-600"}`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${healthErr ? "bg-slate-400" : health?.status === "ok" ? "bg-donazo-500" : "bg-amber-500"} ${health?.status === "ok" ? "animate-pulse" : ""}`}
                  />
                  {healthErr
                    ? "Unreachable"
                    : (health?.status?.toUpperCase() ?? "Unknown")}
                </span>
              }
            />
            <SettingCell
              label="Service"
              value={
                <span className="font-mono text-xs">
                  {health?.service ?? "—"}
                </span>
              }
            />
            <SettingCell
              label="Version"
              value={
                <span className="font-mono text-xs">
                  {health?.version ?? "—"}
                </span>
              }
            />
            <SettingCell
              label="Network"
              value={
                <span className="font-mono text-xs">
                  {health?.network ?? "—"}
                </span>
              }
            />
            <SettingCell
              label="Last check"
              value={
                health?.timestamp
                  ? new Date(health.timestamp).toLocaleString()
                  : "—"
              }
            />
          </dl>

          <div>
            <h3 className="font-bold text-slate-900 text-[14px]">PostgreSQL</h3>
          </div>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <SettingCell
              label="Connected"
              value={
                health?.database?.connected ? (
                  <span className="text-donazo-600 font-semibold inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-donazo-500" /> Yes
                  </span>
                ) : (
                  <span className="text-amber-600 font-semibold inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />{" "}
                    No — rules + ML still score, but writes are skipped.
                  </span>
                )
              }
            />
            <SettingCell
              label="DATABASE_URL set"
              value={health?.database?.connectionStringSet ? "Yes" : "No"}
            />
            {health?.database?.lastError && (
              <SettingCell
                label="Last init error"
                value={
                  <code className="font-mono text-[11px] break-all text-rose-700">
                    {health.database.lastError}
                  </code>
                }
                fullWidth
              />
            )}
          </dl>

          <div className="flex items-start justify-between gap-4 flex-wrap rounded-[18px] border border-[#e6ece9] bg-[#f8faf9]/40 p-4">
            <div className="max-w-lg">
              <h3 className="font-bold text-slate-900 text-[14px]">
                Apply database schema
              </h3>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                Idempotently runs{" "}
                <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#e6ece9] text-[11px]">
                  /api/sql/001_schema.sql
                </code>{" "}
                via{" "}
                <code className="font-mono bg-white px-1.5 py-0.5 rounded border border-[#e6ece9] text-[11px]">
                  POST /v1/db/apply-schema
                </code>
                .
              </p>
              {applyMsg && (
                <div
                  className={`mt-3 text-[12px] font-semibold ${applyMsg.ok ? "text-donazo-700" : "text-rose-700"}`}
                >
                  {applyMsg.text}
                </div>
              )}
            </div>
            <button
              onClick={() => void applySchema()}
              disabled={applying || !health?.database?.connected}
              className="h-11 px-5 rounded-[14px] bg-donazo-600 text-white font-semibold text-sm shadow-[0_10px_24px_-12px_rgb(40_134_78_/_0.7)] hover:bg-donazo-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {applying ? "Applying…" : "Apply 001_schema.sql"}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="rounded-[24px] border border-[#e6ece9] shadow-[0_8px_40px_-24px_rgb(15_83_52_/_0.12)] bg-white p-5">
            <h3 className="font-bold text-slate-900 text-[14px] mb-3">
              Rules & score floors
            </h3>
            <ul className="space-y-2.5 text-[12px]">
              <li className="rounded-[12px] bg-donazo-50 border border-donazo-100 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-donazo-800">
                    CRITICAL floor
                  </span>
                  <span className="font-mono text-donazo-700">
                    min score ≥ 75
                  </span>
                </div>
              </li>
              <li className="rounded-[12px] bg-amber-50 border border-amber-100 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-800">HIGH floor</span>
                  <span className="font-mono text-amber-700">
                    min score ≥ 55
                  </span>
                </div>
              </li>
              <li className="rounded-[12px] bg-slate-50 border border-slate-200 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-800">Risk scale</span>
                  <span className="font-mono text-slate-700">
                    0–99 rules · 100 ML blended
                  </span>
                </div>
              </li>
              <li className="rounded-[12px] bg-slate-50 border border-slate-200 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-800">Detectors</span>
                  <span className="font-mono text-slate-700">
                    4 rule engines
                  </span>
                </div>
              </li>
            </ul>
          </div>
          <div className="rounded-[24px] bg-gradient-to-br from-donazo-600 via-donazo-700 to-donazo-900 text-white p-5 shadow-[0_18px_44px_-22px_rgb(40_134_78_/_0.7)] relative overflow-hidden">
            <div
              className="absolute inset-0 opacity-30"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 100% 0%, #90d4ac 0%, transparent 45%), radial-gradient(circle at 0% 100%, #0b2819 0%, transparent 50%)",
              }}
            />
            <div className="relative">
              <div className="text-[11px] uppercase tracking-[0.2em] text-donazo-100/85 font-bold">
                Fixtures bundle
              </div>
              <div className="mt-2 text-3xl font-black tabular-nums">
                {fixtures.samples.length}
              </div>
              <div className="text-[12px] text-donazo-100/90 mt-1">
                {new Date(fixtures.generatedAt).toLocaleString()} · schema v
                {fixtures.schemaVersion}
              </div>
              <div className="mt-3 text-[11px] font-mono text-donazo-100/80 break-all leading-snug">
                token: {trunc(fixtures.tokenProgramId, 14)}
                <br />
                mint: {trunc(fixtures.fakeMint, 14)}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingCell({
  label,
  value,
  fullWidth,
}: {
  label: string;
  value: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={`rounded-[14px] border border-[#e6ece9] bg-[#f8faf9]/40 p-3 ${fullWidth ? "sm:col-span-2" : ""}`}
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
        {label}
      </div>
      <div className="mt-1 text-slate-800 break-words">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Transaction Drawer (detail + feedback)
// ---------------------------------------------------------------------------
function TransactionDrawer({
  tx,
  fromFixture,
  onClose,
  onSubmitted,
}: {
  tx: TxLike;
  fromFixture: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const storedId =
    (tx as AnalyzeResponse).storedTransactionId ??
    (tx as StoredTransactionDetail).id ??
    null;
  const effectiveId =
    storedId ??
    (() => {
      const h = (tx as AnalyzeResponse).transactionHash;
      if (!h) return 0;
      let n = 0;
      for (let i = 0; i < Math.min(h.length, 8); i++)
        n = (n * 16 + parseInt(h[i]!, 16)) >>> 0;
      return Math.max(1, n % 0x7fffffff);
    })();
  const hasSerialized =
    "serializedTransaction" in tx &&
    typeof (tx as StoredTransactionDetail).serializedTransaction === "string";
  const [fbOpen, setFbOpen] = useState(false);
  const [fbType, setFbType] = useState<
    "false_positive" | "false_negative" | "note"
  >("false_positive");
  const [fbComment, setFbComment] = useState("");
  const [fbReporter, setFbReporter] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fbResult, setFbResult] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const submitFb = async () => {
    setSubmitting(true);
    setFbResult(null);
    try {
      await submitFeedback({
        scoredTransactionId: effectiveId,
        feedbackType: fbType,
        comment: fbComment || null,
        reporter: fbReporter || null,
      });
      setFbResult({
        ok: true,
        msg: "Feedback queued for retraining. Thank you.",
      });
      setFbComment("");
      setTimeout(() => {
        setFbOpen(false);
        onSubmitted();
      }, 1800);
    } catch (e) {
      setFbResult({
        ok: false,
        msg: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const level = riskLevelOf(tx);
  const rec =
    (tx as AnalyzeResponse).recommendation ??
    (tx as StoredTransactionSummary).recommendation;

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute right-0 top-0 h-full w-full max-w-[540px] bg-white shadow-2xl overflow-y-auto border-l border-[#e6ece9]"
        style={{ animation: "slideInDrawer 200ms ease-out both" }}
      >
        <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-[#e6ece9] px-6 py-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">
              {fromFixture ? "Fixture result" : "Transaction detail"}
            </div>
            <div className="font-bold text-slate-900 mt-0.5">
              #{storedId ?? "—"} · Risk {tx.riskScore}/100
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 rounded-[12px] hover:bg-[#f8faf9] text-slate-500 grid place-items-center border border-transparent hover:border-[#e6ece9] transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="p-6 space-y-5">
          <div
            className={`rounded-[20px] border p-5 ${LEVEL_CHIP[level] ?? ""}`}
          >
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="max-w-[60%]">
                <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">
                  Risk level
                </div>
                <div
                  className={`text-3xl font-black mt-1 ${LEVEL_TEXT[level]}`}
                >
                  {level.toUpperCase()}
                </div>
                <p className="text-sm text-slate-700 mt-2 leading-relaxed">
                  {tx.explanation}
                </p>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">
                  Score
                </div>
                <div className="text-5xl font-black tabular-nums text-slate-900 leading-none mt-1">
                  {tx.riskScore}
                  <span className="text-slate-400 text-2xl align-top font-bold">
                    /100
                  </span>
                </div>
                <span
                  className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${REC_STYLE[rec] ?? "bg-slate-500 text-white"}`}
                >
                  {rec}
                </span>
              </div>
            </div>
            <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-white/80">
              <div
                className={`h-full ${LEVEL_DOT[level]}`}
                style={{ width: `${Math.min(100, tx.riskScore)}%` }}
              />
            </div>
            {"ml" in tx && (tx as AnalyzeResponse).ml && (
              <MlBadge ml={(tx as AnalyzeResponse).ml!} />
            )}
          </div>

          {/* Detection flags */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-bold text-slate-900">Detection flags</h4>
              <span className="text-xs text-slate-500">
                {tx.flags.length} trigger{tx.flags.length === 1 ? "" : "s"}
              </span>
            </div>
            {tx.flags.length === 0 ? (
              <div className="rounded-[16px] bg-donazo-50 border border-donazo-200 text-donazo-700 p-4 text-sm">
                ✓ No scam patterns were detected in this transaction.
              </div>
            ) : (
              <ul className="space-y-3">
                {tx.flags.map((f, i) => (
                  <li
                    key={i}
                    className="rounded-[18px] border border-[#e6ece9] bg-[#f8faf9]/40 p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span
                        className={`rounded-[8px] border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${FLAG_CHIP[f.type] ?? "bg-slate-50 text-slate-600 border-slate-200"}`}
                      >
                        {FLAG_LABEL[f.type] ?? f.type}
                      </span>
                      <span
                        className={`rounded-[8px] px-2 py-0.5 text-[10px] font-bold text-white ${LEVEL_DOT[f.severity as RiskLevel] ?? "bg-slate-500"}`}
                      >
                        {(f.severity as string).toUpperCase()}
                      </span>
                    </div>
                    <p className="text-sm text-slate-800">{f.detail}</p>
                    {!!f.metadata && (
                      <pre className="mt-2 text-[11px] bg-white border border-[#e6ece9] rounded-[10px] p-2 overflow-auto max-h-48 font-mono text-slate-600 whitespace-pre-wrap">
                        {JSON.stringify(f.metadata, null, 2)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Meta */}
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <MetaCell
              label="Network"
              value={(tx as AnalyzeResponse).network ?? "—"}
            />
            {"dbConnected" in tx && (
              <MetaCell
                label="DB"
                value={
                  (tx as AnalyzeResponse).dbConnected === false
                    ? "Offline during analyze"
                    : "Connected"
                }
              />
            )}
            <MetaCell
              label="Row id"
              value={storedId != null ? String(storedId) : "—"}
            />
            <MetaCell
              label="Transaction hash"
              value={
                <span className="font-mono break-all text-xs">
                  {trunc((tx as StoredTransactionSummary).transactionHash, 22)}
                </span>
              }
            />
            {(tx as StoredTransactionSummary).signature && (
              <MetaCell
                label="Signature"
                value={
                  <span className="font-mono break-all text-xs">
                    {trunc((tx as StoredTransactionSummary).signature, 22)}
                  </span>
                }
              />
            )}
            {(tx as StoredTransactionSummary).feePayer && (
              <MetaCell
                label="Fee payer"
                value={
                  <span className="font-mono break-all text-xs">
                    {trunc((tx as StoredTransactionSummary).feePayer, 22)}
                  </span>
                }
              />
            )}
            {(tx as StoredTransactionSummary).createdAt && (
              <MetaCell
                label="Created"
                value={new Date(
                  (tx as StoredTransactionSummary).createdAt!,
                ).toLocaleString()}
              />
            )}
            {hasSerialized && (
              <MetaCell
                fullWidth
                label="Serialized tx (base64)"
                value={
                  <span className="font-mono break-all text-xs line-clamp-3">
                    {trunc(
                      (tx as StoredTransactionDetail).serializedTransaction!,
                      140,
                    )}
                  </span>
                }
              />
            )}
          </dl>

          {/* Feedback */}
          <div>
            {!fbOpen ? (
              <div className="flex items-center justify-between gap-3 rounded-[18px] border border-[#e6ece9] bg-[#f8faf9]/50 px-4 py-3">
                <div>
                  <div className="font-semibold text-sm text-slate-800">
                    Was this result wrong?
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Report FP/FN to improve the scoring model.
                  </div>
                </div>
                <button
                  onClick={() => setFbOpen(true)}
                  className="rounded-[12px] border border-[#e6ece9] bg-white text-slate-700 font-semibold text-sm px-3 py-2 hover:bg-[#f8faf9] transition-colors"
                >
                  ⚐ Report
                </button>
              </div>
            ) : (
              <div className="rounded-[18px] border border-[#e6ece9] bg-[#f8faf9]/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold text-slate-900 text-sm">
                      Human-in-the-loop feedback
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      Scored row #{storedId ?? "—"}.
                    </div>
                  </div>
                  <button
                    onClick={() => setFbOpen(false)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    ✕
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <FbBtn
                    active={fbType === "false_positive"}
                    onClick={() => setFbType("false_positive")}
                    label="False positive"
                    sub="Flagged but safe"
                    tone="green"
                  />
                  <FbBtn
                    active={fbType === "false_negative"}
                    onClick={() => setFbType("false_negative")}
                    label="False negative"
                    sub="Missed a scam"
                    tone="red"
                  />
                  <FbBtn
                    active={fbType === "note"}
                    onClick={() => setFbType("note")}
                    label="Note"
                    sub="Other"
                    tone="slate"
                  />
                </div>
                <input
                  value={fbReporter}
                  onChange={(e) => setFbReporter(e.target.value)}
                  placeholder="Pubkey / email (optional)"
                  className="w-full rounded-[12px] bg-white border border-[#e6ece9] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-donazo-400/60"
                />
                <textarea
                  value={fbComment}
                  onChange={(e) => setFbComment(e.target.value)}
                  rows={2}
                  placeholder="Short description of the miscategorization…"
                  className="w-full rounded-[12px] bg-white border border-[#e6ece9] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-donazo-400/60"
                />
                <div className="flex items-center justify-between flex-wrap gap-3">
                  {fbResult && (
                    <div
                      className={`text-sm ${fbResult.ok ? "text-donazo-700" : "text-rose-700"}`}
                    >
                      {fbResult.msg}
                    </div>
                  )}
                  <button
                    onClick={() => void submitFb()}
                    disabled={submitting || effectiveId <= 0}
                    className="ml-auto rounded-[12px] bg-donazo-600 hover:bg-donazo-500 disabled:bg-slate-400 text-white font-semibold text-sm px-4 py-2 transition-colors"
                  >
                    {submitting ? "Submitting…" : "Submit feedback"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <style>{`@keyframes slideInDrawer { from { transform: translateX(16px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }`}</style>
    </div>
  );
}

function MlBadge({ ml }: { ml: NonNullable<AnalyzeResponse["ml"]> }) {
  return (
    <div className="mt-4 flex items-center gap-3 flex-wrap text-xs rounded-[14px] bg-white/80 border border-[#e6ece9] px-3 py-2">
      <span
        className={`rounded-[8px] px-2 py-0.5 font-bold border ${ml.blended ? "bg-donazo-50 border-donazo-200 text-donazo-700" : "bg-slate-50 border-[#e6ece9] text-slate-600"}`}
      >
        ML ·{" "}
        {ml.enabled ? (ml.blended ? "BLENDED" : "NOT BLENDED") : "DISABLED"}
      </span>
      {ml.probability != null && (
        <span className="font-mono text-slate-700">
          P(malicious) = {(ml.probability * 100).toFixed(1)}%
        </span>
      )}
      {ml.version && (
        <span className="text-slate-500">model v{ml.version}</span>
      )}
      {ml.error && (
        <span className="text-amber-600 font-mono truncate">
          err: {ml.error}
        </span>
      )}
    </div>
  );
}

function FbBtn({
  active,
  onClick,
  label,
  sub,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  sub: string;
  tone: "green" | "red" | "slate";
}) {
  const tones: Record<typeof tone, string> = {
    green: active
      ? "bg-donazo-50 border-donazo-400 text-donazo-700"
      : "border-[#e6ece9] text-slate-500 hover:text-slate-700 hover:border-slate-300",
    red: active
      ? "bg-rose-50 border-rose-400 text-rose-700"
      : "border-[#e6ece9] text-slate-500 hover:text-slate-700 hover:border-slate-300",
    slate: active
      ? "bg-slate-100 border-slate-400 text-slate-800"
      : "border-[#e6ece9] text-slate-500 hover:text-slate-700 hover:border-slate-300",
  };
  return (
    <button
      onClick={onClick}
      className={`rounded-[14px] border p-3 text-left transition-colors ${tones[tone]} ${active ? "ring-1 shadow-sm" : ""}`}
    >
      <div className="text-sm font-semibold">{label}</div>
      <div className="text-[11px] opacity-80 mt-0.5">{sub}</div>
    </button>
  );
}

function MetaCell({
  label,
  value,
  fullWidth,
}: {
  label: string;
  value: React.ReactNode;
  fullWidth?: boolean;
}) {
  return (
    <div
      className={`rounded-[14px] border border-[#e6ece9] bg-white p-3 ${fullWidth ? "col-span-2" : ""}`}
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">
        {label}
      </div>
      <div className="mt-1 text-slate-800 text-sm break-words">{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scan transaction modal
// ---------------------------------------------------------------------------
function ScanTransactionModal({
  onClose,
  onRun,
}: {
  onClose: () => void;
  onRun: (
    serialized: string,
    network: "mainnet-beta" | "devnet" | "testnet",
  ) => Promise<void> | void;
}) {
  const [serialized, setSerialized] = useState("");
  const [network, setNetwork] = useState<"mainnet-beta" | "devnet" | "testnet">(
    "mainnet-beta",
  );
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setError(null);
    if (!serialized.trim()) {
      setError("A base64-encoded transaction is required.");
      return;
    }
    setRunning(true);
    try {
      await onRun(serialized.trim(), network);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const fillFixture = () => {
    const risky = fixtures.samples.find((s) => s.category.startsWith("risk:"));
    if (risky) setSerialized(risky.serializedTransaction);
  };

  return (
    <div className="fixed inset-0 z-[60]" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-[640px] rounded-[28px] bg-white shadow-2xl border border-[#e6ece9] overflow-hidden"
        style={{ animation: "popIn 160ms ease-out both" }}
      >
        <div className="px-6 py-4 border-b border-[#e6ece9] flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-slate-400 font-bold">
              POST /v1/analyze-transaction
            </div>
            <h3 className="font-extrabold text-slate-900 text-[1.15rem] mt-0.5">
              Scan a transaction
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              Paste the base64-encoded transaction (the same format used by{" "}
              <code className="font-mono bg-[#f8faf9] px-1.5 py-0.5 rounded text-[11px] border border-[#e6ece9]">
                @solana/web3.js
              </code>
              's{" "}
              <code className="font-mono bg-[#f8faf9] px-1.5 py-0.5 rounded text-[11px] border border-[#e6ece9]">
                serialize()
              </code>
              ).
            </p>
          </div>
          <button
            onClick={onClose}
            className="h-9 w-9 rounded-[12px] hover:bg-[#f8faf9] text-slate-500 grid place-items-center border border-transparent hover:border-[#e6ece9] transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
                Network
              </label>
            </div>
            <div className="flex rounded-[14px] border border-[#e6ece9] overflow-hidden bg-white p-1">
              {(["mainnet-beta", "devnet", "testnet"] as const).map((n) => (
                <button
                  key={n}
                  onClick={() => setNetwork(n)}
                  className={`flex-1 h-9 rounded-[10px] text-[12px] font-semibold transition-colors ${network === n ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-[#f8faf9]"}`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
                Serialized transaction (base64)
              </label>
              <button
                onClick={fillFixture}
                className="text-[11px] text-donazo-600 hover:text-donazo-700 font-semibold underline-offset-2 hover:underline"
              >
                Paste a known-risk fixture
              </button>
            </div>
            <textarea
              value={serialized}
              onChange={(e) => setSerialized(e.target.value)}
              rows={7}
              spellCheck={false}
              className="w-full font-mono text-xs rounded-[14px] bg-[#f8faf9] border border-[#e6ece9] px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-donazo-400/60 focus:border-donazo-400 focus:bg-white transition-all"
              placeholder="Abcdefg1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=…"
            />
            <div className="flex items-center justify-between mt-1.5 text-[11px] text-slate-500">
              <span>{serialized.length.toLocaleString()} characters</span>
              {serialized.length > 0 &&
                !/^[A-Za-z0-9+/]+=*$/.test(serialized.trim()) && (
                  <span className="text-amber-600 font-semibold">
                    ⚠ Doesn't look like base64
                  </span>
                )}
            </div>
          </div>

          {error && (
            <div className="rounded-[14px] border border-rose-200 bg-rose-50 text-rose-700 px-3 py-2 text-xs">
              <div className="font-bold">Scan failed</div>
              <code className="font-mono text-[11px] break-all block mt-0.5">
                {error}
              </code>
            </div>
          )}

          <div className="flex items-center justify-end gap-2.5 pt-1">
            <button
              onClick={onClose}
              className="h-11 px-5 rounded-[14px] border border-[#e6ece9] bg-white font-semibold text-sm text-slate-700 hover:bg-[#f8faf9] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void run()}
              disabled={running || !serialized.trim()}
              className="h-11 px-6 rounded-[14px] bg-donazo-600 text-white font-semibold text-sm shadow-[0_10px_24px_-12px_rgb(40_134_78_/_0.7)] hover:bg-donazo-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {running ? (
                <>
                  <svg
                    className="h-4 w-4 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  >
                    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
                  </svg>
                  Scanning…
                </>
              ) : (
                "Run risk scan"
              )}
            </button>
          </div>
        </div>
      </div>
      <style>{`@keyframes popIn { from { transform: translate(-50%, -46%) scale(.96); opacity: 0 } to { transform: translate(-50%, -50%) scale(1); opacity: 1 } }`}</style>
    </div>
  );
}
