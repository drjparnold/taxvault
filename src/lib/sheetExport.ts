import * as XLSX from 'xlsx';
import {
  IRS_CATEGORY_LINE_MAP,
  InvoiceRecord,
  TAX_CATEGORIES,
} from '../types/invoice';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeDelimitedCell(value: string | number, delimiter: string): string {
  const str = String(value ?? '');
  if (str.includes(delimiter) || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function exportToDelimited(
  records: InvoiceRecord[],
  format: 'csv' | 'tsv',
  baseName = 'taxvault-deductions'
) {
  const delimiter = format === 'csv' ? ',' : '\t';
  const headers = [
    'Date',
    'Month',
    'Vendor',
    'Category',
    'IRS Schedule C Line',
    'Invoice Number',
    'Currency',
    'Subtotal',
    'Tax',
    'Total Amount',
    'Deductible %',
    'Deductible Amount',
    'Payment Method',
    'Tax Notes',
    'Drive Folder Path',
    'Drive File URL',
  ];

  const rows = records.map((r) => [
    r.date,
    r.date.slice(0, 7),
    r.vendor,
    r.category,
    IRS_CATEGORY_LINE_MAP[r.category] || '',
    r.invoiceNumber || '',
    r.currency,
    r.subtotal.toFixed(2),
    r.taxAmount.toFixed(2),
    r.totalAmount.toFixed(2),
    String(r.deductiblePercentage),
    r.deductibleAmount.toFixed(2),
    r.paymentMethod,
    r.summary,
    r.driveFolderPath || '',
    r.driveWebViewLink || '',
  ]);

  const lines = [headers, ...rows].map((row) =>
    row.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter)
  );

  const mimeType =
    format === 'csv'
      ? 'text/csv;charset=utf-8;'
      : 'text/tab-separated-values;charset=utf-8;';
  const blob = new Blob([lines.join('\r\n')], { type: mimeType });
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, `${baseName}-${stamp}.${format}`);
}

export function exportToXlsx(
  records: InvoiceRecord[],
  baseName = 'taxvault-deductions'
) {
  const workbook = XLSX.utils.book_new();

  // Sheet 1: Deductions Ledger
  const ledgerRows = records.map((r) => ({
    Date: r.date,
    Month: r.date.slice(0, 7),
    Vendor: r.vendor,
    Category: r.category,
    'IRS Reference': IRS_CATEGORY_LINE_MAP[r.category] || '',
    'Invoice #': r.invoiceNumber || '',
    Currency: r.currency,
    Subtotal: r.subtotal,
    Tax: r.taxAmount,
    'Total Amount': r.totalAmount,
    'Deductible %': r.deductiblePercentage,
    'Deductible Amount': r.deductibleAmount,
    'Payment Method': r.paymentMethod,
    'Tax Notes': r.summary,
    'Drive Folder Path': r.driveFolderPath || '',
    'Drive Link': r.driveWebViewLink || '',
  }));

  const ledgerSheet = XLSX.utils.json_to_sheet(
    ledgerRows.length > 0
      ? ledgerRows
      : [
          {
            Date: '',
            Month: '',
            Vendor: '',
            Category: '',
            'IRS Reference': '',
            'Invoice #': '',
            Currency: 'ZAR',
            Subtotal: 0,
            Tax: 0,
            'Total Amount': 0,
            'Deductible %': 100,
            'Deductible Amount': 0,
            'Payment Method': '',
            'Tax Notes': '',
            'Drive Folder Path': '',
            'Drive Link': '',
          },
        ]
  );
  ledgerSheet['!cols'] = [
    { wch: 12 },
    { wch: 10 },
    { wch: 24 },
    { wch: 22 },
    { wch: 28 },
    { wch: 14 },
    { wch: 10 },
    { wch: 12 },
    { wch: 10 },
    { wch: 13 },
    { wch: 13 },
    { wch: 16 },
    { wch: 16 },
    { wch: 36 },
    { wch: 36 },
    { wch: 42 },
  ];
  XLSX.utils.book_append_sheet(workbook, ledgerSheet, 'Deductions Ledger');

  // Sheet 2: Category Summary
  const categoryRows = TAX_CATEGORIES.map((category) => {
    const matching = records.filter((r) => r.category === category);
    const grossTotal = matching.reduce((sum, r) => sum + r.totalAmount, 0);
    const deductibleTotal = matching.reduce((sum, r) => sum + r.deductibleAmount, 0);
    return {
      Category: category,
      'IRS Schedule C Line': IRS_CATEGORY_LINE_MAP[category],
      'Invoice Count': matching.length,
      'Gross Spend': Number(grossTotal.toFixed(2)),
      'Deductible Total': Number(deductibleTotal.toFixed(2)),
    };
  });
  const summarySheet = XLSX.utils.json_to_sheet(categoryRows);
  summarySheet['!cols'] = [
    { wch: 24 },
    { wch: 32 },
    { wch: 14 },
    { wch: 14 },
    { wch: 16 },
  ];
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Category Summary');

  // Sheet 3: Monthly Summary
  const monthsMap = new Map<
    string,
    { count: number; gross: number; tax: number; deductible: number }
  >();
  for (const r of records) {
    const month = r.date.slice(0, 7);
    const prev = monthsMap.get(month) || { count: 0, gross: 0, tax: 0, deductible: 0 };
    monthsMap.set(month, {
      count: prev.count + 1,
      gross: prev.gross + r.totalAmount,
      tax: prev.tax + r.taxAmount,
      deductible: prev.deductible + r.deductibleAmount,
    });
  }
  const monthlyRows = Array.from(monthsMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, stats]) => ({
      Month: month,
      'Invoice Count': stats.count,
      'Gross Spend': Number(stats.gross.toFixed(2)),
      'Tax Paid': Number(stats.tax.toFixed(2)),
      'Deductible Amount': Number(stats.deductible.toFixed(2)),
    }));
  const monthlySheet = XLSX.utils.json_to_sheet(
    monthlyRows.length > 0
      ? monthlyRows
      : [{ Month: new Date().toISOString().slice(0, 7), 'Invoice Count': 0, 'Gross Spend': 0, 'Tax Paid': 0, 'Deductible Amount': 0 }]
  );
  monthlySheet['!cols'] = [
    { wch: 12 },
    { wch: 14 },
    { wch: 14 },
    { wch: 12 },
    { wch: 18 },
  ];
  XLSX.utils.book_append_sheet(workbook, monthlySheet, 'Monthly Summary');

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(workbook, `${baseName}-${stamp}.xlsx`);
}
