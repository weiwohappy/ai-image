import { PlaceholderPage } from './PlaceholderPage';

export function RealApiUnavailablePage({ title }: { title: string }) {
  return <PlaceholderPage title={title} description="真实后端当前已接通创作、任务、资产和账户核心链路；该模块的服务端接口尚未开放。" />;
}
