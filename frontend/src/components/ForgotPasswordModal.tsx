import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Mail, Lock, KeyRound, CheckCircle2 } from "lucide-react";
import { sendForgotPasswordCode, forgotPassword } from "../request/api";

interface ForgotPasswordModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccessToast: (msg: string) => void;
}

export const ForgotPasswordModal: React.FC<ForgotPasswordModalProps> = ({
  isOpen,
  onClose,
  onSuccessToast,
}) => {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [isSuccess, setIsSuccess] = useState(false);

  const handleSendCode = async () => {
    if (!email) {
      onSuccessToast("请输入绑定的邮箱");
      return;
    }
    await sendForgotPasswordCode(email);
    setCountdown(60);
    onSuccessToast("验证码已发送至你的账号");
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !code || !newPassword || !confirmPassword) {
      onSuccessToast("请完整填写所有重置信息");
      return;
    }
    // if (code !== "888888" && code !== "123456") {
    //   onSuccessToast("验证码不正确，请输入测试验证码：888888");
    //   return;
    // }
    await forgotPassword({
      email,
      emailCode: code,
      newPassword,
      confirmPassword,
    });
    setIsSuccess(true);
    setTimeout(() => {
      onSuccessToast("密码重置成功！请使用新密码登录");
      setIsSuccess(false);
      onClose();
    }, 1500);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px] rounded-2xl bg-white p-6 shadow-2xl border border-slate-200">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold text-slate-900">
            找回密码
          </DialogTitle>
          <DialogDescription className="text-xs text-slate-500">
            通过绑定的邮箱获取验证码重置密码
          </DialogDescription>
        </DialogHeader>

        {isSuccess ? (
          <div className="py-8 flex flex-col items-center justify-center text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <h4 className="text-lg font-bold text-slate-900">重置成功</h4>
            <p className="text-xs text-slate-500">
              新密码已生效，正在返回登录界面...
            </p>
          </div>
        ) : (
          <form onSubmit={handleResetPassword} className="space-y-4 pt-2">
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-slate-700">
                邮箱
              </Label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                <Input
                  type="text"
                  placeholder="请输入邮箱"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-slate-700">
                验证码
              </Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                  <Input
                    type="text"
                    placeholder="6位验证码"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="pl-10"
                    maxLength={6}
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSendCode}
                  disabled={countdown > 0}
                  className="whitespace-nowrap px-3 text-xs border-indigo-200 text-indigo-600 hover:bg-indigo-50"
                >
                  {countdown > 0 ? `${countdown}s 后重新发送` : "获取验证码"}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-slate-700">
                设置新密码
              </Label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                <Input
                  type="password"
                  placeholder="6位以上字母数字"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-semibold text-slate-700">
                确认新密码
              </Label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                <Input
                  type="password"
                  placeholder="6位以上字母数字"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="pt-2 flex justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={onClose}
                className="rounded-xl"
              >
                取消
              </Button>
              <Button type="submit" variant="brand" className="rounded-xl">
                确认重置
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
};
