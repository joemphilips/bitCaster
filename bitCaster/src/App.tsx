import { BrowserRouter, Routes, Route, NavLink } from "react-router";

function MarketsPage() {
  return (
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-bitcoin mb-4">Markets</h1>
      <p className="text-gray-400">
        Active prediction markets will appear here. Connect your Nostr identity
        to participate.
      </p>
    </main>
  );
}

function WalletPage() {
  return (
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-bitcoin mb-4">Wallet</h1>
      <p className="text-gray-400">
        Your Cashu ecash balance will appear here. Use NWC or scan a token to
        top up.
      </p>
    </main>
  );
}

function SettingsPage() {
  return (
    <main className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-bitcoin mb-4">Settings</h1>
      <p className="text-gray-400">
        Configure your Nostr identity, mint URL, and NWC connection.
      </p>
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
        <header className="border-b border-gray-800 px-6 py-3 flex items-center gap-4">
          <span className="font-bold text-lg tracking-tight">
            <span className="text-bitcoin">bit</span>Caster
          </span>
          <nav className="flex gap-4 text-sm ml-auto">
            <NavLink
              to="/"
              className={({ isActive }) =>
                isActive ? "text-bitcoin font-medium" : "text-gray-400 hover:text-gray-100"
              }
            >
              Markets
            </NavLink>
            <NavLink
              to="/wallet"
              className={({ isActive }) =>
                isActive ? "text-bitcoin font-medium" : "text-gray-400 hover:text-gray-100"
              }
            >
              Wallet
            </NavLink>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                isActive ? "text-bitcoin font-medium" : "text-gray-400 hover:text-gray-100"
              }
            >
              Settings
            </NavLink>
          </nav>
        </header>

        <Routes>
          <Route path="/" element={<MarketsPage />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
