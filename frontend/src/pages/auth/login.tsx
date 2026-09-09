import React, { useState } from 'react';
import { AuthCard } from '../../components/AuthCard';
import { ForgotPasswordModal } from '../../components/ForgotPasswordModal';
import { WorkspaceDashboard } from '../../components/WorkspaceDashboard';
import type { UserProfile, ViewDevice } from '../../types/auth';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2 } from 'lucide-react';

const Auth: React.FC = () => { // 修正点 1：将 ( 改为 {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const viewDevice: ViewDevice = 'auto';
  const [isForgotModalOpen, setIsForgotModalOpen] = useState(false);

  // Toast state
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => {
      setToastMsg((current) => (current === msg ? null : current));
    }, 3200);
  };

  return (
    <div className="min-h-screen bg-[#f6f5f0] text-slate-900 font-sans antialiased flex flex-col justify-between selection:bg-indigo-500 selection:text-white">
      {/* Toast Notification Container */}
      <AnimatePresence>
        {toastMsg && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.9 }}
            className="fixed top-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-2xl bg-slate-900/90 text-white text-xs sm:text-sm font-medium shadow-2xl backdrop-blur-md border border-slate-700/60 flex items-center gap-2 max-w-[90vw]"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{toastMsg}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Container */}
      <div className="w-full flex-1 flex flex-col">
        {/* Top Header Navigation */}
        {/* <Header
          viewDevice={viewDevice}
          onDeviceChange={setViewDevice}
          lang={lang}
          onLangToggle={handleLangToggle}
        /> */}

        {/* Main Content Area */}
        <main className="flex-1 w-full max-w-7xl mx-auto px-3 sm:px-6 py-4 flex items-center justify-center">
          {currentUser ? (
            <WorkspaceDashboard
              user={currentUser}
              onLogout={() => {
                setCurrentUser(null);
                showToast('已安全退出登录');
              }}
              onShowToast={showToast}
            />
          ) : (
            <AuthCard
              onOpenForgotModal={() => setIsForgotModalOpen(true)}
              onShowToast={showToast}
              viewDevice={viewDevice}
            />
          )}
        </main>
      </div>

      {/* Forgot Password Dialog */}
      <ForgotPasswordModal
        isOpen={isForgotModalOpen}
        onClose={() => setIsForgotModalOpen(false)}
        onSuccessToast={showToast}
      />

      {/* Footer */}
      <footer className="w-full py-4 px-4 text-center text-xs text-slate-600 border-t border-slate-200/60 select-none">
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
          <p>© 2026 Wisora AI. 保留所有权利。</p>
          <div className="flex items-center gap-4 text-slate-600">
            <span
              className="hover:text-indigo-600 cursor-pointer"
              onClick={() => showToast('Wisora 多端适配架构：极速协同，移动端优美体验')}
            >
              兼任 Web & H5 移动端
            </span>
            <span>·</span>
            <span
              className="hover:text-indigo-600 cursor-pointer"
              onClick={() => showToast('技术栈：React + TypeScript + TailwindCSS + shadcn/ui')}
            >
              React + TS + Tailwind + shadcn/ui
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}; // 修正点 2：将结尾处的 ); 修正为正常的结束花括号 };

export default Auth;
