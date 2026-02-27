const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Config ---
const CHAINS = {
  base: {
    contract: '0x5555Fa783936C260f77385b4E153B9725feF1719',
    url: 'https://poidh.xyz/base',
    idOffset: 986,
  },
  arbitrum: {
    contract: '0x5555Fa783936C260f77385b4E153B9725feF1719',
    url: 'https://poidh.xyz/arbitrum',
    idOffset: 0,
  },
  degen: {
    contract: '0x18E5585ca7cE31b90Bc8BB7aAf84152857cE243f',
    url: 'https://poidh.xyz/degen',
    idOffset: 0,
  },
};

const CHAIN_NAME = process.env.POIDH_CHAIN || 'base';
const CHAIN = CHAINS[CHAIN_NAME] || CHAINS.base;

// PoidhV2 ABI (actual contract on Base)
const ABI = [
  'function createSoloBounty(string name, string description) payable',
  'function createOpenBounty(string name, string description) payable',
  'function createClaim(uint256 bountyId, string name, string description, string uri)',
  'function acceptClaim(uint256 bountyId, uint256 claimId)',
  'function submitClaimForVote(uint256 bountyId, uint256 claimId)',
  'function resolveVote(uint256 bountyId)',
  'function withdraw()',
  'function withdrawTo(address recipient)',
  'function getClaimsByBountyId(uint256 bountyId, uint256 offset) view returns (tuple(uint256 id, address issuer, uint256 bountyId, address bountyIssuer, string name, string description, uint256 createdAt, bool accepted)[])',
  'function bounties(uint256) view returns (uint256 id, address issuer, string name, string description, uint256 amount, address claimer, uint256 createdAt, uint256 claimId)',
  'function bountyVotingTracker(uint256) view returns (uint256 yesWeight, uint256 noWeight, uint256 deadline)',
  'function bountyCurrentVotingClaim(uint256) view returns (uint256)',
  'function everHadExternalContributor(uint256) view returns (bool)',
  'function pendingWithdrawals(address) view returns (uint256)',
  'function poidhNft() view returns (address)',
  'function MIN_BOUNTY_AMOUNT() view returns (uint256)',
  'function MIN_CONTRIBUTION() view returns (uint256)',
  'event BountyCreated(uint256 indexed bountyId, address indexed issuer)',
  'event ClaimCreated(uint256 indexed claimId, address indexed issuer, uint256 indexed bountyId)',
];

const NFT_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
];

const STATE_FILE = path.join(__dirname, 'bot-state.json');
const LOG_FILE = path.join(__dirname, 'bot-log.json');
const PENDING_FILE = path.join(__dirname, 'pending-bounties.json');
const BALANCE_SNAPSHOT_FILE = path.join(__dirname, 'balance-snapshot.json');
const LOCK_FILE = path.join(__dirname, '.bot-lock');

// --- Lock to prevent concurrent cron runs ---
function acquireLock() {
  try {
    // Check if stale lock exists (> 10 minutes old)
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      const age = Date.now() - stat.mtimeMs;
      if (age < 10 * 60 * 1000) {
        const pid = fs.readFileSync(LOCK_FILE, 'utf8').trim();
        console.log(`Another instance is running (pid ${pid}, ${Math.round(age / 1000)}s ago). Exiting.`);
        return false;
      }
      console.log(`Stale lock found (${Math.round(age / 1000)}s old), removing.`);
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch { return true; }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// --- Helpers ---

// Atomic write: write to tmp then rename to prevent corrupted JSON on crash
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}

function saveState(state) {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
  updateSummary(state);
}

function appendLog(entry) {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  logs.push({ ...entry, timestamp: new Date().toISOString() });
  // Keep last 500 entries to prevent unbounded growth
  if (logs.length > 500) logs = logs.slice(-500);
  atomicWrite(LOG_FILE, JSON.stringify(logs, null, 2));
}

// --- Export readable summary for external systems (e.g. Farcaster webhook/Gemini) ---
const SUMMARY_FILE = path.join(__dirname, 'bot-summary.txt');

function updateSummary(state) {
  if (!state) { state = loadState(); }
  if (!state) {
    try { fs.unlinkSync(SUMMARY_FILE); } catch {}
    return;
  }

  const stateChain = CHAINS[state.chain || CHAIN_NAME] || CHAIN;
  const webId = state.bountyId + stateChain.idOffset;
  let summary = `POIDH BOT STATUS\n`;
  summary += `Phase: ${state.phase}\n`;
  summary += `Bounty: "${state.bountyName}" (#${state.bountyId}, web: ${webId})\n`;
  summary += `URL: ${stateChain.url}/bounty/${webId}\n`;
  summary += `Amount: ${state.amount} ETH\n`;
  summary += `Created: ${state.createdAt}\n`;
  summary += `Claims evaluated: ${state.evaluatedClaims.length}\n\n`;

  if (state.evaluatedClaims.length > 0) {
    const sorted = [...state.evaluatedClaims].sort((a, b) => b.score - a.score || a.id - b.id);
    summary += `EVALUATIONS (ranked):\n`;
    sorted.forEach((c, i) => {
      summary += `${i + 1}. Claim #${c.id} — ${c.score}/30 (r:${c.relevance} q:${c.quality} a:${c.authenticity}) — ${c.reasoning}\n`;
    });
    summary += '\n';
  }

  if (state.winner) {
    summary += `WINNER: Claim #${state.winner.id} — ${state.winner.score}/30\n`;
    summary += `Reason: ${state.winner.reasoning}\n`;
    summary += `TX: ${state.acceptTxHash || state.voteTxHash || 'pending'}\n`;
  }

  fs.writeFileSync(SUMMARY_FILE, summary);
}

// --- Pending bounty requests ---
function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); }
  catch { return []; }
}

function savePending(list) {
  atomicWrite(PENDING_FILE, JSON.stringify(list, null, 2));
}

function addPendingRequest(name, description, amount, requestedBy, chain = 'base', castHash = '', authorFid = 0) {
  const list = loadPending();
  list.push({ name, description, amount, requestedBy, chain, castHash, authorFid, createdAt: new Date().toISOString() });
  savePending(list);
  const token = chain === 'degen' ? 'DEGEN' : 'ETH';
  console.log(`Pending bounty request saved: "${name}" for ${amount} ${token} on ${chain} from @${requestedBy}`);
}

// Balance snapshot is per-chain: { "base": { balance, timestamp }, "arbitrum": { ... } }
function loadBalanceSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(BALANCE_SNAPSHOT_FILE, 'utf8'));
    // Migrate old format (flat { balance, timestamp }) to per-chain
    if (data.balance !== undefined && !data.base) return { base: data };
    return data;
  } catch { return {}; }
}

function saveBalanceSnapshot(snapshots) {
  atomicWrite(BALANCE_SNAPSHOT_FILE, JSON.stringify(snapshots));
}

const RPC_URLS = {
  base: 'https://mainnet.base.org',
  arbitrum: 'https://arb1.arbitrum.io/rpc',
  degen: 'https://rpc.degen.tips',
};

// Check if funds arrived on any chain and create bounty if so
async function checkPendingFunds() {
  let pending = loadPending();
  if (pending.length === 0) return;

  // Expire pending requests older than 10 minutes
  const now = Date.now();
  const expired = pending.filter(p => now - new Date(p.createdAt).getTime() > 10 * 60 * 1000);
  if (expired.length > 0) {
    expired.forEach(p => console.log(`Expired pending request: "${p.name}" from @${p.requestedBy} (${p.createdAt})`));
    pending = pending.filter(p => now - new Date(p.createdAt).getTime() <= 10 * 60 * 1000);
    savePending(pending);
    if (pending.length === 0) return;
  }

  let walletAddress;
  try {
    let pk = process.env.PRIVATE_KEY;
    if (!pk) { console.error('PRIVATE_KEY env var not set'); return; }
    if (!pk.startsWith('0x')) pk = '0x' + pk;
    walletAddress = new ethers.Wallet(pk).address;
  } catch (e) { console.error('Invalid PRIVATE_KEY'); return; }

  const snapshots = loadBalanceSnapshot();

  // Check all supported chains (not just chains in pending) to enable cross-chain detection
  const chains = Object.keys(RPC_URLS);

  for (const chain of chains) {
    const rpcUrl = RPC_URLS[chain] || RPC_URLS.base;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    let currentBalance;
    try {
      currentBalance = parseFloat(ethers.formatEther(await provider.getBalance(walletAddress)));
    } catch (e) {
      console.log(`Could not check ${chain} balance: ${e.message}`);
      continue;
    }

    const chainSnapshot = snapshots[chain] || { balance: null };

    // First run for this chain: just save snapshot
    if (chainSnapshot.balance === null) {
      snapshots[chain] = { balance: currentBalance, timestamp: new Date().toISOString() };
      saveBalanceSnapshot(snapshots);
      console.log(`${chain} balance snapshot saved: ${currentBalance}`);
      continue;
    }

    const increase = currentBalance - chainSnapshot.balance;
    const minIncrease = chain === 'degen' ? 500 : 0.0005;
    if (increase < minIncrease) {
      snapshots[chain] = { balance: currentBalance, timestamp: new Date().toISOString() };
      saveBalanceSnapshot(snapshots);
      continue;
    }

    const token = chain === 'degen' ? 'DEGEN' : 'ETH';
    console.log(`${chain}: balance increased by ${increase.toFixed(6)} ${token}`);

    // Match against pending requests — first try same chain, then cross-chain (user sent to wrong chain)
    const chainPending = pending.filter(p => (p.chain || 'base') === chain);
    const allPending = pending; // fallback: match any chain
    let matched = null;
    let bestDelta = Infinity;

    // Priority 1: match same-chain pending
    for (const p of chainPending) {
      const requested = parseFloat(p.amount);
      const delta = Math.abs(increase - requested);
      const tolerance = requested * 0.2;
      if (delta <= tolerance && delta < bestDelta) {
        matched = p;
        bestDelta = delta;
      }
    }
    if (!matched) {
      matched = chainPending.find(p => {
        const requested = parseFloat(p.amount);
        return increase >= requested * 0.9 && increase <= requested * 1.5;
      });
    }

    // Priority 2: cross-chain match (user transferred to wrong chain)
    if (!matched) {
      bestDelta = Infinity;
      for (const p of allPending) {
        if ((p.chain || 'base') === chain) continue; // already tried
        const requested = parseFloat(p.amount);
        const delta = Math.abs(increase - requested);
        const tolerance = requested * 0.2;
        if (delta <= tolerance && delta < bestDelta) {
          matched = p;
          bestDelta = delta;
          console.log(`Cross-chain match: user requested on ${p.chain || 'base'} but funds arrived on ${chain}. Creating on ${chain} instead.`);
        }
      }
      if (!matched) {
        const crossMatch = allPending.find(p => {
          if ((p.chain || 'base') === chain) return false;
          const requested = parseFloat(p.amount);
          return increase >= requested * 0.9 && increase <= requested * 1.5;
        });
        if (crossMatch) {
          matched = crossMatch;
          console.log(`Cross-chain match: user requested on ${crossMatch.chain || 'base'} but funds arrived on ${chain}. Creating on ${chain} instead.`);
        }
      }
    }

    if (!matched) {
      console.log(`${chain}: increase ${increase.toFixed(6)} ${token} but no pending request matches`);
      snapshots[chain] = { balance: currentBalance, timestamp: new Date().toISOString() };
      saveBalanceSnapshot(snapshots);
      continue;
    }

    console.log(`Matched: "${matched.name}" for ${matched.amount} ${token} on ${chain} from @${matched.requestedBy}`);

    // Update balance snapshot immediately (so we don't re-trigger on same increase)
    snapshots[chain] = { balance: currentBalance, timestamp: new Date().toISOString() };
    saveBalanceSnapshot(snapshots);

    // Check if another bounty is already active
    const state = loadState();
    if (state && state.phase === 'monitoring') {
      const elapsedH = (Date.now() - new Date(state.createdAt).getTime()) / (1000 * 60 * 60);
      const bestScore = state.evaluatedClaims.length > 0
        ? Math.max(...state.evaluatedClaims.map(c => c.score))
        : 0;

      // Auto-expire old bounty if: >24h and no good claims (best < 15), or >48h regardless
      if (elapsedH > 48 || (elapsedH > 24 && bestScore < 15)) {
        console.log(`Auto-expiring bounty #${state.bountyId} (${elapsedH.toFixed(1)}h, best score ${bestScore}/30) to make room for new bounty`);
        state.phase = 'expired';
        saveState(state);
        appendLog({ event: 'bounty_auto_expired', bountyId: state.bountyId, reason: `${elapsedH.toFixed(1)}h, best ${bestScore}/30, new pending` });
      } else {
        console.log(`Another bounty is active (#${state.bountyId}, ${elapsedH.toFixed(1)}h, best ${bestScore}/30). Will retry later.`);
        continue;
      }
    }

    // Try to create the bounty
    let newState = null;
    try {
      newState = await createBounty({
        type: 'open',
        name: matched.name,
        description: matched.description || matched.name,
        amount: matched.amount,
        chain: chain,
        castHash: matched.castHash || '',
        authorFid: matched.authorFid || 0,
      });
    } catch (e) {
      console.error(`Failed to create bounty: ${e.message}`);
      appendLog({ event: 'bounty_creation_failed', name: matched.name, chain, reason: e.message.slice(0, 100) });
    }

    if (newState) {
      // Success — remove from pending
      const remaining = pending.filter(p => p !== matched);
      savePending(remaining);
      pending = remaining;

      appendLog({ event: 'auto_created_bounty', name: matched.name, amount: matched.amount, chain, requestedBy: matched.requestedBy });

      // Notify the original requester via Farcaster reply
      if (matched.castHash && matched.authorFid) {
        try {
          const bountyChain = CHAINS[chain] || CHAINS.base;
          const webId = newState.bountyId + bountyChain.idOffset;
          const notifyText = `your bounty is live! "${matched.name}" — ${matched.amount} ${token} on ${chain}\n\n${bountyChain.url}/bounty/${webId}`;
          replyToFarcaster(matched.castHash, matched.authorFid, notifyText);
          console.log(`Notified @${matched.requestedBy} via reply to ${matched.castHash}`);
        } catch (e) {
          console.error(`Failed to notify @${matched.requestedBy}: ${e.message}`);
        }
      }
    } else {
      // Failed — keep in pending for retry (next run or next balance check)
      console.log(`Bounty creation failed. Keeping "${matched.name}" in pending for retry.`);
    }
  }
}

function getWallet() {
  const rpcUrl = process.env.RPC_URL || 'https://mainnet.base.org';
  let privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    console.error('PRIVATE_KEY env var not set');
    process.exit(1);
  }
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  return { wallet, provider };
}

function getContract(wallet) {
  return new ethers.Contract(CHAIN.contract, ABI, wallet);
}

function fetch(url, timeoutMs = 30000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'poidh-bot/1.0' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location, timeoutMs, _redirects + 1).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Fetch timeout after ${timeoutMs}ms: ${url}`)); });
  });
}

function fetchBuffer(url, timeoutMs = 30000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'poidh-bot/1.0' }, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBuffer(res.headers.location, timeoutMs, _redirects + 1).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, data: Buffer.concat(chunks), contentType: res.headers['content-type'] || '' }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Fetch timeout after ${timeoutMs}ms: ${url}`)); });
  });
}

function postJSON(url, body, headers = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, data: d }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`POST timeout after ${timeoutMs}ms: ${url}`)); });
    req.write(data);
    req.end();
  });
}

// --- Gemini Vision Evaluation ---
async function evaluateWithGemini(imageUrl, bountyName, bountyDesc, claimName, claimDesc) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

  let imageData, mimeType;
  try {
    const img = await fetchBuffer(imageUrl);
    imageData = img.data.toString('base64');
    const ct = img.contentType.toLowerCase();
    if (ct.includes('png')) mimeType = 'image/png';
    else if (ct.includes('webp')) mimeType = 'image/webp';
    else if (ct.includes('gif')) mimeType = 'image/gif';
    else if (ct.includes('svg')) mimeType = 'image/svg+xml';
    else mimeType = 'image/jpeg';
  } catch (e) {
    return { total: 0, relevance: 0, quality: 0, authenticity: 0, reasoning: `Could not fetch image: ${e.message}` };
  }

  const prompt = `You are an impartial judge evaluating a submission for an on-chain bounty.

Bounty: "${bountyName}"
Description: "${bountyDesc}"

Submission title: "${claimName}"
Submission description: "${claimDesc}"

The attached image is the submission proof.

Evaluate on these criteria (0-10 each):
1. RELEVANCE: Does the image match what the bounty asked for?
2. QUALITY: Is the image clear, well-composed, and convincing?
3. AUTHENTICITY: Is this a real photograph, not AI-generated?
   Check carefully for these AI-generation signs:
   - Hands/fingers: wrong number, fused, melted, extra joints
   - Text/signs: garbled, misspelled, or nonsensical letters
   - Skin: too smooth, waxy, plastic-looking, uncanny valley
   - Eyes: asymmetric pupils, different iris patterns, unnaturally sharp
   - Background: objects that blur/merge/dissolve, impossible geometry
   - Lighting: inconsistent shadows, light coming from multiple directions
   - Overall: too perfect, too clean, no sensor noise, no lens distortion
   - Style: looks like Midjourney/DALL-E/Stable Diffusion output
   If you detect ANY strong AI indicators, score authenticity 0-2.
   If uncertain but suspicious, score 3-5.
   Only score 8-10 if the image clearly looks like a real camera photo.

Respond in this exact JSON format only, no other text:
{"relevance": N, "quality": N, "authenticity": N, "total": N, "reasoning": "one sentence explanation"}

The "total" should be the sum of the three scores (max 30).`;

  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: imageData } }
      ]
    }]
  };

  const res = await postJSON(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
    body,
    {},
    60000 // 60s for vision evaluation with large images
  );

  try {
    const parsed = JSON.parse(res.data);
    if (!parsed.candidates || !parsed.candidates[0]?.content?.parts?.[0]?.text) {
      const reason = parsed.error?.message || parsed.promptFeedback?.blockReason || 'no candidates';
      return { total: 0, relevance: 0, quality: 0, authenticity: 0, reasoning: `Gemini blocked: ${reason}` };
    }
    const text = parsed.candidates[0].content.parts[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    return { total: 0, relevance: 0, quality: 0, authenticity: 0, reasoning: `Gemini parse error: ${e.message}` };
  }
  return { total: 0, relevance: 0, quality: 0, authenticity: 0, reasoning: 'Gemini returned unexpected format' };
}

// --- Resolve claim image URL ---
async function resolveClaimImage(claimId, contract, provider) {
  try {
    const nftAddr = await contract.poidhNft();
    const nft = new ethers.Contract(nftAddr, NFT_ABI, provider);
    let uri = await nft.tokenURI(claimId);

    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    else if (uri.startsWith('ar://')) uri = uri.replace('ar://', 'https://arweave.net/');

    // Handle base64 data URIs (e.g. data:application/json;base64,...)
    let metaText;
    if (uri.startsWith('data:')) {
      const b64Match = uri.match(/base64,(.+)/);
      if (b64Match) metaText = Buffer.from(b64Match[1], 'base64').toString('utf8');
      else return null;
    } else {
      const res = await fetch(uri);
      metaText = res.data;
    }

    try {
      const meta = JSON.parse(metaText);
      let imgUrl = meta.animation_url || meta.image || uri;
      if (imgUrl.startsWith('ipfs://')) imgUrl = imgUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
      else if (imgUrl.startsWith('ar://')) imgUrl = imgUrl.replace('ar://', 'https://arweave.net/');
      return imgUrl;
    } catch {
      return uri.startsWith('data:') ? null : uri;
    }
  } catch (e) {
    return null;
  }
}

// --- Farcaster posting via Neynar API ---
function truncateToBytes(text, maxBytes = 320) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes - 3) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '...';
}

async function postToFarcaster(text, channel = null) {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;
  if (!apiKey || !signerUuid) {
    console.log('NEYNAR_API_KEY or NEYNAR_SIGNER_UUID not set, skipping Farcaster post.');
    return null;
  }

  const truncated = truncateToBytes(text);
  const body = { signer_uuid: signerUuid, text: truncated };
  if (channel) body.channel_id = channel;

  try {
    const res = await postJSON('https://api.neynar.com/v2/farcaster/cast', body, { 'x-api-key': apiKey });
    const data = JSON.parse(res.data);
    if (data.success && data.cast) {
      appendLog({ event: 'farcaster_post_ok', hash: data.cast.hash });
      return data.cast.hash;
    }
    console.error('Farcaster post unexpected response:', res.data.slice(0, 200));
    appendLog({ event: 'farcaster_post_ok', output: res.data.slice(0, 100) });
    return null;
  } catch (e) {
    console.error('Farcaster post failed:', e.message.slice(0, 200));
    appendLog({ event: 'farcaster_post_failed', reason: e.message.slice(0, 100) });
    return null;
  }
}

async function replyToFarcaster(parentHash, parentFid, text) {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;
  if (!apiKey || !signerUuid) {
    console.log('NEYNAR_API_KEY or NEYNAR_SIGNER_UUID not set, skipping Farcaster reply.');
    return null;
  }

  const truncated = truncateToBytes(text);
  const body = { signer_uuid: signerUuid, text: truncated, parent: parentHash, parent_author_fid: Number(parentFid) };

  try {
    const res = await postJSON('https://api.neynar.com/v2/farcaster/cast', body, { 'x-api-key': apiKey });
    const data = JSON.parse(res.data);
    if (data.success && data.cast) {
      appendLog({ event: 'farcaster_reply_ok', parentHash, hash: data.cast.hash });
      return data.cast.hash;
    }
    return null;
  } catch (e) {
    console.error('Farcaster reply failed:', e.message.slice(0, 200));
    appendLog({ event: 'farcaster_reply_failed', parentHash, reason: e.message.slice(0, 100) });
    return null;
  }
}

// --- Bot Phases ---

// Phase 1: Create bounty
async function createBounty(opts = {}) {
  // Allow chain override for multi-chain pending funds
  const chainName = opts.chain || CHAIN_NAME;
  const chain = CHAINS[chainName] || CHAINS.base;
  const rpcUrl = opts.chain ? (RPC_URLS[chainName] || 'https://mainnet.base.org') : (process.env.RPC_URL || 'https://mainnet.base.org');
  let privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error('PRIVATE_KEY env var not set'); process.exit(1); }
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(chain.contract, ABI, wallet);

  const type = opts.type || 'open';
  const name = opts.name || 'Show your city right now';
  const desc = opts.description || 'Take a photo of something happening in your city right now — a street scene, a sunset, a market, anything real and current. Must be an original photo taken by you today. Most vivid and authentic photo wins.';
  let amount = opts.amount || '0.001';

  // Check minimum bounty amount
  try {
    const minAmount = await contract.MIN_BOUNTY_AMOUNT();
    const value = ethers.parseEther(amount);
    if (value < minAmount) {
      console.error(`Amount ${amount} ETH is below minimum ${ethers.formatEther(minAmount)} ETH`);
      return;
    }
  } catch (e) {
    console.log(`Warning: Could not check MIN_BOUNTY_AMOUNT: ${e.message}`);
  }

  // Check wallet has enough balance for bounty amount + gas
  const value = ethers.parseEther(amount);
  const walletBalance = await provider.getBalance(wallet.address);
  const gasBuffer = ethers.parseEther('0.0002'); // ~0.0002 ETH buffer for gas on L2
  if (walletBalance < value + gasBuffer) {
    // If not enough for full amount + gas, reduce amount to leave gas room
    const adjustedValue = walletBalance - gasBuffer;
    if (adjustedValue <= 0n) {
      console.error(`Wallet balance ${ethers.formatEther(walletBalance)} ETH too low for bounty + gas`);
      return null;
    }
    const adjustedAmount = ethers.formatEther(adjustedValue);
    console.log(`Adjusting bounty amount from ${amount} to ${adjustedAmount} ETH (leaving gas buffer)`);
    amount = adjustedAmount;
  }

  const fn = type === 'open' ? 'createOpenBounty' : 'createSoloBounty';
  console.log(`Creating ${type} bounty: "${name}" for ${amount} ETH...`);
  const tx = await contract[fn](name, desc, { value: ethers.parseEther(amount) });
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();

  // Parse bounty ID from receipt logs (match contract address + topics with bountyId)
  let bountyId = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() === contract.target.toLowerCase() && log.topics.length >= 2) {
      bountyId = Number(BigInt(log.topics[1]));
      break;
    }
  }

  if (bountyId === null) throw new Error('Could not parse bounty ID from receipt');

  const state = {
    phase: 'monitoring',
    bountyId,
    bountyName: name,
    bountyDesc: desc,
    amount,
    chain: chainName,
    txHash: tx.hash,
    createdAt: new Date().toISOString(),
    evaluatedClaims: [],
    winner: null,
    acceptTxHash: null,
    farcasterPostHash: null,
    castHash: opts.castHash || '',
    authorFid: opts.authorFid || 0,
  };
  saveState(state);
  appendLog({ event: 'bounty_created', bountyId, txHash: tx.hash });

  const webId = bountyId + chain.idOffset;
  console.log(`Bounty #${bountyId} (web: ${webId}) created: ${chain.url}/bounty/${webId}`);

  // Announce on Farcaster
  try {
    const chainLabel = chainName.charAt(0).toUpperCase() + chainName.slice(1);
    const typeLabel = type === 'open' ? 'open bounty (anyone can add funds)' : 'bounty';
    const token = chainName === 'degen' ? 'DEGEN' : 'ETH';
    const postText = `new ${typeLabel} on poidh: "${name}" — ${amount} ${token} on ${chainLabel}\n\n${chain.url}/bounty/${webId}`;
    await postToFarcaster(postText, 'poidh');
    console.log('Announced on Farcaster.');
    appendLog({ event: 'farcaster_announce', bountyId, webId });
  } catch (e) {
    console.error('Farcaster announce failed:', e.message);
  }

  return state;
}

// Get wallet and contract for the chain stored in state (or default)
function getWalletForState(state) {
  const chainName = state?.chain || CHAIN_NAME;
  const chain = CHAINS[chainName] || CHAINS.base;
  const rpcUrl = RPC_URLS[chainName] || process.env.RPC_URL || 'https://mainnet.base.org';
  let privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) { console.error('PRIVATE_KEY env var not set'); process.exit(1); }
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(chain.contract, ABI, wallet);
  return { wallet, provider, contract, chain, chainName };
}

// Phase 2: Monitor and evaluate claims
async function monitorAndEvaluate() {
  const state = loadState();
  if (!state || state.phase !== 'monitoring') {
    console.log('No active bounty in monitoring phase.');
    return;
  }

  const { wallet, provider, contract, chain: stateChain } = getWalletForState(state);

  // Check bounty still active
  const bounty = await contract.bounties(state.bountyId);
  if (bounty.claimer !== ethers.ZeroAddress) {
    console.log('Bounty already finalized.');
    state.phase = 'completed';
    saveState(state);
    return;
  }

  // Fetch all claims (paginate in batches of 10, contract reverts when offset exceeds)
  let allFetchedClaims = [];
  let offset = 0;
  while (true) {
    let batch;
    try {
      batch = await contract.getClaimsByBountyId(state.bountyId, offset);
    } catch {
      break; // contract reverts when offset exceeds total claims
    }
    if (batch.length === 0) break;
    allFetchedClaims = allFetchedClaims.concat(batch);
    if (batch.length < 10) break;
    offset += 10;
  }

  const newClaims = allFetchedClaims.filter(c =>
    c.issuer !== ethers.ZeroAddress && !c.accepted && !state.evaluatedClaims.find(ec => ec.id === Number(c.id))
  );
  if (newClaims.length === 0) {
    console.log(`No new claims. Total evaluated: ${state.evaluatedClaims.length}`);
    return;
  }

  console.log(`Found ${newClaims.length} new claim(s). Evaluating...`);

  for (const claim of newClaims) {
    const claimId = Number(claim.id);
    console.log(`\nEvaluating claim #${claimId}: "${claim.name}"`);

    const imageUrl = await resolveClaimImage(claimId, contract, provider);
    if (!imageUrl) {
      console.log('  Could not resolve image, skipping.');
      state.evaluatedClaims.push({ id: claimId, issuer: claim.issuer, name: claim.name, description: claim.description, score: 0, relevance: 0, quality: 0, authenticity: 0, reasoning: 'Could not resolve image' });
      continue;
    }

    console.log(`  Image: ${imageUrl}`);
    const evaluation = await evaluateWithGemini(imageUrl, state.bountyName, state.bountyDesc, claim.name, claim.description);
    console.log(`  Score: ${evaluation.total || 0}/30 — ${evaluation.reasoning}`);

    state.evaluatedClaims.push({
      id: claimId,
      issuer: claim.issuer,
      name: claim.name,
      description: claim.description,
      imageUrl,
      score: evaluation.total || 0,
      relevance: evaluation.relevance || 0,
      quality: evaluation.quality || 0,
      authenticity: evaluation.authenticity || 0,
      reasoning: evaluation.reasoning || 'No reasoning',
    });

    appendLog({ event: 'claim_evaluated', claimId, score: evaluation.total || 0, reasoning: evaluation.reasoning });

    // Post evaluation publicly on Farcaster
    try {
      const webId = state.bountyId + stateChain.idOffset;
      const evalPost = `evaluated claim #${claimId} on bounty "${state.bountyName}"\n\nrelevance: ${evaluation.relevance || 0}/10\nquality: ${evaluation.quality || 0}/10\nauthenticity: ${evaluation.authenticity || 0}/10\ntotal: ${evaluation.total || 0}/30\n\n${evaluation.reasoning || 'No reasoning'}\n\n${stateChain.url}/bounty/${webId}`;
      await postToFarcaster(evalPost);
      console.log(`  Posted evaluation on Farcaster.`);
    } catch (e) {
      console.error(`  Farcaster eval post failed: ${e.message}`);
    }
  }

  saveState(state);
  console.log(`\nTotal evaluated claims: ${state.evaluatedClaims.length}`);
}

// Phase 3: Select winner and accept
async function selectAndAccept(minWaitHours = 24) {
  const state = loadState();
  if (!state || state.phase !== 'monitoring') {
    console.log('No active bounty in monitoring phase.');
    return;
  }

  // Check minimum wait time
  const elapsed = (Date.now() - new Date(state.createdAt).getTime()) / (1000 * 60 * 60);
  if (elapsed < minWaitHours) {
    console.log(`Only ${elapsed.toFixed(1)}h since creation. Waiting at least ${minWaitHours}h before selecting winner.`);
    return;
  }

  const userTriggered = minWaitHours === 0; // User explicitly said "pick winner"

  if (state.evaluatedClaims.length === 0) {
    if (userTriggered) {
      console.log('No claims submitted yet. Nothing to pick.');
    } else if (elapsed > 168) {
      console.log('No claims after 7 days. Marking bounty as expired.');
      state.phase = 'expired';
      saveState(state);
      appendLog({ event: 'bounty_expired', bountyId: state.bountyId, reason: 'no claims after 7 days' });
      try {
        const webId = state.bountyId + stateChain.idOffset;
        await postToFarcaster(`bounty "${state.bountyName}" expired — no valid claims after 7 days\n\n${stateChain.url}/bounty/${webId}`);
      } catch (e) { /* ignore */ }
    } else {
      console.log('No claims to evaluate.');
    }
    return;
  }

  // Gemini health check: verify API is working before making settlement decisions
  const apiKey = process.env.GOOGLE_API_KEY;
  if (apiKey) {
    try {
      const testRes = await postJSON(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
        { contents: [{ parts: [{ text: 'reply with "ok"' }] }] }
      );
      const testData = JSON.parse(testRes.data);
      if (!testData.candidates || testData.candidates.length === 0) {
        console.log('Gemini API not healthy (no candidates). Skipping settlement to prevent errors.');
        appendLog({ event: 'settlement_skipped', reason: 'Gemini API unhealthy' });
        return;
      }
    } catch (e) {
      console.log(`Gemini API check failed: ${e.message}. Skipping settlement.`);
      appendLog({ event: 'settlement_skipped', reason: `Gemini check failed: ${e.message}` });
      return;
    }
  }

  // Re-evaluate any claims that scored 0 due to previous API failures
  const { wallet, provider, contract, chain: stateChain } = getWalletForState(state);
  const failedClaims = state.evaluatedClaims.filter(c => c.score === 0 && c.reasoning?.includes('Could not'));
  for (const fc of failedClaims) {
    console.log(`Re-evaluating previously failed claim #${fc.id}...`);
    const imageUrl = await resolveClaimImage(fc.id, contract, provider);
    if (!imageUrl) continue;
    const evaluation = await evaluateWithGemini(imageUrl, state.bountyName, state.bountyDesc, fc.name, fc.description);
    if (evaluation.total > 0) {
      Object.assign(fc, {
        score: evaluation.total,
        relevance: evaluation.relevance || 0,
        quality: evaluation.quality || 0,
        authenticity: evaluation.authenticity || 0,
        reasoning: evaluation.reasoning || 'Re-evaluated',
      });
      console.log(`  Re-evaluated: ${evaluation.total}/30`);
    }
  }
  saveState(state);

  // Sort all claims by score (tie-break: earlier claim ID wins)
  const allClaims = [...state.evaluatedClaims].sort((a, b) => b.score - a.score || a.id - b.id);
  const validClaims = allClaims.filter(c => c.score > 0);
  if (validClaims.length === 0) {
    console.log('No valid claims (all scored 0).');
    return;
  }

  const winner = validClaims[0];

  // Minimum quality threshold (skip if user explicitly triggered)
  if (!userTriggered && winner.score < 15) {
    console.log(`Best score is ${winner.score}/30, below threshold of 15. Waiting for better submissions.`);
    return;
  }

  // Post full ranking on Farcaster BEFORE accepting
  try {
    const webId = state.bountyId + stateChain.idOffset;
    let ranking = `final ranking for bounty "${state.bountyName}" (${allClaims.length} submissions)\n\n`;
    allClaims.forEach((c, i) => {
      const medal = i === 0 ? '1st' : i === 1 ? '2nd' : i === 2 ? '3rd' : `${i + 1}th`;
      ranking += `${medal}: claim #${c.id} — ${c.score}/30 (r:${c.relevance} q:${c.quality} a:${c.authenticity})\n`;
    });
    if (allClaims.length > 1) {
      ranking += `\nweakest: claim #${allClaims[allClaims.length - 1].id} — ${allClaims[allClaims.length - 1].reasoning}`;
    }
    ranking += `\n\n${stateChain.url}/bounty/${webId}`;

    await postToFarcaster(ranking);
    console.log('Posted full ranking on Farcaster.');
    appendLog({ event: 'farcaster_ranking', bountyId: state.bountyId });
  } catch (e) {
    console.error('Farcaster ranking post failed:', e.message);
  }

  console.log(`\nWinner: Claim #${winner.id} by ${winner.issuer}`);
  console.log(`  Score: ${winner.score}/30`);
  console.log(`  Reasoning: ${winner.reasoning}`);

  // Determine acceptance path: solo (direct accept) vs open with contributors (vote flow)
  let needsVote = false;
  try {
    needsVote = await contract.everHadExternalContributor(state.bountyId);
  } catch (e) {
    console.log(`Warning: Could not check everHadExternalContributor: ${e.message}`);
  }

  if (needsVote) {
    // Open bounty vote flow
    console.log('\nOpen bounty with external contributors — submitting claim for vote...');
    const tx = await contract.submitClaimForVote(state.bountyId, winner.id);
    console.log(`TX: ${tx.hash}`);
    await tx.wait();
    console.log('Claim submitted for vote. Contributors have 2 days to vote.');

    state.winner = winner;
    state.voteTxHash = tx.hash;
    state.phase = 'voting';
    state.voteSubmittedAt = new Date().toISOString();
    saveState(state);
    appendLog({ event: 'vote_submitted', claimId: winner.id, txHash: tx.hash });

    try {
      const webId = state.bountyId + stateChain.idOffset;
      const votePost = `submitted claim #${winner.id} for vote on bounty "${state.bountyName}" — score ${winner.score}/30\n\ncontributors have 2 days to vote\n\n${winner.reasoning}\n\n${stateChain.url}/bounty/${webId}`;
      await postToFarcaster(votePost);
    } catch (e) {
      console.error('Farcaster vote post failed:', e.message);
    }
  } else {
    // Solo bounty or open with no external contributors — direct accept
    console.log('\nAccepting claim on-chain...');
    const tx = await contract.acceptClaim(state.bountyId, winner.id);
    console.log(`TX: ${tx.hash}`);
    await tx.wait();
    console.log('Claim accepted!');

    state.winner = winner;
    state.acceptTxHash = tx.hash;
    state.phase = 'accepted';
    saveState(state);
    appendLog({ event: 'claim_accepted', claimId: winner.id, txHash: tx.hash, score: winner.score });

    try {
      const webId = state.bountyId + stateChain.idOffset;
      const explanation = `accepted claim #${winner.id} on my poidh bounty "${state.bountyName}" — score ${winner.score}/30\n\n${winner.reasoning}\n\n${stateChain.url}/bounty/${webId}`;
      await postToFarcaster(explanation);
      appendLog({ event: 'farcaster_explanation', bountyId: state.bountyId });
    } catch (e) {
      console.error('Farcaster post failed:', e.message);
    }
  }

  // Notify the original requester
  if (state.castHash && state.authorFid) {
    try {
      const webId = state.bountyId + stateChain.idOffset;
      await replyToFarcaster(state.castHash, state.authorFid,
        `winner picked for your bounty "${state.bountyName}"! claim #${winner.id} — score ${winner.score}/30\n\n${stateChain.url}/bounty/${webId}`);
    } catch (e) { /* ignore */ }
  }

  console.log('\nBounty settlement complete!');
}

// Accept a specific claim by ID (user-directed)
async function acceptSpecificClaim(claimId) {
  const state = loadState();
  if (!state || state.phase !== 'monitoring') {
    console.log('No active bounty in monitoring phase.');
    return;
  }

  const { wallet, provider, contract, chain: stateChain } = getWalletForState(state);
  const webId = state.bountyId + stateChain.idOffset;

  // Find claim in evaluated list or fetch it
  let claim = state.evaluatedClaims.find(c => c.id === claimId);
  if (!claim) {
    console.log(`Claim #${claimId} not in evaluated list. Checking on-chain...`);
    try {
      const claims = await contract.getClaimsByBountyId(state.bountyId, 0);
      const found = claims.find(c => Number(c.id) === claimId);
      if (!found) {
        console.log(`Claim #${claimId} not found on bounty #${state.bountyId}.`);
        return;
      }
      claim = { id: claimId, issuer: found.issuer, name: found.name, score: 0, reasoning: 'User-selected' };
    } catch (e) {
      console.log(`Error fetching claim: ${e.message}`);
      return;
    }
  }

  console.log(`Accepting user-selected claim #${claimId}...`);

  let needsVote = false;
  try {
    needsVote = await contract.everHadExternalContributor(state.bountyId);
  } catch (e) {
    console.log(`Warning: Could not check everHadExternalContributor: ${e.message}`);
  }

  if (needsVote) {
    console.log('Open bounty with external contributors — submitting claim for vote...');
    const tx = await contract.submitClaimForVote(state.bountyId, claimId);
    console.log(`TX: ${tx.hash}`);
    await tx.wait();
    console.log('Claim submitted for vote. Contributors have 2 days to vote.');
    state.winner = claim;
    state.voteTxHash = tx.hash;
    state.phase = 'voting';
    state.voteSubmittedAt = new Date().toISOString();
    saveState(state);
    appendLog({ event: 'vote_submitted_user', claimId, txHash: tx.hash });
    try {
      await postToFarcaster(`submitted claim #${claimId} for vote on bounty "${state.bountyName}" (user-selected)\n\ncontributors have 2 days to vote\n\n${stateChain.url}/bounty/${webId}`);
    } catch (e) { /* ignore */ }
  } else {
    const tx = await contract.acceptClaim(state.bountyId, claimId);
    console.log(`TX: ${tx.hash}`);
    await tx.wait();
    console.log(`Claim #${claimId} accepted!`);
    state.winner = claim;
    state.acceptTxHash = tx.hash;
    state.phase = 'accepted';
    saveState(state);
    appendLog({ event: 'claim_accepted_user', claimId, txHash: tx.hash });
    try {
      await postToFarcaster(`accepted claim #${claimId} on bounty "${state.bountyName}" (selected by bounty creator)\n\n${stateChain.url}/bounty/${webId}`);
    } catch (e) { /* ignore */ }
  }

  // Notify the original requester
  if (state.castHash && state.authorFid) {
    try {
      await replyToFarcaster(state.castHash, state.authorFid,
        `claim #${claimId} has been accepted on your bounty "${state.bountyName}"!\n\n${stateChain.url}/bounty/${webId}`);
    } catch (e) { /* ignore */ }
  }

  console.log('Done!');
}

// Phase 3b: Resolve vote for open bounties
async function resolveOpenVote() {
  const state = loadState();
  if (!state || state.phase !== 'voting') return;

  const { wallet, contract, chain: stateChain } = getWalletForState(state);

  const [yesWeight, noWeight, deadline] = await contract.bountyVotingTracker(state.bountyId);
  const now = Math.floor(Date.now() / 1000);

  if (now < Number(deadline)) {
    const hoursLeft = Math.ceil((Number(deadline) - now) / 3600);
    console.log(`Vote still active. ${hoursLeft}h remaining. Yes: ${yesWeight}, No: ${noWeight}`);
    return;
  }

  const totalWeight = BigInt(yesWeight) + BigInt(noWeight);
  const votePassed = totalWeight > 0n && BigInt(yesWeight) * 2n > totalWeight;

  console.log(`Vote deadline passed. Yes: ${yesWeight}, No: ${noWeight}. ${votePassed ? 'PASSED' : 'FAILED'}. Resolving...`);
  const tx = await contract.resolveVote(state.bountyId);
  console.log(`TX: ${tx.hash}`);
  await tx.wait();

  const bounty = await contract.bounties(state.bountyId);
  const isFinalized = bounty.claimer !== ethers.ZeroAddress;

  if (isFinalized) {
    console.log('Vote resolved — claim accepted!');
    state.phase = 'accepted';
    state.acceptTxHash = tx.hash;
    saveState(state);
    appendLog({ event: 'vote_resolved', bountyId: state.bountyId, txHash: tx.hash, result: 'accepted', yesWeight: yesWeight.toString(), noWeight: noWeight.toString() });

    try {
      const webId = state.bountyId + stateChain.idOffset;
      await postToFarcaster(`vote resolved on bounty "${state.bountyName}" — claim #${state.winner.id} wins!\n\nyes: ${yesWeight}, no: ${noWeight}\n\n${stateChain.url}/bounty/${webId}`);
    } catch (e) {
      console.error('Farcaster resolve post failed:', e.message);
    }
  } else {
    console.log('Vote resolved but claim was NOT accepted (vote failed). Returning to monitoring.');
    state.phase = 'monitoring';
    state.winner = null;
    state.voteTxHash = null;
    state.voteSubmittedAt = null;
    saveState(state);
    appendLog({ event: 'vote_failed', bountyId: state.bountyId, txHash: tx.hash, yesWeight: yesWeight.toString(), noWeight: noWeight.toString() });

    try {
      const webId = state.bountyId + stateChain.idOffset;
      await postToFarcaster(`vote on bounty "${state.bountyName}" did not pass (yes: ${yesWeight}, no: ${noWeight}). reopening for new submissions.\n\n${stateChain.url}/bounty/${webId}`);
    } catch (e) {
      console.error('Farcaster vote failed post failed:', e.message);
    }
  }
}

// Phase 4: Status check
async function status() {
  const state = loadState();
  if (!state) {
    console.log('No bot state found. Run "start" to create a bounty.');
    return;
  }
  const stateChain = CHAINS[state.chain || CHAIN_NAME] || CHAIN;
  const webId = state.bountyId + stateChain.idOffset;
  console.log(`Phase: ${state.phase}`);
  console.log(`Chain: ${state.chain || CHAIN_NAME}`);
  console.log(`Bounty #${state.bountyId} (web: ${webId}): "${state.bountyName}"`);
  console.log(`Created: ${state.createdAt}`);
  console.log(`Claims evaluated: ${state.evaluatedClaims.length}`);
  console.log(`URL: ${stateChain.url}/bounty/${webId}`);
  if (state.winner) {
    console.log(`Winner: Claim #${state.winner.id} (score: ${state.winner.score}/30)`);
    console.log(`Accept TX: ${state.acceptTxHash || state.voteTxHash || 'pending'}`);
  }
  const elapsed = (Date.now() - new Date(state.createdAt).getTime()) / (1000 * 60 * 60);
  console.log(`Time elapsed: ${elapsed.toFixed(1)}h`);

  // Check recent Farcaster post failures
  try {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
    const recent = logs.slice(-50);
    const fails = recent.filter(l => l.event === 'farcaster_post_failed').length;
    const oks = recent.filter(l => l.event === 'farcaster_post_ok').length;
    if (fails > 0) console.log(`Farcaster posts (last 50 logs): ${oks} ok, ${fails} failed`);
  } catch {}
}

// --- CLI ---
const [,, cmd, ...args] = process.argv;
function parseStartArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--type' && args[i + 1]) opts.type = args[++i];
    else if (args[i] === '--name' && args[i + 1]) opts.name = args[++i];
    else if (args[i] === '--desc' && args[i + 1]) opts.description = args[++i];
    else if (args[i] === '--amount' && args[i + 1]) opts.amount = args[++i];
  }
  return opts;
}

const HELP = `poidh-bot — Autonomous bounty bot

Commands:
  start [options]    Create a new bounty and announce on Farcaster
    --type solo|open   Bounty type (default: open, allows others to add funds)
    --name "..."       Bounty title
    --desc "..."       Bounty description
    --amount 0.001     ETH amount (default: 0.001)
  monitor            Check for new claims and evaluate them
  select-winner      Pick the highest-scored claim and accept it
  accept-claim <id>  Accept a specific claim by ID
  select [hours]     Legacy: select winner with minimum wait (default: 24h)
  resolve-vote       Resolve an open bounty vote
  withdraw [to]      Withdraw pending payouts (optionally to a specific address)
  status             Show current bot state
  run                Full auto: monitor + check pending funds (for cron)
  queue              Add a pending bounty request
    --name "..."       Bounty title
    --desc "..."       Bounty description
    --amount 0.001     ETH amount
    --from "username"  Who requested it
  pending            Show pending bounty requests
`;

(async () => {
  try {
    switch (cmd) {
      case 'start':
        await createBounty(parseStartArgs(args));
        break;
      case 'monitor':
        await monitorAndEvaluate();
        break;
      case 'select-winner':
        await selectAndAccept(0); // No minimum wait — user triggered
        break;
      case 'accept-claim':
        if (!args[0]) { console.error('Usage: accept-claim <claim-id>'); process.exit(1); }
        await acceptSpecificClaim(parseInt(args[0]));
        break;
      case 'select':
        await selectAndAccept(parseInt(args[0]) || 24);
        break;
      case 'status':
        await status();
        break;
      case 'run':
        if (!acquireLock()) break;
        try {
          await checkPendingFunds();
          await resolveOpenVote();
          await monitorAndEvaluate();
        } finally { releaseLock(); }
        break;
      case 'queue': {
        const opts = parseStartArgs(args);
        const getArg = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i + 1] ? args[i + 1] : def; };
        const from = getArg('--from', 'unknown');
        const chain = getArg('--chain', 'base');
        const castHash = getArg('--cast-hash', '');
        const authorFid = parseInt(getArg('--author-fid', '0')) || 0;
        if (!opts.name || !opts.amount) { console.error('Usage: queue --name "..." --amount 0.01 --from "username" [--desc "..."] [--chain base|arbitrum|degen] [--cast-hash 0x...] [--author-fid 123]'); process.exit(1); }
        addPendingRequest(opts.name, opts.description || opts.name, opts.amount, from, chain, castHash, authorFid);
        break;
      }
      case 'resolve-vote':
        await resolveOpenVote();
        break;
      case 'withdraw': {
        const { wallet, provider, contract } = getWalletForState(loadState() || {});
        const recipient = args[0];
        if (recipient) {
          console.log(`Withdrawing pending payouts to ${recipient}...`);
          const tx = await contract.withdrawTo(recipient);
          console.log(`TX: ${tx.hash}`);
          await tx.wait();
          console.log('Withdraw complete.');
          appendLog({ event: 'withdraw', to: recipient, txHash: tx.hash });
        } else {
          const pending = await contract.pendingWithdrawals(wallet.address);
          if (pending === 0n) { console.log('No pending withdrawals.'); break; }
          console.log(`Withdrawing ${ethers.formatEther(pending)} ETH...`);
          const tx = await contract.withdraw();
          console.log(`TX: ${tx.hash}`);
          await tx.wait();
          console.log('Withdraw complete.');
          appendLog({ event: 'withdraw', amount: ethers.formatEther(pending), txHash: tx.hash });
        }
        break;
      }
      case 'pending': {
        const list = loadPending();
        if (list.length === 0) { console.log('No pending requests.'); break; }
        list.forEach((p, i) => console.log(`${i + 1}. "${p.name}" — ${p.amount} ETH from @${p.requestedBy} (${p.createdAt})`));
        break;
      }
      default:
        console.log(HELP);
    }
  } catch (e) {
    console.error('Error:', e.shortMessage || e.message);
    appendLog({ event: 'error', message: e.message });
    process.exit(1);
  }
})();
