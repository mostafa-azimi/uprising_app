'use client';

import { useState } from 'react';

export function CopyButton({
  value,
  size = 'sm',
  label,
}: {
  value: string;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // older browsers / blocked clipboard — fallback: select-and-prompt
      window.prompt('Copy this value', value);
    }
  }

  const cls =
    size === 'md'
      ? 'text-sm px-2 py-1'
      : 'text-xs px-1.5 py-0.5';

  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
      className={`inline-flex items-center gap-1 ml-1 rounded border border-line bg-white hover:bg-slate-50 ${cls} ${copied ? 'border-emerald-300 text-emerald-700' : 'text-muted'}`}
    >
      {copied ? '✓' : '⧉'}
      {label ? <span>{label}</span> : null}
    </button>
  );
}
