import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createJupiterApiClient, QuoteGetRequest, QuoteResponse } from "@jup-ag/api";
import tokenData from '../../../tokens.json';
const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY');
const jupiterQuoteApi = createJupiterApiClient();
// Token mint address mapping
// const TOKEN_MINT_ADDRESSES = {
//   '$WIF': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
//   'POPCAT': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
//   'TRUMP': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
// };
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

interface Token {
  id: string;
  symbol: string;
  name: string;
  quantity: number;
  coingeckoId: string;
}

interface CrateData {
  id: string;
  name: string;
  tokens: Token[];
  creator: {
    walletAddress: string;
  };
}

async function fetchCrateData(id: string): Promise<CrateData> {
  const response = await fetch(`https://sickb.vercel.app/api/crates/${id}`);
  if (!response.ok) {
    throw new Error('Failed to fetch crate data');
  }
  return await response.json();
}

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number
): Promise<QuoteResponse> {
  const params: QuoteGetRequest = {
    inputMint: inputMint,
    outputMint: outputMint,
    amount: amount,
    autoSlippage: true,
    autoSlippageCollisionUsdValue: 1000,
    maxAutoSlippageBps: 1000,
    minimizeSlippage: true,
    onlyDirectRoutes: false,
    asLegacyTransaction: false,
  };
  const quote = await jupiterQuoteApi.quoteGet(params);
  if (!quote) {
    throw new Error("unable to quote");
  }
  return quote;
}

async function getSwapObj(wallet: string, quote: QuoteResponse) {
  const swapObj = await jupiterQuoteApi.swapPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: wallet,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    },
  });
  return swapObj;
}

export async function GET(request: NextRequest) {
  const crateId = request.nextUrl.searchParams.get('crateId');
  if (!crateId) {
    return NextResponse.json({ error: "Crate ID is required" }, { status: 400 });
  }

  try {
    if (!crateId) {
      return NextResponse.json({ error: "Crate ID is required" }, { status: 400 });
    }
   
    const crateData = await fetchCrateData(crateId);

    return NextResponse.json({
      type: "action",
      icon: "https://blinks.sickfreak.club/proto.png",
      title: `Swap for ${crateData.name}`,
      description: "Swap tokens using Jupiter aggregator",
      label: "Swap",
      links: {
        actions: [
          {
            label: "Perform Swap",
            href: "/api/swap",
            parameters: [
              {
                name: "inputAmount",
                label: "Input Amount",
                type: "number"
              },
              {
                name: "inputCurrency",
                label: "Input Currency",
                type: "select",
                options: [
                  { label: "SOL", value: "SOL" }
                ]
              },
            ]
          }
        ]
      }
    });
  } catch (error) {
    console.error("Error fetching crate data:", error);
    return NextResponse.json({ error: "Failed to fetch crate data" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { account, data } = body;
  const { inputAmount, inputCurrency } = data;
  const crateId = request.nextUrl.searchParams.get('crateId');
  if (!account || !crateId ) {
    return NextResponse.json({ error: "User publickey and crate ID are required" }, { status: 400 });
  }

  try {
    const crateData = await fetchCrateData(crateId);
    const totalAmount = parseFloat(inputAmount);
    const inputMint = inputCurrency === 'USDC' ? USDC_MINT : SOL_MINT;
    const inputDecimals = inputCurrency === 'USDC' ? 6 : 9;

    const tokenAllocations = crateData.tokens.map(token => ({
      symbol: token.symbol,
      mint: tokenData.find(t => t.symbol === token.symbol)?.address || '',
      amount: (totalAmount * token.quantity) / 100
    }));

    const quoteResults = [];
    const unsupportedTokens = [];

    for (const { symbol, mint, amount } of tokenAllocations) {
      const atomicAmount = Math.floor(amount * Math.pow(10, inputDecimals));
      try {
        const quote = await getQuote(inputMint, mint, atomicAmount);
        quoteResults.push({ outputMint: mint, quote });
      } catch (error) {
        console.warn(`Unable to get quote for token ${symbol} (${mint}):`, error);
        unsupportedTokens.push(symbol);
      }
    }

    if (quoteResults.length === 0) {
      return NextResponse.json({ error: "No supported tokens found in the crate" }, { status: 400 });
    }

    const swapObjs = await Promise.all(quoteResults.map(({ quote }) => 
      getSwapObj(account, quote)
    ));

    const transactions = swapObjs.map(swapObj => {
      const swapTransactionBuf = Buffer.from(swapObj.swapTransaction, "base64");
      return VersionedTransaction.deserialize(swapTransactionBuf);
    });

    // Add transfer transactions (keep existing code for transfers)

    // Serialize all transactions
    const serializedTransactions = transactions.map(tx => 
      Buffer.from(tx.serialize()).toString('base64')
    );

    return NextResponse.json({
      transaction: serializedTransactions[0],
      message: "Swap transactions ready for signing",
      unsupportedTokens: unsupportedTokens.length > 0 ? unsupportedTokens : undefined,
    });
  } catch (error) {
    console.error("Error preparing swap:", error);
    return NextResponse.json({ error: "Failed to prepare swap", details: (error as Error).message }, { status: 500 });
  }
}