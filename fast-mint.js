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
  maxRetries: parseInt(process.env.MAX_RETRIES) || 10,
  retryDelay: parseInt(process.env.RETRY_DELAY) || 300,
};

function log(msg, type = 'info') {
  const time = new Date().toISOString().split('T')[1].split('.')[0];
  const prefix = { info: '✓', warn: '⚠', error: '✗', success: '★', fast: '⚡', broadcast: '📡' }[type] || '•';
  console.log(`[${time}] ${prefix} ${msg}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function initProviders() {
  const providers = CONFIG.rpcEndpoints.map((url, i) => {
    try {
      return new ethers.JsonRpcProvider(url, parseInt(process.env.CHAIN_ID) || 4663, {
        staticNetwork: true,
        batchMaxCount: 1,
      });
    } catch (e) {
      return null;
    }
  }).filter(Boolean);

  if (providers.length === 0) {
    log('No valid RPC endpoints!', 'error');
    process.exit(1);
  }

  log(`${providers.length} RPC providers initialized`);
  return providers;
}

async function detectMintFunction(provider) {
  const signatures = [
    { name: 'publicMint', inputs: ['uint256'] },
    { name: 'mint', inputs: ['uint256'] },
    { name: 'freeMint', inputs: ['uint256'] },
    { name: 'claim', inputs: ['uint256'] },
    { name: 'mintTo', inputs: ['address', 'uint256'] },
    { name: 'safeMint', inputs: ['uint256'] },
    { name: 'mintPublic', inputs: ['uint256'] },
    { name: 'mintNFT', inputs: ['uint256'] },
    { name: 'mintMultiple', inputs: ['uint256'] },
    { name: 'whitelistMint', inputs: ['uint256'] },
  ];

  for (const sig of signatures) {
    try {
      const iface = new ethers.Interface([`function ${sig.name}(${sig.inputs.join(',')})`]);
      const args = sig.inputs.length === 1 ? [CONFIG.mintQuantity] : [ethers.ZeroAddress, CONFIG.mintQuantity];
      const calldata = iface.encodeFunctionData(sig.name, args);
      await provider.call({ to: CONFIG.contractAddress, data: calldata, value: 0n });
      log(`Mint function found: ${sig.name}(${sig.inputs.join(',')})`, 'success');
      return sig;
    } catch (e) {
      continue;
    }
  }

  log('Using default: mint(uint256)', 'warn');
  return { name: 'mint', inputs: ['uint256'] };
}

async function broadcastToAll(providers, signedTx) {
  const results = await Promise.allSettled(
    providers.map((provider, i) =>
      provider.broadcastTransaction(signedTx).then(r => {
        log(`RPC ${i + 1} broadcast success: ${r.hash}`, 'broadcast');
        return r;
      }).catch(e => {
        log(`RPC ${i + 1} broadcast failed: ${e.message?.substring(0, 80)}`, 'error');
        throw e;
      })
    )
  );

  const success = results.find(r => r.status === 'fulfilled');
  return success ? success.value : null;
}

async function isMintActive(provider, wallet) {
  const signatures = [
    { name: 'publicMint', inputs: ['uint256'] },
    { name: 'mint', inputs: ['uint256'] },
    { name: 'freeMint', inputs: ['uint256'] },
    { name: 'claim', inputs: ['uint256'] },
    { name: 'mintTo', inputs: ['address', 'uint256'] },
    { name: 'safeMint', inputs: ['uint256'] },
    { name: 'mintPublic', inputs: ['uint256'] },
  ];

  for (const sig of signatures) {
    try {
      const iface = new ethers.Interface([`function ${sig.name}(${sig.inputs.join(',')})`]);
      const args = sig.inputs.length === 1 ? [CONFIG.mintQuantity] : [wallet.address, CONFIG.mintQuantity];
      const calldata = iface.encodeFunctionData(sig.name, args);
      await provider.call({ to: CONFIG.contractAddress, data: calldata, value: 0n });
      return sig;
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('execution reverted')) {
        return null;
      }
      continue;
    }
  }
  return null;
}

async function main() {
  console.log('========================================');
  console.log('  Rare Friends Genesis - Ultra Fast Bot');
  console.log('========================================');

  if (!CONFIG.privateKey || CONFIG.privateKey === 'your_private_key_here') {
    log('Set PRIVATE_KEY in .env!', 'error');
    process.exit(1);
  }

  const providers = initProviders();
  const primaryProvider = providers[0];
  const wallet = new ethers.Wallet(CONFIG.privateKey, primaryProvider);

  log(`Wallet: ${wallet.address}`);
  const balance = await primaryProvider.getBalance(wallet.address);
  log(`Balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    log('No ETH for gas!', 'error');
    process.exit(1);
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

    const mintFunc = await isMintActive(primaryProvider, wallet);

    if (mintFunc) {
      if (!mintFound) {
        console.log('');
        log(`MINT IS ACTIVE! Found: ${mintFunc.name}(${mintFunc.inputs.join(',')})`, 'success');
        mintFound = true;
        activeMintFunc = mintFunc;
      }

      log('Attempting mint NOW...', 'fast');

      let nonce = await primaryProvider.getTransactionCount(wallet.address, 'pending');
      let success = false;

      for (let attempt = 1; attempt <= 5; attempt++) {
        const startTime = Date.now();

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

          const signedTx = await wallet.signTransaction(tx);
          const result = await broadcastToAll(providers, signedTx);
          const totalTime = Date.now() - startTime;

          if (result) {
            log(`TX sent in ${totalTime}ms | Hash: ${result.hash}`, 'success');
            log(`Explorer: https://robinhoodchain.blockscout.com/tx/${result.hash}`);

            const receipt = await result.wait(1);
            if (receipt && receipt.status === 1) {
              log(`MINT SUCCESSFUL! Block: ${receipt.blockNumber}`, 'success');
              log(`Gas Used: ${receipt.gasUsed}`);
              success = true;
              break;
            } else {
              log(`TX reverted`, 'error');
            }
          }
        } catch (e) {
          const errorMsg = e.message || '';
          if (errorMsg.includes('nonce')) {
            nonce = await primaryProvider.getTransactionCount(wallet.address, 'pending');
          } else if (errorMsg.includes('gas') || errorMsg.includes('fee')) {
            CONFIG.maxFeePerGas = CONFIG.maxFeePerGas * 125n / 100n;
            CONFIG.maxPriorityFeePerGas = CONFIG.maxPriorityFeePerGas * 125n / 100n;
          } else if (errorMsg.includes('insufficient')) {
            log('Out of funds!', 'error');
            process.exit(1);
          }
          log(`Attempt ${attempt} failed: ${errorMsg.substring(0, 100)}`, 'error');
        }
        nonce++;
      }

      if (success) {
        log('Mint complete! Continuing to monitor...', 'success');
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
  log(`Fatal: ${e.message}`, 'error');
  process.exit(1);
});
