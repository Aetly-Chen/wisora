import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, LogOut } from 'lucide-react';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getUserProfile } from '@/request/api';
import { listFriends } from '@/request/chat';
import { listNotes } from '@/request/notes';
import { displayName, useUserStore } from '@/stores/useAppStore';
import { logout } from '@/lib/logout';

/**
 * 个人资料页。
 *
 * 形状参考 Telegram 的「我的资料」：头像居中打头，下面是身份信息，
 * 再下面是账号数据，最后是一个退出入口。
 *
 * 两处刻意的取舍：
 *
 * 1. **不用卡片容器**。这一页的行是齐平的设置项，套一层白卡片
 *    只是多一圈边框，反而把「一页读完」的连贯感切碎了。
 *    分组靠留白与发丝线，与 Telegram 一致。
 * 2. **拿不到值的行直接不渲染**。账号（handle）与简介是可选字段，
 *    显示「未设置」会引出一个这页回答不了的问题（怎么设置）。
 */

/** 注册时间只到日：资料页不需要精确到分秒 */
function formatJoinDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 一行设置项：左侧标签，右侧值 */
const InfoRow: React.FC<{ label: string; value: React.ReactNode }> = ({
  label,
  value,
}) => (
  <div className="flex items-baseline justify-between gap-6 py-3.5">
    <span className="shrink-0 text-[13px] text-slate-500">{label}</span>
    <span className="min-w-0 break-all text-right text-[13.5px] font-medium text-slate-800">
      {value}
    </span>
  </div>
);

const ProfilePage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const setUser = useUserStore((s) => s.setUser);

  const [profile, setProfile] = useState<Awaited<ReturnType<typeof getUserProfile>> | null>(
    null,
  );
  const [loadError, setLoadError] = useState<string | undefined>();
  const [counts, setCounts] = useState<{ friends?: number; notes?: number }>({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void getUserProfile()
      .then((user) => {
        if (cancelled) return;
        setProfile(user);
        // 顺带把 store 刷新一遍：这一页拿到的就是最新资料，
        // 让顶部导航的昵称与这里显示的保持一致
        setUser(user);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message || '加载资料失败');
      });

    /*
     * 数量是锦上添花，两个各自失败都不该影响主信息：
     * 用 allSettled 各自兜底，失败的那个保留 undefined，对应行不渲染。
     */
    void Promise.allSettled([listFriends(), listNotes()]).then(([friends, notes]) => {
      if (cancelled) return;
      setCounts({
        friends: friends.status === 'fulfilled' ? friends.value.length : undefined,
        notes: notes.status === 'fulfilled' ? notes.value.length : undefined,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [setUser]);

  const handleBack = () => {
    // location.key === 'default' 表示这是浏览器里的第一个条目（直接打开链接），
    // 此时没有上一页可回，退到首页而不是卡在原地
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  const handleLogout = () => {
    logout();
    setConfirming(false);
    // replace：退出后不该能用「后退」回到需要登录的页面
    navigate('/auth', { replace: true });
  };

  return (
    <div className="min-h-[100dvh] bg-[#f6f5f0]" data-testid="profile-page">
      <div className="mx-auto w-full max-w-xl px-5 pb-20 pt-2">
        {/* 返回 + 页标题 */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={handleBack}
            aria-label="返回上一页"
            title="返回上一页"
            className="-ml-1.5 rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-900/[0.05] hover:text-slate-800"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-[16px] font-semibold tracking-tight text-slate-900">
            个人资料
          </h1>
        </div>

        {loadError ? (
          <div className="py-24 text-center" data-testid="profile-error">
            <p className="text-[13.5px] text-slate-600">{loadError}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4 rounded-lg border-slate-200 text-[12.5px]"
              onClick={() => window.location.reload()}
            >
              重新加载
            </Button>
          </div>
        ) : !profile ? (
          /* 骨架屏：形状对齐真实内容，比居中转圈更能说明「这里将出现什么」 */
          <div className="pt-6" data-testid="profile-skeleton">
            <div className="flex flex-col items-center gap-3">
              <div className="h-20 w-20 animate-pulse rounded-full bg-slate-900/[0.05]" />
              <div className="h-4 w-24 animate-pulse rounded bg-slate-900/[0.05]" />
              <div className="h-3 w-40 animate-pulse rounded bg-slate-900/[0.04]" />
            </div>
            <div className="mt-8 space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded bg-slate-900/[0.04]" />
              ))}
            </div>
          </div>
        ) : (
          <>
            {/* 身份区 */}
            <div className="flex flex-col items-center pt-4 text-center">
              <Avatar id={profile.id} name={displayName(profile)} size="xl" />
              <h2
                className="mt-4 text-[19px] font-semibold tracking-tight text-slate-900"
                data-testid="profile-name"
              >
                {displayName(profile)}
              </h2>
              <p className="mt-0.5 max-w-full break-all text-[13px] text-slate-500">
                {profile.email}
              </p>
              {/* slate-500 而不是更浅的灰：这行是解释性文案，属于正文，
                  对比度要到 4.5:1；slate-400 在暖白底上只有 2.8:1 */}
              <p className="mt-2 text-[11.5px] text-slate-500">头像由昵称自动生成</p>
            </div>

            {/* 账号信息 */}
            <div className="mt-8 divide-y divide-slate-200/80">
              <InfoRow label="昵称" value={displayName(profile)} />
              {profile.handle ? (
                <InfoRow label="账号" value={`@${profile.handle}`} />
              ) : null}
              {profile.bio ? <InfoRow label="简介" value={profile.bio} /> : null}
              <InfoRow label="注册时间" value={formatJoinDate(profile.createdAt)} />
              {counts.friends !== undefined ? (
                <InfoRow label="好友" value={`${counts.friends} 位`} />
              ) : null}
              {counts.notes !== undefined ? (
                <InfoRow label="笔记" value={`${counts.notes} 篇`} />
              ) : null}
            </div>

            {/* 退出登录 */}
            <button
              type="button"
              onClick={() => setConfirming(true)}
              data-testid="logout-button"
              className="mt-10 flex w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white py-3 text-[13.5px] font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 active:scale-[0.995]"
            >
              <LogOut className="h-4 w-4" />
              退出登录
            </button>
          </>
        )}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="max-w-sm gap-1 p-5">
          <DialogHeader>
            <DialogTitle className="text-[15.5px] font-semibold text-slate-900">
              退出登录？
            </DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed text-slate-500">
              退出后需要重新输入邮箱与密码才能继续使用。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg border-slate-200 text-[12.5px]"
              onClick={() => setConfirming(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="rounded-lg bg-red-600 text-[12.5px] text-white hover:bg-red-700"
              onClick={handleLogout}
              data-testid="logout-confirm"
            >
              退出登录
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ProfilePage;
