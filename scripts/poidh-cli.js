const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// --- Config ---
const CHAINS = {
  arbitrum: {
    contract: '0x5555Fa783936C260f77385b4E153B9725feF1719',
    url: 'https://poidh.xyz/arbitrum',
  },
  base: {
    contract: '0x5555Fa783936C260f77385b4E153B9725feF1719',
    url: 'https://poidh.xyz/base',
  },
  degen: {
    contract: '0x18E5585ca7cE31b90Bc8BB7aAf84152857cE243f',
    url: 'https://poidh.xyz/degen',
  },
};

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
  'event BountyCreated(uint256 indexed bountyId, address indexed issuer, string name, string description, uint256 amount)',
  'event ClaimCreated(uint256 indexed claimId, address indexed issuer, uint256 indexed bountyId, string name, string description, string uri)',
];

const NFT_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
];

function loadConfig() {
  const chainName = process.env.POIDH_CHAIN || 'base';
  const chain = CHAINS[chainName];
  if (!chain) {
    console.error(`Unknown chain: ${chainName}. Use: arbitrum, base, degen`);
    process.exit(1);
  }

  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('RPC_URL env not set');
    process.exit(1);
  }

  let privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    // fallback: read from farcaster-agent credentials
    try {
      const creds = JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', '..', 'farcaster-agent', 'scripts', 'credentials.json'), 'utf8'
      ));
      privateKey = creds.custodyPrivateKey;
    } catch (e) {
      console.error('PRIVATE_KEY env not set and credentials.json not found');
      process.exit(1);
    }
  }
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(chain.contract, ABI, wallet);

  return { chain, chainName, provider, wallet, contract };
}

async function createBounty(type, name, desc, amount) {
  const { chain, contract } = loadConfig();
  const value = ethers.parseEther(amount);
  const fn = type === 'open' ? 'createOpenBounty' : 'createSoloBounty';
  console.log(`Creating ${type} bounty: "${name}" for ${amount}...`);
  const tx = await contract[fn](name, desc, { value });
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();
  const log = receipt.logs.find(l => l.address.toLowerCase() === contract.target.toLowerCase() && l.topics.length >= 2);
  if (log) {
    const bountyId = parseInt(log.topics[1], 16);
    console.log(`Bounty ID: ${bountyId}`);
    console.log(`View: ${chain.url}/${bountyId}`);
  }
}

async function createClaimCmd(bountyId, name, desc, uri) {
  const { contract } = loadConfig();
  console.log(`Submitting claim on bounty #${bountyId}...`);
  const tx = await contract.createClaim(bountyId, name, desc, uri);
  console.log(`TX: ${tx.hash}`);
  const receipt = await tx.wait();
  const log = receipt.logs.find(l => l.address.toLowerCase() === contract.target.toLowerCase() && l.topics.length >= 2);
  if (log) {
    const claimId = parseInt(log.topics[1], 16);
    console.log(`Claim ID: ${claimId}`);
  }
}

async function getClaims(bountyId, offset = 0) {
  const { contract } = loadConfig();
  const claims = await contract.getClaimsByBountyId(bountyId, offset);
  if (claims.length === 0) {
    console.log('No claims found.');
    return;
  }
  for (const c of claims) {
    console.log(`---`);
    console.log(`Claim #${c.id} by ${c.issuer}`);
    console.log(`  Name: ${c.name}`);
    console.log(`  Desc: ${c.description}`);
    console.log(`  Accepted: ${c.accepted}`);
  }
}

async function getClaimURI(claimId) {
  const { contract, provider } = loadConfig();
  const nftAddr = await contract.poidhNft();
  const nft = new ethers.Contract(nftAddr, NFT_ABI, provider);
  const uri = await nft.tokenURI(claimId);
  console.log(`URI: ${uri}`);
  // resolve ipfs/ar
  let url = uri;
  if (uri.startsWith('ipfs://')) url = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
  else if (uri.startsWith('ar://')) url = uri.replace('ar://', 'https://arweave.net/');
  if (url !== uri) console.log(`Resolved: ${url}`);
}

async function getBounty(bountyId) {
  const { contract, chain } = loadConfig();
  const b = await contract.bounties(bountyId);
  console.log(`Bounty #${b.id}`);
  console.log(`  Issuer: ${b.issuer}`);
  console.log(`  Name: ${b.name}`);
  console.log(`  Description: ${b.description}`);
  console.log(`  Amount: ${ethers.formatEther(b.amount)}`);
  console.log(`  Claimer: ${b.claimer}`);
  console.log(`  Status: ${b.claimer === ethers.ZeroAddress ? 'ACTIVE' : 'FINALIZED'}`);
  console.log(`  URL: ${chain.url}/${bountyId}`);
}

async function acceptClaimCmd(bountyId, claimId) {
  const { contract } = loadConfig();
  console.log(`Accepting claim #${claimId} on bounty #${bountyId}...`);
  const tx = await contract.acceptClaim(bountyId, claimId);
  console.log(`TX: ${tx.hash}`);
  await tx.wait();
  console.log('Done.');
}

async function submitForVote(bountyId, claimId) {
  const { contract } = loadConfig();
  console.log(`Submitting claim #${claimId} for vote on bounty #${bountyId}...`);
  const tx = await contract.submitClaimForVote(bountyId, claimId);
  console.log(`TX: ${tx.hash}`);
  await tx.wait();
  console.log('Done. Contributors have 2 days to vote.');
}

async function checkVote(bountyId) {
  const { contract } = loadConfig();
  const [yes, no, deadline] = await contract.bountyVotingTracker(bountyId);
  const now = Math.floor(Date.now() / 1000);
  console.log(`Yes: ${yes}, No: ${no}`);
  console.log(`Deadline: ${new Date(Number(deadline) * 1000).toISOString()}`);
  console.log(now > Number(deadline) ? 'Voting ended' : `Voting ends in ${Math.ceil((Number(deadline) - now) / 3600)}h`);
}

async function resolveVoteCmd(bountyId) {
  const { contract } = loadConfig();
  console.log(`Resolving vote on bounty #${bountyId}...`);
  const tx = await contract.resolveVote(bountyId);
  console.log(`TX: ${tx.hash}`);
  await tx.wait();
  console.log('Done.');
}

async function checkBalance() {
  const { contract, wallet } = loadConfig();
  const pending = await contract.pendingWithdrawals(wallet.address);
  const native = await wallet.provider.getBalance(wallet.address);
  console.log(`Wallet: ${wallet.address}`);
  console.log(`Native balance: ${ethers.formatEther(native)}`);
  console.log(`Pending withdrawals: ${ethers.formatEther(pending)}`);
}

async function withdrawCmd(recipient) {
  const { contract } = loadConfig();
  let tx;
  if (recipient) {
    console.log(`Withdrawing to ${recipient}...`);
    tx = await contract.withdrawTo(recipient);
  } else {
    console.log('Withdrawing...');
    tx = await contract.withdraw();
  }
  console.log(`TX: ${tx.hash}`);
  await tx.wait();
  console.log('Done.');
}

async function minAmounts() {
  const { contract } = loadConfig();
  const minBounty = await contract.MIN_BOUNTY_AMOUNT();
  const minContrib = await contract.MIN_CONTRIBUTION();
  console.log(`Min bounty: ${ethers.formatEther(minBounty)}`);
  console.log(`Min contribution: ${ethers.formatEther(minContrib)}`);
}

// --- CLI ---
const [,, cmd, ...args] = process.argv;

const HELP = `poidh-cli — poidh on-chain bounty tool

Commands:
  create-bounty <solo|open> <name> <description> <amount>
  create-claim <bountyId> <name> <description> <proofURI>
  get-bounty <bountyId>
  get-claims <bountyId> [offset]
  get-claim-uri <claimId>
  accept-claim <bountyId> <claimId>
  submit-vote <bountyId> <claimId>
  check-vote <bountyId>
  resolve-vote <bountyId>
  balance
  withdraw [recipientAddress]
  min-amounts

Env vars: POIDH_CHAIN (base|arbitrum|degen), RPC_URL, PRIVATE_KEY (optional, falls back to farcaster credentials)
`;

(async () => {
  try {
    switch (cmd) {
      case 'create-bounty':
        await createBounty(args[0], args[1], args[2], args[3]);
        break;
      case 'create-claim':
        await createClaimCmd(parseInt(args[0]), args[1], args[2], args[3]);
        break;
      case 'get-bounty':
        await getBounty(parseInt(args[0]));
        break;
      case 'get-claims':
        await getClaims(parseInt(args[0]), parseInt(args[1] || '0'));
        break;
      case 'get-claim-uri':
        await getClaimURI(parseInt(args[0]));
        break;
      case 'accept-claim':
        await acceptClaimCmd(parseInt(args[0]), parseInt(args[1]));
        break;
      case 'submit-vote':
        await submitForVote(parseInt(args[0]), parseInt(args[1]));
        break;
      case 'check-vote':
        await checkVote(parseInt(args[0]));
        break;
      case 'resolve-vote':
        await resolveVoteCmd(parseInt(args[0]));
        break;
      case 'balance':
        await checkBalance();
        break;
      case 'withdraw':
        await withdrawCmd(args[0]);
        break;
      case 'min-amounts':
        await minAmounts();
        break;
      default:
        console.log(HELP);
    }
  } catch (e) {
    console.error('Error:', e.shortMessage || e.message);
    process.exit(1);
  }
})();
