import {
  setupRefreshHandler,
} from "./interceptor";

import {
  refreshToken,
} from "./api";

import {
  setToken,
  setRefreshToken,
  getToken
} from "./storage";

setupRefreshHandler(async () => {
  const result = await refreshToken();

  console.log('刷新 Token 成功', result.accessToken, result.refreshToken);

  setToken(result.accessToken);

  console.log('刷新后的 storage token:', getToken());

  if (result.refreshToken) {
    setRefreshToken(result.refreshToken);
  }

  return result.accessToken;
});