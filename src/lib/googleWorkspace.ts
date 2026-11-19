import {
  DriveTreeNode,
  FolderOrganizationScheme,
  IRS_CATEGORY_LINE_MAP,
  InvoiceRecord,
  ScannedInvoiceDraft,
  TAX_CATEGORIES,
  TaxCategory,
  WorkspaceSettings,
} from '../types/invoice';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

export class WorkspaceApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'WorkspaceApiError';
    this.status = status;
  }
}

async function googleFetch(url: string, accessToken: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    let errorMessage = `Google Workspace request failed (${response.status})`;
    try {
      const errJson = await response.json();
      if (errJson?.error?.message) {
        errorMessage = errJson.error.message;
      }
    } catch {
      // Ignore parse failure
    }
    throw new WorkspaceApiError(errorMessage, response.status);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function sanitizeFolderSegment(name: string): string {
  return name.replace(/[/\\<>:"|?*]/g, '-').trim() || 'Uncategorized';
}

export function buildFolderSegments(
  date: string,
  category: string,
  scheme: FolderOrganizationScheme,
  rootFolderName: string
): string[] {
  const safeRoot = sanitizeFolderSegment(rootFolderName || 'TaxVault Invoices');
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : new Date().toISOString().slice(0, 10);
  const year = safeDate.slice(0, 4);
  const yearMonth = safeDate.slice(0, 7);
  const safeCat = sanitizeFolderSegment(category);

  switch (scheme) {
    case 'year-category-month':
      return [safeRoot, year, safeCat, yearMonth];
    case 'date-category':
      return [safeRoot, year, `${safeDate} · ${safeCat}`];
    case 'year-month-category':
    default:
      return [safeRoot, year, yearMonth, safeCat];
  }
}

export function buildNormalizedInvoiceFileName(draft: {
  date: string;
  vendor: string;
  currency: string;
  totalAmount: number;
  fileName: string;
}): string {
  const extMatch = draft.fileName.match(/\.([a-zA-Z0-9]+)$/);
  const ext = extMatch ? extMatch[1].toLowerCase() : 'pdf';
  const safeVendor = draft.vendor
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'Vendor';
  const amountStr = draft.totalAmount.toFixed(2);
  return `${draft.date}_${safeVendor}_${draft.currency}_${amountStr}.${ext}`;
}

export async function findOrCreateFolder(
  accessToken: string,
  name: string,
  parentId?: string
): Promise<string> {
  const escapedName = escapeDriveQuery(name);
  const parentClause = parentId ? ` and '${escapeDriveQuery(parentId)}' in parents` : '';
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escapedName}'${parentClause} and trashed = false`;

  const searchUrl = `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,parents)&spaces=drive`;
  const searchData = await googleFetch(searchUrl, accessToken);

  if (Array.isArray(searchData?.files) && searchData.files.length > 0) {
    return searchData.files[0].id as string;
  }

  const metadata: Record<string, unknown> = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (parentId) {
    metadata.parents = [parentId];
  }

  const created = await googleFetch(`${DRIVE_API}/files?fields=id,name`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata),
  });

  return created.id as string;
}

export async function ensureDriveFolderPath(
  accessToken: string,
  segments: string[]
): Promise<{
  rootFolderId: string;
  leafFolderId: string;
  folderPath: string;
}> {
  let parentId: string | undefined;
  let rootFolderId = '';

  for (let i = 0; i < segments.length; i++) {
    const folderId = await findOrCreateFolder(accessToken, segments[i], parentId);
    if (i === 0) {
      rootFolderId = folderId;
    }
    parentId = folderId;
  }

  return {
    rootFolderId,
    leafFolderId: parentId!,
    folderPath: segments.join(' / '),
  };
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function uploadInvoiceToDrive(
  accessToken: string,
  folderId: string,
  draft: ScannedInvoiceDraft
): Promise<{
  driveFileId: string;
  driveWebViewLink: string;
  uploadedFileName: string;
}> {
  const uploadedFileName = buildNormalizedInvoiceFileName(draft);
  const metadata = {
    name: uploadedFileName,
    parents: [folderId],
    description: `TaxVault Invoice | Vendor: ${draft.vendor} | Category: ${draft.category} | Date: ${draft.date} | Total: ${draft.currency} ${draft.totalAmount.toFixed(2)}`,
  };

  const boundary = `taxvault_boundary_${Date.now()}`;
  const encoder = new TextEncoder();

  const part1 = encoder.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
  );
  const part2Header = encoder.encode(
    `--${boundary}\r\nContent-Type: ${draft.mimeType || 'application/octet-stream'}\r\n\r\n`
  );
  const fileBytes = base64ToUint8Array(draft.base64Data);
  const closing = encoder.encode(`\r\n--${boundary}--`);

  const bodyBytes = new Uint8Array(
    part1.length + part2Header.length + fileBytes.length + closing.length
  );
  let offset = 0;
  bodyBytes.set(part1, offset);
  offset += part1.length;
  bodyBytes.set(part2Header, offset);
  offset += part2Header.length;
  bodyBytes.set(fileBytes, offset);
  offset += fileBytes.length;
  bodyBytes.set(closing, offset);

  const uploadUrl = `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,webViewLink,parents`;
  const uploaded = await googleFetch(uploadUrl, accessToken, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: bodyBytes,
  });

  return {
    driveFileId: uploaded.id as string,
    driveWebViewLink:
      (uploaded.webViewLink as string) ||
      `https://drive.google.com/file/d/${uploaded.id}/view`,
    uploadedFileName: (uploaded.name as string) || uploadedFileName,
  };
}

export async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
  await googleFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, accessToken, {
    method: 'DELETE',
  });
}

export const LEDGER_HEADERS = [
  'Record ID',
  'Date',
  'Month',
  'Vendor',
  'Category',
  'IRS Line',
  'Invoice #',
  'Currency',
  'Subtotal',
  'Tax',
  'Total',
  'Deductible %',
  'Deductible Amount',
  'Payment Method',
  'Tax Notes',
  'Drive Folder Path',
  'Drive File Link',
];

function invoiceToSheetRow(record: InvoiceRecord): (string | number)[] {
  return [
    record.id,
    record.date,
    record.date.slice(0, 7),
    record.vendor,
    record.category,
    IRS_CATEGORY_LINE_MAP[record.category] || 'Schedule C · Line 27a',
    record.invoiceNumber || '',
    record.currency,
    record.subtotal,
    record.taxAmount,
    record.totalAmount,
    record.deductiblePercentage,
    record.deductibleAmount,
    record.paymentMethod,
    record.summary,
    record.driveFolderPath || '',
    record.driveWebViewLink || '',
  ];
}

export async function ensureTaxSpreadsheet(
  accessToken: string,
  rootFolderId: string,
  settings: WorkspaceSettings
): Promise<{
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
  ledgerTabName: string;
  ledgerSheetId: number;
}> {
  // 1. Check if configured spreadsheetId still exists and inspect its actual tab names
  if (settings.spreadsheetId) {
    try {
      const meta = await googleFetch(
        `${SHEETS_API}/${encodeURIComponent(settings.spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`,
        accessToken
      );
      const sheets = meta.sheets || [];
      const ledgerSheet =
        sheets.find((s: { properties?: { title?: string } }) => s.properties?.title === 'Deductions Ledger') ||
        sheets[0];

      if (ledgerSheet?.properties) {
        return {
          spreadsheetId: meta.spreadsheetId,
          spreadsheetUrl: meta.spreadsheetUrl,
          spreadsheetTitle: meta.properties?.title || settings.spreadsheetTitle,
          ledgerTabName: ledgerSheet.properties.title,
          ledgerSheetId: ledgerSheet.properties.sheetId,
        };
      }
    } catch (err) {
      if (err instanceof WorkspaceApiError && err.status === 401) {
        throw err;
      }
      // Fall through to search/create if spreadsheet was deleted or inaccessible
    }
  }

  // 2. Search Drive for an existing spreadsheet with this title inside rootFolderId
  const targetTitle = settings.spreadsheetTitle || `TaxVault Ledger ${new Date().getFullYear()}`;
  const searchQ = `mimeType = 'application/vnd.google-apps.spreadsheet' and name = '${escapeDriveQuery(targetTitle)}' and '${escapeDriveQuery(rootFolderId)}' in parents and trashed = false`;
  const existingSearch = await googleFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent(searchQ)}&fields=files(id,name,webViewLink)`,
    accessToken
  );

  if (Array.isArray(existingSearch?.files) && existingSearch.files.length > 0) {
    const existingId = existingSearch.files[0].id as string;
    const meta = await googleFetch(
      `${SHEETS_API}/${encodeURIComponent(existingId)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`,
      accessToken
    );
    const sheets = meta.sheets || [];
    const ledgerSheet =
      sheets.find((s: { properties?: { title?: string } }) => s.properties?.title === 'Deductions Ledger') ||
      sheets[0];
    return {
      spreadsheetId: meta.spreadsheetId,
      spreadsheetUrl: meta.spreadsheetUrl,
      spreadsheetTitle: meta.properties?.title || targetTitle,
      ledgerTabName: ledgerSheet?.properties?.title || 'Deductions Ledger',
      ledgerSheetId: ledgerSheet?.properties?.sheetId ?? 0,
    };
  }

  // 3. Create a brand new Google Spreadsheet with Deductions Ledger & Category Summary tabs
  const created = await googleFetch(SHEETS_API, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title: targetTitle },
      sheets: [
        {
          properties: {
            title: 'Deductions Ledger',
            gridProperties: { frozenRowCount: 1 },
          },
        },
        {
          properties: {
            title: 'Category Summary',
            gridProperties: { frozenRowCount: 1 },
          },
        },
      ],
    }),
  });

  const spreadsheetId = created.spreadsheetId as string;
  const spreadsheetUrl = created.spreadsheetUrl as string;
  const ledgerSheetId = created.sheets[0].properties.sheetId as number;
  const summarySheetId = created.sheets[1].properties.sheetId as number;

  // Move spreadsheet into rootFolderId
  try {
    const fileParents = await googleFetch(
      `${DRIVE_API}/files/${encodeURIComponent(spreadsheetId)}?fields=parents`,
      accessToken
    );
    const previousParents = Array.isArray(fileParents?.parents)
      ? fileParents.parents.join(',')
      : '';
    const moveQuery = previousParents
      ? `addParents=${encodeURIComponent(rootFolderId)}&removeParents=${encodeURIComponent(previousParents)}`
      : `addParents=${encodeURIComponent(rootFolderId)}`;
    await googleFetch(`${DRIVE_API}/files/${encodeURIComponent(spreadsheetId)}?${moveQuery}`, accessToken, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (moveErr) {
    console.warn('Could not move spreadsheet into root folder:', moveErr);
  }

  // Populate headers on Deductions Ledger & formula table on Category Summary
  const summaryRows: (string | number)[][] = [
    ['Tax Category', 'IRS Schedule C Reference', 'Invoice Count', 'Gross Spend', 'Deductible Total'],
    ...TAX_CATEGORIES.map((cat, index) => {
      const r = index + 2;
      return [
        cat,
        IRS_CATEGORY_LINE_MAP[cat],
        `=COUNTIF('Deductions Ledger'!$E$2:$E, A${r})`,
        `=SUMIF('Deductions Ledger'!$E$2:$E, A${r}, 'Deductions Ledger'!$K$2:$K)`,
        `=SUMIF('Deductions Ledger'!$E$2:$E, A${r}, 'Deductions Ledger'!$M$2:$M)`,
      ];
    }),
    [
      'Total',
      '',
      `=SUM(C2:C${TAX_CATEGORIES.length + 1})`,
      `=SUM(D2:D${TAX_CATEGORIES.length + 1})`,
      `=SUM(E2:E${TAX_CATEGORIES.length + 1})`,
    ],
  ];

  await googleFetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `'Deductions Ledger'!A1:Q1`,
          values: [LEDGER_HEADERS],
        },
        {
          range: `'Category Summary'!A1:E${summaryRows.length}`,
          values: summaryRows,
        },
      ],
    }),
  });

  // Apply clean header styling and number formatting
  await googleFetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId: ledgerSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.06, green: 0.09, blue: 0.16 },
                textFormat: {
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                  bold: true,
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        },
        {
          repeatCell: {
            range: { sheetId: summarySheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.06, green: 0.46, blue: 0.43 },
                textFormat: {
                  foregroundColor: { red: 1, green: 1, blue: 1 },
                  bold: true,
                },
              },
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat)',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: ledgerSheetId,
              startRowIndex: 1,
              startColumnIndex: 8,
              endColumnIndex: 13,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '"R "#,##0.00' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: summarySheetId,
              startRowIndex: 1,
              startColumnIndex: 3,
              endColumnIndex: 5,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: 'NUMBER', pattern: '"R "#,##0.00' },
              },
            },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
      ],
    }),
  });

  return {
    spreadsheetId,
    spreadsheetUrl,
    spreadsheetTitle: targetTitle,
    ledgerTabName: 'Deductions Ledger',
    ledgerSheetId,
  };
}

export async function appendInvoiceToSheet(
  accessToken: string,
  spreadsheetId: string,
  ledgerTabName: string,
  record: InvoiceRecord
): Promise<{ updatedRange: string; rowNumber?: number }> {
  const range = `'${ledgerTabName}'!A:Q`;
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const result = await googleFetch(url, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: [invoiceToSheetRow(record)],
    }),
  });

  const updatedRange: string = result?.updates?.updatedRange || '';
  const rowMatch = updatedRange.match(/!A(\d+)/);
  return {
    updatedRange,
    rowNumber: rowMatch ? Number(rowMatch[1]) : undefined,
  };
}

export async function updateInvoiceRowInSheet(
  accessToken: string,
  spreadsheetId: string,
  ledgerTabName: string,
  rowNumber: number,
  record: InvoiceRecord
): Promise<void> {
  const range = `'${ledgerTabName}'!A${rowNumber}:Q${rowNumber}`;
  const url = `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  await googleFetch(url, accessToken, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      values: [invoiceToSheetRow(record)],
    }),
  });
}

export async function deleteInvoiceRowInSheet(
  accessToken: string,
  spreadsheetId: string,
  ledgerSheetId: number,
  rowNumber: number
): Promise<void> {
  await googleFetch(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: ledgerSheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    }),
  });
}

export async function readLedgerFromSheet(
  accessToken: string,
  spreadsheetId: string
): Promise<{
  records: InvoiceRecord[];
  ledgerTabName: string;
  ledgerSheetId: number;
  spreadsheetUrl: string;
  spreadsheetTitle: string;
}> {
  const meta = await googleFetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`,
    accessToken
  );

  const sheets = meta.sheets || [];
  const ledgerSheet =
    sheets.find((s: { properties?: { title?: string } }) => s.properties?.title === 'Deductions Ledger') ||
    sheets[0];

  const ledgerTabName: string = ledgerSheet?.properties?.title || 'Deductions Ledger';
  const ledgerSheetId: number = ledgerSheet?.properties?.sheetId ?? 0;

  const valuesResp = await googleFetch(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(`'${ledgerTabName}'!A2:Q1000`)}`,
    accessToken
  );

  const rows: string[][] = Array.isArray(valuesResp?.values) ? valuesResp.values : [];
  const records: InvoiceRecord[] = rows
    .map((row, idx) => {
      if (!row || row.length === 0 || !row[1]) return null;
      const category = (TAX_CATEGORIES as readonly string[]).includes(row[4])
        ? (row[4] as TaxCategory)
        : 'Other Deductible';
      const totalAmount = Number(String(row[10] || '0').replace(/[^0-9.-]/g, '')) || 0;
      const subtotal = Number(String(row[8] || '0').replace(/[^0-9.-]/g, '')) || 0;
      const taxAmount = Number(String(row[9] || '0').replace(/[^0-9.-]/g, '')) || 0;
      const deductiblePercentage = Number(String(row[11] || '100').replace(/[^0-9.-]/g, '')) || 100;
      const deductibleAmount =
        Number(String(row[12] || '0').replace(/[^0-9.-]/g, '')) ||
        Number(((totalAmount * deductiblePercentage) / 100).toFixed(2));
      const driveWebViewLink = row[16] || '';
      const driveIdMatch = driveWebViewLink.match(/\/d\/([a-zA-Z0-9_-]+)/);

      return {
        id: row[0] || `sheet-row-${idx + 2}`,
        date: row[1],
        vendor: row[3] || 'Unknown Vendor',
        category,
        invoiceNumber: row[6] || '',
        currency: row[7] || 'ZAR',
        subtotal,
        taxAmount,
        totalAmount,
        deductiblePercentage,
        deductibleAmount,
        paymentMethod: row[13] || 'Unspecified',
        summary: row[14] || '',
        driveFolderPath: row[15] || '',
        driveWebViewLink,
        driveFileId: driveIdMatch ? driveIdMatch[1] : undefined,
        fileName: `${row[1]}_${(row[3] || 'invoice').replace(/\s+/g, '_')}`,
        mimeType: 'application/pdf',
        lineItems: [],
        sheetRowNumber: idx + 2,
        syncedAt: new Date().toISOString(),
        createdAt: `${row[1]}T12:00:00.000Z`,
      } as InvoiceRecord;
    })
    .filter((item): item is InvoiceRecord => item !== null);

  return {
    records,
    ledgerTabName,
    ledgerSheetId,
    spreadsheetUrl: meta.spreadsheetUrl,
    spreadsheetTitle: meta.properties?.title || 'TaxVault Ledger',
  };
}

export async function fetchDriveTree(
  accessToken: string,
  rootFolderName: string
): Promise<DriveTreeNode | null> {
  const res = await googleFetch(
    `${DRIVE_API}/files?q=${encodeURIComponent('trashed = false')}&fields=files(id,name,mimeType,parents,webViewLink,modifiedTime,size)&pageSize=500`,
    accessToken
  );

  const files: Array<{
    id: string;
    name: string;
    mimeType: string;
    parents?: string[];
    webViewLink?: string;
    modifiedTime?: string;
    size?: string;
  }> = Array.isArray(res?.files) ? res.files : [];

  const rootFile = files.find(
    (f) =>
      f.mimeType === 'application/vnd.google-apps.folder' &&
      f.name === (rootFolderName || 'TaxVault Invoices')
  );

  if (!rootFile) {
    return null;
  }

  const buildNode = (
    item: (typeof files)[number],
    parentPath: string
  ): DriveTreeNode => {
    const currentPath = parentPath ? `${parentPath} / ${item.name}` : item.name;
    const isFolder = item.mimeType === 'application/vnd.google-apps.folder';
    const children = isFolder
      ? files
          .filter((child) => child.parents?.includes(item.id))
          .sort((a, b) => {
            const aFolder = a.mimeType === 'application/vnd.google-apps.folder';
            const bFolder = b.mimeType === 'application/vnd.google-apps.folder';
            if (aFolder !== bFolder) return aFolder ? -1 : 1;
            return b.name.localeCompare(a.name);
          })
          .map((child) => buildNode(child, currentPath))
      : undefined;

    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      webViewLink: item.webViewLink,
      parents: item.parents,
      modifiedTime: item.modifiedTime,
      size: item.size,
      children,
      path: currentPath,
    };
  };

  return buildNode(rootFile, '');
}
