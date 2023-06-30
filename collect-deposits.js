
// mainnet
var web3Rpc = "http://10.16.71.102:8545"
var archiveRpcs = [
  "https://eth-mainnet.g.alchemy.com/v2/**meeh**",
  "https://eth-mainnet.g.alchemy.com/v2/**meeh**",
  "https://eth-mainnet.g.alchemy.com/v2/**meeh**",
  "https://eth-mainnet.g.alchemy.com/v2/**meeh**",
  "https://eth-mainnet.g.alchemy.com/v2/**meeh**",
  "https://mainnet.infura.io/v3/**meeh**",
  "https://mainnet.infura.io/v3/**meeh**",
]
var depositContract = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
var startBlock = 11052984;
var stateFile = "mainnet-deposits.json";
var outFile = "mainnet-deposits.csv";

// goerli
/*
var web3Rpc = "http://10.16.71.104:8555"
var archiveRpcs = [
  "https://eth-goerli.g.alchemy.com/v2/**meeh**",
  "https://eth-goerli.g.alchemy.com/v2/**meeh**",
  "https://eth-goerli.g.alchemy.com/v2/**meeh**",
  "https://eth-goerli.g.alchemy.com/v2/**meeh**",
  "https://goerli.infura.io/v3/**meeh**",
  "https://goerli.infura.io/v3/**meeh**",
]
var depositContract = "0xff50ed3d0ec03aC01D4C79aAd74928BFF48a7b2b";
var startBlock = 4367322;
var stateFile = "goerli-deposits.json";
var outFile = "goerli-deposits.csv";
*/

var parallelReqs = 16;

/*
RUN:
npm install web3
node ./collect-deposits.js
*/


var depositEventInputAbi = [{"indexed":false,"internalType":"bytes","name":"pubkey","type":"bytes"},{"indexed":false,"internalType":"bytes","name":"withdrawal_credentials","type":"bytes"},{"indexed":false,"internalType":"bytes","name":"amount","type":"bytes"},{"indexed":false,"internalType":"bytes","name":"signature","type":"bytes"},{"indexed":false,"internalType":"bytes","name":"index","type":"bytes"}];
var fs = require('fs');
var Web3 = require('web3');
var web3Provider = new Web3.providers.http.HttpProvider(web3Rpc);
var web3 = new Web3.Web3(web3Provider);
var archiveWeb3 = archiveRpcs.map((rpc) => {
  var web3Provider = new Web3.providers.http.HttpProvider(rpc);
  return new Web3.Web3(web3Provider);
});
var lastArchiveCallIdx = 0;


main().then(function() {
  console.log("script completed");
});


function getArchiveWeb3() {
  let callIdx = lastArchiveCallIdx++;
  let providerIdx = callIdx % archiveWeb3.length;
  return archiveWeb3[providerIdx];
}

async function main() {
  let headBlock = await web3.eth.getBlockNumber();
  let currentBlock = BigInt(startBlock);
  let eventBatchSize = 10000n;

  let validatorsDict = {};

  
  let validators = [];
  let flushValidators = () => {
    let lines = [];
    if(!fs.existsSync(outFile)) {
      lines.push([
        "pubkey",
        "wdaddr",
        "block",
        "from",
        "proxy",
      ].join(";"));
    }
    validators.forEach((v) => {
      lines.push([
        JSON.stringify(v.pubkey),
        JSON.stringify(v.wdaddr),
        v.block,
        JSON.stringify(v.from),
        JSON.stringify(v.proxy),
      ].join(";"));
    });
    validators = [];
    if(lines.length > 0) {
      fs.appendFileSync(outFile, lines.join("\n") + "\n");
    }
  };

  if(fs.existsSync(stateFile)) {
    let state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    currentBlock = BigInt(state.current);
    if(state.validators) {
      validators = state.validators;
      state.pubkeys = validators.map((v) => v.pubkey);
      flushValidators();
    }
    
    state.pubkeys.forEach((v) => validatorsDict[v] = true);
    console.log("resuming from block " + currentBlock.toString());
  }

  while(currentBlock < headBlock) {
    try {
      console.log("processing " + currentBlock.toString() + " / " + headBlock.toString());
      logs = await web3.eth.getPastLogs({
        address: depositContract,
        fromBlock: "0x" + currentBlock.toString(16),
        toBlock: "0x" + (currentBlock + eventBatchSize).toString(16),
      });
      console.log("  total events: " + logs.length);

      let promises = [];
      for(let evtIdx = 0; evtIdx < logs.length; evtIdx++) {
        let evt = logs[evtIdx];
        let depositEventInputs = web3.eth.abi.decodeLog(depositEventInputAbi, evt.data, evt.topics);

        if(validatorsDict[depositEventInputs.pubkey])
          continue;
        validatorsDict[depositEventInputs.pubkey] = true;
        
        let wdAddr = depositEventInputs.withdrawal_credentials.match(/^0x01/) ? depositEventInputs.withdrawal_credentials.replace(/^0x01[0]{22}/, "0x") : "";
        let entry = {
          pubkey: depositEventInputs.pubkey,
          wdaddr: wdAddr,
          block: evt.blockNumber.toString(),
          from: null,
          proxy: null,
        };
        validators.push(entry);

        ((entry) => {
          promises.push(enqueueGetTx(evt.transactionHash).then((txData) => {
            entry.from = txData?.from.toLowerCase() || "";
            entry.proxy = txData ? (txData.to?.toLowerCase() !== depositContract.toLowerCase() ? txData.to?.toLowerCase() : "") : "";
          }))
        })(entry);
      }
      let stopFn = printQueueStats(promises.length);
      await Promise.all(promises);
      stopFn();

      currentBlock += eventBatchSize;
      flushValidators();
      fs.writeFileSync(stateFile, JSON.stringify({
        current: currentBlock.toString(),
        pubkeys: Object.keys(validatorsDict),
      }));
      await sleepPromise(1000);
    } catch(ex) {
      console.error("Error on height " + currentBlock + ": " + ex.toString());
      await sleepPromise(2000);
    }
  }
}


var txDetailsProcessing = 0;
var txDetailsQueue = [];
function enqueueGetTx(txHash) {
  let dfd = {};
  dfd.promise = new Promise((resolve, reject) => {
    dfd.resolve = resolve;
    dfd.reject = reject;
  });
  txDetailsQueue.push({
    dfd: dfd,
    hash: txHash,
  });
  if(txDetailsProcessing < parallelReqs)
    processGetTxQueue();

  return dfd.promise;
}

function processGetTxQueue() {
  if(txDetailsProcessing < parallelReqs && txDetailsQueue.length > 0) {
    let req = txDetailsQueue.shift();
    txDetailsProcessing++;
    getTxDetails(req.hash).then(req.dfd.resolve, req.dfd.reject).then(() => {
      txDetailsProcessing--;
      processGetTxQueue();
    });
  }
}

function printQueueStats(totalCount) {
  let statsTimer = setInterval(() => {
    let processed = totalCount - txDetailsQueue.length;
    console.log("    processed tx: " + processed + " / " + totalCount);
  }, 15 * 1000);
  return function() {
    clearInterval(statsTimer);
  };
}

async function getTxDetails(txHash) {
  let txData = null;
  let txRetry = 0;
  let archiveWeb3 = null /*web3*/;
  do {
    try {
      if(!archiveWeb3)
        throw "ex";
      txData = await archiveWeb3.eth.getTransaction(txHash);
    } catch(ex) {
      if(txRetry > 0 && ex !== "ex")
        console.error("Error while fetching tx " + txHash + ": " + ex.toString());
      switch(txRetry++) {
        case 0:
        case 5:
          archiveWeb3 = getArchiveWeb3();
          break;
        default:
          await sleepPromise(2000);
      }
    }
  } while(!txData && txRetry < 10);
  return txData;
}

function sleepPromise(delay) {
  return new Promise((resolve) => {
    setTimeout(resolve, delay);
  });
}