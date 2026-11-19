import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);

const ALLOWED_CATEGORIES = [
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
];

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/scan-invoice', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
      const { fileName, mimeType, base64Data } = req.body as {
        fileName?: string;
        mimeType?: string;
        base64Data?: string;
      };

      if (!base64Data || !mimeType) {
        res.status(400).json({
          error: 'Missing invoice file data or MIME type.',
        });
        return;
      }

      const normalizedMime = mimeType.toLowerCase().trim();
      const supportedMimeTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
        'application/pdf',
      ];

      if (!supportedMimeTypes.includes(normalizedMime)) {
        res.status(400).json({
          error: `Unsupported file type "${mimeType}". Upload a PDF, PNG, JPG, or WebP invoice.`,
        });
        return;
      }

      const ai = getGenAIClient();

      const prompt = `Analyze this invoice or receipt (${fileName || 'uploaded document'}) for business tax deduction bookkeeping.
Extract every field accurately:
1. vendor: Clean merchant or company name.
2. invoiceNumber: Receipt, order, or invoice identifier (empty string if absent).
3. date: Transaction or invoice issue date strictly formatted as YYYY-MM-DD. If only month/day is visible, infer the year or use the current year ${new Date().getFullYear()}.
4. category: Classify into the SINGLE best matching tax category from this exact list: ${ALLOWED_CATEGORIES.join(', ')}.
5. currency: 3-letter ISO 4217 code (e.g., ZAR, USD, EUR, GBP). Default to ZAR if the currency symbol is "R" or "ZAR" or if no currency is specified.
6. subtotal: Numeric subtotal before tax (0 if not broken out).
7. taxAmount: Numeric sales tax / VAT / GST amount (0 if none shown).
8. totalAmount: Final numeric total paid or invoiced.
9. deductiblePercentage: Standard tax deductibility percentage (use 50 for "Meals & Entertainment", 100 for all other business categories unless clearly personal).
10. paymentMethod: Card type/last4, bank transfer, cash, or "Unspecified".
11. summary: Concise 1-sentence business purpose / audit description of items purchased.
12. lineItems: Array of line items found on the invoice.
13. confidence: Number from 0 to 1 reflecting extraction legibility and certainty.`;

      const schemaConfig = {
        type: Type.OBJECT,
        properties: {
          vendor: { type: Type.STRING },
          invoiceNumber: { type: Type.STRING },
          date: { type: Type.STRING },
          category: { type: Type.STRING },
          currency: { type: Type.STRING },
          subtotal: { type: Type.NUMBER },
          taxAmount: { type: Type.NUMBER },
          totalAmount: { type: Type.NUMBER },
          deductiblePercentage: { type: Type.NUMBER },
          paymentMethod: { type: Type.STRING },
          summary: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          lineItems: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                description: { type: Type.STRING },
                quantity: { type: Type.NUMBER },
                unitPrice: { type: Type.NUMBER },
                amount: { type: Type.NUMBER },
              },
            },
          },
        },
        required: [
          'vendor',
          'date',
          'category',
          'currency',
          'totalAmount',
          'deductiblePercentage',
          'summary',
        ],
      };

      const requestContents = [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: normalizedMime === 'image/jpg' ? 'image/jpeg' : normalizedMime,
                data: base64Data,
              },
            },
            { text: prompt },
          ],
        },
      ];

      const modelsToTry = [
        { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW, timeoutMs: 10000 },
        { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 18000 },
      ];

      let responseText: string | undefined;
      let lastError: unknown;

      for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
        const { model, thinkingLevel, timeoutMs } = modelsToTry[attempt];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await ai.models.generateContent({
            model,
            contents: requestContents,
            config: {
              abortSignal: controller.signal,
              systemInstruction:
                'You are a meticulous CPA-grade invoice extraction engine. Return only accurate, verifiable numbers and dates visible on the document.',
              thinkingConfig: { thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: schemaConfig,
            },
          });
          responseText = response.text;
          break;
        } catch (err: unknown) {
          lastError = err;
          const status = (err as { status?: number })?.status;
          const isAbort = (err as { name?: string })?.name === 'AbortError';
          const isTransient = isAbort || status === 503 || status === 429 || status === 500;
          console.warn(
            `Invoice scan attempt ${attempt + 1} (${model}) failed (${isAbort ? 'timeout' : status || 'error'})`
          );
          if (!isTransient || attempt === modelsToTry.length - 1) {
            throw err;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        } finally {
          clearTimeout(timer);
        }
      }

      if (!responseText && lastError) {
        throw lastError;
      }

      let rawText = (responseText ?? '{}').trim();
      if (rawText.startsWith('```')) {
        rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      }
      const parsed = JSON.parse(rawText);

      console.log(`Scanned invoice "${fileName || 'unnamed'}" in ${Date.now() - startedAt}ms`);

      const normalizedCategory = ALLOWED_CATEGORIES.includes(parsed.category)
        ? parsed.category
        : 'Other Deductible';

      const totalAmount = Number(parsed.totalAmount) || 0;
      const subtotal = Number(parsed.subtotal) || Math.max(0, totalAmount - (Number(parsed.taxAmount) || 0));
      const taxAmount = Number(parsed.taxAmount) || 0;
      const deductiblePercentage =
        typeof parsed.deductiblePercentage === 'number'
          ? Math.min(100, Math.max(0, parsed.deductiblePercentage))
          : normalizedCategory === 'Meals & Entertainment'
            ? 50
            : 100;
      const deductibleAmount = Number(((totalAmount * deductiblePercentage) / 100).toFixed(2));

      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      const safeDate =
        typeof parsed.date === 'string' && dateRegex.test(parsed.date)
          ? parsed.date
          : new Date().toISOString().slice(0, 10);

      res.json({
        vendor: parsed.vendor || 'Unknown Vendor',
        invoiceNumber: parsed.invoiceNumber || '',
        date: safeDate,
        category: normalizedCategory,
        currency: (parsed.currency || 'ZAR').toUpperCase().slice(0, 3),
        subtotal: Number(subtotal.toFixed(2)),
        taxAmount: Number(taxAmount.toFixed(2)),
        totalAmount: Number(totalAmount.toFixed(2)),
        deductiblePercentage,
        deductibleAmount,
        paymentMethod: parsed.paymentMethod || 'Unspecified',
        summary: parsed.summary || 'Business expense invoice',
        lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems : [],
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.9,
      });
    } catch (error: unknown) {
      const errObj = error as { status?: number; message?: string };
      console.error('Invoice scan error:', error);
      const status = typeof errObj?.status === 'number' ? errObj.status : 500;
      let message =
        errObj?.message || 'Failed to analyze invoice with Gemini API.';
      try {
        const nested = JSON.parse(message);
        if (nested?.error?.message) {
          message = nested.error.message;
        }
      } catch {
        // Message is already plain text
      }
      res.status(status >= 400 && status < 600 ? status : 500).json({
        error: message,
      });
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      plugins: disableHmr
        ? [
            {
              name: 'disable-hmr-client-ws',
              enforce: 'post',
              transform(code: string, id: string) {
                if (
                  id.includes('vite/dist/client/client.mjs') &&
                  code.includes('transport.connect(createHMRHandler(handleMessage));')
                ) {
                  return {
                    code: code.replace(
                      'transport.connect(createHMRHandler(handleMessage));',
                      '/* HMR WebSocket disabled when DISABLE_HMR=true */'
                    ),
                    map: null,
                  };
                }
              },
            },
          ]
        : [],
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ...(disableHmr ? { hmr: false, ws: false } : { ws: { server: httpServer } }),
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`TaxVault server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
