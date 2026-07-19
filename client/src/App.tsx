import { createBrowserRouter, Navigate, RouterProvider, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ReactNode } from 'react';
import { AppShell } from './layouts/AppShell';
import { LoginPage } from './features/auth/LoginPage';
import { AuthProvider, useAuth } from './features/auth/AuthContext';
import { ToastRegion } from './components/ui/Toast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RouteError } from './components/RouteError';
import { Spinner } from './components/ui/primitives';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const InternalCandidatesListPage = lazy(() =>
  import('./pages/candidates/InternalCandidatesListPage').then((m) => ({ default: m.InternalCandidatesListPage })),
);
const InternalCandidateDetailPage = lazy(() =>
  import('./pages/candidates/InternalCandidateDetailPage').then((m) => ({ default: m.InternalCandidateDetailPage })),
);
const ExternalCandidatesListPage = lazy(() =>
  import('./pages/candidates/ExternalCandidatesListPage').then((m) => ({ default: m.ExternalCandidatesListPage })),
);
const ExternalCandidateDetailPage = lazy(() =>
  import('./pages/candidates/ExternalCandidateDetailPage').then((m) => ({ default: m.ExternalCandidateDetailPage })),
);
const MatchesPipelinePage = lazy(() =>
  import('./pages/matches/MatchesPipelinePage').then((m) => ({ default: m.MatchesPipelinePage })),
);
const ProposalInboxPage = lazy(() =>
  import('./pages/inbox/ProposalInboxPage').then((m) => ({ default: m.ProposalInboxPage })),
);
const MatchDetailPage = lazy(() =>
  import('./pages/matches/MatchDetailPage').then((m) => ({ default: m.MatchDetailPage })),
);
const SmartMatchesPage = lazy(() =>
  import('./pages/matches/SmartMatchesPage').then((m) => ({ default: m.SmartMatchesPage })),
);
const CandidateCheckPage = lazy(() =>
  import('./pages/matches/CandidateCheckPage').then((m) => ({ default: m.CandidateCheckPage })),
);
const ChatsPage = lazy(() => import('./pages/chats/ChatsPage').then((m) => ({ default: m.ChatsPage })));
const ChannelsPage = lazy(() => import('./pages/channels/ChannelsPage').then((m) => ({ default: m.ChannelsPage })));
const ChannelMappingsPage = lazy(() =>
  import('./pages/channels/ChannelMappingsPage').then((m) => ({ default: m.ChannelMappingsPage })),
);
const PendingChannelsPage = lazy(() =>
  import('./pages/channels/PendingChannelsPage').then((m) => ({ default: m.PendingChannelsPage })),
);
const ReviewQueuePage = lazy(() =>
  import('./pages/review/ReviewQueuePage').then((m) => ({ default: m.ReviewQueuePage })),
);
const FailedCandidatesPage = lazy(() =>
  import('./pages/candidates/FailedCandidatesPage').then((m) => ({ default: m.FailedCandidatesPage })),
);
const TasksPage = lazy(() => import('./pages/tasks/TasksPage').then((m) => ({ default: m.TasksPage })));
const InsightsPage = lazy(() => import('./pages/insights/InsightsPage').then((m) => ({ default: m.InsightsPage })));
const MonitoringPage = lazy(() =>
  import('./pages/monitoring/MonitoringPage').then((m) => ({ default: m.MonitoringPage })),
);
const SettingsPage = lazy(() => import('./pages/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));

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

function lazyPage(element: ReactNode) {
  return (
    <Suspense
      fallback={
        <div className="min-h-[50vh] flex items-center justify-center">
          <Spinner className="h-8 w-8 text-brand" />
        </div>
      }
    >
      {element}
    </Suspense>
  );
}

// Each page route carries its own `errorElement`, so a crash inside a
// page renders the error in the AppShell's <Outlet/> slot (shell stays
// mounted, operator can navigate away) instead of bubbling to the
// top-level <ErrorBoundary> which would blank the whole app.
const appChildren = [
  { index: true, element: lazyPage(<DashboardPage />) },
  { path: 'candidates/internal', element: lazyPage(<InternalCandidatesListPage />) },
  { path: 'candidates/internal/:id', element: lazyPage(<InternalCandidateDetailPage />) },
  { path: 'candidates/external', element: lazyPage(<ExternalCandidatesListPage />) },
  { path: 'candidates/external/:id', element: lazyPage(<ExternalCandidateDetailPage />) },
  { path: 'candidates/failed', element: lazyPage(<FailedCandidatesPage />) },
  { path: 'inbox', element: lazyPage(<ProposalInboxPage />) },
  { path: 'matches', element: lazyPage(<MatchesPipelinePage />) },
  { path: 'matches/:id', element: lazyPage(<MatchDetailPage />) },
  { path: 'smart-matches', element: lazyPage(<SmartMatchesPage />) },
  { path: 'check-candidates', element: lazyPage(<CandidateCheckPage />) },
  { path: 'chats', element: lazyPage(<ChatsPage />) },
  { path: 'channels', element: lazyPage(<ChannelsPage />) },
  { path: 'channels/mappings', element: lazyPage(<ChannelMappingsPage />) },
  { path: 'channels/pending', element: lazyPage(<PendingChannelsPage />) },
  { path: 'review', element: lazyPage(<ReviewQueuePage />) },
  { path: 'tasks', element: lazyPage(<TasksPage />) },
  { path: 'insights', element: lazyPage(<InsightsPage />) },
  { path: 'monitoring', element: lazyPage(<MonitoringPage />) },
  { path: 'settings', element: lazyPage(<SettingsPage />) },
  { path: 'settings/:section', element: lazyPage(<SettingsPage />) },
  { path: '*', element: lazyPage(<NotFoundPage />) },
].map((r) => ({ ...r, errorElement: <RouteError /> }));

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
  {
    path: '/',
    element: <RequireAuth><AppShell /></RequireAuth>,
    errorElement: <RouteError />,
    children: appChildren,
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
