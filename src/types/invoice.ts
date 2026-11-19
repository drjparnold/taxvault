export const TAX_CATEGORIES = [
  'Software & SaaS',
  'Travel & Lodging',
  'Meals & Entertainment',
  'Office Supplies',
  'Equipment & Hardware',
  'Marketing & Advertising',
  'Professional Services',
  'Utilities & Telecom',
  'Education & Training',
  'Rent & Coworking',
  'Shipping & Postage',
  'Other Deductible',
] as const;

export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export const DEFAULT_DEDUCTIBLE_RATES: Record<TaxCategory, number> = {
  'Software & SaaS': 100,
  'Travel & Lodging': 100,
  'Meals & Entertainment': 50,
  'Office Supplies': 100,
  'Equipment & Hardware': 100,
  'Marketing & Advertising': 100,
  'Professional Services': 100,
  'Utilities & Telecom': 100,
  'Education & Training': 100,
  'Rent & Coworking': 100,
  'Shipping & Postage': 100,
  'Other Deductible': 100,
};

export const IRS_CATEGORY_LINE_MAP: Record<TaxCategory, string> = {
  'Software & SaaS': 'Schedule C · Line 18 (Office / Software)',
  'Travel & Lodging': 'Schedule C · Line 24a (Travel)',
  'Meals & Entertainment': 'Schedule C · Line 24b (Meals — 50%)',
  'Office Supplies': 'Schedule C · Line 22 (Supplies)',
  'Equipment & Hardware': 'Schedule C · Line 13 / Sec. 179',
  'Marketing & Advertising': 'Schedule C · Line 8 (Advertising)',
  'Professional Services': 'Schedule C · Line 17 (Legal & Prof.)',
  'Utilities & Telecom': 'Schedule C · Line 25 (Utilities)',
  'Education & Training': 'Schedule C · Line 27a (Other Expenses)',
  'Rent & Coworking': 'Schedule C · Line 20b (Rent/Lease)',
  'Shipping & Postage': 'Schedule C · Line 27a (Postage)',
  'Other Deductible': 'Schedule C · Line 27a (Other Expenses)',
};

export type FolderOrganizationScheme =
  | 'year-month-category'
  | 'year-category-month'
  | 'date-category';

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface ScannedInvoiceDraft {
  tempId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  previewUrl: string;
  base64Data: string;
  vendor: string;
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  category: TaxCategory;
  currency: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  deductiblePercentage: number;
  deductibleAmount: number;
  paymentMethod: string;
  summary: string;
  lineItems: InvoiceLineItem[];
  confidence: number;
}

export interface InvoiceRecord {
  id: string;
  fileName: string;
  mimeType: string;
  vendor: string;
  invoiceNumber: string;
  date: string; // YYYY-MM-DD
  category: TaxCategory;
  currency: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  deductiblePercentage: number;
  deductibleAmount: number;
  paymentMethod: string;
  summary: string;
  lineItems: InvoiceLineItem[];
  driveFileId?: string;
  driveWebViewLink?: string;
  driveFolderId?: string;
  driveFolderPath?: string;
  sheetRowNumber?: number;
  syncedAt?: string;
  createdAt: string;
  previewDataUrl?: string;
}

export interface WorkspaceSettings {
  rootFolderName: string;
  rootFolderId?: string;
  spreadsheetId?: string;
  spreadsheetTitle: string;
  spreadsheetUrl?: string;
  sheetTabName?: string;
  folderScheme: FolderOrganizationScheme;
  autoSyncOnConfirm: boolean;
  defaultCurrency: string;
}

export interface DriveTreeNode {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  children?: DriveTreeNode[];
  path: string;
}
