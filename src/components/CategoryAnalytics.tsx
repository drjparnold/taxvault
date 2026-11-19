import React, { useMemo } from 'react';
import {
  IRS_CATEGORY_LINE_MAP,
  InvoiceRecord,
  TAX_CATEGORIES,
} from '../types/invoice';

interface CategoryAnalyticsProps {
  records: InvoiceRecord[];
}

export const CategoryAnalytics: React.FC<CategoryAnalyticsProps> = ({
  records,
}) => {
  const categoryStats = useMemo(() => {
    const map = new Map<
      string,
      { count: number; gross: number; tax: number; deductible: number }
    >();

    for (const cat of TAX_CATEGORIES) {
      map.set(cat, { count: 0, gross: 0, tax: 0, deductible: 0 });
    }

    for (const r of records) {
      const prev = map.get(r.category) || {
        count: 0,
        gross: 0,
        tax: 0,
        deductible: 0,
      };
      map.set(r.category, {
        count: prev.count + 1,
        gross: prev.gross + r.totalAmount,
        tax: prev.tax + r.taxAmount,
        deductible: prev.deductible + r.deductibleAmount,
      });
    }

    return Array.from(map.entries())
      .map(([category, stats]) => ({
        category,
        irsLine:
          IRS_CATEGORY_LINE_MAP[category as keyof typeof IRS_CATEGORY_LINE_MAP] ||
          '',
        ...stats,
      }))
      .sort((a, b) => b.deductible - a.deductible);
  }, [records]);

  const maxDeductible = useMemo(
    () => Math.max(1, ...categoryStats.map((c) => c.deductible)),
    [categoryStats]
  );

  const totalDeductible = useMemo(
    () => categoryStats.reduce((s, c) => s + c.deductible, 0),
    [categoryStats]
  );

  const monthlyStats = useMemo(() => {
    const map = new Map<
      string,
      { count: number; gross: number; deductible: number }
    >();
    for (const r of records) {
      const m = r.date.slice(0, 7);
      const prev = map.get(m) || { count: 0, gross: 0, deductible: 0 };
      map.set(m, {
        count: prev.count + 1,
        gross: prev.gross + r.totalAmount,
        deductible: prev.deductible + r.deductibleAmount,
      });
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, stats]) => ({ month, ...stats }));
  }, [records]);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Category Schedule C Breakdown */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white lg:col-span-8">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900">
              Tax Deduction Breakdown by Category
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Mapped to IRS Schedule C expense lines for year-end accountant handoff
            </p>
          </div>
          <div className="text-right">
            <span className="text-xs text-slate-500">Total Deductible</span>
            <p className="font-mono text-base font-semibold text-teal-800 tabular-nums">
              R {totalDeductible.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>

        <div className="divide-y divide-slate-100">
          {categoryStats.map((row) => {
            const pctWidth = (row.deductible / maxDeductible) * 100;
            const share =
              totalDeductible > 0
                ? ((row.deductible / totalDeductible) * 100).toFixed(1)
                : '0.0';

            return (
              <div key={row.category} className="px-5 py-3.5">
                <div className="flex items-baseline justify-between gap-4">
                  <div className="min-w-0">
                    <span className="text-sm font-medium text-slate-900">
                      {row.category}
                    </span>
                    <span className="mx-2 text-slate-300" aria-hidden="true">
                      ·
                    </span>
                    <span className="text-xs text-slate-500">{row.irsLine}</span>
                  </div>
                  <div className="shrink-0 text-right font-mono text-xs tabular-nums">
                    <span className="font-semibold text-slate-900">
                      R {row.deductible.toFixed(2)}
                    </span>
                    <span className="ml-2 text-slate-400">({share}%)</span>
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-slate-100">
                    <div
                      className="h-full bg-teal-700 transition-all"
                      style={{ width: `${row.deductible > 0 ? Math.max(2, pctWidth) : 0}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right font-mono text-[11px] text-slate-500 tabular-nums">
                    {row.count} invoice{row.count === 1 ? '' : 's'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Monthly Cadence */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white lg:col-span-4">
        <div className="border-b border-slate-200 px-5 py-4">
          <h2 className="font-display text-base font-semibold text-slate-900">
            Monthly Ledger Cadence
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Deductible totals grouped by invoice month
          </p>
        </div>

        {monthlyStats.length > 0 ? (
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Month</th>
                <th className="px-4 py-2.5 text-right font-semibold">Count</th>
                <th className="px-4 py-2.5 text-right font-semibold">Deductible</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {monthlyStats.map((m) => (
                <tr key={m.month}>
                  <td className="px-4 py-3 font-mono font-medium text-slate-900 tabular-nums">
                    {m.month}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-600 tabular-nums">
                    {m.count}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-teal-800 tabular-nums">
                    R {m.deductible.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-5 py-10 text-center text-xs text-slate-500">
            Monthly breakdown will populate automatically as invoices are recorded.
          </div>
        )}
      </div>
    </div>
  );
};
