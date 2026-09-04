import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import Home from '@/app/page';

it('exposes image generation as a product action', () => {
  render(<Home />);

  expect(screen.getByRole('link', { name: '图片生成' })).toBeInTheDocument();
});
