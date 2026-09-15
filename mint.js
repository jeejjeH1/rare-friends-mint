require('dotenv').config();
const { ethers } = require('ethers');

const CONFIG = {
  privateKey: process.env.PRIVATE_KEY,
  contractAddress: process.env.CONTRACT_ADDRESS,
  rpcEndpoints: [
    process.env.RPC_URL,
    process.env.RPC_ENDPOINT_1,
    process.env.RPC_ENDPOINT_2,
    process.env.RPC_ENDPOINT_3,
  ].filter(Boolean),
  mintQuantity: parseInt(process.env.MINT_QUANTITY) || 1,
  gasLimit: BigInt(process.env.GAS_LIMIT || 300000),
  maxFeePerGas: BigInt(process.env.MAX_FEE_PER_GAS || 2000000000),
  maxPriorityFeePerGas: BigInt(process.env.MAX_PRIORITY_FEE_PER_GAS || 100000000),
  retryDelay: parseInt(process.env.RETRY_DELAY) || 500,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 10,
};

const MINT_FUNCTION_SIGNATURES = [
  { name: 'publicMint', inputs: ['uint256'] },
  { name: 'mint', inputs: ['uint256'] },
  { name: 'freeMint', inputs: ['uint256'] },
  { name: 'claim', inputs: ['uint256'] },
  { name: 'mintTo', inputs: ['address', 'uint256'] },
  { name: 'mintNFT', inputs: ['uint256'] },
  { name: 'mintMultiple', inputs: ['uint256'] },
  { name: 'mintPublic', inputs: ['uint256'] },
  { name: 'safeMint', inputs: ['uint256'] },
  { name: 'whitelistMint', inputs: ['uint256'] },
];

let rpcProviders = [];
let activeRpcIndex = 0;

function log(msg, type = 'info') {
  const time = new Date().toISOString().split('T')[1].split('.')[0];
  const prefix = { info: '✓', warn: '⚠', error: '✗', success: '★', fast: '⚡' }[type] || '•';
  console.log(`[${time}] ${prefix} ${msg}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function initProviders() {
  rpcProviders = CONFIG.rpcEndpoints.map((url, i) => {
    try {
      const provider = new ethers.JsonRpcProvider(url, parseInt(process.env.CHAIN_ID) || 4663, {
        staticNetwork: true,
        batchMaxCount: 1,
      });
      log(`RPC ${i + 1} connected: ${url.substring(0, 40)}...`);
      return provider;
    } catch (e) {
      log(`RPC ${i + 1} failed: ${e.message}`, 'warn');
      return null;
    }
  }).filter(Boolean);

  if (rpcProviders.length === 0) {
    log('No valid RPC endpoints found!', 'error');
    process.exit(1);
  }

  log(`Total active RPCs: ${rpcProviders.length}`);
}

function getProvider() {
  return rpcProviders[activeRpcIndex % rpcProviders.length];
}

function rotateProvider() {
  activeRpcIndex = (activeRpcIndex + 1) % rpcProviders.length;
  return getProvider();
}

async function detectMintFunction(wallet) {
  log('Detecting mint function on contract...');
  const provider = getProvider();

  for (const sig of MINT_FUNCTION_SIGNATURES) {
    try {
      const iface = new ethers.Interface([`function ${sig.name}(${sig.inputs.join(',')})`]);
      const calldata = iface.encodeFunctionData(sig.name, sig.inputs.length === 1 ? [CONFIG.mintQuantity] : [wallet.address, CONFIG.mintQuantity]);

      const tx = {
        to: CONFIG.contractAddress,
        data: calldata,
        value: 0n,
      };

      await provider.call(tx);
      log(`Found mint function: ${sig.name}(${sig.inputs.join(',')})`, 'success');
      return sig;
    } catch (e) {
      continue;
    }
  }

  log('Could not auto-detect mint function. Trying common signatures...', 'warn');
  return MINT_FUNCTION_SIGNATURES[0];
}

async function getNonce(wallet) {
  const provider = getProvider();
  return await provider.getTransactionCount(wallet.address, 'pending');
}

async function buildMintTx(wallet, mintFunc, nonce) {
  const iface = new ethers.Interface([`function ${mintFunc.name}(${mintFunc.inputs.join(',')})`]);
  const args = mintFunc.inputs.length === 1 ? [CONFIG.mintQuantity] : [wallet.address, CONFIG.mintQuantity];
  const calldata = iface.encodeFunctionData(mintFunc.name, args);

  const feeData = await getProvider().getFeeData();
  const maxFee = feeData.gasPrice ? feeData.gasPrice * 2n : CONFIG.maxFeePerGas;
  const maxPriority = CONFIG.maxPriorityFeePerGas;

  return {
    to: CONFIG.contractAddress,
    data: calldata,
    value: 0n,
    gasLimit: CONFIG.gasLimit,
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: maxPriority,
    nonce: nonce,
    chainId: undefined,
    type: 2,
  };
}

async function sendTransaction(wallet, tx) {
  try {
    const signedTx = await wallet.signTransaction(tx);
    const provider = getProvider();
    const response = await provider.broadcastTransaction(signedTx);
    return { success: true, hash: response.hash, tx: response };
  } catch (e) {
    return { success: false, error: e.message || e.toString() };
  }
}

async function waitForConfirmation(hash, timeout = 60000) {
  const provider = getProvider();
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) {
        return receipt;
      }
    } catch (e) {
      // ignore
    }
    await delay(1000);
  }
  return null;
}

async function checkContractStatus() {
  const provider = getProvider();
  log('Checking contract status...');

  try {
    const code = await provider.getCode(CONFIG.contractAddress);
    if (code === '0x' || code === '0x0') {
      log('Contract not found at this address!', 'error');
      return false;
    }
    log(`Contract code size: ${(code.length - 2) / 2} bytes`);

    const balance = await provider.getBalance(CONFIG.contractAddress);
    log(`Contract balance: ${ethers.formatEther(balance)} ETH`);

    return true;
  } catch (e) {
    log(`Error checking contract: ${e.message}`, 'error');
    return false;
  }
}

async function checkAllowlist(walletAddress) {
  const provider = getProvider();
  try {
    const iface = new ethers.Interface([
      'function allowed(address) view returns (bool)',
      'function allowlist(address) view returns (bool)',
      'function whitelist(address) view returns (bool)',
      'function isAllowed(address) view returns (bool)',
      'function minted(address) view returns (uint256)',
      'function totalMinted(address) view returns (uint256)',
    ]);

    for (const func of ['allowed', 'allowlist', 'whitelist', 'isAllowed']) {
      try {
        const data = iface.encodeFunctionData(func, [walletAddress]);
        const result = await provider.call({ to: CONFIG.contractAddress, data });
        const decoded = iface.decodeFunctionResult(func, result);
        log(`${func}(${walletAddress}): ${decoded[0]}`);
        return decoded[0];
      } catch (e) {
        continue;
      }
    }

    for (const func of ['minted', 'totalMinted']) {
      try {
        const data = iface.encodeFunctionData(func, [walletAddress]);
        const result = await provider.call({ to: CONFIG.contractAddress, data });
        const decoded = iface.decodeFunctionResult(func, result);
        log(`${func}(${walletAddress}): ${decoded[0].toString()}`);
        return decoded[0];
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    // ignore
  }
  return null;
}

async function fastMint(wallet, mintFunc) {
  let nonce = await getNonce(wallet);
  log(`Starting fast mint | Quantity: ${CONFIG.mintQuantity} | Nonce: ${nonce}`);
  log(`Gas Limit: ${CONFIG.gasLimit} | Max Fee: ${ethers.formatUnits(CONFIG.maxFeePerGas, 'gwei')} gwei`);

  for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
    log(`Attempt ${attempt}/${CONFIG.maxRetries}...`);

    const tx = await buildMintTx(wallet, mintFunc, nonce);
    log(`Sending transaction...`, 'fast');

    const startTime = Date.now();
    const result = await sendTransaction(wallet, tx);
    const sendTime = Date.now() - startTime;

    if (result.success) {
      log(`TX sent in ${sendTime}ms | Hash: ${result.hash}`, 'success');
      log(`Explorer: https://robinhoodchain.blockscout.com/tx/${result.hash}`);

      log('Waiting for confirmation...');
      const receipt = await waitForConfirmation(result.hash);

      if (receipt) {
        const status = receipt.status === 1 ? 'SUCCESS' : 'FAILED';
        log(`TX Confirmed! Status: ${status} | Block: ${receipt.blockNumber}`, status === 'SUCCESS' ? 'success' : 'error');
        log(`Gas Used: ${receipt.gasUsed.toString()} | Effective Gas: ${ethers.formatUnits(receipt.gasPrice || 0n, 'gwei')} gwei`);

        if (receipt.status === 1) {
          log('MINT SUCCESSFUL!', 'success');
          return true;
        } else {
          log('Transaction reverted!', 'error');
        }
      } else {
        log('TX sent but not confirmed within timeout', 'warn');
      }
    } else {
      const isNonce = result.error.includes('nonce');
      const isGas = result.error.includes('gas') || result.error.includes('fee');
      const isReverted = result.error.includes('revert');
      const isInsufficient = result.error.includes('insufficient');

      if (isNonce) {
        log(`Nonce error - resetting nonce`, 'warn');
        nonce = await getNonce(wallet);
      } else if (isGas) {
        log(`Gas error - increasing gas`, 'warn');
        CONFIG.maxFeePerGas = CONFIG.maxFeePerGas * 120n / 100n;
        CONFIG.maxPriorityFeePerGas = CONFIG.maxPriorityFeePerGas * 120n / 100n;
      } else if (isReverted) {
        log(`Contract reverted - mint may not be active yet`, 'error');
      } else if (isInsufficient) {
        log(`Insufficient funds for gas`, 'error');
        return false;
      }

      log(`Error: ${result.error.substring(0, 150)}`, 'error');
      nonce++;
    }

    if (attempt < CONFIG.maxRetries) {
      await delay(CONFIG.retryDelay);
    }
  }

  log(`All ${CONFIG.maxRetries} attempts failed`, 'error');
  return false;
}

async function isMintActive(provider, wallet) {
  try {
    const mintFuncs = [
      { name: 'publicMint', inputs: ['uint256'] },
      { name: 'mint', inputs: ['uint256'] },
      { name: 'freeMint', inputs: ['uint256'] },
      { name: 'claim', inputs: ['uint256'] },
      { name: 'mintTo', inputs: ['address', 'uint256'] },
      { name: 'safeMint', inputs: ['uint256'] },
      { name: 'mintPublic', inputs: ['uint256'] },
    ];

    for (const sig of mintFuncs) {
      try {
        const iface = new ethers.Interface([`function ${sig.name}(${sig.inputs.join(',')})`]);
        const args = sig.inputs.length === 1 ? [CONFIG.mintQuantity] : [wallet.address, CONFIG.mintQuantity];
        const calldata = iface.encodeFunctionData(sig.name, args);
        await provider.call({ to: CONFIG.contractAddress, data: calldata, value: 0n });
        return sig;
      } catch (e) {
        const msg = e.message || '';
        if (msg.includes('revert') && !msg.includes('execution reverted')) {
          continue;
        }
        if (msg.includes('execution reverted')) {
          return null;
        }
        continue;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');

  console.log('========================================');
  console.log('  Rare Friends Genesis - Mint Bot');
  console.log('========================================');
  console.log(`Contract: ${CONFIG.contractAddress}`);
  console.log(`Quantity: ${CONFIG.mintQuantity}`);
  console.log(`RPCs: ${CONFIG.rpcEndpoints.length}`);
  console.log('========================================');
  console.log('');

  if (!CONFIG.privateKey || CONFIG.privateKey === 'your_private_key_here') {
    log('Please set your PRIVATE_KEY in .env file!', 'error');
    process.exit(1);
  }

  if (!CONFIG.rpcEndpoints[0] || CONFIG.rpcEndpoints[0] === 'your_rpc_url_here') {
    log('Please set RPC_URL in .env file!', 'error');
    process.exit(1);
  }

  initProviders();

  const wallet = new ethers.Wallet(CONFIG.privateKey, getProvider());
  log(`Wallet: ${wallet.address}`);

  const provider = getProvider();
  const balance = await provider.getBalance(wallet.address);
  log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    log('Insufficient balance! You need ETH for gas.', 'error');
    process.exit(1);
  }

  if (isCheck) {
    await checkContractStatus();
    await checkAllowlist(wallet.address);
    return;
  }

  const contractOk = await checkContractStatus();
  if (!contractOk) {
    log('Contract check failed. Continuing anyway...', 'warn');
  }

  let checkCount = 0;
  let mintFound = false;
  let activeMintFunc = null;

  console.log('');
  log('Starting continuous monitoring... (Ctrl+C to stop)');
  log('Waiting for mint to become active...');
  console.log('');

  while (true) {
    checkCount++;
    const now = new Date().toISOString().split('T')[1].split('.')[0];
    process.stdout.write(`\r[${now}] Check #${checkCount} - Checking mint status...`);

    const mintFunc = await isMintActive(provider, wallet);

    if (mintFunc) {
      if (!mintFound) {
        console.log('');
        log(`MINT IS ACTIVE! Found: ${mintFunc.name}(${mintFunc.inputs.join(',')})`, 'success');
        mintFound = true;
        activeMintFunc = mintFunc;
      }

      log('Attempting mint NOW...', 'fast');

      let nonce = await getNonce(wallet);
      let success = false;

      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const iface = new ethers.Interface([`function ${activeMintFunc.name}(${activeMintFunc.inputs.join(',')})`]);
          const args = activeMintFunc.inputs.length === 1 ? [CONFIG.mintQuantity] : [wallet.address, CONFIG.mintQuantity];
          const calldata = iface.encodeFunctionData(activeMintFunc.name, args);

          const tx = {
            to: CONFIG.contractAddress,
            data: calldata,
            value: 0n,
            gasLimit: CONFIG.gasLimit,
            maxFeePerGas: CONFIG.maxFeePerGas,
            maxPriorityFeePerGas: CONFIG.maxPriorityFeePerGas,
            nonce: nonce,
            type: 2,
          };

          const startTime = Date.now();
          const signedTx = await wallet.signTransaction(tx);
          const result = await provider.broadcastTransaction(signedTx);
          const sendTime = Date.now() - startTime;

          log(`TX sent in ${sendTime}ms | Hash: ${result.hash}`, 'success');
          log(`Explorer: https://robinhoodchain.blockscout.com/tx/${result.hash}`);

          const receipt = await waitForConfirmation(result.hash, 60000);

          if (receipt && receipt.status === 1) {
            log(`MINT SUCCESSFUL! Block: ${receipt.blockNumber}`, 'success');
            log(`Gas Used: ${receipt.gasUsed.toString()}`);
            success = true;
            break;
          } else {
            log(`TX reverted or not confirmed`, 'error');
          }
        } catch (e) {
          const msg = e.message || '';
          if (msg.includes('nonce')) {
            nonce = await getNonce(wallet);
          } else if (msg.includes('insufficient')) {
            log('Out of funds!', 'error');
            process.exit(1);
          }
          log(`Attempt ${attempt} failed: ${msg.substring(0, 100)}`, 'error');
        }
        nonce++;
      }

      if (success) {
        log('Mint complete! Continuing to monitor for more mints...', 'success');
        await delay(5000);
      } else {
        log('Mint failed, retrying...', 'error');
        await delay(1000);
      }
    } else {
      if (mintFound) {
        mintFound = false;
        log('Mint deactivated, waiting...', 'warn');
      }
      await delay(2000);
    }
  }
}

main().catch(e => {
  log(`Fatal error: ${e.message}`, 'error');
  process.exit(1);
});
