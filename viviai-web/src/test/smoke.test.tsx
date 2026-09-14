import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import Home from '@/app/page';
import { server } from '@/src/mocks/server';

// This test mounts the whole app, so every request it fires has to be answered: an unhandled one
// settles after the environment is torn down and takes the React scheduler with it.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(cleanup);
afterAll(() => server.close());

it('exposes image generation as a product action', async () => {
  render(<Home />);

  expect(await screen.findByRole('link', { name: '图片生成' })).toBeInTheDocument();
});
