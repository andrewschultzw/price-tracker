import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { getPublicSavings } from '../api';
import type { SavingsSummary } from '../types';
import useTitle from '../useTitle';

/**
 * Public-facing cumulative-savings page. Backed by
 * `/api/public/savings` — no auth, no PII (no product/retailer
 * names). Hero number on top, cumulative area chart below. The page
 * is intentionally minimal so it can be linked from social/SEO without
 * exposing the rest of the app's chrome to anonymous visitors.
 */
export default function Savings() {
  const [data, setData] = useState<SavingsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useTitle('Savings');

  useEffect(() => {
    getPublicSavings()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-center text-text-muted">
        Couldn't load savings data.
      </div>
    );
  }
  if (!data) {
    return <div className="max-w-3xl mx-auto p-8 text-center text-text-muted">Loading...</div>;
  }
  if (data.purchase_count === 0 || data.since === null) {
    return (
      <div className="max-w-3xl mx-auto p-8 text-center text-text-muted">
        No purchases yet — check back soon.
      </div>
    );
  }

  const since = new Date(data.since).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
  // Cumulative running total per month for the area chart. Keeps the
  // shape monotonically non-decreasing so the chart reads as "growth
  // over time" rather than "monthly burst".
  let running = 0;
  const series = data.monthly.map(m => ({
    month: m.month,
    cumulative: (running += m.saved),
  }));

  return (
    <div className="max-w-3xl mx-auto px-4 py-12 text-center">
      <div className="text-5xl sm:text-6xl font-bold text-success tracking-tight">
        ${data.total_saved.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div className="text-text-muted mt-3">
        saved across {data.purchase_count} purchases since {since}
      </div>

      <div className="mt-12 h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={series} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
            <XAxis dataKey="month" stroke="#64748b" fontSize={12} tickLine={false} />
            <YAxis
              stroke="#64748b"
              fontSize={12}
              tickLine={false}
              tickFormatter={(v: number) => `$${v}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1e293b',
                border: '1px solid #334155',
                borderRadius: '8px',
                color: '#f1f5f9',
                fontSize: '13px',
              }}
              formatter={(v: unknown) => [`$${Number(v).toFixed(2)}`, 'Cumulative']}
            />
            <Area type="monotone" dataKey="cumulative" stroke="#22c55e" fill="#22c55e33" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
