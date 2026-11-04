# dsh-plugin-cookie-whitelist

> 只把 Cookie 交给白名单：Chrome / Edge / Firefox 扩展 + 本机接收器 + 只读 CDP 浏览器。

`dsh-plugin-cookie-whitelist` 让 DeepSeek Harness 的智能体在**你逐条批准的域名**上使用你的登录态读取网页；其他站点一律匿名访问。Cookie 值只在内存中保存，不写入磁盘，不出现在日志、设置页或工具结果里。

## 它解决什么

Chrome 127+ 的 App-Bound Encryption 让外部程序无法直接解密浏览器 Cookie 数据库。这个插件不碰数据库，而是：

1. 浏览器扩展在浏览器内部用 `chrome.cookies` / `browser.cookies` 读取 Cookie；
2. 扩展在离开浏览器之前按任务中的白名单域名过滤；
3. 过滤后的 Cookie 只发到 `http://127.0.0.1:<端口>`，并携带配对令牌；
4. 插件把 Cookie 放进**纯内存 Vault**；
5. 智能体用本机 Chrome/Edge 的一次性无痕实例读取网页，每次导航前清空浏览器 Cookie，只注入当前 URL 命中白名单的 Cookie。

## 安全边界（先读）

- **只读交互**：智能体可以导航、读取正文、点击翻页/展开、滚动、截图；**不能填表、不能提交**。插件在工具层禁止 fill，在页面脚本层拦截 `submit` / `requestSubmit` / `window.open`，在 CDP 网络层拒绝所有非 `GET` / `HEAD` / `OPTIONS` 请求。
- **非白名单即匿名**：每次导航先 `Network.clearBrowserCookies()`，再只注入当前 URL 命中白名单的 Cookie。顶层页面不在白名单时，请求中的 `Cookie` 头会被剥掉。
- **Cookie 不落盘**：Vault 只存在 Host 进程内存；只读浏览器用 `--incognito` + 一次性 profile，关闭后删除；临时登录窗口也用 `--incognito`，结束即销毁。设置页和工具只显示域名、条数、字节数、时间，不显示 Cookie 名称或值。
- **授权是用户动作**：智能体调用 `cookie_authorize` 只能**请求**；聊天内原生审批或设置页「允许并加入白名单」才真正加入。请求有超时，过期自动失效。
- **接收器只监听 127.0.0.1**：所有 `/v1/*` 请求需要配对令牌；来自普通网页的 `http(s)` Origin 会被 403 拒绝；扩展只允许 `chrome-extension://` / `moz-extension://`。
- **扩展权限较宽**：`<all_urls>` 是 `cookies` API 读取任意域名的前置条件。扩展没有内容脚本、不读页面 DOM、不连接远程服务器、无遥测；只向 `127.0.0.1` 发送数据。

### 已知限制

- 某些站点会因设备指纹、会话绑定或风控拒绝“克隆登录态”；机制可用不等于每个站点都接受。
- 验证码、2FA、扫码登录需要你本人在临时登录窗口完成。
- Firefox 扩展需要「临时加载」或自行打包签名；Chrome/Edge 使用开发者模式加载未打包扩展。
- Chrome/Edge 不允许在默认 profile 上开远程调试端口，所以插件使用独立的一次性 profile；这不是缺陷。
- 截图可能包含页面上的个人信息；插件只用 `attachments` 保存工具结果所需的图片，若 `attachments` 不可用则写到插件数据目录的 `shots/`。

## 架构

```text
Chrome/Edge/Firefox
  └─ extension/ (MV3 / MV2)
       chrome.cookies.getAll({url}) → 域名过滤 → POST 127.0.0.1/v1/cookies
                                                        │
DSH Host (index.js + lib/)                              ▼
  ├─ ExtensionReceiver   token + Origin 校验，任务队列
  ├─ BridgeStore         白名单 / 授权请求 / 心跳（state.json）
  ├─ CookieVault         纯内存 Cookie，TTL，零值化清理
  ├─ ReadOnlyBrowser     一次性 headless Chrome/Edge + CDP
  ├─ TempLoginManager    可见的一次性登录窗口
  ├─ Tools               cookie_whitelist_status / authorize / sync / browse
  └─ Settings API        /cookie-whitelist/api（同源 + 自定义头）
```

## 安装

### 1. 安装 DSH 插件

从 GitHub 安装：

```bash
dsh plugin --profile desktop add github:wth373737/dsh-plugin-cookie-whitelist
```

或在本地开发时，把仓库目录通过 `plugin_manager` 的 `install_bundle` 安装。

安装后在 **设置 → Cookie 白名单** 打开设置页。接收器默认监听 `127.0.0.1:47821`；如果端口被占用会自动尝试后续端口，设置页会显示实际端口。

### 2. 加载浏览器扩展

**Chrome / Edge**

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 打开右上角「开发者模式」。
3. 「加载已解压的扩展程序」→ 选择插件目录下的 `extension/chromium`。
4. 打开扩展的「选项」，填入设置页显示的接收地址和配对令牌，保存。
5. 点「测试连接」；回到 DSH 设置页，扩展状态应变为「已连接」。

**Firefox**

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 「临时载入附加组件」→ 选择 `extension/firefox/manifest.json`。
3. 打开扩展选项，填入接收地址和令牌，保存并测试。

> 扩展目录路径会显示在设置页，并可直接「打开文件夹」。也可以把 `extension/chromium` 打包成 zip 后用 Chrome 的「加载已解压」之外的发行流程；Firefox 正式安装需要签名，开发时用临时载入。

### 3. 加入白名单

- 在设置页输入域名 →「加入白名单」，或
- 让智能体请求：它调用 `cookie_authorize`，你在聊天里审批；也可以稍后在设置页「授权请求」里逐条批准/拒绝。
- 加完后扩展会在下一次轮询读取该域名的 Cookie；设置页点「让扩展立即同步」可催促。

### 4. 临时登录（没有扩展或使用其他浏览器时）

1. 先把域名加入白名单。
2. 设置页「临时浏览器登录」输入域名 →「打开登录窗口」。
3. 在弹出的 Chrome/Edge 无痕窗口里手动登录（含验证码/2FA）。
4. 回到设置页点「完成并提取」；Cookie 进入内存 Vault，窗口和临时 profile 立即销毁。

## 智能体工具

| 工具 | 作用 |
| --- | --- |
| `cookie_whitelist_status` | 查看白名单、待批准请求、扩展心跳、Vault 条数、只读浏览器状态。永不返回值。 |
| `cookie_authorize` | 请求把某个域名加入白名单。先创建待办，再走聊天内原生审批；无 UI 时留在设置页待办。 |
| `cookie_sync` | 让扩展重新读取指定（或全部）白名单域名的 Cookie；只返回计数。 |
| `cookie_browse` | 只读浏览器：`open` / `read` / `snapshot` / `click` / `scroll` / `screenshot` / `status` / `close`。 |

典型流程：

```text
cookie_whitelist_status
cookie_authorize { domain: "example.com", reason: "读取课程列表" }
cookie_sync { domains: ["example.com"] }
cookie_browse { action: "open", url: "https://example.com/" }
cookie_browse { action: "read" }
cookie_browse { action: "click", ref: "..." }   // 只用于翻页/展开
```

## 配置

`cordis.patch.yml` 的默认配置：

```yaml
server:
  port: 47821
  maxDomainsPerTask: 40
security:
  requestTtlMinutes: 10
  vaultTtlMinutes: 120
  maxCookiesPerDomain: 3000
  maxCookieBytesPerDomain: 2097152
browser:
  executable: ''        # 留空自动探测 Chrome → Edge
  idleTimeoutMin: 15
  readTimeoutMs: 30000
syncWaitMs: 8000
dataDir: ''             # 留空使用 $DSH_HOME/cookie-whitelist
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 设置页显示「扩展未连接」 | 检查扩展选项里的地址/令牌；点「测试连接」；确认 DSH 设置页显示同一端口。 |
| `cookie_sync` 一直未完成 | MV3 扩展可能处于休眠；设置页点「让扩展立即同步」，或打开扩展选项页唤醒。 |
| 浏览器没有启动 | 需要本机安装 Chrome 或 Edge；设置 `browser.executable` 指向可执行文件。 |
| 登录态无效 | 站点可能拒绝克隆会话；用临时登录窗口在同一浏览器里重新登录，或让扩展重新同步。 |
| 端口被占用 | 插件会自动尝试后续端口；以设置页显示为准，重新填入扩展选项。 |
| 页面读不到内容 | 站点可能需要 JS 渲染或登录；先 `cookie_browse open`，再 `read`/`snapshot`。若页面有验证码，用临时登录窗口人工完成。 |

## 开发与测试

```bash
node scripts/build-extensions.mjs   # 从 extension-src 生成 extension/chromium 与 extension/firefox
node test/smoke.mjs                 # util / store / vault / receiver / tools
node test/extension-sim.mjs         # 用 mock chrome.* 把扩展 background 跑通，验证任务/过滤/上报
node test/browser.mjs               # 需要本机 Chrome/Edge；验证 Cookie 注入、点击、POST 拦截、截图
node test/host-sim.mjs              # 验证 Host 入口注册的工具/路由/提示词
```

`node test/browser.mjs` 会启动一个临时本地 HTTP 服务和一个一次性 Chrome；请在没有敏感浏览会话的机器上运行。它不会使用你的浏览器 profile。

## 许可

MIT。图标为本项目原创；扩展与 Host 代码不包含第三方运行时。

