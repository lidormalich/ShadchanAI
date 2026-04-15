import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppShell } from './layouts/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { InternalCandidatesListPage } from './pages/candidates/InternalCandidatesListPage';
import { InternalCandidateDetailPage } from './pages/candidates/InternalCandidateDetailPage';
import { ExternalCandidatesListPage } from './pages/candidates/ExternalCandidatesListPage';
import { MatchesPipelinePage } from './pages/matches/MatchesPipelinePage';
import { MatchDetailPage } from './pages/matches/MatchDetailPage';
import { ChatsPage } from './pages/chats/ChatsPage';
import { ChannelsPage } from './pages/channels/ChannelsPage';
import { ReviewQueuePage } from './pages/review/ReviewQueuePage';
import { TasksPage } from './pages/tasks/TasksPage';
import { InsightsPage } from './pages/insights/InsightsPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { LoginPage } from './features/auth/LoginPage';
import { AuthProvider, useAuth } from './features/auth/AuthContext';
import { ToastRegion } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Spinner } from './components/ui/primitives';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
});

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner className="h-8 w-8 text-brand" />
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <RequireAuth><AppShell /></RequireAuth>,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'candidates/internal', element: <InternalCandidatesListPage /> },
      { path: 'candidates/internal/:id', element: <InternalCandidateDetailPage /> },
      { path: 'candidates/external', element: <ExternalCandidatesListPage /> },
      { path: 'matches', element: <MatchesPipelinePage /> },
      { path: 'matches/:id', element: <MatchDetailPage /> },
      { path: 'chats', element: <ChatsPage /> },
      { path: 'channels', element: <ChannelsPage /> },
      { path: 'review', element: <ReviewQueuePage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'insights', element: <InsightsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/:section', element: <SettingsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
          <ToastRegion />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
