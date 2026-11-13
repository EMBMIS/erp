import React from 'react';
import { API_BASE_URL } from '../services/api'
import { AlertOctagon, RefreshCw } from 'lucide-react';
import { useI18n } from '../contexts/I18nContext';

export class ErrorBoundaryClass extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary caught exception]:', error, errorInfo);
    try {
      fetch(`${API_BASE_URL}/logs/client-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: error.message,
          stack: error.stack,
          componentStack: errorInfo?.componentStack,
          url: window.location.href,
        }),
      }).catch(() => {});
    } catch {
      // Ignore network reporting failures
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    if (this.props.onReset) {
      this.props.onReset();
    }
  };

  render() {
    // `t` arrives as a prop, not from the hook: this is a class component and
    // hooks cannot run in one. The ErrorBoundary function below is the wrapper
    // that calls useI18n() and passes it down.
    const { t } = this.props;
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback({ error: this.state.error, reset: this.handleReset });
      }

      return (
        <div className="p-6 my-4 mx-auto max-w-2xl bg-red-950/40 border border-red-800/60 rounded-xl text-red-100 shadow-xl backdrop-blur-md">
          <div className="flex items-start space-x-4">
            <div className="p-3 bg-red-900/50 rounded-lg text-red-400">
              <AlertOctagon className="w-8 h-8" />
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-red-200">
                {this.props.title || t('ui.somethingWentWrongOnThisScreen')}
              </h3>
              <p className="mt-1 text-sm text-red-300/80">
                {t('ui.anUnforeseenRenderingErrorOccurred')}
              </p>
              {this.state.error?.message && (
                <div className="mt-3 p-3 bg-black/40 rounded border border-red-900/40 font-mono text-xs text-red-300 overflow-x-auto">
                  {this.state.error.message}
                </div>
              )}
              <div className="mt-4 flex space-x-3">
                <button
                  type="button"
                  onClick={this.handleReset}
                  className="inline-flex items-center px-4 py-2 bg-red-700 hover:bg-red-600 text-white font-medium text-sm rounded-lg transition-colors shadow"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  {t('ui.tryAgain')}
                </button>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="inline-flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-sm rounded-lg transition-colors border border-slate-700"
                >
                  {t('ui.reloadPage')}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export function ErrorBoundary(props) {
  const { t } = useI18n();
  return <ErrorBoundaryClass {...props} t={t} />;
}

export default ErrorBoundary;
