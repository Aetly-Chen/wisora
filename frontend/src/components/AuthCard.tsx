import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { IllustrationGraphic } from "./IllustrationGraphic";
import type { ViewDevice } from "../types/auth";
import {
  Sparkles,
  Eye,
  EyeOff,
  Mail,
  Lock,
  Smartphone,
  KeyRound,
  ArrowRight,
} from "lucide-react";
import {
  register,
  sendRegisterCode,
  sendLoginCode,
  loginByCode,
  login,
} from "../request/api";
import { setToken, setRefreshToken } from "../request/storage";
import { useUserStore } from "../stores/useAppStore";
import { useNavigate } from "react-router-dom";

interface AuthCardProps {
  onOpenForgotModal: () => void;
  onShowToast: (msg: string) => void;
  viewDevice: ViewDevice;
}

export const AuthCard: React.FC<AuthCardProps> = ({
  onOpenForgotModal,
  onShowToast,
  viewDevice,
}) => {
  const [authMode, setAuthMode] = useState<"login" | "register">("login");
  const [loginMethod, setLoginMethod] = useState<"password" | "code">(
    "password",
  );
  const navigate = useNavigate();
  const setUser = useUserStore((s) => s.setUser);

  // Form State
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [agreeTerms, setAgreeTerms] = useState(true);

  // Code Countdown
  const [codeCountdown, setCodeCountdown] = useState(0);

  const handleSendCode = async () => {
    if (!email) {
      onShowToast("请输入接收验证码的邮箱");
      return;
    }

    if (authMode === "login") {
      const res = await sendLoginCode({ email });
      console.log("发送验证码接口返回结果：", res);
    } else {
      const res = await sendRegisterCode({ email });
      console.log("发送验证码接口返回结果：", res);
    }
    setCodeCountdown(60);
    const timer = setInterval(() => {
      setCodeCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (authMode === "register") {
      if (!name || !email || !password) {
        onShowToast("请完整填写注册信息");
        return;
      }
      if (password !== confirmPassword) {
        onShowToast("两次输入的密码不一致");
        return;
      }
      if (!agreeTerms) {
        onShowToast("请勾选并同意服务协议和隐私政策");
        return;
      }
      const res = await register({
        nickname: name,
        email,
        password,
        confirmPassword,
        emailCode: phoneCode,
      });
      console.log("注册接口返回结果：", res);
      // return;
      onShowToast("注册成功");
      setName("");
      setEmail("");
      setPassword("");
      setConfirmPassword("");
      setPhoneCode("");
      setAuthMode("login");
      return;
    }
    let res;

    // Login mode
    if (loginMethod === "password") {
      if (!email || !password) {
        onShowToast("请输入邮箱和密码");
        return;
      }
      res = await login({
        email,
        password,
      });
    } else {
      if (!email || !phoneCode) {
        onShowToast("请输入邮箱和验证码");
        return;
      }
      res = await loginByCode({
        email,
        emailCode: phoneCode,
      });
    }
    console.log("登录接口返回结果：", res);
    setToken(res.accessToken);
    setRefreshToken(res.refreshToken);
    // 登录响应已带用户信息，直接落到 store，侧边栏就能显示真实昵称
    if (res.user) setUser(res.user);
    onShowToast("登录成功");
    navigate("/", { replace: true });
  };

  // Device Responsive Class
  const isForcedH5 = viewDevice === "h5";
  const isForcedDesktop = viewDevice === "desktop";

  return (
    <div
      className={`w-full transition-all duration-300 ${isForcedH5 ? "max-w-md mx-auto" : "max-w-5xl mx-auto"}`}
    >
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="rounded-3xl border border-slate-200/90 bg-white/95 backdrop-blur-xl shadow-2xl overflow-hidden p-2 sm:p-3"
      >
        <div
          className={`grid gap-4 ${isForcedDesktop ? "grid-cols-1 md:grid-cols-12" : isForcedH5 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-12"}`}
        >
          {/* Left Column: Form Section */}
          <div
            className={`${isForcedDesktop ? "md:col-span-6 lg:col-span-6" : isForcedH5 ? "col-span-1" : "md:col-span-6 lg:col-span-6"} p-5 sm:p-8 flex flex-col justify-between`}
          >
            {/* Top Bar inside Card */}
            <div>
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-xs">
                    <Sparkles className="w-4.5 h-4.5 text-amber-300" />
                  </div>
                  <span className="text-lg font-black tracking-tight text-slate-900 font-sans">
                    Wisora
                  </span>
                </div>

                <div className="px-3 py-1 rounded-full bg-slate-100 text-[11px] font-medium text-slate-600 border border-slate-200/60">
                  中文 / English
                </div>
              </div>

              {/* Header Title */}
              <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-extrabold text-slate-900 tracking-tight">
                  {authMode === "login" ? "欢迎回来" : "创建新账号"}
                </h1>
                <p className="text-xs text-slate-500 mt-1">
                  {authMode === "login"
                    ? "登录 Wisora 智能平台，体验全新的 AI 工作流"
                    : "立即注册，获赠 50,000 AI 计算 Token 体验额度"}
                </p>
              </div>

              {/* Login Method Tabs */}
              {authMode === "login" && (
                <div className="mb-6">
                  <Tabs
                    value={loginMethod}
                    onValueChange={(v) =>
                      setLoginMethod(v as "password" | "code")
                    }
                    className="w-full"
                  >
                    <TabsList className="w-full grid grid-cols-2 bg-slate-100/90 rounded-xl p-1">
                      <TabsTrigger
                        value="password"
                        className="text-xs sm:text-sm font-semibold rounded-lg py-2"
                      >
                        密码登录
                      </TabsTrigger>
                      <TabsTrigger
                        value="code"
                        className="text-xs sm:text-sm font-semibold rounded-lg py-2"
                      >
                        验证码登录
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              )}

              {/* Main Auth Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                <AnimatePresence mode="wait">
                  {authMode === "register" && (
                    <motion.div
                      key="name-field"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="space-y-1.5"
                    >
                      <Label className="text-xs font-semibold text-slate-700">
                        用户名
                      </Label>
                      <Input
                        type="text"
                        placeholder="请输入你的昵称或姓名"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="bg-slate-50 border-slate-200"
                        required
                      />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Email or Phone Field */}
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold text-slate-700">
                    {loginMethod === "code" ? "邮箱" : "邮箱"}
                  </Label>
                  <div className="relative">
                    {loginMethod === "code" ? (
                      <Smartphone className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                    ) : (
                      <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                    )}
                    <Input
                      type="text"
                      placeholder={
                        loginMethod === "code" ? "请输入邮箱" : "请输入邮箱"
                      }
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-10 bg-slate-50 border-slate-200 focus:bg-white"
                      required
                    />
                  </div>
                </div>

                {authMode === "register" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-slate-700">
                      验证码
                    </Label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                        <Input
                          type="text"
                          placeholder="请输入验证码"
                          value={phoneCode}
                          onChange={(e) => setPhoneCode(e.target.value)}
                          className="pl-10 bg-slate-50 border-slate-200 focus:bg-white"
                          maxLength={6}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleSendCode}
                        disabled={codeCountdown > 0}
                        className="whitespace-nowrap px-3 text-xs border-indigo-200 text-indigo-600 hover:bg-indigo-50 font-medium"
                      >
                        {codeCountdown > 0
                          ? `${codeCountdown}s 后可重发`
                          : "获取验证码"}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {/* Password vs Verification Code */}
                {authMode === "login" && loginMethod === "code" ? (
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-slate-700">
                      验证码
                    </Label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <KeyRound className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                        <Input
                          type="text"
                          placeholder="请输入验证码 (测试: 888888)"
                          value={phoneCode}
                          onChange={(e) => setPhoneCode(e.target.value)}
                          className="pl-10 bg-slate-50 border-slate-200 focus:bg-white"
                          maxLength={6}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleSendCode}
                        disabled={codeCountdown > 0}
                        className="whitespace-nowrap px-3 text-xs border-indigo-200 text-indigo-600 hover:bg-indigo-50 font-medium"
                      >
                        {codeCountdown > 0
                          ? `${codeCountdown}s 后可重发`
                          : "获取验证码"}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-semibold text-slate-700">
                        {" "}
                        密码
                      </Label>
                      {authMode === "login" && (
                        <button
                          type="button"
                          onClick={onOpenForgotModal}
                          className="text-xs text-indigo-600 hover:text-indigo-800 hover:underline font-medium"
                        >
                          忘记密码？
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                      <Input
                        type={showPassword ? "text" : "password"}
                        placeholder="请输入密码"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="pl-10 pr-10 bg-slate-50 border-slate-200 focus:bg-white"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-3.5 top-3.5 text-slate-400 hover:text-slate-600"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                )}

                {authMode === "register" ? (
                  <div>
                    <Label className="text-xs font-semibold text-slate-700">
                      确认密码
                    </Label>
                    <div className="relative">
                      <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3.5" />
                      <Input
                        type={showConfirmPassword ? "text" : "password"}
                        placeholder="请确认密码"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        className="pl-10 pr-10 bg-slate-50 border-slate-200 focus:bg-white"
                        required
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setShowConfirmPassword(!showConfirmPassword)
                        }
                        className="absolute right-3.5 top-3.5 text-slate-400 hover:text-slate-600"
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* Extra Option Checkboxes */}
                {authMode === "login" ? (
                  <div className="flex items-center justify-between pt-1">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600">
                      <input
                        type="checkbox"
                        checked={rememberMe}
                        onChange={(e) => setRememberMe(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5"
                      />
                      <span>记住登录状态 (30天内免登录)</span>
                    </label>
                  </div>
                ) : (
                  <div className="pt-1">
                    <label className="flex items-start gap-2 cursor-pointer text-xs text-slate-600 leading-relaxed">
                      <input
                        type="checkbox"
                        checked={agreeTerms}
                        onChange={(e) => setAgreeTerms(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 mt-0.5"
                      />
                      <span>
                        我已阅读并同意{" "}
                        <a
                          href="#terms"
                          onClick={(e) => {
                            e.preventDefault();
                            onShowToast(
                              "Wisora 服务条款：极速、安全、隐私保护。",
                            );
                          }}
                          className="text-indigo-600 underline"
                        >
                          服务协议
                        </a>{" "}
                        与{" "}
                        <a
                          href="#privacy"
                          onClick={(e) => {
                            e.preventDefault();
                            onShowToast(
                              "Wisora 隐私政策：承诺数据加密不泄露。",
                            );
                          }}
                          className="text-indigo-600 underline"
                        >
                          隐私政策
                        </a>
                      </span>
                    </label>
                  </div>
                )}

                {/* Primary Action Button */}
                <Button
                  type="submit"
                  variant="brand"
                  className="w-full h-12 rounded-xl text-base font-semibold shadow-indigo-600/30 transition-transform active:scale-[0.99] flex items-center justify-center gap-2"
                >
                  <span>{authMode === "login" ? "登录" : "注册并登录"}</span>
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </form>

              {/* <div className="relative my-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-3 text-slate-400 font-medium">
                    or
                  </span>
                </div>
              </div>

            
              <div className="space-y-2.5">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleQuickLogin("GitHub")}
                  className="w-full h-11 rounded-xl text-xs sm:text-sm font-semibold border-slate-200 text-slate-700 hover:bg-slate-50 flex items-center justify-center gap-2"
                >
                  <span>使用 GitHub 登录</span>
                </Button>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleQuickLogin("微信")}
                    className="h-10 rounded-xl text-xs font-medium border-slate-200 text-emerald-700 hover:bg-emerald-50/50 flex items-center justify-center gap-1.5"
                  >
                    <QrCode className="w-3.5 h-3.5 text-emerald-600" />
                    <span>微信一键登录</span>
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => handleQuickLogin("免密手机号")}
                    className="h-10 rounded-xl text-xs font-medium border-slate-200 text-indigo-700 hover:bg-indigo-50/50 flex items-center justify-center gap-1.5"
                  >
                    <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />
                    <span>一键快捷免密</span>
                  </Button>
                </div>
              </div> */}
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100 text-center text-xs text-slate-600">
              {authMode === "login" ? (
                <>
                  还没有账号？{" "}
                  <button
                    type="button"
                    onClick={() => setAuthMode("register")}
                    className="font-bold text-indigo-600 hover:underline hover:text-indigo-800"
                  >
                    注册
                  </button>
                </>
              ) : (
                <>
                  已有 Wisora 账号？{" "}
                  <button
                    type="button"
                    onClick={() => setAuthMode("login")}
                    className="font-bold text-indigo-600 hover:underline hover:text-indigo-800"
                  >
                    立即登录
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Right Column: Illustration Banner (Shown on Desktop, or as top banner on H5) */}
          <div
            className={`${isForcedDesktop ? "md:col-span-6 lg:col-span-6 block" : isForcedH5 ? "col-span-1 hidden sm:block" : "md:col-span-6 lg:col-span-6 hidden md:block"} p-2`}
          >
            <IllustrationGraphic />
          </div>
        </div>
      </motion.div>
    </div>
  );
};
