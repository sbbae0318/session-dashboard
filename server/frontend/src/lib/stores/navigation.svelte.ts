
type ViewType = 'overview' | 'session-detail';

interface NavigationState {
  currentView: ViewType;
  sessionId: string | null;
  previousScrollPosition: number;
}

// Parse URL on load for SSR-safe initialization
function getInitialState(): NavigationState {
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    if (sessionId) {
      return {
        currentView: 'session-detail',
        sessionId,
        previousScrollPosition: 0,
      };
    }
  }
  return {
    currentView: 'overview',
    sessionId: null,
    previousScrollPosition: 0,
  };
}

let state = $state<NavigationState>(getInitialState());

// Browser back button support
if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    popToOverview();
  });
}


export function getCurrentView(): ViewType {
  return state.currentView;
}

export function getDetailSessionId(): string | null {
  return state.sessionId;
}

export function pushSessionDetail(sessionId: string): void {
  // Save scroll position of .main-content
  if (typeof window !== 'undefined') {
    const mainContent = document.querySelector('.main-content');
    state.previousScrollPosition = mainContent ? (mainContent as HTMLElement).scrollTop : 0;
  }

  state.currentView = 'session-detail';
  state.sessionId = sessionId;

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.set('session', sessionId);
    history.pushState(null, '', url.toString());
  }
}

export function popToOverview(): void {
  const savedScroll = state.previousScrollPosition;

  state.currentView = 'overview';
  state.sessionId = null;
  state.previousScrollPosition = 0;

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.delete('session');
    history.pushState(null, '', url.toString());

    // Restore scroll position after DOM update
    requestAnimationFrame(() => {
      const mainContent = document.querySelector('.main-content');
      if (mainContent) {
        (mainContent as HTMLElement).scrollTop = savedScroll;
      }
    });
  }
}

export function isDetailView(): boolean {
  return state.currentView === 'session-detail';
}
