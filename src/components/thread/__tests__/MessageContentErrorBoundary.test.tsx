import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useState, type FC } from 'react';
import { MessageContentErrorBoundary } from '../MessageContentErrorBoundary';

// A child that throws while `boom` is true (simulates tapClientLookup's transient
// out-of-bounds throw during a streaming content update).
const Boomable: FC<{ boom: boolean }> = ({ boom }) => {
  if (boom) throw new Error('tapClientLookup: Index 7 out of bounds (length: 2)');
  return <span>content ok</span>;
};

describe('MessageContentErrorBoundary', () => {
  it('renders children normally when they do not throw', () => {
    const { getByText } = render(
      <MessageContentErrorBoundary resetKey={1}>
        <Boomable boom={false} />
      </MessageContentErrorBoundary>,
    );
    expect(getByText('content ok')).toBeTruthy();
  });

  it('shows a compact fallback (not a crash) when a child throws', () => {
    const { queryByText, getByText } = render(
      <MessageContentErrorBoundary resetKey={1}>
        <Boomable boom={true} />
      </MessageContentErrorBoundary>,
    );
    expect(queryByText('content ok')).toBeNull();
    expect(getByText('rendering…')).toBeTruthy();
  });

  it('auto-recovers when resetKey changes after an error (transient race self-heals)', () => {
    // Harness: a parent that flips both the throw and the resetKey, mimicking the
    // next streaming content update arriving with a consistent part count.
    const Harness: FC = () => {
      const [{ boom, key }, setS] = useState({ boom: true, key: 1 });
      return (
        <>
          <button onClick={() => setS({ boom: false, key: 2 })}>advance</button>
          <MessageContentErrorBoundary resetKey={key}>
            <Boomable boom={boom} />
          </MessageContentErrorBoundary>
        </>
      );
    };
    const { getByText, queryByText } = render(<Harness />);
    // Initially errored → fallback shown.
    expect(getByText('rendering…')).toBeTruthy();
    // Next content update (resetKey changes + child no longer throws) → recovers.
    fireEvent.click(getByText('advance'));
    expect(queryByText('rendering…')).toBeNull();
    expect(getByText('content ok')).toBeTruthy();
  });
});
