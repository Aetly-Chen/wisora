export const TOKEN_KEY="TOKEN"

export const REFRESH_TOKEN_KEY="REFRESH_TOKEN"

const isBrowser = typeof window !== 'undefined'

/**
 * Token 存取只做最小封装。
 *
 * 为什么要单独放这里：
 * - 以后如果要从 localStorage 换成 cookie / indexedDB
 *   只需要改这一层，不用改所有业务请求。
 * - SSR / 构建阶段访问 window 会报错，所以先判断环境。
 */
export function getToken(){
    return isBrowser ? localStorage.getItem(TOKEN_KEY) : null
}

export function setToken(token:string){
    if (isBrowser) localStorage.setItem(TOKEN_KEY,token)
}

export function removeToken(){
    if (isBrowser) localStorage.removeItem(TOKEN_KEY)
}

export function getRefreshToken(){
    return isBrowser ? localStorage.getItem(REFRESH_TOKEN_KEY) : null
}

export function setRefreshToken(token:string){
    if (isBrowser) localStorage.setItem(REFRESH_TOKEN_KEY,token)
}

/** 清理刷新 token。 */
export function removeRefreshToken(){
    if (isBrowser) localStorage.removeItem(REFRESH_TOKEN_KEY)
}
