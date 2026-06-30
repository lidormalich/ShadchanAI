import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { PageTitleProvider } from './PageTitleContext';
import { SafeModeBanner } from '../features/safe-mode/SafeModeBanner';

export function AppShell() {
  // Mobile nav drawer state. On lg+ the sidebar is always visible and this
  // is irrelevant; below lg the sidebar slides in over an overlay.
  const [navOpen, setNavOpen] = useState(false);

  return (
    <PageTitleProvider>
      <div className="min-h-screen flex bg-bg">
        <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
        <div className="flex-1 min-w-0 flex flex-col">
          <SafeModeBanner />
          <Topbar onOpenNav={() => setNavOpen(true)} />
          <main className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
            <div className="mx-auto max-w-screen-2xl">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </PageTitleProvider>
  );
}
