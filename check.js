require('dotenv').config();
const { ethers } = require('ethers');

async function checkSetup() {
  console.log('========================================');
  console.log('  Setup Check - Rare Friends Mint Bot');
  console.log('========================================');
  console.log('');

  const checks = [];

  // Check .env
  if (CONFIG.privateKey && CONFIG.privateKey !== 'your_private_key_here') {
    checks.push({ name: 'Private Key', status: 'OK' });
  } else {
    checks.push({ name: 'Private Key', status: 'MISSING' });
  }

  if (CONFIG.rpcEndpoints[0] && CONFIG.rpcEndpoints[0] !== 'your_rpc_url_here') {
    checks.push({ name: 'RPC URL', status: 'OK' });
  } else {
    checks.push({ name: 'RPC URL', status: 'MISSING' });
  }

  // Check wallet
  try {
    const wallet = new ethers.Wallet(CONFIG.privateKey);
    checks.push({ name: 'Wallet Address', status: wallet.address });
  } catch (e) {
    checks.push({ name: 'Wallet', status: 'INVALID KEY' });
  }

  // Check provider
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.rpcEndpoints[0], CONFIG.chainId, { staticNetwork: true });
    const network = await provider.getNetwork();
    checks.push({ name: 'Network', status: `Robinhood Chain (Chain: ${network.chainId})` });
  } catch (e) {
    checks.push({ name: 'Network', status: `ERROR: ${e.message}` });
  }

  // Check contract
  try {
    const provider = new ethers.JsonRpcProvider(CONFIG.rpcEndpoints[0], CONFIG.chainId, { staticNetwork: true });
    const code = await provider.getCode(CONFIG.contractAddress);
    if (code === '0x' || code === '0x0') {
      checks.push({ name: 'Contract', status: 'NOT FOUND' });
    } else {
      checks.push({ name: 'Contract', status: `FOUND (${(code.length - 2) / 2} bytes)` });
    }
  } catch (e) {
    checks.push({ name: 'Contract', status: `ERROR: ${e.message}` });
  }

  // Check balance
  try {
    const wallet = new ethers.Wallet(CONFIG.privateKey, new ethers.JsonRpcProvider(CONFIG.rpcEndpoints[0], CONFIG.chainId, { staticNetwork: true }));
    const balance = await wallet.provider.getBalance(wallet.address);
    checks.push({ name: 'Balance', status: `${ethers.formatEther(balance)} ETH` });
  } catch (e) {
    checks.push({ name: 'Balance', status: `ERROR: ${e.message}` });
  }

  console.log('');
  checks.forEach(c => {
    const icon = c.status === 'OK' || c.status === 'FOUND' ? '✓' : c.status.includes('ERROR') || c.status === 'MISSING' ? '✗' : '•';
    console.log(`  ${icon} ${c.name}: ${c.status}`);
  });
  console.log('');
}

const CONFIG = {
  privateKey: process.env.PRIVATE_KEY,
  contractAddress: process.env.CONTRACT_ADDRESS,
  chainId: parseInt(process.env.CHAIN_ID) || 4663,
  rpcEndpoints: [
    process.env.RPC_URL,
    process.env.RPC_ENDPOINT_1,
    process.env.RPC_ENDPOINT_2,
    process.env.RPC_ENDPOINT_3,
  ].filter(Boolean),
};

checkSetup().catch(e => console.error('Error:', e.message));
