import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';
import { mutateDb, resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetDb());
afterEach(() => cleanup());
afterAll(() => server.close());

describe('application routes', () => {
  it('opens the image generation workspace from the create hash route', async () => {
    window.location.hash = '#/create';
    render(<App />);

    expect(await screen.findByRole('heading', { name: '图片生成' })).toBeVisible();
    expect(screen.getByRole('link', { name: '爆款复刻' })).toBeVisible();
  });

  it('redirects signed-out users from protected routes to login', async () => {
    mutateDb((draft) => {
      draft.sessionUserId = null;
    });
    window.location.hash = '#/assets';
    render(<App />);

    expect(await screen.findByRole('heading', { name: '登录 VIVIAI' })).toBeVisible();
  });

  it('renders route links without React or Base UI console errors', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.location.hash = '#/create';
    render(<App />);

    await screen.findByRole('heading', { name: '图片生成' });
    const messages = errorSpy.mock.calls.flat().join(' ');
    errorSpy.mockRestore();

    expect(messages).toBe('');
  });

  it('uses one interactive element for each sidebar destination', async () => {
    window.location.hash = '#/create';
    render(<App />);

    const remixLink = await screen.findByRole('link', { name: '爆款复刻' });
    expect(remixLink.querySelector('button')).toBeNull();
  });
});
