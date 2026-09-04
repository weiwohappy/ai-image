import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { App } from '@/src/app/App';
import { resetDb } from '@/src/mocks/db';
import { server } from '@/src/mocks/server';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  resetDb();
  window.location.hash = '#/create';
});
afterEach(() => cleanup());
afterAll(() => server.close());

describe('image generation', () => {
  it('estimates credits and creates a queued task', async () => {
    const user = userEvent.setup();
    render(<App />);

    const submit = await screen.findByRole('button', { name: '开始生成' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('描述你想生成的画面'), '透明香氛瓶，暖色电影光');
    expect(screen.getByText('预计消耗 4 积分')).toBeVisible();
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(await screen.findByText('正在排队')).toBeVisible();
  });
});
