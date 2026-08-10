import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import "@fontsource/anton/400.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

import { WalletProvider } from "./wallet/WalletProvider";
import { SessionProvider } from "./app/SessionProvider";
import { ThemeProvider, ToastProvider } from "./components/ui";
import { DemoApprovalSheet } from "./components/wallet-ui";
import { Footer, Header } from "./components/Shell";
import { Landing } from "./routes/Landing";
import { Compose } from "./routes/Compose";
import { ThreadView } from "./routes/Thread";
import { Explore, Inbox, Ledger, Sent } from "./routes/Lists";
import { Profile } from "./routes/Profile";
import { Settings } from "./routes/Settings";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <WalletProvider>
          <SessionProvider>
            <BrowserRouter>
              <Header />
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/explore" element={<Explore />} />
                <Route path="/u/:handle" element={<Profile />} />
                <Route path="/compose" element={<Compose />} />
                <Route path="/inbox" element={<Inbox />} />
                <Route path="/sent" element={<Sent />} />
                <Route path="/t/:id" element={<ThreadView />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/ledger" element={<Ledger />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <Footer />
            </BrowserRouter>
            <DemoApprovalSheet />
          </SessionProvider>
        </WalletProvider>
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
