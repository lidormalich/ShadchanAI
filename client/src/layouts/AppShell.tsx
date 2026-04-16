import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { SafeModeBanner } from '../features/safe-mode/SafeModeBanner';

export function AppShell() {
  return (
    <div className="min-h-screen flex bg-bg">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <SafeModeBanner />
        <Topbar />
        <main className="flex-1 overflow-y-auto px-8 py-6">
          <div className="mx-auto max-w-screen-2xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
