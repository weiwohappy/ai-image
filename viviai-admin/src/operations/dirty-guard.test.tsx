import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { useDirtyGuard, useDirtyRegistration } from './dirty-guard';

function Registration({ discard }: { discard: () => void }) {
  useDirtyRegistration({ dirty: true, pending: false, discard });
  return null;
}

function GuardButton() {
  const guard = useDirtyGuard();
  return <button onClick={guard.discard}>discard</button>;
}

it('invokes the current discard callback when a blocker is replaced without changing its count', () => {
  const oldDiscard = vi.fn();
  const currentDiscard = vi.fn();

  function Harness() {
    const [replacement, setReplacement] = useState(false);
    return (
      <>
        <Registration discard={replacement ? currentDiscard : oldDiscard} />
        <button onClick={() => setReplacement(true)}>replace callback</button>
        <GuardButton />
      </>
    );
  }

  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'replace callback' }));
  fireEvent.click(screen.getByRole('button', { name: 'discard' }));
  expect(currentDiscard).toHaveBeenCalledTimes(1);
  expect(oldDiscard).not.toHaveBeenCalled();
});
