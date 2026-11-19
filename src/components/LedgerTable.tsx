import React, { useMemo, useState } from 'react';
import {
  Download,
  ExternalLink,
  Pencil,
  RefreshCw,
  Search,
  Sheet,
  Trash2,
  X,
} from 'lucide-react';
import {
  DEFAULT_DEDUCTIBLE_RATES,
  IRS_CATEGORY_LINE_MAP,
  InvoiceRecord,
  TAX_CATEGORIES,
  TaxCategory,
  WorkspaceSettings,
} from '../types/invoice';
import { exportToDelimited, exportToXlsx } from '../lib/sheetExport';

interface LedgerTableProps {
  records: InvoiceRecord[];
  isGoogleConnected: boolean;
  isSyncingSheet: boolean;
  settings: WorkspaceSettings;
  onSyncFromSheet: () => void;
  onSyncLocalRecordToWorkspace: (record: InvoiceRecord) => Promise<void>;
  onRequestUpdateRecord: (updated: InvoiceRecord) => void;
  onRequestDeleteRecord: (record: InvoiceRecord) => void;
  onNavigateToScanner: () => void;
}

export const LedgerTable: React.FC<LedgerTableProps> = ({
  records,
  isGoogleConnected,
  isSyncingSheet,
  settings,
  onSyncFromSheet,
  onSyncLocalRecordToWorkspace,
  onRequestUpdateRecord,
  onRequestDeleteRecord,
  onNavigateToScanner,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('ALL');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [editingRecord, setEditingRecord] = useState<InvoiceRecord | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records) {
      counts.set(r.category, (counts.get(r.category) || 0) + 1);
    }
    return counts;
  }, [records]);

  const hasActiveFilters = Boolean(
    searchQuery.trim() || selectedCategory !== 'ALL' || startDate || endDate
  );

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedCategory('ALL');
    setStartDate('');
    setEndDate('');
  };

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return records
      .filter((r) => {
        if (selectedCategory !== 'ALL' && r.category !== selectedCategory) return false;
        if (startDate && r.date < startDate) return false;
        if (endDate && r.date > endDate) return false;
        if (!q) return true;
        return (
          r.vendor.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q) ||
          r.date.toLowerCase().includes(q) ||
          r.summary.toLowerCase().includes(q) ||
          r.invoiceNumber.toLowerCase().includes(q) ||
          r.paymentMethod.toLowerCase().includes(q) ||
          (r.driveFolderPath || '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [records, searchQuery, selectedCategory, startDate, endDate]);

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, r) => {
        acc.gross += r.totalAmount;
        acc.tax += r.taxAmount;
        acc.deductible += r.deductibleAmount;
        return acc;
      },
      { gross: 0, tax: 0, deductible: 0 }
    );
  }, [filtered]);

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRecord) return;
    onRequestUpdateRecord(editingRecord);
    setEditingRecord(null);
  };

  return (
    <div className="space-y-6">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Total Deductible</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-teal-800 tabular-nums">
            R {totals.deductible.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Schedule C eligible write-off
          </p>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Gross Invoice Spend</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            R {totals.gross.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Across {filtered.length} filtered invoice{filtered.length === 1 ? '' : 's'}
          </p>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Sales Tax / VAT Paid</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            R {totals.tax.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Captured from receipt subtotals
          </p>
        </div>

        <div className="px-5 py-4">
          <p className="text-xs font-medium text-slate-500">Google Sheets Sync</p>
          <p className="mt-1 font-mono text-2xl font-semibold text-slate-900 tabular-nums">
            {records.filter((r) => Boolean(r.sheetRowNumber)).length} / {records.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {settings.spreadsheetUrl ? (
              <a
                href={settings.spreadsheetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline"
              >
                Open {settings.spreadsheetTitle}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              'Sheet created on first Drive sync'
            )}
          </p>
        </div>
      </div>

      {/* Controls & Sheet Export Bar */}
      <div className="flex flex-col justify-between gap-3 rounded-lg border border-slate-200 bg-white p-4 xl:flex-row xl:items-center">
        <div className="flex flex-1 flex-wrap items-center gap-2.5">
          <div className="relative min-w-[220px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search vendor, invoice #, or notes..."
              aria-label="Search invoices by vendor, invoice number, or notes"
              className="w-full rounded-md border border-slate-300 bg-white py-2 pl-9 pr-8 text-xs text-slate-900 placeholder:text-slate-400 focus:border-teal-700 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Clear search query"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <select
            value={selectedCategory}
            onChange={(e) => setSelectedCategory(e.target.value)}
            aria-label="Filter by tax category"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 focus:border-teal-700 focus:outline-none"
          >
            <option value="ALL">All Categories ({records.length})</option>
            {TAX_CATEGORIES.map((cat) => {
              const count = categoryCounts.get(cat) || 0;
              return (
                <option key={cat} value={cat}>
                  {cat}{count > 0 ? ` (${count})` : ''}
                </option>
              );
            })}
          </select>

          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={startDate}
              max={endDate || undefined}
              onChange={(e) => setStartDate(e.target.value)}
              aria-label="Filter start date"
              title="Start date"
              className="rounded-md border border-slate-300 bg-white px-2.5 py-2 font-mono text-xs text-slate-800 tabular-nums focus:border-teal-700 focus:outline-none"
            />
            <span className="text-xs text-slate-400" aria-hidden="true">
              –
            </span>
            <input
              type="date"
              value={endDate}
              min={startDate || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              aria-label="Filter end date"
              title="End date"
              className="rounded-md border border-slate-300 bg-white px-2.5 py-2 font-mono text-xs text-slate-800 tabular-nums focus:border-teal-700 focus:outline-none"
            />
          </div>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              <X className="h-3.5 w-3.5" />
              Clear
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isGoogleConnected && (
            <button
              type="button"
              onClick={onSyncFromSheet}
              disabled={isSyncingSheet}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isSyncingSheet ? 'animate-spin' : ''}`} />
              {isSyncingSheet ? 'Refreshing...' : 'Refresh from Sheet'}
            </button>
          )}

          <button
            type="button"
            onClick={() => exportToXlsx(filtered)}
            disabled={filtered.length === 0}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40"
          >
            <Sheet className="h-3.5 w-3.5 text-teal-700" />
            Export XLSX
          </button>

          <button
            type="button"
            onClick={() => exportToDelimited(filtered, 'csv')}
            disabled={filtered.length === 0}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>

          <button
            type="button"
            onClick={() => exportToDelimited(filtered, 'tsv')}
            disabled={filtered.length === 0}
            className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            TSV
          </button>
        </div>
      </div>

      {/* High-Density Ledger Table */}
      {filtered.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <tr>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Date</th>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Vendor & Audit Note</th>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Tax Category</th>
                  <th className="whitespace-nowrap px-4 py-3 font-semibold">Drive Folder</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Total</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Deductible</th>
                  <th className="whitespace-nowrap px-4 py-3 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filtered.map((record) => (
                  <tr key={record.id} className="transition-colors hover:bg-slate-50/80">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-700 tabular-nums">
                      {record.date}
                    </td>
                    <td className="max-w-[260px] px-4 py-3">
                      <div className="truncate font-medium text-slate-900">
                        {record.vendor}
                        {record.invoiceNumber ? (
                          <span className="ml-1.5 font-mono text-[11px] font-normal text-slate-400">
                            #{record.invoiceNumber}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">
                        {record.summary || record.paymentMethod}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <div className="font-medium text-slate-800">{record.category}</div>
                      <div className="text-[11px] text-slate-500">
                        {record.deductiblePercentage}% rate · {IRS_CATEGORY_LINE_MAP[record.category]?.split('(')[0].trim()}
                      </div>
                    </td>
                    <td className="max-w-[240px] px-4 py-3">
                      {record.driveWebViewLink ? (
                        <a
                          href={record.driveWebViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex max-w-full items-center gap-1 font-mono text-[11px] text-teal-700 hover:underline"
                          title={record.driveFolderPath}
                        >
                          <span className="truncate">
                            {record.driveFolderPath || 'Open in Drive'}
                          </span>
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </a>
                      ) : isGoogleConnected ? (
                        <button
                          type="button"
                          disabled={syncingId === record.id}
                          onClick={async () => {
                            setSyncingId(record.id);
                            try {
                              await onSyncLocalRecordToWorkspace(record);
                            } finally {
                              setSyncingId(null);
                            }
                          }}
                          className="whitespace-nowrap font-medium text-amber-700 hover:underline disabled:opacity-50"
                        >
                          {syncingId === record.id ? 'Syncing...' : 'Sync to Sheet'}
                        </button>
                      ) : (
                        <span className="text-[11px] text-slate-400">Local session only</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-slate-700 tabular-nums">
                      {record.currency === 'ZAR' ? 'R' : record.currency} {record.totalAmount.toFixed(2)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-mono font-semibold text-teal-800 tabular-nums">
                      {record.currency === 'ZAR' ? 'R' : record.currency} {record.deductibleAmount.toFixed(2)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingRecord({ ...record })}
                          className="rounded p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
                          aria-label={`Edit ${record.vendor} record`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRequestDeleteRecord(record)}
                          className="rounded p-1.5 text-slate-500 transition-colors hover:bg-red-50 hover:text-red-700"
                          aria-label={`Delete ${record.vendor} record`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white px-6 py-14 text-center">
          <p className="font-display text-sm font-semibold text-slate-900">
            {records.length === 0
              ? 'No tax deductions recorded yet'
              : 'No records match your current filters'}
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
            {records.length === 0
              ? 'Scan your first invoice or refresh from an existing Google Sheet to populate your deductions ledger.'
              : 'Clear your search query, category filter, or date range to view all recorded invoices.'}
          </p>
          {records.length === 0 ? (
            <button
              type="button"
              onClick={onNavigateToScanner}
              className="mt-4 inline-flex items-center whitespace-nowrap rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-teal-800"
            >
              Scan First Invoice
            </button>
          ) : (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 inline-flex items-center whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              Clear Filters
            </button>
          )}
        </div>
      )}

      {/* Edit Modal */}
      {editingRecord && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-record-title"
        >
          <form
            onSubmit={handleSaveEdit}
            className="w-full max-w-lg rounded-lg border border-slate-200 bg-white shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
              <h3
                id="edit-record-title"
                className="font-display text-base font-semibold text-slate-900"
              >
                Edit Deduction Record
              </h3>
              <button
                type="button"
                onClick={() => setEditingRecord(null)}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close edit modal"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-700">Vendor</label>
                <input
                  type="text"
                  required
                  value={editingRecord.vendor}
                  onChange={(e) =>
                    setEditingRecord({ ...editingRecord, vendor: e.target.value })
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">Date</label>
                <input
                  type="date"
                  required
                  value={editingRecord.date}
                  onChange={(e) =>
                    setEditingRecord({ ...editingRecord, date: e.target.value })
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">Category</label>
                <select
                  value={editingRecord.category}
                  onChange={(e) => {
                    const cat = e.target.value as TaxCategory;
                    const rate = DEFAULT_DEDUCTIBLE_RATES[cat] ?? 100;
                    setEditingRecord({
                      ...editingRecord,
                      category: cat,
                      deductiblePercentage: rate,
                      deductibleAmount: Number(
                        ((editingRecord.totalAmount * rate) / 100).toFixed(2)
                      ),
                    });
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                >
                  {TAX_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Total Amount ({editingRecord.currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={editingRecord.totalAmount}
                  onChange={(e) => {
                    const total = Number(e.target.value) || 0;
                    setEditingRecord({
                      ...editingRecord,
                      totalAmount: total,
                      deductibleAmount: Number(
                        ((total * editingRecord.deductiblePercentage) / 100).toFixed(2)
                      ),
                    });
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Deductible %
                </label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={editingRecord.deductiblePercentage}
                  onChange={(e) => {
                    const pct = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                    setEditingRecord({
                      ...editingRecord,
                      deductiblePercentage: pct,
                      deductibleAmount: Number(
                        ((editingRecord.totalAmount * pct) / 100).toFixed(2)
                      ),
                    });
                  }}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700">
                  Payment Method
                </label>
                <input
                  type="text"
                  value={editingRecord.paymentMethod}
                  onChange={(e) =>
                    setEditingRecord({
                      ...editingRecord,
                      paymentMethod: e.target.value,
                    })
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-700">
                  Tax Notes
                </label>
                <input
                  type="text"
                  value={editingRecord.summary}
                  onChange={(e) =>
                    setEditingRecord({ ...editingRecord, summary: e.target.value })
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-5 py-3.5">
              <button
                type="button"
                onClick={() => setEditingRecord(null)}
                className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="whitespace-nowrap rounded-md bg-teal-700 px-4 py-2 text-xs font-medium text-white hover:bg-teal-800"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
