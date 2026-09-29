// Debounced server-side validation of a reward bundle form
// (POST /api/admin/rewards/validate) — the Codes / Gifts live check.
import { useEffect, useState } from 'react';
import { econ, reasonText } from '../economy/api';
import { bundleDraftEmpty, draftToBundle, type BundleDraft } from './spec-draft';

export type BundleCheck = { state: 'empty' | 'checking' | 'ok' | 'err'; text: string };

// Debounced server-side validation of the current bundle.
export function useBundleCheck(b: BundleDraft, enabled = true): BundleCheck {
  const [res, setRes] = useState<{ key: string; ok: boolean; text: string } | null>(null);
  const empty = bundleDraftEmpty(b);
  const key = JSON.stringify(draftToBundle(b));
  useEffect(() => {
    if (!enabled || empty) return;
    let live = true;
    const t = window.setTimeout(async () => {
      const r = await econ.adminValidateReward(JSON.parse(key));
      if (live) setRes({ key, ok: r.ok, text: r.ok ? '' : reasonText(r, 'admin') });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [key, enabled, empty]);
  if (!enabled || empty) return { state: 'empty', text: '' };
  if (!res || res.key !== key) return { state: 'checking', text: '' };
  return res.ok ? { state: 'ok', text: '' } : { state: 'err', text: res.text };
}

