'use client';

import { jsPDF } from 'jspdf';
import { lineTotal, type InvoiceData, type LineItem } from './types';

/**
 * Renders an invoice as a one-page PDF and triggers download.
 * Layout is hand-laid out so we don't pull in `jspdf-autotable` — saves ~30KB.
 *
 * Coordinates are in mm. Page is US Letter (215.9 × 279.4).
 */

const PAGE_W = 215.9;
const MARGIN_X = 16;
const HEADER_H = 36;
const NAVY: [number, number, number] = [15, 31, 58]; // matches the on-screen preview band
const MUTED: [number, number, number] = [100, 116, 139];
const LINE: [number, number, number] = [203, 213, 225];
const INK: [number, number, number] = [15, 23, 42];

function fmtMoney(n: number) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtDateLong(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function setColor(doc: jsPDF, color: [number, number, number]) {
  doc.setTextColor(color[0], color[1], color[2]);
}

function setFill(doc: jsPDF, color: [number, number, number]) {
  doc.setFillColor(color[0], color[1], color[2]);
}

function setDraw(doc: jsPDF, color: [number, number, number]) {
  doc.setDrawColor(color[0], color[1], color[2]);
}

export interface InvoiceForPdf extends InvoiceData {
  subtotal: number;
  total: number;
}

export function downloadInvoicePdf(data: InvoiceForPdf): void {
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  let y = renderHeader(doc, data);
  y = renderMeta(doc, data, y + 8);
  y = renderBillTo(doc, data, y + 8);
  y = renderTable(doc, data.line_items, y + 6);
  y = renderTotals(doc, data, y + 4);
  y = renderRemitTo(doc, data, y + 12);
  renderFooter(doc, y + 14);

  if (data.status === 'paid' && data.paid_at) {
    drawPaidStamp(doc);
  }

  const filename = `Invoice_${(data.invoice_number ?? 'draft').replace(/[#\s]/g, '')}.pdf`;
  doc.save(filename);
}

function renderHeader(doc: jsPDF, data: InvoiceForPdf): number {
  // Navy banner
  setFill(doc, NAVY);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');

  // Brand
  setColor(doc, [255, 255, 255]);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('DiscHub', MARGIN_X, 16);

  // Address (multiline)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const addressLines = (data.remit_to_address || '').split('\n');
  let lineY = 22;
  for (const ln of addressLines) {
    doc.text(ln, MARGIN_X, lineY);
    lineY += 4;
  }

  // Right side: invoice number
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('INVOICE', PAGE_W - MARGIN_X, 14, { align: 'right' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(data.invoice_number ?? '(draft)', PAGE_W - MARGIN_X, 22, { align: 'right' });

  return HEADER_H;
}

function renderMeta(doc: jsPDF, data: InvoiceForPdf, y: number): number {
  setColor(doc, MUTED);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('INVOICE DATE', MARGIN_X, y);
  doc.text('DUE', PAGE_W / 2, y);

  setColor(doc, INK);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(fmtDateLong(data.invoice_date), MARGIN_X, y + 5);

  const dueLine =
    fmtDateLong(data.due_date) +
    (data.payment_terms ? `   (${data.payment_terms})` : '');
  doc.text(dueLine, PAGE_W / 2, y + 5);
  return y + 8;
}

function renderBillTo(doc: jsPDF, data: InvoiceForPdf, y: number): number {
  setColor(doc, MUTED);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('BILL TO', MARGIN_X, y);

  setColor(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(data.bill_to_name || '—', MARGIN_X, y + 5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  setColor(doc, MUTED);
  let lineY = y + 10;
  for (const ln of (data.bill_to_address || '').split('\n')) {
    doc.text(ln, MARGIN_X, lineY);
    lineY += 4.5;
  }
  return lineY;
}

const COL_DESC_X = MARGIN_X;
const COL_AMOUNT_X = 130;
const COL_DISCOUNT_X = 158;
const COL_TOTAL_X = PAGE_W - MARGIN_X;

function renderTable(doc: jsPDF, items: LineItem[], y: number): number {
  // Header
  setDraw(doc, LINE);
  doc.setLineWidth(0.3);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);

  setColor(doc, MUTED);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('DESCRIPTION', COL_DESC_X, y + 5);
  doc.text('AMOUNT', COL_AMOUNT_X, y + 5, { align: 'right' });
  doc.text('DISCOUNT', COL_DISCOUNT_X, y + 5, { align: 'right' });
  doc.text('LINE TOTAL', COL_TOTAL_X, y + 5, { align: 'right' });

  doc.line(MARGIN_X, y + 7, PAGE_W - MARGIN_X, y + 7);

  let rowY = y + 13;
  setColor(doc, INK);
  doc.setFontSize(10);
  for (const li of items) {
    // Wrap long descriptions to a max width
    const descLines = doc.splitTextToSize(li.description || '—', COL_AMOUNT_X - COL_DESC_X - 5);
    doc.setFont('helvetica', 'normal');
    doc.text(descLines, COL_DESC_X, rowY);

    doc.text(fmtMoney(li.amount), COL_AMOUNT_X, rowY, { align: 'right' });
    doc.text(li.discount_pct ? `${li.discount_pct}%` : '—', COL_DISCOUNT_X, rowY, {
      align: 'right',
    });
    doc.setFont('helvetica', 'bold');
    doc.text(fmtMoney(lineTotal(li)), COL_TOTAL_X, rowY, { align: 'right' });

    const consumed = Math.max(descLines.length * 4.5, 6);
    rowY += consumed;
    setDraw(doc, LINE);
    doc.setLineWidth(0.1);
    doc.line(MARGIN_X, rowY - 2, PAGE_W - MARGIN_X, rowY - 2);
  }

  return rowY;
}

function renderTotals(doc: jsPDF, data: InvoiceForPdf, y: number): number {
  const labelX = PAGE_W - MARGIN_X - 60;
  const valueX = PAGE_W - MARGIN_X;

  setColor(doc, MUTED);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text('Subtotal', labelX, y + 6);
  setColor(doc, INK);
  doc.text(fmtMoney(data.subtotal), valueX, y + 6, { align: 'right' });

  setDraw(doc, LINE);
  doc.setLineWidth(0.3);
  doc.line(labelX, y + 9, valueX, y + 9);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Total', labelX, y + 15);
  doc.text(fmtMoney(data.total), valueX, y + 15, { align: 'right' });
  return y + 18;
}

function renderRemitTo(doc: jsPDF, data: InvoiceForPdf, y: number): number {
  setDraw(doc, LINE);
  doc.setLineWidth(0.3);
  doc.line(MARGIN_X, y, PAGE_W - MARGIN_X, y);

  setColor(doc, MUTED);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('REMIT TO', MARGIN_X, y + 6);

  setColor(doc, INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(data.remit_to_name || '—', MARGIN_X, y + 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  setColor(doc, MUTED);
  let lineY = y + 17;
  for (const ln of (data.remit_to_address || '').split('\n')) {
    doc.text(ln, MARGIN_X, lineY);
    lineY += 4.5;
  }
  return lineY;
}

function renderFooter(doc: jsPDF, y: number): void {
  setColor(doc, MUTED);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(11);
  doc.text('Thank you for your business!', PAGE_W / 2, y, { align: 'center' });
}

function drawPaidStamp(doc: jsPDF): void {
  // Diagonal "PAID" stamp in muted green, lower-right of the page
  doc.saveGraphicsState();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(58);
  doc.setTextColor(16, 185, 129);
  // jsPDF's text rotation: degrees, around the anchor point.
  doc.text('PAID', PAGE_W - 70, 130, { angle: -18 });
  doc.restoreGraphicsState();
}
