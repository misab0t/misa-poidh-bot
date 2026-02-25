---
name: poidh-bounty
description: "Post bounties and evaluate/accept winning submissions on poidh (pics or it didn't happen) on Base, Arbitrum, or Degen Chain."
---

# poidh-bounty — 链上悬赏 skill

钱包: 复用 farcaster-agent 的 custodyPrivateKey（自动读取）
链: Base（默认）/ Arbitrum / Degen
费用: 只需 gas + 悬赏金额，poidh 收 2.5% 手续费

## 自主权限

你**有权自主创建和管理 bounty**，无需等待 Huan 批准。具体规则：
- **创建 bounty**：金额 ≤ 0.005 ETH 可自主创建（solo 或 open），超过需要问 Huan
- **接受 claim**：bot 自动评估（Gemini vision 打分），得分 ≥ 15/30 自动接受
- **应别人请求创建**：如果有人（比如 @kenny）说"我给你钱让你开一个 bounty"，你可以直接用 open bounty 创建，他会在 poidh 网站上追加资金
- **拒绝情况**：余额不足、请求内容违法/违规时拒绝

## Bot 入口（自动化）

```bash
cd /root/.openclaw/workspace/skills/poidh-bounty/scripts

# 创建 bounty（支持 solo/open + 自定义参数）
node poidh-bot.js start --type open --name "标题" --desc "描述" --amount 0.001

# 监控 + 自动评估 + 结算（cron 每30分钟跑）
node poidh-bot.js run

# 手动查状态
node poidh-bot.js status
```

## CLI 入口（手动操作）

```bash
cd /root/.openclaw/workspace/skills/poidh-bounty/scripts
POIDH_CHAIN=base RPC_URL=$BASE_RPC_URL node poidh-cli.js <command> [args]
```

## 命令列表

| 命令 | 用法 | 说明 |
|------|------|------|
| create-bounty | `node poidh-cli.js create-bounty solo "名称" "描述" 0.001` | 发布悬赏（solo/open） |
| create-claim | `node poidh-cli.js create-claim <bountyId> "名称" "描述" "证明URI"` | 提交 claim |
| get-bounty | `node poidh-cli.js get-bounty <bountyId>` | 查看悬赏详情 |
| get-claims | `node poidh-cli.js get-claims <bountyId> [offset]` | 查看所有 claim |
| get-claim-uri | `node poidh-cli.js get-claim-uri <claimId>` | 获取 claim 的 NFT URI |
| accept-claim | `node poidh-cli.js accept-claim <bountyId> <claimId>` | 接受 claim（solo bounty） |
| submit-vote | `node poidh-cli.js submit-vote <bountyId> <claimId>` | 提交投票（open bounty） |
| check-vote | `node poidh-cli.js check-vote <bountyId>` | 查看投票状态 |
| resolve-vote | `node poidh-cli.js resolve-vote <bountyId>` | 结算投票 |
| balance | `node poidh-cli.js balance` | 查钱包余额和待提现 |
| withdraw | `node poidh-cli.js withdraw [地址]` | 提现 |
| min-amounts | `node poidh-cli.js min-amounts` | 查最低金额 |

## 环境变量

| 变量 | 说明 |
|------|------|
| POIDH_CHAIN | 目标链：base / arbitrum / degen（默认 base） |
| RPC_URL | 链的 RPC URL |
| PRIVATE_KEY | （可选）不设则自动读 farcaster-agent 的 custodyPrivateKey |

## 最低金额

- Arbitrum/Base: 0.001 ETH（悬赏），0.00001 ETH（贡献）
- Degen: 1000 DEGEN（悬赏），10 DEGEN（贡献）

## V3 合约 ID 偏移

- 网站 ID = 链上 ID + 986
- 例：链上 bounty ID 67 → 网站 URL 是 /bounty/1053
- bot 发公告时已自动处理偏移

## 注意

- 只能用 EOA 钱包，合约钱包会被拒
- 不能 claim 自己发的 bounty
- 提交 claim 不需要 ETH（只需 gas）
- open bounty 有外部贡献者时，接受 claim 需要走投票流程（2天）
- 链接：https://poidh.xyz
