'use client';

import { createContext, useContext, useState, useCallback } from 'react';
import type { AssetClass } from '@/lib/demo';

interface ProviderContextValue {
  assetClass: AssetClass;
  setAssetClass: (a: AssetClass) => void;
}

const ProviderContext = createContext<ProviderContextValue>({
  assetClass: 'forex',
  setAssetClass: () => {},
});

const STORAGE_KEY = 'rmp.assetClass';

function readSavedAssetClass(): AssetClass {
  if (typeof window === 'undefined') return 'forex';
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'futures' ? 'futures' : 'forex';
  } catch {
    return 'forex';
  }
}

export function ProviderProvider({ children }: { children: React.ReactNode }) {
  // Read the saved choice synchronously on first render so pages never flash
  // the wrong asset class before correcting (no double-fetch on load).
  const [assetClass, setAssetClassState] = useState<AssetClass>(readSavedAssetClass);

  const setAssetClass = useCallback((a: AssetClass) => {
    setAssetClassState(a);
    try {
      window.localStorage.setItem(STORAGE_KEY, a);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <ProviderContext.Provider value={{ assetClass, setAssetClass }}>{children}</ProviderContext.Provider>
  );
}

export function useProviderContext() {
  return useContext(ProviderContext);
}

/** Convenience: just the current asset class (for hooks/fetchers). */
export function useAssetClass(): AssetClass {
  return useContext(ProviderContext).assetClass;
}
