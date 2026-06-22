import {
  ClobClient,
  Side,
  OrderType,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config";

/**
 * Order execution. Reused from the copybot path that placed a real *matched*
 * order: package @polymarket/clob-client-v2 (v1.0.6), sigType 3 = POLY_1271
 * (deposit wallet), createAndPostMarketOrder with OrderType.FOK, amount in
 * USDC dollars for BUY. The slippage guard uses calculateMarketPrice.
 */

let client: ClobClient | null = null;

const sigTypeMap: Record<number, SignatureTypeV2> = {
  0: SignatureTypeV2.EOA,
  1: SignatureTypeV2.POLY_PROXY,
  2: SignatureTypeV2.POLY_GNOSIS_SAFE,
  3: SignatureTypeV2.POLY_1271,
};

export interface OrderRequest {
  tokenId: string;
  side: "UP" | "DOWN"; // we always BUY a side
  amountUsd: number; // $ to spend
  refPrice: number; // the price we expect to pay (best ask)
}

export interface OrderResult {
  placed: boolean;
  dryRun: boolean;
  reason: string;
  estPrice?: number;
  hash?: string;
  status?: string;
}

export async function initExecutor(): Promise<void> {
  if (config.dryRun) {
    // In dry-run we still derive creds to validate auth WITHOUT needing balance,
    // exactly like the copybot did — but only if a key is present.
    if (!config.privateKey || config.privateKey === "0x") {
      console.log("[exec] dry-run, no key provided — skipping auth derivation");
      return;
    }
  }
  const account = privateKeyToAccount(config.privateKey);
  const signer = createWalletClient({ account, chain: polygon, transport: http(config.clobHost ? undefined : undefined) });

  const temp = new ClobClient({ host: config.clobHost, chain: config.chainId, signer } as any);
  const creds = await (temp as any).createOrDeriveApiKey();

  client = new ClobClient({
    host: config.clobHost,
    chain: config.chainId,
    signer,
    creds,
    signatureType: sigTypeMap[config.signatureType] ?? SignatureTypeV2.POLY_1271,
    funderAddress: config.funderAddress,
  } as any);

  console.log(
    `[exec] CLOB ready (sigType=${config.signatureType}, funder=${config.funderAddress.slice(0, 8)}…)`
  );
}

export async function placeOrder(req: OrderRequest): Promise<OrderResult> {
  // DRY RUN: never touch the network for order placement.
  if (config.dryRun) {
    return {
      placed: false,
      dryRun: true,
      reason: `WOULD BUY ${req.side} $${req.amountUsd} @~${req.refPrice}`,
      estPrice: req.refPrice,
    };
  }

  if (!client) return { placed: false, dryRun: false, reason: "executor not initialized" };

  // Slippage guard
  let est = req.refPrice;
  try {
    est = await (client as any).calculateMarketPrice(req.tokenId, Side.BUY, req.amountUsd, OrderType.FOK);
    const drift = est - req.refPrice;
    if (drift > config.maxSlippage) {
      return { placed: false, dryRun: false, reason: `slippage ${drift.toFixed(3)} > ${config.maxSlippage}`, estPrice: est };
    }
  } catch (e: any) {
    // proceed cautiously — copybot behavior
    console.log(`[exec] price-check failed (${e?.message}); proceeding`);
  }

  try {
    const res = await (client as any).createAndPostMarketOrder(
      { tokenID: req.tokenId, amount: req.amountUsd, side: Side.BUY },
      { tickSize: "0.01", negRisk: false },
      OrderType.FOK
    );
    const status = res?.status ?? (res?.success ? "matched" : "unknown");
    const ok = res?.success !== false && (status === "matched" || status === "live" || !!res?.orderID);
    return {
      placed: ok,
      dryRun: false,
      reason: ok ? "order posted" : `rejected: ${JSON.stringify(res).slice(0, 200)}`,
      estPrice: est,
      hash: res?.orderID || res?.transactionHash,
      status,
    };
  } catch (e: any) {
    return { placed: false, dryRun: false, reason: `error: ${e?.message}`, estPrice: est };
  }
}