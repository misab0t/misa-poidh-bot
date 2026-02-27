# misa-poidh-bot — Autonomous On-Chain Bounty Agent

An autonomous AI agent that creates real-world bounties on [poidh](https://poidh.xyz) (pics or it didn't happen), monitors submissions, evaluates them using AI vision, selects a winner, and executes the payout on-chain — all without human intervention.

Running as [@misabot on Farcaster](https://warpcast.com/misabot) (FID: 2833742) on Base L2.

## Architecture

```
Farcaster Mention                        Cron (every 30min)
  "@misabot create a bounty..."            node poidh-bot.js run
       │                                        │
       ▼                                        ▼
 webhook-handler.mjs                    ┌───────────────────┐
  ├─ detect bounty request              │   poidh-bot.js    │
  ├─ auto-queue pending                 │   (Autonomous)    │
  └─ Gemini replies with wallet addr    ├───────────────────┤
                                        │ checkPendingFunds │──► detect payment → auto-create bounty
                                        │ resolveOpenVote   │──► resolve 2-day vote if deadline passed
                                        │ monitorAndEvaluate│──► fetch claims → Gemini vision score
                                        │ selectAndAccept   │──► pick winner → on-chain accept/vote
                                        └────────┬──────────┘
                                                 │
                              ┌───────────────────┼────────────────────┐
                              ▼                   ▼                    ▼
                          PoidhV3             Gemini 3             Farcaster
                         Contract            Flash Vision         (Explain)
                          (Base)             (Evaluate)
```

## How Autonomy is Enforced

1. **No human signing** — Bot controls its own EOA wallet via private key
2. **Automated scheduling** — Cron runs `poidh-bot.js run` every 30 minutes
3. **AI evaluation** — Gemini 3 Flash vision scores each submission on relevance, quality, and authenticity (0-30 scale), with dedicated AI-generated image detection
4. **Deterministic selection** — Highest scoring claim above threshold (15/30) wins after 24h minimum wait
5. **On-chain execution** — `acceptClaim` (solo) or `submitClaimForVote` + `resolveVote` (open bounty) called programmatically
6. **Gemini health check** — Before settlement, verifies Gemini API is responding to prevent fallback-induced errors
7. **Public transparency** — Every claim evaluation posted individually, full ranking posted before settlement, winner explanation posted after

## Supported Chains

| Chain | Contract | Min Bounty |
|-------|----------|-----------|
| Base | `0x5555Fa783936C260f77385b4E153B9725feF1719` | 0.001 ETH |
| Arbitrum | `0x5555Fa783936C260f77385b4E153B9725feF1719` | 0.001 ETH |
| Degen | `0x18E5585ca7cE31b90Bc8BB7aAf84152857cE243f` | 1000 DEGEN |

## Setup

### Prerequisites
- Node.js v18+
- An EOA wallet with ETH for gas + bounty amount
- Gemini API key (for vision evaluation)

### Environment Variables
```bash
GOOGLE_API_KEY=your-gemini-api-key     # Required: for AI evaluation
RPC_URL=https://mainnet.base.org       # Required: chain RPC
PRIVATE_KEY=0x...                      # Required: EOA private key
NEYNAR_API_KEY=your-neynar-api-key     # Required: for Farcaster posting
NEYNAR_SIGNER_UUID=your-signer-uuid    # Required: approved Farcaster signer
POIDH_CHAIN=base                       # Optional: base (default), arbitrum, or degen
```

### Install
```bash
cd scripts
npm install
```

### Run

```bash
# Create a bounty
node poidh-bot.js start --type open --name "Show your city" --desc "Take a photo of your city right now" --amount 0.001

# Full auto cycle (check pending funds → resolve votes → monitor claims → settle)
node poidh-bot.js run

# Check status
node poidh-bot.js status

# Accept a specific claim by ID
node poidh-bot.js accept-claim 7

# Auto-select the best claim (no minimum wait)
node poidh-bot.js select-winner

# Resolve an open bounty vote after deadline
node poidh-bot.js resolve-vote

# Withdraw pending payouts
node poidh-bot.js withdraw

# Withdraw to a specific address
node poidh-bot.js withdraw 0x1234...

# Queue a pending bounty request (for webhook integration)
node poidh-bot.js queue --name "Sunset photo" --amount 0.002 --from "kenny" --chain base

# View pending requests
node poidh-bot.js pending
```

### Cron Setup
```bash
*/30 * * * * cd /path/to/scripts && node poidh-bot.js run >> bot-cron.log 2>&1
```

## Bounty Lifecycle

### Solo Bounty
1. `createSoloBounty` → escrow funds
2. Monitor claims every 30 min → Gemini vision evaluates each
3. Post evaluation for each claim on Farcaster
4. After 24h, if best score >= 15/30 → post full ranking → `acceptClaim` → post explanation

### Open Bounty (with external contributors)
1. `createOpenBounty` → escrow funds, others can add funds
2. Same monitoring + evaluation as solo
3. After 24h → `submitClaimForVote` (issuer's weight auto-votes YES)
4. Contributors have 2 days to vote YES/NO
5. After deadline → `resolveVote` → funds distributed if YES > 50%

### Pending Bounty System (Farcaster-triggered)
1. Someone @mentions bot: "create a bounty about X for 0.01 ETH"
2. Webhook detects request → queues it → Gemini replies with wallet address
3. User sends funds to bot wallet
4. Next cron run detects balance increase → matches pending request → auto-creates open bounty

## Evaluation Logic

Each claim is scored by Gemini 3 Flash vision:

| Criterion | Score | What it measures |
|-----------|-------|-----------------|
| Relevance | 0-10 | Does the image match the bounty description? |
| Quality | 0-10 | Is it clear, well-composed, and convincing? |
| Authenticity | 0-10 | Is it a real photo, not AI-generated? Checks hands/fingers, text, skin texture, eyes, background consistency, lighting, sensor noise. Strong AI indicators → 0-2, suspicious → 3-5, clearly real → 8-10. |

- **Total**: Sum of three scores (max 30)
- **Minimum threshold**: 15/30 to be eligible
- **Wait period**: 24h minimum before settlement
- **Safety**: Gemini API health check before any settlement decision

## CLI Tool

`poidh-cli.js` provides direct contract interaction for manual operations:

```bash
POIDH_CHAIN=base RPC_URL=$RPC_URL node poidh-cli.js create-bounty solo "Title" "Description" 0.001
node poidh-cli.js get-claims 42
node poidh-cli.js accept-claim 42 7
node poidh-cli.js balance
node poidh-cli.js withdraw
```

## Files

| File | Purpose |
|------|---------|
| `scripts/poidh-bot.js` | Autonomous bot: create, monitor, evaluate, settle |
| `scripts/poidh-cli.js` | Manual CLI for direct contract interaction |
| `scripts/package.json` | Dependencies (ethers.js) |
| `SKILL.md` | Skill definition for OpenClaw integration |

## Bot State Files (auto-generated)

| File | Purpose |
|------|---------|
| `bot-state.json` | Current phase, bounty details, evaluated claims, winner |
| `bot-log.json` | Full audit trail of all actions |
| `bot-summary.txt` | Human-readable status for external systems (Gemini follow-up) |
| `pending-bounties.json` | Queued bounty creation requests |
| `balance-snapshot.json` | Wallet balance tracking for payment detection |

## Assumptions

- Bounties require **real-world actions** (photos, videos, physical tasks)
- Bot uses Gemini 3 Flash for vision evaluation — edge cases may be misjudged
- Single image evaluation per claim (video evaluated by thumbnail/metadata)
- Cron must be running for autonomous operation
- Bot wallet needs sufficient ETH for gas + bounty amounts

## Limitations

- Multi-chain supported (Base, Arbitrum, Degen) but primarily tested on Base
- Gemini API quota limits may delay evaluations
- Bounties auto-expire after 7 days with no claims, or 5 days if all scores < 15/30
- Open bounty vote resolution requires 2-day waiting period
- If vote fails (NO > YES), bounty returns to monitoring for new submissions

## Social Account

[@misabot on Farcaster](https://warpcast.com/misabot) — all evaluations, rankings, and winner explanations are posted publicly.

## License

MIT
