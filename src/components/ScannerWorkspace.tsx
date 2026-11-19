import React, { useRef, useState } from 'react';
import {
  Check,
  FileText,
  FolderTree,
  Loader2,
  Plus,
  Sheet,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  DEFAULT_DEDUCTIBLE_RATES,
  IRS_CATEGORY_LINE_MAP,
  ScannedInvoiceDraft,
  TAX_CATEGORIES,
  TaxCategory,
  WorkspaceSettings,
} from '../types/invoice';
import {
  buildFolderSegments,
  buildNormalizedInvoiceFileName,
} from '../lib/googleWorkspace';
import { GoogleSignInButton } from './GoogleSignInButton';

interface QueueItem {
  id: string;
  fileName: string;
  status: 'scanning' | 'ready' | 'error';
  error?: string;
}

interface ScannerWorkspaceProps {
  isGoogleConnected: boolean;
  onGoogleSignIn: () => void;
  isSigningIn: boolean;
  settings: WorkspaceSettings;
  drafts: ScannedInvoiceDraft[];
  activeDraftId: string | null;
  onSelectDraft: (id: string) => void;
  onUpdateDraft: (id: string, patch: Partial<ScannedInvoiceDraft>) => void;
  onDiscardDraft: (id: string) => void;
  onAddDrafts: (newDrafts: ScannedInvoiceDraft[]) => void;
  onConfirmAndSave: (draft: ScannedInvoiceDraft) => Promise<void>;
  isSaving: boolean;
  saveProgress: string;
}

function readFileAsBase64(file: File): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      const commaIdx = dataUrl.indexOf(',');
      const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
      resolve({ base64, dataUrl });
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function resolveInvoiceMimeType(file: File): string {
  const rawType = (file.type || '').toLowerCase().trim();
  if (rawType === 'application/x-pdf') return 'application/pdf';
  if (rawType) return rawType;

  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  switch (ext) {
    case 'pdf':
      return 'application/pdf';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
      return 'image/heic';
    case 'heif':
      return 'image/heif';
    case 'jpg':
    case 'jpeg':
    default:
      return 'image/jpeg';
  }
}

export const ScannerWorkspace: React.FC<ScannerWorkspaceProps> = ({
  isGoogleConnected,
  onGoogleSignIn,
  isSigningIn,
  settings,
  drafts,
  activeDraftId,
  onSelectDraft,
  onUpdateDraft,
  onDiscardDraft,
  onAddDrafts,
  onConfirmAndSave,
  isSaving,
  saveProgress,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);

  const activeDraft = drafts.find((d) => d.tempId === activeDraftId) || drafts[0] || null;

  const processFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setScanError(null);
    const items: QueueItem[] = files.map((file, idx) => ({
      id: `${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      fileName: file.name,
      status: 'scanning',
    }));
    setQueue((prev) => [...items, ...prev]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const qId = items[i].id;

      try {
        const mimeType = resolveInvoiceMimeType(file);
        const { base64, dataUrl } = await readFileAsBase64(file);

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 90000);

        let response: Response;
        try {
          response = await fetch('/api/scan-invoice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: file.name,
              mimeType,
              base64Data: base64,
            }),
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(timeoutId);
        }

        const rawBody = await response.text();
        let payload: Record<string, unknown> = {};
        try {
          payload = rawBody ? JSON.parse(rawBody) : {};
        } catch {
          throw new Error(
            response.ok
              ? 'Received an unexpected response format from the scanner.'
              : `Scan failed (${response.status}): ${rawBody.slice(0, 140) || response.statusText}`
          );
        }

        if (!response.ok) {
          throw new Error(
            typeof payload?.error === 'string'
              ? payload.error
              : `Scan failed (${response.status})`
          );
        }

        const draft: ScannedInvoiceDraft = {
          tempId: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          fileName: file.name,
          mimeType,
          fileSize: file.size,
          previewUrl: dataUrl,
          base64Data: base64,
          vendor: String(payload.vendor || 'Unknown Vendor'),
          invoiceNumber: String(payload.invoiceNumber || ''),
          date: String(payload.date || new Date().toISOString().slice(0, 10)),
          category: (payload.category as TaxCategory) || 'Other Deductible',
          currency: String(payload.currency || settings.defaultCurrency || 'ZAR'),
          subtotal: Number(payload.subtotal) || 0,
          taxAmount: Number(payload.taxAmount) || 0,
          totalAmount: Number(payload.totalAmount) || 0,
          deductiblePercentage: Number(payload.deductiblePercentage) || 100,
          deductibleAmount: Number(payload.deductibleAmount) || 0,
          paymentMethod: String(payload.paymentMethod || 'Unspecified'),
          summary: String(payload.summary || ''),
          lineItems: Array.isArray(payload.lineItems) ? payload.lineItems : [],
          confidence: Number(payload.confidence) || 0.9,
        };

        onAddDrafts([draft]);
        setQueue((prev) =>
          prev.map((q) => (q.id === qId ? { ...q, status: 'ready' } : q))
        );
      } catch (err: unknown) {
        const message =
          err instanceof DOMException && err.name === 'AbortError'
            ? 'Invoice scan timed out after 90 seconds. Please try again with a clearer or smaller file.'
            : err instanceof Error
              ? err.message
              : 'Unable to scan invoice.';
        setScanError(message);
        setQueue((prev) =>
          prev.map((q) => (q.id === qId ? { ...q, status: 'error', error: message } : q))
        );
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.length) {
      processFiles(e.dataTransfer.files);
    }
  };

  const handleCategoryChange = (draft: ScannedInvoiceDraft, category: TaxCategory) => {
    const rate = DEFAULT_DEDUCTIBLE_RATES[category] ?? 100;
    const deductibleAmount = Number(((draft.totalAmount * rate) / 100).toFixed(2));
    onUpdateDraft(draft.tempId, {
      category,
      deductiblePercentage: rate,
      deductibleAmount,
    });
  };

  const handleAmountChange = (
    draft: ScannedInvoiceDraft,
    field: 'subtotal' | 'taxAmount' | 'totalAmount' | 'deductiblePercentage',
    rawValue: string
  ) => {
    const val = Number(rawValue);
    if (Number.isNaN(val)) return;

    if (field === 'totalAmount') {
      const deductibleAmount = Number(
        ((val * draft.deductiblePercentage) / 100).toFixed(2)
      );
      onUpdateDraft(draft.tempId, { totalAmount: val, deductibleAmount });
    } else if (field === 'deductiblePercentage') {
      const clamped = Math.min(100, Math.max(0, val));
      const deductibleAmount = Number(
        ((draft.totalAmount * clamped) / 100).toFixed(2)
      );
      onUpdateDraft(draft.tempId, {
        deductiblePercentage: clamped,
        deductibleAmount,
      });
    } else {
      onUpdateDraft(draft.tempId, { [field]: val });
    }
  };

  const targetSegments = activeDraft
    ? buildFolderSegments(
        activeDraft.date,
        activeDraft.category,
        settings.folderScheme,
        settings.rootFolderName
      )
    : [];
  const targetFileName = activeDraft ? buildNormalizedInvoiceFileName(activeDraft) : '';
  const scanningCount = queue.filter((q) => q.status === 'scanning').length;

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => {
          const selected = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = '';
          if (selected.length > 0) {
            void processFiles(selected);
          }
        }}
      />

      {!isGoogleConnected && (
        <div className="flex flex-col justify-between gap-4 rounded-lg border border-slate-200 bg-white px-5 py-4 sm:flex-row sm:items-center">
          <div className="space-y-1">
            <h2 className="font-display text-sm font-semibold text-slate-900">
              Connect Google Drive & Google Sheets for automatic filing
            </h2>
            <p className="text-xs text-slate-600">
              Sign in with Google to organize scanned invoices into date and category folders in Drive and export rows directly to your tax spreadsheet.
            </p>
          </div>
          <GoogleSignInButton
            onClick={onGoogleSignIn}
            disabled={isSigningIn}
            label={isSigningIn ? 'Connecting...' : 'Sign in with Google'}
          />
        </div>
      )}

      {/* Upload Dropzone */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`rounded-lg border border-dashed transition-colors ${
          isDragging
            ? 'border-teal-700 bg-teal-50/40'
            : 'border-slate-300 bg-white hover:border-slate-400'
        }`}
      >
        <div
          onClick={() => fileInputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-between gap-4 px-6 py-6 sm:flex-row"
        >
          <div className="flex items-center gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-700">
              {scanningCount > 0 ? (
                <Loader2 className="h-5 w-5 animate-spin text-teal-700" />
              ) : (
                <Upload className="h-5 w-5" />
              )}
            </div>
            <div>
              <p className="font-display text-sm font-semibold text-slate-900">
                {scanningCount > 0
                  ? `Extracting tax details from ${scanningCount} invoice${scanningCount > 1 ? 's' : ''}...`
                  : 'Drop invoices or receipts here to scan'}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                Supports PDF, PNG, JPG, and WebP · Extracts vendor, date, tax category, subtotal, tax, and deductible total
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-teal-700 px-4 py-2.5 text-xs font-medium text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            <Plus className="h-4 w-4" />
            Select Invoices
          </button>
        </div>

        {scanError && (
          <div className="border-t border-red-200 bg-red-50 px-6 py-2.5 text-xs text-red-700">
            Scan notice: {scanError}
          </div>
        )}

        {queue.length > 0 && (
          <div className="divide-y divide-slate-100 border-t border-slate-200 bg-slate-50/70">
            {queue.slice(0, 5).map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-3 px-6 py-2 text-xs"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {item.status === 'scanning' ? (
                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-700" />
                  ) : item.status === 'ready' ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-teal-700" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5 shrink-0 text-red-600" />
                  )}
                  <span className="truncate font-mono text-slate-700">{item.fileName}</span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span
                    className={
                      item.status === 'error'
                        ? 'text-red-700'
                        : item.status === 'ready'
                          ? 'text-teal-700'
                          : 'text-slate-500'
                    }
                  >
                    {item.status === 'scanning'
                      ? 'Extracting invoice details...'
                      : item.status === 'ready'
                        ? 'Ready for review'
                        : item.error || 'Failed'}
                  </span>
                  {item.status !== 'scanning' && (
                    <button
                      type="button"
                      onClick={() =>
                        setQueue((prev) => prev.filter((q) => q.id !== item.id))
                      }
                      className="text-slate-400 hover:text-slate-700"
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Review Workspace */}
      {activeDraft ? (
        <div className="space-y-4">
          {drafts.length > 1 && (
            <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 pb-3">
              <span className="shrink-0 text-xs font-medium text-slate-500">
                Pending review ({drafts.length}):
              </span>
              {drafts.map((d) => (
                <button
                  key={d.tempId}
                  type="button"
                  onClick={() => onSelectDraft(d.tempId)}
                  className={`shrink-0 whitespace-nowrap rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    d.tempId === activeDraft.tempId
                      ? 'border-teal-700 bg-teal-700 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {d.vendor} · <span className="font-mono tabular-nums">{d.currency} {d.totalAmount.toFixed(2)}</span>
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-12">
            {/* Document Preview Pane */}
            <div className="flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white lg:col-span-5">
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                <div className="flex min-w-0 items-center gap-2">
                  <FileText className="h-4 w-4 shrink-0 text-slate-500" />
                  <span className="truncate font-mono text-xs font-medium text-slate-700">
                    {activeDraft.fileName}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-xs text-slate-500 tabular-nums">
                  {Math.round(activeDraft.confidence * 100)}% match
                </span>
              </div>

              <div className="flex min-h-[420px] flex-1 items-center justify-center bg-slate-100 p-4">
                {activeDraft.mimeType === 'application/pdf' ? (
                  <iframe
                    src={activeDraft.previewUrl}
                    title={activeDraft.fileName}
                    className="h-[520px] w-full rounded border border-slate-200 bg-white"
                  />
                ) : (
                  <img
                    src={activeDraft.previewUrl}
                    alt={`Scanned invoice from ${activeDraft.vendor}`}
                    className="max-h-[520px] w-auto rounded border border-slate-200 object-contain shadow-sm"
                  />
                )}
              </div>
            </div>

            {/* Extracted Tax Fields & Filing Destination */}
            <div className="flex flex-col justify-between rounded-lg border border-slate-200 bg-white lg:col-span-7">
              <div className="space-y-5 p-5">
                <div className="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
                  <div>
                    <h3 className="font-display text-base font-semibold text-slate-900">
                      Verify Extracted Tax Details
                    </h3>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Confirm category, date, and deductible amount before filing to Drive & Sheets.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => onDiscardDraft(activeDraft.tempId)}
                    disabled={isSaving}
                    className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-700"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Discard
                  </button>
                </div>

                {/* Primary Fields Grid */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Vendor / Merchant
                    </label>
                    <input
                      type="text"
                      value={activeDraft.vendor}
                      onChange={(e) =>
                        onUpdateDraft(activeDraft.tempId, { vendor: e.target.value })
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Invoice Date
                    </label>
                    <input
                      type="date"
                      value={activeDraft.date}
                      onChange={(e) =>
                        onUpdateDraft(activeDraft.tempId, { date: e.target.value })
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Tax Deduction Category
                    </label>
                    <select
                      value={activeDraft.category}
                      onChange={(e) =>
                        handleCategoryChange(activeDraft, e.target.value as TaxCategory)
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                    >
                      {TAX_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-slate-500">
                      {IRS_CATEGORY_LINE_MAP[activeDraft.category]}
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Invoice / Receipt #
                    </label>
                    <input
                      type="text"
                      value={activeDraft.invoiceNumber}
                      placeholder="Optional"
                      onChange={(e) =>
                        onUpdateDraft(activeDraft.tempId, {
                          invoiceNumber: e.target.value,
                        })
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Amounts Row */}
                <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Currency
                    </label>
                    <input
                      type="text"
                      maxLength={3}
                      value={activeDraft.currency}
                      onChange={(e) =>
                        onUpdateDraft(activeDraft.tempId, {
                          currency: e.target.value.toUpperCase(),
                        })
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm uppercase text-slate-900 focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Subtotal
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={activeDraft.subtotal}
                      onChange={(e) =>
                        handleAmountChange(activeDraft, 'subtotal', e.target.value)
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Tax / VAT
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={activeDraft.taxAmount}
                      onChange={(e) =>
                        handleAmountChange(activeDraft, 'taxAmount', e.target.value)
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Total Paid
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={activeDraft.totalAmount}
                      onChange={(e) =>
                        handleAmountChange(activeDraft, 'totalAmount', e.target.value)
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm font-semibold text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
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
                      value={activeDraft.deductiblePercentage}
                      onChange={(e) =>
                        handleAmountChange(
                          activeDraft,
                          'deductiblePercentage',
                          e.target.value
                        )
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 tabular-nums focus:border-teal-700 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Payment & Notes */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700">
                      Payment Method
                    </label>
                    <input
                      type="text"
                      value={activeDraft.paymentMethod}
                      onChange={(e) =>
                        onUpdateDraft(activeDraft.tempId, {
                          paymentMethod: e.target.value,
                        })
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-xs font-medium text-slate-700">
                      Business Purpose / Audit Notes
                    </label>
                    <input
                      type="text"
                      value={activeDraft.summary}
                      onChange={(e) =>
                        onUpdateDraft(activeDraft.tempId, { summary: e.target.value })
                      }
                      className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus:border-teal-700 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Line Items Preview if detected */}
                {activeDraft.lineItems.length > 0 && (
                  <div className="border-t border-slate-100 pt-3">
                    <p className="mb-2 text-xs font-medium text-slate-700">
                      Extracted Line Items ({activeDraft.lineItems.length})
                    </p>
                    <div className="max-h-32 overflow-y-auto rounded border border-slate-200">
                      <table className="w-full text-left text-xs">
                        <thead className="border-b border-slate-200 bg-slate-50 text-slate-600">
                          <tr>
                            <th className="px-3 py-1.5 font-medium">Description</th>
                            <th className="px-3 py-1.5 text-right font-medium">Qty</th>
                            <th className="px-3 py-1.5 text-right font-medium">Amount</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {activeDraft.lineItems.map((item, idx) => (
                            <tr key={idx}>
                              <td className="px-3 py-1.5 text-slate-800">
                                {item.description}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-slate-600 tabular-nums">
                                {item.quantity ?? 1}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-slate-900 tabular-nums">
                                {(item.amount ?? 0).toFixed(2)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* Filing Destination Summary */}
                <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-xs">
                  <div className="flex items-start gap-2.5 text-slate-700">
                    <FolderTree className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-700" />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-slate-900">Google Drive Destination: </span>
                      <span className="font-mono text-slate-700">
                        {targetSegments.join(' / ')} / {targetFileName}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2.5 text-slate-700">
                    <Sheet className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-700" />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-slate-900">Sheet Ledger Row: </span>
                      <span className="font-mono text-slate-700">
                        {settings.spreadsheetTitle} · Deductions Ledger
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Action Footer */}
              <div className="flex flex-col justify-between gap-3 border-t border-slate-200 bg-slate-50/70 px-5 py-4 sm:flex-row sm:items-center">
                <div className="text-xs text-slate-600">
                  Deductible Tax Write-Off:{' '}
                  <span className="font-mono text-sm font-semibold text-teal-800 tabular-nums">
                    {activeDraft.currency === 'ZAR' ? 'R' : activeDraft.currency} {activeDraft.deductibleAmount.toFixed(2)}
                  </span>
                  {saveProgress && (
                    <span className="ml-3 text-slate-500">· {saveProgress}</span>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onConfirmAndSave(activeDraft)}
                  disabled={isSaving}
                  className="inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-teal-700 px-5 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-teal-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:opacity-50"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Filing & Exporting...
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4" />
                      {isGoogleConnected
                        ? 'Confirm & File to Drive + Sheets'
                        : 'Confirm & Add to Ledger'}
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center">
          <p className="font-display text-sm font-semibold text-slate-900">
            No pending invoices in review queue
          </p>
          <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-slate-500">
            Upload a receipt image or PDF invoice above. Extracted fields will appear side-by-side with your document so you can verify the tax category, deductible percentage, and Google Drive folder path before saving.
          </p>
        </div>
      )}
    </div>
  );
};
