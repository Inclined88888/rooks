'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

export class PluginBoundary extends Component<{ pluginId: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[plugin:${this.props.pluginId}] rendu en erreur`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <div role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">Plugin {this.props.pluginId} en erreur</div>;
    }
    return this.props.children;
  }
}
