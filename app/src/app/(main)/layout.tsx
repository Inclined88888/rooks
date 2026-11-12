import { SlotRoot } from '@/lib/plugin-host/slot-root';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return <SlotRoot>{children}</SlotRoot>;
}
