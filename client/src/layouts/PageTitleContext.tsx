// ═══════════════════════════════════════════════════════════
// Lets a detail page override the LAST breadcrumb crumb (and the page
// <h1>) with a friendly title instead of the raw id in the URL.
//
//   useSetPageTitle(`${internal} × ${external}`)
//
// The page sets it once its data loads and clears it on unmount.
// ═══════════════════════════════════════════════════════════

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface PageTitleCtx {
  title: string | null;
  setTitle: (t: string | null) => void;
}

const PageTitleContext = createContext<PageTitleCtx>({ title: null, setTitle: () => {} });

export function PageTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);
  return (
    <PageTitleContext.Provider value={{ title, setTitle }}>
      {children}
    </PageTitleContext.Provider>
  );
}

export function usePageTitle(): PageTitleCtx {
  return useContext(PageTitleContext);
}

/**
 * Convenience hook for pages: set the breadcrumb title when `title` is
 * truthy, and clear it on unmount (so the next page falls back to its
 * route-derived crumb).
 */
export function useSetPageTitle(title: string | null | undefined): void {
  const { setTitle } = usePageTitle();
  useEffect(() => {
    if (title) setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);
}
