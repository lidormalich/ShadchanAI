import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/primitives';
import { ErrorState } from './states/states';

interface State { error?: Error }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-bg flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-bg-card border border-border rounded-xl shadow-card">
            <ErrorState
              title="שגיאה לא צפויה"
              description={this.state.error.message || 'קרתה שגיאה בלתי צפויה. ניתן לרענן את הדף.'}
            />
            <div className="flex justify-center pb-6">
              <Button onClick={() => window.location.reload()}>רענן</Button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
