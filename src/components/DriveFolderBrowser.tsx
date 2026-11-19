import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {
  DriveTreeNode,
  FolderOrganizationScheme,
  InvoiceRecord,
  WorkspaceSettings,
} from '../types/invoice';
import { GoogleSignInButton } from './GoogleSignInButton';

interface DriveFolderBrowserProps {
  isGoogleConnected: boolean;
  isSigningIn: boolean;
  onGoogleSignIn: () => void;
  driveTree: DriveTreeNode | null;
  isLoadingTree: boolean;
  onRefreshTree: () => void;
  settings: WorkspaceSettings;
  onUpdateSettings: (patch: Partial<WorkspaceSettings>) => void;
  localRecords: InvoiceRecord[];
  onRequestDeleteDriveFile: (fileId: string, fileName: string) => void;
}

const SCHEME_OPTIONS: {
  id: FolderOrganizationScheme;
  label: string;
  example: string;
}[] = [
  {
    id: 'year-month-category',
    label: 'Year / Month / Category',
    example: 'TaxVault Invoices / 2026 / 2026-11 / Software & SaaS',
  },
  {
    id: 'year-category-month',
    label: 'Year / Category / Month',
    example: 'TaxVault Invoices / 2026 / Software & SaaS / 2026-11',
  },
  {
    id: 'date-category',
    label: 'Year / Exact Date · Category',
    example: 'TaxVault Invoices / 2026 / 2026-11-17 · Software & SaaS',
  },
];

const TreeRow: React.FC<{
  node: DriveTreeNode;
  depth: number;
  onRequestDeleteDriveFile: (fileId: string, fileName: string) => void;
}> = ({ node, depth, onRequestDeleteDriveFile }) => {
  const isFolder = node.mimeType === 'application/vnd.google-apps.folder';
  const [expanded, setExpanded] = useState(depth < 3);

  const childCount = node.children?.length || 0;

  return (
    <div>
      <div
        className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 text-xs transition-colors hover:bg-slate-50"
        style={{ paddingLeft: `${16 + depth * 22}px` }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isFolder ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex min-w-0 items-center gap-2 text-left font-medium text-slate-900"
            >
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              )}
              {expanded ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-teal-700" />
              ) : (
                <Folder className="h-4 w-4 shrink-0 text-teal-700" />
              )}
              <span className="truncate">{node.name}</span>
              <span className="shrink-0 font-mono text-[11px] font-normal text-slate-400 tabular-nums">
                ({childCount})
              </span>
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-2 pl-5">
              <FileText className="h-4 w-4 shrink-0 text-slate-500" />
              <span className="truncate font-mono text-slate-800">{node.name}</span>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {node.modifiedTime && (
            <span className="hidden font-mono text-[11px] text-slate-400 tabular-nums sm:inline">
              {node.modifiedTime.slice(0, 10)}
            </span>
          )}

          {node.webViewLink && (
            <a
              href={node.webViewLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 whitespace-nowrap font-medium text-teal-700 hover:underline"
            >
              Open
              <ExternalLink className="h-3 w-3" />
            </a>
          )}

          {!isFolder && (
            <button
              type="button"
              onClick={() => onRequestDeleteDriveFile(node.id, node.name)}
              className="rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-700"
              aria-label={`Delete ${node.name} from Google Drive`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {isFolder && expanded && node.children && node.children.length > 0 && (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              onRequestDeleteDriveFile={onRequestDeleteDriveFile}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const DriveFolderBrowser: React.FC<DriveFolderBrowserProps> = ({
  isGoogleConnected,
  isSigningIn,
  onGoogleSignIn,
  driveTree,
  isLoadingTree,
  onRefreshTree,
  settings,
  onUpdateSettings,
  localRecords,
  onRequestDeleteDriveFile,
}) => {
  return (
    <div className="space-y-6">
      {/* Folder Organization Rules */}
      <div className="rounded-lg border border-slate-200 bg-white p-5">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-200 pb-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900">
              Google Drive Folder Organization
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Configure how newly scanned invoices are automatically nested by date and tax category in your Drive.
            </p>
          </div>
          {isGoogleConnected && (
            <button
              type="button"
              onClick={onRefreshTree}
              disabled={isLoadingTree}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingTree ? 'animate-spin' : ''}`} />
              {isLoadingTree ? 'Loading Drive...' : 'Refresh Drive Tree'}
            </button>
          )}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-4">
          <div>
            <label className="block text-xs font-medium text-slate-700">
              Root Drive Folder Name
            </label>
            <input
              type="text"
              value={settings.rootFolderName}
              onChange={(e) =>
                onUpdateSettings({ rootFolderName: e.target.value })
              }
              className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
            />
            <label className="mt-3 block text-xs font-medium text-slate-700">
              Master Google Sheet Title
            </label>
            <input
              type="text"
              value={settings.spreadsheetTitle}
              onChange={(e) =>
                onUpdateSettings({ spreadsheetTitle: e.target.value })
              }
              className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-xs text-slate-900 focus:border-teal-700 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-3">
            {SCHEME_OPTIONS.map((opt) => {
              const active = settings.folderScheme === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onUpdateSettings({ folderScheme: opt.id })}
                  className={`flex flex-col justify-between rounded-md border p-3.5 text-left transition-colors ${
                    active
                      ? 'border-teal-700 bg-teal-50/40'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div>
                    <p className="font-display text-xs font-semibold text-slate-900">
                      {opt.label}
                    </p>
                    <p className="mt-1.5 break-all font-mono text-[11px] leading-relaxed text-slate-600">
                      {opt.example.replace('TaxVault Invoices', settings.rootFolderName || 'TaxVault Invoices')}
                    </p>
                  </div>
                  <span
                    className={`mt-3 text-[11px] font-medium ${
                      active ? 'text-teal-800' : 'text-slate-400'
                    }`}
                  >
                    {active ? 'Active scheme' : 'Select scheme'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Live Drive Tree */}
      {!isGoogleConnected ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-slate-200 bg-white px-6 py-12 text-center">
          <Folder className="h-8 w-8 text-slate-400" />
          <h3 className="mt-3 font-display text-sm font-semibold text-slate-900">
            Connect Google Drive to browse live folders
          </h3>
          <p className="mt-1 max-w-md text-xs text-slate-500">
            Once connected, your organized date and category folders and uploaded PDF/image invoices appear here with direct Drive links.
          </p>
          <div className="mt-4">
            <GoogleSignInButton
              onClick={onGoogleSignIn}
              disabled={isSigningIn}
              label={isSigningIn ? 'Connecting...' : 'Sign in with Google'}
            />
          </div>
        </div>
      ) : driveTree ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold text-slate-700">
            <span>Google Drive Hierarchy</span>
            <span className="font-mono font-normal text-slate-500">
              {settings.rootFolderName}
            </span>
          </div>
          <TreeRow
            node={driveTree}
            depth={0}
            onRequestDeleteDriveFile={onRequestDeleteDriveFile}
          />
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white px-6 py-12 text-center">
          <p className="font-display text-sm font-semibold text-slate-900">
            Folder &ldquo;{settings.rootFolderName}&rdquo; has not been created in Google Drive yet
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500">
            File your first scanned invoice to automatically create your date- and category-organized folder tree and master Google Sheet.
            {localRecords.length > 0
              ? ` You currently have ${localRecords.length} local session record(s) ready to sync from the Deductions Ledger.`
              : ''}
          </p>
        </div>
      )}
    </div>
  );
};
