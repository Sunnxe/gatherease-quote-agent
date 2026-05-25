# NemoClaw Custom Egress Presets

這個資料夾的 YAML 是 **GatherEase 自訂的 NemoClaw policy presets**，套用後 sandbox 內的 agent 只能對 whitelist 的 host/port 發 egress 連線（其他全部被 NemoClaw kernel-level 擋）。

## 檔案

| 檔 | 開放給 | 用途 |
|---|---|---|
| [`line-messaging.yaml`](./line-messaging.yaml) | `api.line.me` `api-data.line.me` 443 | LINE flex message push / webhook（老闆守門簽核） |
| [`gmail-smtp.yaml`](./gmail-smtp.yaml) | `smtp.gmail.com` 587/465 | 對外發詢價信 / 加密報價單 |
| [`gmail-imap.yaml`](./gmail-imap.yaml) | `imap.gmail.com` 993 | 收代工廠回信 / 客戶詢價 |
| `gatherease-egress.legacy.yaml` | — | 早期我們自己猜的 schema（archived 留紀錄、不要套） |

**內建 preset 已涵蓋的東西**（不用自訂）：

| 內建 preset | 涵蓋 |
|---|---|
| `nvidia`（onboard 自動配） | `integrate.api.nvidia.com` / Nemotron API |
| `managed_inference` | `inference.local`（sandbox 經 OpenShell gateway 走 inference） |
| `npm`（Balanced tier 預設開） | `registry.npmjs.org`、yarn |
| `pypi`（Balanced） | `pypi.org`、`files.pythonhosted.org` |
| `huggingface`（Balanced） | `huggingface.co`、`cdn-lfs.huggingface.co`、router |
| `brew`（Balanced） | Homebrew taps |
| `brave`（Balanced） | `api.search.brave.com` |

## 套用

**Dry run 看內容**（不會真的改 policy）：

```bash
nemoclaw gatherease-quote-agent policy-add --from-file ./presets/line-messaging.yaml --dry-run
```

**套單一檔**：

```bash
nemoclaw gatherease-quote-agent policy-add --from-file ./presets/line-messaging.yaml --yes
nemoclaw gatherease-quote-agent policy-add --from-file ./presets/gmail-smtp.yaml --yes
nemoclaw gatherease-quote-agent policy-add --from-file ./presets/gmail-imap.yaml --yes
```

**或一次套整個資料夾**（NemoClaw 會按字母序處理，跳過 `.legacy.yaml`——但建議重新命名避免它載入）：

```bash
nemoclaw gatherease-quote-agent policy-add --from-dir ./presets/ --yes
```

**驗證有套上**：

```bash
nemoclaw gatherease-quote-agent policy-list
nemoclaw gatherease-quote-agent status   # 看 policy version 跳號
```

## 移除（如果想 rollback）

```bash
nemoclaw gatherease-quote-agent policy-remove line-messaging --yes
nemoclaw gatherease-quote-agent policy-remove gmail-smtp --yes
nemoclaw gatherease-quote-agent policy-remove gmail-imap --yes
```

## Schema 來源

Schema 完全依照 NVIDIA 官方文件：
- [Customize the Network Policy](https://docs.nvidia.com/nemoclaw/latest/network-policy/customize-network-policy.html)
- [Integration Policy Examples](https://docs.nvidia.com/nemoclaw/latest/network-policy/integration-policy-examples.html)
- 內建 presets：[NemoClaw repo `nemoclaw-blueprint/policies/presets/`](https://github.com/NVIDIA/NemoClaw/tree/main/nemoclaw-blueprint/policies/presets)

**關鍵約束**：
- `preset.name` 必須 lowercase RFC 1123 label
- 不能跟內建 preset 衝突（brave/brew/slack/pypi/telegram/discord/github/jira/outlook/local-inference/npm/huggingface）
- REST 端點：`protocol: rest` + `enforcement: enforce` + `rules: [allow: {method, path}]`
- 非 REST（SMTP/IMAP）：`tls: skip` + `access: full`，無 rules
