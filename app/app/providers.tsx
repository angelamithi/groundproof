'use client';

import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { makeDAppKit } from '@/lib/dappkit';
import { I18nProvider } from '@/lib/i18n';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } }));
  // dApp Kit and the Enoki wallet use browser storage, so create them only on the client.
  const [dAppKit, setDAppKit] = useState<ReturnType<typeof makeDAppKit> | null>(null);
  useEffect(() => setDAppKit(makeDAppKit()), []);

  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        {dAppKit ? (
          <DAppKitProvider dAppKit={dAppKit}>{children}</DAppKitProvider>
        ) : (
          <div className="center muted">…</div>
        )}
      </QueryClientProvider>
    </I18nProvider>
  );
}
