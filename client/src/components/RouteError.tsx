// ═══════════════════════════════════════════════════════════
// Route-scoped error element. Rendered by react-router in the
// <Outlet/> slot when a page throws during render (or a loader/
// action fails), so the AppShell stays mounted and the operator
// can navigate away instead of being forced to reload the app.
// ═══════════════════════════════════════════════════════════

import { isRouteErrorResponse, useNavigate, useRouteError } from 'react-router-dom';
import { Button } from './ui/primitives';
import { ErrorState } from './states/states';

export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();

  let description = 'קרתה שגיאה בלתי צפויה בעמוד זה.';
  if (isRouteErrorResponse(error)) {
    description = `${error.status} ${error.statusText}`;
  } else if (error instanceof Error) {
    description = error.message || description;
  }

  // eslint-disable-next-line no-console
  console.error('[RouteError]', error);

  return (
    <div className="min-h-[50vh] flex items-center justify-center p-6">
      <div className="max-w-lg w-full bg-bg-card border border-border rounded-xl shadow-card">
        <ErrorState title="שגיאה בטעינת העמוד" description={description} />
        <div className="flex justify-center gap-2 pb-6">
          <Button variant="secondary" onClick={() => navigate(-1)}>חזרה</Button>
          <Button onClick={() => window.location.reload()}>רענן</Button>
        </div>
      </div>
    </div>
  );
}
