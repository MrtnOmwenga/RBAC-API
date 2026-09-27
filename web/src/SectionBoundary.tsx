import { Component, type ReactNode } from 'react';

/** Keeps one section's failure (e.g. a lost connection) from blanking the whole pane. */
export class SectionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <p className="section-error">This section could not be loaded.</p> : this.props.children;
  }
}
