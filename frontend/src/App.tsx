import { useState } from 'react';
import { DashboardPage } from './pages/DashboardPage';
import { TradesPage } from './pages/TradesPage';
import { SettingsPage } from './pages/SettingsPage';
import { ApiTokenGate } from './components/ApiTokenGate';

type Tab = 'dashboard' | 'trades' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');

  return (
    <ApiTokenGate>
      <div className="min-h-screen">
        <header className="bg-panel border-b border-border sticky top-0 z-30">
          <div className="max-w-[1600px] mx-auto px-6 py-3 flex items-center justify-between">
            <div className="flex items-center gap-8">
              <div className="font-semibold text-base">
                <span className="text-accent">◆</span> SOL Trading Bot
              </div>
              <nav className="flex gap-1">
                <NavBtn active={tab === 'dashboard'} onClick={() => setTab('dashboard')}>Dashboard</NavBtn>
                <NavBtn active={tab === 'trades'} onClick={() => setTab('trades')}>交易记录</NavBtn>
                <NavBtn active={tab === 'settings'} onClick={() => setTab('settings')}>设置</NavBtn>
              </nav>
            </div>
            <div className="text-xs text-muted">
              ⚠️ 实盘交易，操作前请确认
            </div>
          </div>
        </header>

        <main className="max-w-[1600px] mx-auto p-6">
          {tab === 'dashboard' && <DashboardPage />}
          {tab === 'trades' && <TradesPage />}
          {tab === 'settings' && <SettingsPage />}
        </main>
      </div>
    </ApiTokenGate>
  );
}

function NavBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded transition ${active ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text hover:bg-panel2'}`}
    >
      {children}
    </button>
  );
}
