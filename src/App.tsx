import React, { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  ExternalLink,
  FolderTree,
  LogOut,
  Menu,
  ScanLine,
  Table2,
  X,
} from 'lucide-react';
import {
  DriveTreeNode,
  InvoiceRecord,
  ScannedInvoiceDraft,
  WorkspaceSettings,
} from './types/invoice';
import {
  AuthUserProfile,
  GoogleAuthFlowError,
  clearAccessToken,
  getAccessToken,
  googleSignIn,
  googleSignInDirectGis,
  initAuth,
  logout,
} from './lib/auth';
import {
  WorkspaceApiError,
  appendInvoiceToSheet,
  buildFolderSegments,
  deleteDriveFile,
  deleteInvoiceRowInSheet,
  ensureDriveFolderPath,
  ensureTaxSpreadsheet,
  fetchDriveTree,
  findOrCreateFolder,
  readLedgerFromSheet,
  updateInvoiceRowInSheet,
  uploadInvoiceToDrive,
} from './lib/googleWorkspace';
import { GoogleSignInButton } from './components/GoogleSignInButton';
import { ConfirmModal } from './components/ConfirmModal';
import { ScannerWorkspace } from './components/ScannerWorkspace';
import { LedgerTable } from './components/LedgerTable';
import { DriveFolderBrowser } from './components/DriveFolderBrowser';
import { CategoryAnalytics } from './components/CategoryAnalytics';

type ActiveTab = 'scanner' | 'ledger' | 'drive' | 'analytics';

const SETTINGS_STORAGE_KEY = 'taxvault_workspace_settings_v1';

const DEFAULT_SETTINGS: WorkspaceSettings = {
  rootFolderName: 'TaxVault Invoices',
  spreadsheetTitle: `TaxVault Ledger ${new Date().getFullYear()}`,
  folderScheme: 'year-month-category',
  autoSyncOnConfirm: true,
  defaultCurrency: 'ZAR',
};

function loadSavedSettings(): WorkspaceSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      defaultCurrency: parsed.defaultCurrency === 'USD' ? 'ZAR' : (parsed.defaultCurrency || 'ZAR'),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface PendingConfirmState {
  title: string;
  description: string;
  details: string[];
  confirmLabel: string;
  destructive: boolean;
  onConfirm: () => Promise<void>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('scanner');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Auth & Workspace state
  const [user, setUser] = useState<AuthUserProfile | null>(null);
  const [needsAuth, setNeedsAuth] = useState(true);
  const [isSigningIn, setIsSigningIn] = useState(false);

  // Settings & Data
  const [settings, setSettings] = useState<WorkspaceSettings>(loadSavedSettings);
  const [records, setRecords] = useState<InvoiceRecord[]>([]);
  const [drafts, setDrafts] = useState<ScannedInvoiceDraft[]>([]);
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  const [driveTree, setDriveTree] = useState<DriveTreeNode | null>(null);

  // Operational state
  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState('');
  const [isSyncingSheet, setIsSyncingSheet] = useState(false);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [banner, setBanner] = useState<{
    type: 'info' | 'error' | 'success';
    message: string;
    canRetryDirectGis?: boolean;
  } | null>(null);
  const [confirmState, setConfirmState] = useState<PendingConfirmState | null>(null);
  const [isConfirmBusy, setIsConfirmBusy] = useState(false);

  const updateSettings = useCallback((patch: Partial<WorkspaceSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage quota errors
      }
      return next;
    });
  }, []);

  const handleWorkspaceAuthError = useCallback((err: unknown) => {
    if (err instanceof WorkspaceApiError && err.status === 401) {
      clearAccessToken();
      setNeedsAuth(true);
      setBanner({
        type: 'error',
        message: 'Your Google Workspace session expired. Please sign in with Google again.',
      });
      return true;
    }
    return false;
  }, []);

  const syncFromGoogleWorkspace = useCallback(
    async (tokenOverride?: string, currentSettings?: WorkspaceSettings) => {
      const token = tokenOverride || getAccessToken();
      if (!token) {
        setNeedsAuth(true);
        return;
      }

      const activeSettings = currentSettings || settings;
      setIsSyncingSheet(true);
      setIsLoadingTree(true);

      try {
        const rootFolderId = await findOrCreateFolder(
          token,
          activeSettings.rootFolderName || 'TaxVault Invoices'
        );

        const sheetMeta = await ensureTaxSpreadsheet(token, rootFolderId, activeSettings);
        updateSettings({
          rootFolderId,
          spreadsheetId: sheetMeta.spreadsheetId,
          spreadsheetUrl: sheetMeta.spreadsheetUrl,
          spreadsheetTitle: sheetMeta.spreadsheetTitle,
          sheetTabName: sheetMeta.ledgerTabName,
        });

        const [ledgerData, treeData] = await Promise.all([
          readLedgerFromSheet(token, sheetMeta.spreadsheetId),
          fetchDriveTree(token, activeSettings.rootFolderName),
        ]);

        setRecords((prev) => {
          const unsyncedLocal = prev.filter((r) => !r.sheetRowNumber);
          const mergedIds = new Set(ledgerData.records.map((r) => r.id));
          const remainingLocal = unsyncedLocal.filter((r) => !mergedIds.has(r.id));
          return [...ledgerData.records, ...remainingLocal];
        });
        setDriveTree(treeData);
      } catch (err: unknown) {
        if (!handleWorkspaceAuthError(err)) {
          const msg =
            err instanceof Error
              ? err.message
              : 'Unable to synchronize with Google Drive and Sheets.';
          setBanner({ type: 'error', message: msg });
        }
      } finally {
        setIsSyncingSheet(false);
        setIsLoadingTree(false);
      }
    },
    [handleWorkspaceAuthError, settings, updateSettings]
  );

  useEffect(() => {
    const unsubscribe = initAuth(
      (authedUser, token) => {
        setUser(authedUser);
        setNeedsAuth(false);
        if (token) {
          void syncFromGoogleWorkspace(token);
        }
      },
      (maybeUser) => {
        setUser(maybeUser);
        setNeedsAuth(true);
      }
    );
    return () => unsubscribe();
    // Run auth listener setup once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDirectGisSignIn = async () => {
    setIsSigningIn(true);
    setBanner(null);
    try {
      const result = await googleSignInDirectGis();
      setUser(result.user);
      setNeedsAuth(false);
      setBanner({
        type: 'success',
        message: `Connected to Google Drive & Sheets${result.user.email ? ` as ${result.user.email}` : ''}.`,
      });
      await syncFromGoogleWorkspace(result.accessToken);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Direct Google sign-in was cancelled or failed.';
      setBanner({ type: 'error', message: msg });
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsSigningIn(true);
    setBanner(null);
    try {
      const result = await googleSignIn();
      setUser(result.user);
      setNeedsAuth(false);
      setBanner({
        type: 'success',
        message: `Connected to Google Drive & Sheets as ${result.user.email || 'Google user'}.`,
      });
      await syncFromGoogleWorkspace(result.accessToken);
    } catch (err: unknown) {
      if (
        err instanceof GoogleAuthFlowError &&
        (err.code === 'auth/internal-error' ||
          err.code === 'auth/operation-not-supported-in-this-environment' ||
          err.code === 'auth/unauthorized-domain' ||
          err.code === 'auth/missing-access-token')
      ) {
        try {
          const fallback = await googleSignInDirectGis();
          setUser(fallback.user);
          setNeedsAuth(false);
          setBanner({
            type: 'success',
            message: `Connected to Google Drive & Sheets${fallback.user.email ? ` as ${fallback.user.email}` : ''}.`,
          });
          await syncFromGoogleWorkspace(fallback.accessToken);
          return;
        } catch (gisErr: unknown) {
          const gisMsg =
            gisErr instanceof Error ? gisErr.message : err.message;
          setBanner({
            type: 'error',
            message: gisMsg,
            canRetryDirectGis: true,
          });
          return;
        }
      }

      const msg =
        err instanceof Error ? err.message : 'Google sign-in was cancelled or failed.';
      const canRetryDirectGis =
        err instanceof GoogleAuthFlowError ? err.canRetryWithDirectGis : true;
      setBanner({ type: 'error', message: msg, canRetryDirectGis });
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    setUser(null);
    setNeedsAuth(true);
    setDriveTree(null);
    setBanner({ type: 'info', message: 'Signed out of Google Workspace.' });
  };

  const handleAddDrafts = (newDrafts: ScannedInvoiceDraft[]) => {
    setDrafts((prev) => [...newDrafts, ...prev]);
    if (newDrafts.length > 0) {
      setActiveDraftId(newDrafts[0].tempId);
    }
  };

  const handleUpdateDraft = (id: string, patch: Partial<ScannedInvoiceDraft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.tempId === id ? { ...d, ...patch } : d))
    );
  };

  const handleDiscardDraft = (id: string) => {
    setDrafts((prev) => {
      const next = prev.filter((d) => d.tempId !== id);
      if (activeDraftId === id) {
        setActiveDraftId(next[0]?.tempId || null);
      }
      return next;
    });
  };

  const handleConfirmAndSave = async (draft: ScannedInvoiceDraft) => {
    const token = getAccessToken();
    const recordId = `TV-${Date.now().toString(36).toUpperCase()}`;

    const baseRecord: InvoiceRecord = {
      id: recordId,
      fileName: draft.fileName,
      mimeType: draft.mimeType,
      vendor: draft.vendor.trim() || 'Unknown Vendor',
      invoiceNumber: draft.invoiceNumber.trim(),
      date: draft.date,
      category: draft.category,
      currency: draft.currency || 'ZAR',
      subtotal: Number(draft.subtotal) || 0,
      taxAmount: Number(draft.taxAmount) || 0,
      totalAmount: Number(draft.totalAmount) || 0,
      deductiblePercentage: Number(draft.deductiblePercentage) || 100,
      deductibleAmount: Number(draft.deductibleAmount) || 0,
      paymentMethod: draft.paymentMethod || 'Unspecified',
      summary: draft.summary || '',
      lineItems: draft.lineItems || [],
      createdAt: new Date().toISOString(),
      previewDataUrl: draft.previewUrl,
    };

    if (!token || needsAuth) {
      const segments = buildFolderSegments(
        baseRecord.date,
        baseRecord.category,
        settings.folderScheme,
        settings.rootFolderName
      );
      baseRecord.driveFolderPath = segments.join(' / ');
      setRecords((prev) => [baseRecord, ...prev]);
      handleDiscardDraft(draft.tempId);
      setBanner({
        type: 'info',
        message: `Added ${baseRecord.vendor} to your session ledger. Sign in with Google anytime to file into Drive and export to Google Sheets.`,
      });
      return;
    }

    setIsSaving(true);
    setBanner(null);

    try {
      setSaveProgress('Organizing Drive folders');
      const segments = buildFolderSegments(
        baseRecord.date,
        baseRecord.category,
        settings.folderScheme,
        settings.rootFolderName
      );
      const { rootFolderId, leafFolderId, folderPath } =
        await ensureDriveFolderPath(token, segments);

      setSaveProgress('Uploading invoice file');
      const uploaded = await uploadInvoiceToDrive(token, leafFolderId, draft);

      const syncedRecord: InvoiceRecord = {
        ...baseRecord,
        driveFileId: uploaded.driveFileId,
        driveWebViewLink: uploaded.driveWebViewLink,
        driveFolderId: leafFolderId,
        driveFolderPath: folderPath,
        fileName: uploaded.uploadedFileName,
      };

      setSaveProgress('Appending row to Google Sheets');
      const sheetMeta = await ensureTaxSpreadsheet(token, rootFolderId, settings);
      const appendRes = await appendInvoiceToSheet(
        token,
        sheetMeta.spreadsheetId,
        sheetMeta.ledgerTabName,
        syncedRecord
      );

      syncedRecord.sheetRowNumber = appendRes.rowNumber;
      syncedRecord.syncedAt = new Date().toISOString();

      updateSettings({
        rootFolderId,
        spreadsheetId: sheetMeta.spreadsheetId,
        spreadsheetUrl: sheetMeta.spreadsheetUrl,
        spreadsheetTitle: sheetMeta.spreadsheetTitle,
        sheetTabName: sheetMeta.ledgerTabName,
      });

      setRecords((prev) => [syncedRecord, ...prev]);
      handleDiscardDraft(draft.tempId);

      // Refresh Drive tree quietly
      fetchDriveTree(token, settings.rootFolderName)
        .then((tree) => setDriveTree(tree))
        .catch(() => {});

      setBanner({
        type: 'success',
        message: `Filed "${uploaded.uploadedFileName}" to ${folderPath} and exported row to ${sheetMeta.spreadsheetTitle}.`,
      });
    } catch (err: unknown) {
      if (!handleWorkspaceAuthError(err)) {
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to file invoice to Google Drive and Sheets.';
        setBanner({ type: 'error', message: msg });
      }
    } finally {
      setIsSaving(false);
      setSaveProgress('');
    }
  };

  const handleSyncLocalRecordToWorkspace = async (record: InvoiceRecord) => {
    const token = getAccessToken();
    if (!token) {
      setNeedsAuth(true);
      return;
    }

    try {
      const rootFolderId = await findOrCreateFolder(
        token,
        settings.rootFolderName || 'TaxVault Invoices'
      );
      const sheetMeta = await ensureTaxSpreadsheet(token, rootFolderId, settings);
      const appendRes = await appendInvoiceToSheet(
        token,
        sheetMeta.spreadsheetId,
        sheetMeta.ledgerTabName,
        record
      );

      updateSettings({
        rootFolderId,
        spreadsheetId: sheetMeta.spreadsheetId,
        spreadsheetUrl: sheetMeta.spreadsheetUrl,
        spreadsheetTitle: sheetMeta.spreadsheetTitle,
        sheetTabName: sheetMeta.ledgerTabName,
      });

      setRecords((prev) =>
        prev.map((r) =>
          r.id === record.id
            ? {
                ...r,
                sheetRowNumber: appendRes.rowNumber,
                syncedAt: new Date().toISOString(),
              }
            : r
        )
      );
      setBanner({
        type: 'success',
        message: `Synced ${record.vendor} (${record.date}) to ${sheetMeta.spreadsheetTitle}.`,
      });
    } catch (err: unknown) {
      if (!handleWorkspaceAuthError(err)) {
        setBanner({
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to sync record to Google Sheets.',
        });
      }
    }
  };

  const handleRequestUpdateRecord = (updated: InvoiceRecord) => {
    const token = getAccessToken();
    const isSynced = Boolean(
      token && !needsAuth && settings.spreadsheetId && updated.sheetRowNumber
    );

    if (!isSynced) {
      setRecords((prev) =>
        prev.map((r) => (r.id === updated.id ? updated : r))
      );
      setBanner({
        type: 'success',
        message: `Updated ${updated.vendor} in your local ledger.`,
      });
      return;
    }

    setConfirmState({
      title: `Update row in "${settings.spreadsheetTitle}"?`,
      description:
        'This will overwrite the existing row in your Google Sheets tax ledger with your edited values.',
      details: [
        `Sheet Row: #${updated.sheetRowNumber}`,
        `Vendor: ${updated.vendor} · Date: ${updated.date}`,
        `Category: ${updated.category}`,
        `Deductible: ${updated.currency} ${updated.deductibleAmount.toFixed(2)}`,
      ],
      confirmLabel: 'Update Google Sheet',
      destructive: false,
      onConfirm: async () => {
        const activeToken = getAccessToken();
        if (!activeToken || !settings.spreadsheetId || !updated.sheetRowNumber) return;
        await updateInvoiceRowInSheet(
          activeToken,
          settings.spreadsheetId,
          settings.sheetTabName || 'Deductions Ledger',
          updated.sheetRowNumber,
          updated
        );
        setRecords((prev) =>
          prev.map((r) =>
            r.id === updated.id
              ? { ...updated, syncedAt: new Date().toISOString() }
              : r
          )
        );
        setBanner({
          type: 'success',
          message: `Updated row #${updated.sheetRowNumber} in Google Sheets.`,
        });
      },
    });
  };

  const handleRequestDeleteRecord = (record: InvoiceRecord) => {
    const token = getAccessToken();
    const hasWorkspaceRefs = Boolean(
      token && !needsAuth && (record.driveFileId || (settings.spreadsheetId && record.sheetRowNumber))
    );

    setConfirmState({
      title: hasWorkspaceRefs
        ? `Delete "${record.vendor}" from Google Drive & Sheets?`
        : `Remove "${record.vendor}" from local ledger?`,
      description: hasWorkspaceRefs
        ? 'This will permanently delete the invoice file from Google Drive and remove its row from your Google Sheets ledger. This action cannot be undone.'
        : 'This will remove the record from your current session ledger.',
      details: [
        `Vendor: ${record.vendor} · ${record.date}`,
        `Amount: ${record.currency} ${record.totalAmount.toFixed(2)}`,
        record.driveFolderPath ? `Drive Folder: ${record.driveFolderPath}` : 'Not filed in Drive',
        record.sheetRowNumber ? `Sheet Row: #${record.sheetRowNumber}` : 'Not synced to Sheet',
      ],
      confirmLabel: hasWorkspaceRefs ? 'Delete from Drive & Sheets' : 'Remove Record',
      destructive: true,
      onConfirm: async () => {
        const activeToken = getAccessToken();
        if (activeToken && record.driveFileId) {
          await deleteDriveFile(activeToken, record.driveFileId);
        }
        if (activeToken && settings.spreadsheetId && record.sheetRowNumber) {
          const meta = await readLedgerFromSheet(activeToken, settings.spreadsheetId);
          const matching = meta.records.find((r) => r.id === record.id);
          if (matching?.sheetRowNumber) {
            await deleteInvoiceRowInSheet(
              activeToken,
              settings.spreadsheetId,
              meta.ledgerSheetId,
              matching.sheetRowNumber
            );
          }
        }
        setRecords((prev) => prev.filter((r) => r.id !== record.id));
        if (activeToken) {
          const refreshedTree = await fetchDriveTree(activeToken, settings.rootFolderName).catch(
            () => null
          );
          setDriveTree(refreshedTree);
        }
        setBanner({
          type: 'info',
          message: `Removed ${record.vendor} (${record.date}).`,
        });
      },
    });
  };

  const handleRequestDeleteDriveFile = (fileId: string, fileName: string) => {
    setConfirmState({
      title: 'Delete file from Google Drive?',
      description:
        'Are you sure you want to permanently delete this invoice file from Google Drive? This action cannot be undone.',
      details: [`File: ${fileName}`],
      confirmLabel: 'Delete File',
      destructive: true,
      onConfirm: async () => {
        const token = getAccessToken();
        if (!token) {
          setNeedsAuth(true);
          return;
        }
        await deleteDriveFile(token, fileId);
        const tree = await fetchDriveTree(token, settings.rootFolderName);
        setDriveTree(tree);
        setBanner({
          type: 'info',
          message: `Deleted "${fileName}" from Google Drive.`,
        });
      },
    });
  };

  const executeConfirmModal = async () => {
    if (!confirmState) return;
    setIsConfirmBusy(true);
    try {
      await confirmState.onConfirm();
      setConfirmState(null);
    } catch (err: unknown) {
      if (!handleWorkspaceAuthError(err)) {
        setBanner({
          type: 'error',
          message: err instanceof Error ? err.message : 'Workspace operation failed.',
        });
      }
      setConfirmState(null);
    } finally {
      setIsConfirmBusy(false);
    }
  };

  const navItems: {
    id: ActiveTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }[] = [
    { id: 'scanner', label: 'Scanner & Inbox', icon: ScanLine, count: drafts.length },
    { id: 'ledger', label: 'Deductions Ledger', icon: Table2, count: records.length },
    { id: 'drive', label: 'Drive Folders', icon: FolderTree },
    { id: 'analytics', label: 'Category Breakdown', icon: BarChart3 },
  ];

  const activeTabLabel =
    navItems.find((item) => item.id === activeTab)?.label || 'Scanner & Inbox';

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      {/* Desktop Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col justify-between border-r border-slate-200 bg-white lg:flex">
        <div>
          <div className="flex h-14 items-center border-b border-slate-200 px-5">
            <span className="font-display text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
              TaxVault
            </span>
          </div>

          <nav className="space-y-1 p-3" aria-label="Workspace views">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className="h-4 w-4 shrink-0" />
                    <span>{item.label}</span>
                  </span>
                  {typeof item.count === 'number' && item.count > 0 && (
                    <span
                      className={`font-mono text-[11px] tabular-nums ${
                        isActive ? 'text-slate-300' : 'text-slate-400'
                      }`}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Sidebar Footer: Google Workspace Account */}
        <div className="border-t border-slate-200 p-4">
          {!needsAuth && user ? (
            <div className="space-y-3">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-900">
                  {user.displayName || 'Google Account'}
                </p>
                <p className="truncate text-[11px] text-slate-500">
                  {user.email}
                </p>
              </div>

              {settings.spreadsheetUrl && (
                <a
                  href={settings.spreadsheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-100"
                >
                  <span className="truncate">{settings.spreadsheetTitle}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 text-teal-700" />
                </a>
              )}

              <button
                type="button"
                onClick={handleLogout}
                className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            </div>
          ) : (
            <div className="space-y-2.5">
              <p className="text-[11px] leading-relaxed text-slate-500">
                Connect Google Drive & Sheets to file invoices automatically.
              </p>
              <GoogleSignInButton
                onClick={handleGoogleSignIn}
                disabled={isSigningIn}
                label={isSigningIn ? 'Connecting...' : 'Sign in with Google'}
                className="w-full"
              />
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-40 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-50 flex w-64 flex-col justify-between bg-white shadow-xl">
            <div>
              <div className="flex h-14 items-center justify-between border-b border-slate-200 px-5">
                <span className="font-display text-lg font-bold tracking-tight text-slate-900">
                  TaxVault
                </span>
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  className="rounded p-1 text-slate-500 hover:bg-slate-100"
                  aria-label="Close navigation menu"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <nav className="space-y-1 p-3">
                {navItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(item.id);
                        setMobileMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs font-medium ${
                        isActive
                          ? 'bg-slate-900 text-white'
                          : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <Icon className="h-4 w-4 shrink-0" />
                        <span>{item.label}</span>
                      </span>
                      {typeof item.count === 'number' && item.count > 0 && (
                        <span className="font-mono text-[11px] tabular-nums">
                          {item.count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </nav>
            </div>
            <div className="border-t border-slate-200 p-4">
              {!needsAuth && user ? (
                <div className="space-y-2">
                  <p className="truncate text-xs font-semibold text-slate-900">
                    {user.email}
                  </p>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center justify-center gap-1.5 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Sign out
                  </button>
                </div>
              ) : (
                <GoogleSignInButton
                  onClick={handleGoogleSignIn}
                  disabled={isSigningIn}
                  label={isSigningIn ? 'Connecting...' : 'Sign in with Google'}
                  className="w-full"
                />
              )}
            </div>
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="rounded p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden"
              aria-label="Open navigation menu"
            >
              <Menu className="h-5 w-5" />
            </button>

            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-slate-400">TaxVault</span>
              <span className="text-slate-300" aria-hidden="true">
                /
              </span>
              <h1 className="truncate font-display text-sm font-semibold text-slate-900">
                {activeTabLabel}
              </h1>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {activeTab !== 'scanner' && (
              <button
                type="button"
                onClick={() => setActiveTab('scanner')}
                className="whitespace-nowrap shrink-0 rounded-md bg-teal-700 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-teal-800"
              >
                Scan Invoice
              </button>
            )}
            {needsAuth && (
              <div className="hidden sm:block">
                <GoogleSignInButton
                  onClick={handleGoogleSignIn}
                  disabled={isSigningIn}
                  label={isSigningIn ? 'Connecting...' : 'Sign in with Google'}
                />
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">
          <div className="mx-auto max-w-6xl space-y-5">
            {banner && (
              <div
                role="status"
                className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-xs ${
                  banner.type === 'error'
                    ? 'border-red-200 bg-red-50 text-red-800'
                    : banner.type === 'success'
                      ? 'border-teal-200 bg-teal-50 text-teal-900'
                      : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                <p className="flex-1">{banner.message}</p>
                <div className="flex shrink-0 items-center gap-2">
                  {banner.canRetryDirectGis && (
                    <button
                      type="button"
                      onClick={handleDirectGisSignIn}
                      disabled={isSigningIn}
                      className="whitespace-nowrap rounded border border-red-300 bg-white px-3 py-1 font-medium text-red-800 transition-colors hover:bg-red-100 disabled:opacity-50"
                    >
                      {isSigningIn ? 'Connecting...' : 'Try Direct Google Sign-In'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setBanner(null)}
                    className="shrink-0 rounded p-1 opacity-60 hover:opacity-100"
                    aria-label="Dismiss message"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}

            {activeTab === 'scanner' && (
              <ScannerWorkspace
                isGoogleConnected={!needsAuth && Boolean(getAccessToken())}
                onGoogleSignIn={handleGoogleSignIn}
                isSigningIn={isSigningIn}
                settings={settings}
                drafts={drafts}
                activeDraftId={activeDraftId}
                onSelectDraft={setActiveDraftId}
                onUpdateDraft={handleUpdateDraft}
                onDiscardDraft={handleDiscardDraft}
                onAddDrafts={handleAddDrafts}
                onConfirmAndSave={handleConfirmAndSave}
                isSaving={isSaving}
                saveProgress={saveProgress}
              />
            )}

            {activeTab === 'ledger' && (
              <LedgerTable
                records={records}
                isGoogleConnected={!needsAuth && Boolean(getAccessToken())}
                isSyncingSheet={isSyncingSheet}
                settings={settings}
                onSyncFromSheet={() => syncFromGoogleWorkspace()}
                onSyncLocalRecordToWorkspace={handleSyncLocalRecordToWorkspace}
                onRequestUpdateRecord={handleRequestUpdateRecord}
                onRequestDeleteRecord={handleRequestDeleteRecord}
                onNavigateToScanner={() => setActiveTab('scanner')}
              />
            )}

            {activeTab === 'drive' && (
              <DriveFolderBrowser
                isGoogleConnected={!needsAuth && Boolean(getAccessToken())}
                isSigningIn={isSigningIn}
                onGoogleSignIn={handleGoogleSignIn}
                driveTree={driveTree}
                isLoadingTree={isLoadingTree}
                onRefreshTree={async () => {
                  const token = getAccessToken();
                  if (!token) {
                    setNeedsAuth(true);
                    return;
                  }
                  setIsLoadingTree(true);
                  try {
                    const tree = await fetchDriveTree(token, settings.rootFolderName);
                    setDriveTree(tree);
                  } catch (err) {
                    if (!handleWorkspaceAuthError(err)) {
                      setBanner({
                        type: 'error',
                        message:
                          err instanceof Error ? err.message : 'Unable to refresh Drive tree.',
                      });
                    }
                  } finally {
                    setIsLoadingTree(false);
                  }
                }}
                settings={settings}
                onUpdateSettings={updateSettings}
                localRecords={records}
                onRequestDeleteDriveFile={handleRequestDeleteDriveFile}
              />
            )}

            {activeTab === 'analytics' && <CategoryAnalytics records={records} />}
          </div>
        </main>
      </div>

      <ConfirmModal
        open={Boolean(confirmState)}
        title={confirmState?.title || ''}
        description={confirmState?.description || ''}
        details={confirmState?.details || []}
        confirmLabel={confirmState?.confirmLabel}
        destructive={confirmState?.destructive}
        isBusy={isConfirmBusy}
        onConfirm={executeConfirmModal}
        onCancel={() => {
          if (!isConfirmBusy) setConfirmState(null);
        }}
      />
    </div>
  );
}
