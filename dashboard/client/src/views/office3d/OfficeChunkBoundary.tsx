import React from 'react';

/** Catches a failed lazy load of the 3D chunk so the rest of the dashboard stays mounted. */
export class OfficeChunkBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" style={{ padding: 24, color: '#c9d4e3' }}>
        <p style={{ margin: '0 0 12px' }}>3D Office failed to load.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
