
type ViewType =
  | 'overview'
  | 'session-detail'
  | 'sessions'
  | 'session-prompts'
  | 'token-cost'
  | 'code-impact'
  | 'timeline'
  | 'projects'
  | 'context-recovery'
  | 'summaries'
  | 'memos';

const VALID_VIEWS: ViewType[] = [
  'overview',
  'session-detail',
  'sessions',
  'session-prompts',
  'token-cost',
  'code-impact',
  'timeline',
  'projects',
  'context-recovery',
  'summaries',
  'memos',
];

const ENRICHMENT_VIEWS: ViewType[] = [
  'token-cost',
  'code-impact',
  'timeline',
  'projects',
  'context-recovery',
  'summaries',
];

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
    const view = params.get('view') as ViewType | null;

    if (view === 'session-prompts' && sessionId) {
      return {
        currentView: 'session-prompts',
        sessionId,
        previousScrollPosition: 0,
      };
    }

    if (sessionId) {
      return {
        currentView: 'session-detail',
        sessionId,
        previousScrollPosition: 0,
      };
    }

    if (view && VALID_VIEWS.includes(view)) {
      return {
        currentView: view,
        sessionId: null,
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
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    const view = params.get('view') as ViewType | null;

    if (view === 'session-prompts' && sessionId) {
      state.currentView = 'session-prompts';
      state.sessionId = sessionId;
    } else if (sessionId) {
      state.currentView = 'session-detail';
      state.sessionId = sessionId;
    } else if (view && VALID_VIEWS.includes(view)) {
      state.currentView = view;
      state.sessionId = null;
    } else {
      popToOverview();
    }
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
    url.searchParams.delete('view');
    history.pushState(null, '', url.toString());
  }
}

export function pushView(view: ViewType, params?: Record<string, string>): void {
  state.currentView = view;
  state.sessionId = null;

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.delete('session');

    if (view === 'overview') {
      url.searchParams.delete('view');
    } else {
      url.searchParams.set('view', view);
    }

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

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
    url.searchParams.delete('view');
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

export function pushSessionPrompts(sessionId: string): void {
  state.currentView = 'session-prompts';
  state.sessionId = sessionId;

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'session-prompts');
    url.searchParams.set('session', sessionId);
    history.pushState(null, '', url.toString());
  }
}

export function popToSessions(): void {
  state.currentView = 'sessions';
  state.sessionId = null;

  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    url.searchParams.set('view', 'sessions');
    url.searchParams.delete('session');
    history.pushState(null, '', url.toString());
  }
}

export function isSessionPromptsView(): boolean {
  return state.currentView === 'session-prompts';
}

export function isDetailView(): boolean {
  return state.currentView === 'session-detail';
}

export function isEnrichmentPage(): boolean {
  return ENRICHMENT_VIEWS.includes(state.currentView);
}
