# LINE Messaging API 接通 Runbook

> 給「terminal 關了 / VM 重開 / 明天回來」要重新跑通 LINE 簽核流程的人。
> 上次成功時間：2026-05-25 11:33 UTC（Sunny + Claude）

## 0. 為什麼會需要重來

`cloudflared tunnel --url ...`（quick tunnel，沒帳號）的 URL **每次重啟都會變**。所以：

- webhook server 重啟 → URL 不變（只要 cloudflared 還跑著）
- cloudflared 重啟 → URL 變 → **要回 LINE Console 改 Webhook URL**
- VM 整台重開 → 上面兩個都要重起 → URL 變 → 一樣要改 LINE Console

LINE Console 設的 URL 只要對不上現在 cloudflared 給的 URL，LINE 就會 530 / timeout。

## 1. 三個必跑的進程

VM 上要同時活著的三個進程（其實是兩個進程 + LINE Console 設定）：

| 進程 | 在 VM 哪裡跑 | 死了會發生 |
|---|---|---|
| webhook server | `node skills/line_notify/webhook.js`（port 3000） | LINE 打進來找不到 origin |
| cloudflared tunnel | `cloudflared tunnel --url http://localhost:3000` | 公開 URL 失效 |
| (LINE Console 設定) | webhook URL 必須等於現在 cloudflared 給的 URL | LINE 打到死 URL → 530 |

## 2. 從零重啟（完整流程）

VM ssh 進去後：

### Step 1 — webhook server

開 tab A：

```bash
cd ~/gatherease-quote-agent
git pull                  # 確保最新 code（含 trace logs）
set -a; source .env; set +a
node skills/line_notify/webhook.js
```

看到 `[line_notify webhook] Listening on http://0.0.0.0:3000` 就 OK。**這個 tab 保持開著**。

### Step 2 — cloudflared tunnel

開 tab B：

```bash
cloudflared tunnel --url http://localhost:3000
```

等 5~8 秒，找這段印出來：

```
+----------------------------------------------+
|  Your quick Tunnel has been created!         |
|  https://<random-words>.trycloudflare.com    |
+----------------------------------------------+
```

把這個 URL 記下來。**這個 tab 也保持開著**。

> 如果想關 tab 也讓它繼續跑，用 nohup 版：
>
> ```bash
> nohup cloudflared tunnel --url http://localhost:3000 > /tmp/cf.log 2>&1 &
> sleep 8
> grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf.log | head -1
> ```

### Step 3 — 更新 LINE Developers Console

去 https://developers.line.biz/console/channel/2010190840/messaging-api：

1. **Webhook URL** 欄位 → Edit → 改成 `https://<新URL>.trycloudflare.com/webhook/line` → Update
2. 按 **Verify**
3. 確認跳「Success」（如果跳 530 / timeout，回到 Step 4 排查）
4. **Use webhook** 開關 → 確認是 ON（綠色）
5. **Auto-reply messages** → OFF
6. **Greeting messages** → OFF

### Step 4 — 驗證端到端

VM 開 tab C 測：

```bash
# 換成你新的 URL
curl -s -o /dev/null -w "status=%{http_code} time=%{time_total}s\n" -X POST \
  https://<新URL>.trycloudflare.com/webhook/line \
  -H "Content-Type: application/json" \
  -H "x-line-signature: dummy" \
  --max-time 5 \
  -d '{"events":[]}'
```

預期 `status=401 time=<1s`，**並且** webhook server tab（Step 1）會印類似：

```
[trace] ... POST /webhook/line sig=dummy... ua=curl/8.5.0
[trace] line.middleware called next(err): SignatureValidationFailed
[trace] ↳ POST /webhook/line responded 401 in Xms
```

兩個都對 → 全鏈路通了 → 可以開始錄 demo。

## 3. .env 要有的 LINE 變數

```bash
LINE_CHANNEL_ACCESS_TOKEN=...   # LINE Console > Messaging API > 最下方 Issue
LINE_CHANNEL_SECRET=...         # LINE Console > Basic settings
LINE_BOSS_USER_ID=U...          # 第一次加好友後從 webhook trace 抓
```

`LINE_BOSS_USER_ID` 怎麼抓（第一次設）：

1. webhook server 跑著
2. 手機 LINE 加 OA 為好友（QR Code 或 @ID `@733goljk`）
3. webhook server tab 會印：
   ```
   [webhook] follow from userId = U....
   ```
   或傳訊息給 bot 也行：
   ```
   [webhook] message from userId = U....
   ```
4. 複製 `U` 開頭那 33 字 → 寫進 .env：
   ```bash
   # ⚠️ 不要用 UID 變數名 — UID 在 bash 是 readonly special variable
   # （當前 user 的 user ID，ubuntu user 通常是 1000）
   # read 對 UID 不會成功，$UID 會留 1000 → .env 寫成 LINE_BOSS_USER_ID=1000
   # → LINE API 拒收 → 400
   read -p "LINE_BOSS_USER_ID: " LBUID
   if grep -q '^LINE_BOSS_USER_ID=' .env; then
     sed -i "s|^LINE_BOSS_USER_ID=.*|LINE_BOSS_USER_ID=$LBUID|" .env
   else
     echo "LINE_BOSS_USER_ID=$LBUID" >> .env
   fi
   unset LBUID
   ```

設一次就好，userId 不會變（除非你封鎖再加回來會變新的）。

## 4. 上次成功的設定（reference）

| 項目 | 值 |
|---|---|
| LINE Channel ID | 2010190840 |
| LINE OA | @733goljk |
| 成功時間 | 2026-05-25 11:33 UTC |
| Verify trace | `responded 200 in 1ms`（連三次） |
| 上次 cloudflared URL | `https://sensitive-since-left-teaches.trycloudflare.com`（每次重啟會變） |

## 5. 常見錯誤 → 對應修法

| 症狀 | 根因 | 修法 |
|---|---|---|
| LINE Verify 跳 530 | cloudflared 已關 / URL 變了 | 重起 cloudflared → 拿新 URL → LINE Console 改 |
| LINE Verify 跳 401 | LINE_CHANNEL_SECRET 跟 Console 對不上 | 從 Console > Basic settings 重新複製 secret 寫進 .env，重啟 webhook server |
| LINE Verify "timeout" | webhook handler 卡住沒回 response | 看 webhook tab 有沒有 `[trace] ... STUCK` 或 handler 拋 error |
| curl 401 但 LINE Verify 失敗 | LINE Console webhook URL 字串對不上（少 `/webhook/line` 結尾） | 對齊字串再 Update |
| 加好友後 webhook tab 沒新 trace | Use webhook 沒 toggle ON / 加錯 OA | 回 Step 3 點 4 |
| `^X: command not found` | .env 有 nano 留下的 Ctrl+X 字元 | `sed -i 's/\x18//g' .env` |

## 6. 為什麼用 cloudflared quick tunnel（而不是 ngrok / Nginx+LE）

- ngrok 免費版要登入註冊 + 限頻寬 + URL 也會變
- Nginx + Let's Encrypt + 公網 IP 才是 production 解，但 Brev VM 沒固定公網 hostname
- Cloudflare named tunnel（需 CF 帳號）URL 不會變，但要做 DNS 設定，demo 用 quick 就夠

**Demo 錄影那天**：開錄前 30 分鐘做 Step 1~4，跑通就不要動。錄完整段 3 分鐘大概率 tunnel 不會掛。

## 7. webhook server 的 trace logs

`skills/line_notify/webhook.js` 加了 debug trace（任何進來的 request 都會印一行）。
demo 錄完之後可以拿掉這些 trace logs，code 會比較乾淨。在 webhook.js 找 `>>> DEBUG trace <<<` 那段刪掉就好。

## 8. E2E：跑 orchestrator 真的 push flex 到手機

**架構重點**：webhook server 跟 orchestrator **必須在同一個 Node process**，pendingHolds Map 才共用。所以 orchestrator 啟動時會自己 spin up embedded webhook（不需要另開 webhook tab）。

跑 e2e 測試的順序：

### Step 1 — 確保 cloudflared 還跑著

```bash
# 看 cloudflared PID
ps aux | grep cloudflared | grep -v grep
# 如果沒在跑，重起：
nohup cloudflared tunnel --url http://localhost:3000 > /tmp/cf.log 2>&1 &
sleep 8
grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf.log | head -1
# → 把這個 URL 同步到 LINE Console webhook URL
```

### Step 2 — 關掉獨立 webhook server tab

orchestrator 自己會啟 embedded webhook 在 port 3000。如果原本另開的 webhook server tab 還在，port 衝突會 fail。

```bash
# 找 standalone webhook process（如果有）
ps aux | grep 'node skills/line_notify/webhook.js' | grep -v grep
# 有就 kill：
kill <PID>
```

### Step 3 — 跑 orchestrator with FORCE_LINE_HOLD

```bash
cd ~/gatherease-quote-agent
set -a; source .env; set +a
FORCE_LINE_HOLD=1 node orchestrator.js demo
```

`FORCE_LINE_HOLD=1` 讓 demo mode 也走真實 LINE push（不需要 NVIDIA_API_KEY）。

預期行為：

1. orchestrator 印 `✅ embedded webhook server started`
2. 跑到第一個 HOLD（gate-pre-rfq 或 gate-1-secret-probe）
3. orchestrator 印 `[line_notify] Pushed HOLD ... to LINE user U...`
4. **你手機收到 NVIDIA-green flex message**，標題例如「📋 詢價單彙整」
5. **按按鈕** → webhook tab 印 `[webhook] postback from ... hold=... choice=...`
6. orchestrator 接著跑下一步
7. 後續 HOLD 重複 4–6
8. 跑完整個流程後 process exit

### Step 4 — 演 gate-1 套機密偵測

```bash
FORCE_LINE_HOLD=1 node orchestrator.js demo --secret
```

`--secret` 會帶套機密客戶信件 → gate-1 偵測 → push LINE「🚨 客戶來信疑似套機密」flex message 給你。

### 常見問題

| 症狀 | 修法 |
|---|---|
| `Error: listen EADDRINUSE: address already in use :::3000` | standalone webhook server tab 還在，kill 它 |
| 手機沒收到 flex message | LINE_BOSS_USER_ID 設錯，或 access token 過期 |
| 按按鈕後 orchestrator 卡住 | webhook 不在同 process — 確認沒跑 standalone webhook、orchestrator 啟動印了 `embedded webhook server started` |
| `HOLD ... timeout after 5 min` | 老闆 5 分鐘沒按按鈕，預設 timeout reject。改長：編 `skills/line_notify/index.js` 的 `HOLD_TIMEOUT_MS` |
