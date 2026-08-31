// One-off: count on-chain events missed by the bot between its frozen cursors
// and the current head (public RPC from a residential IP, chunked ranges).
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const GW = "0x50bE7832849EFEdB15611799074FcC409522f27A";
const NFT = "0x9C0f41ce4F8e72F866CC79Acd80386472c53B40B";
const POOL = "0xa9fFaF245686212F7c6F73e7ccd1592e9A5B4923";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const ZERO = "0x" + "0".repeat(64);
const DEAD = "0x" + "0".repeat(60) + "dead";

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

async function scan(name, address, topics, from, to) {
  const out = [];
  const CHUNK = 900000;
  for (let a = from; a <= to; a += CHUNK) {
    const b = Math.min(a + CHUNK - 1, to);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ address, topics, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }]);
    } catch (e) {
      console.log(`  [${name}] blocks ${a}-${b} failed: ${String(e).slice(0, 120)}`);
      continue;
    }
    out.push(...logs);
  }
  console.log(`${name}: ${out.length} events in [${from}..${to}]`);
  for (const l of out.slice(-6)) console.log(`   block ${parseInt(l.blockNumber, 16)} tx ${l.transactionHash.slice(0, 18)}…`);
  return out;
}

(async () => {
  const head = parseInt(await rpc("eth_blockNumber", []), 16);
  console.log("head:", head);
  // stale cursors from the DO
  await scan("missed SWAPS (pool)", POOL, [SWAP], 45866492, head);
  await scan("missed BURNS (GW->dead)", GW, [TRANSFER, null, DEAD], 43060760, head);
  await scan("missed MINTS (OG from 0x0)", NFT, [TRANSFER, ZERO], 43086587, head);
})();
