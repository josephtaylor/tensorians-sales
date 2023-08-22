import dotenv from "dotenv";
import { AttachmentBuilder, EmbedBuilder, WebhookClient, WebhookMessageCreateOptions } from "discord.js";

import TensorService, { TensorTransaction } from "./services/TensorService";
import { nonEmptyStrValidator, roundToDecimal } from "./utils";
import { cleanEnv, str } from "envalid";
import { TwitterApi } from "twitter-api-v2";
import { getSimplePrice } from "./lib/coingecko";
import { fileTypeFromBuffer } from "file-type";

dotenv.config();

const LAMPORTS_PER_SOL = 1_000_000_000;

const enum RarityTier {
  Mythic = "Mythic",
  Legendary = "Legendary",
  Epic = "Epic",
  Rare = "Rare",
  Uncommon = "Uncommon",
  Common = "Common",
}

const RarityTierPercentages = {
  [RarityTier.Mythic]: 0.01,
  [RarityTier.Legendary]: 0.05,
  [RarityTier.Epic]: 0.15,
  [RarityTier.Rare]: 0.35,
  [RarityTier.Uncommon]: 0.6,
  [RarityTier.Common]: 1,
};

function getRarityTier(rarityRank: number, maxSupply: number): RarityTier {
  const rarityPercentage = rarityRank / maxSupply;

  for (const [rarityTier, rarityPercentageThreshold] of Object.entries(
    RarityTierPercentages,
  )) {
    if (rarityPercentage <= rarityPercentageThreshold) {
      return rarityTier as RarityTier;
    }
  }

  return RarityTier.Common;
}

function getRarityColorOrb(rarityTier: RarityTier): string {
  switch (rarityTier) {
    case RarityTier.Mythic:
      return "🔴";
    case RarityTier.Legendary:
      return "🟠";
    case RarityTier.Epic:
      return "🟣";
    case RarityTier.Rare:
      return "🔵";
    case RarityTier.Uncommon:
      return "🟢";
    default:
      return "⚪️";
  }
}

function humanize(input: string): string {
  const lowercase = input.toLowerCase().replace("_", " ");
  return lowercase.charAt(0).toUpperCase() + lowercase.slice(1);
}

async function createDiscordSaleEmbed(
  transaction: TensorTransaction,
  imageBuffer: {
    buffer: Buffer;
    fileType: { ext: string; mime: string } | undefined;
  } | null,
  extra: { stats: { buyNowPriceNetFees: string; numMints: number } },
): Promise<{ embed: EmbedBuilder; attachment: AttachmentBuilder | null }> {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const imageUri = transaction.mint.imageUri;
  const buyerId = transaction.tx.buyerId;
  const sellerId = transaction.tx.sellerId;
  const rank = transaction.mint.rarityRankTT;
  const transactionType = humanize(transaction.tx.txType);

  const grossSaleAmount = parseInt(transaction.tx.grossAmount, 10);

  const imageAttachment = imageBuffer
    ? new AttachmentBuilder(imageBuffer.buffer, {
      name: `${onchainId}.${imageBuffer.fileType?.ext}`,
    })
    : null;

  const buyerMessage = buyerId
    ? `[${buyerId.slice(
      0,
      4,
    )}](https://www.tensor.trade/portfolio?wallet=${buyerId})`
    : "Unknown";

  const sellerMessage = sellerId
    ? `[${sellerId.slice(
      0,
      4,
    )}](https://www.tensor.trade/portfolio?wallet=${sellerId})`
    : "n/a";

  const buyerSellerMessage = `${sellerMessage} → ${buyerMessage}`;

  const conversions = await getSimplePrice("solana", "usd");
  const usdConversion = conversions["solana"].usd;

  const solanaPrice = roundToDecimal(grossSaleAmount / LAMPORTS_PER_SOL, 2);
  const usdPrice = solanaPrice * usdConversion;

  const formattedUsdPrice = usdPrice.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
  });

  const rarityClass = getRarityTier(rank, extra.stats.numMints || 10_000);
  const rarityOrb = getRarityColorOrb(rarityClass);

  const rarityMessage =
    rank != null ? `${rarityOrb} ${rarityClass} (${rank})` : "TBD";

  const faction =
    transaction.mint.attributes.find((attr) => attr.trait_type === "Faction")
      ?.value || "";

  const transactionLinks = [
    `[Tensor](https://www.tensor.trade/item/${onchainId})`,
    `[XRAY](https://xray.helius.xyz/tx/${transaction.tx.txId})`,
  ];

  const embed = new EmbedBuilder()
    .setTitle(`${transactionType} - ${nftName}`)
    .setURL(`https://www.tensor.trade/item/${onchainId}`)
    .setThumbnail(
      imageBuffer ? `attachment://${imageAttachment?.name}` : imageUri,
    )
    .addFields([
      {
        name: "Rarity",
        value: rarityMessage,
        inline: true,
      },
      {
        name: "Faction",
        value: faction,
        inline: true,
      },
      {
        name: "\n",
        value: "\n",
      },
      {
        name: "Price",
        value: `◎${roundToDecimal(
          grossSaleAmount / LAMPORTS_PER_SOL,
          2,
        )} (${formattedUsdPrice})`,
        inline: true,
      },
      {
        name: "Floor",
        value: `◎${roundToDecimal(
          parseInt(extra.stats.buyNowPriceNetFees, 10) / LAMPORTS_PER_SOL,
          2,
        )}`,
        inline: true,
      },
      {
        name: "\n",
        value: "\n",
      },
      {
        name: "Wallets",
        value: buyerSellerMessage,
        inline: true,
      },
      {
        name: "Links",
        value: transactionLinks.join(" | "),
        inline: true,
      },
    ])
    .setFooter({
      iconURL: "https://i.ibb.co/ZMRt7cp/tt.png",
      text: "Tensor Trade",
    })
    .setTimestamp();

  return { embed, attachment: imageAttachment };
}

async function getImageBuffer(imageUri: string): Promise<{
  buffer: Buffer;
  fileType: { ext: string; mime: string } | undefined;
} | null> {
  try {
    const response = await fetch(imageUri);

    if (!response.ok) {
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();

    const buffer = Buffer.from(arrayBuffer);

    const fileType = await fileTypeFromBuffer(buffer);

    return { buffer, fileType };
  } catch (err) {
    return null;
  }
}

async function sendTwitterSaleTweet(
  twitterClient: TwitterApi,
  transaction: TensorTransaction,
  imageBuffer: {
    buffer: Buffer;
    fileType: { ext: string; mime: string } | undefined;
  } | null,
  extra: { stats: { buyNowPriceNetFees: string; numMints: number } },
) {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const txId = transaction.tx.txId;
  const grossSaleAmount = parseInt(transaction.tx.grossAmount, 10);
  const rank = transaction.mint.rarityRankTT;

  const conversions = await getSimplePrice("solana", "usd");
  const usdConversion = conversions["solana"].usd;

  const solanaPrice = roundToDecimal(grossSaleAmount / LAMPORTS_PER_SOL, 2);
  const usdPrice = solanaPrice * usdConversion;

  const formattedUsdPrice = usdPrice.toLocaleString("en-US", {
    currency: "USD",
    style: "currency",
  });

  const marketplaceUrl = `https://www.tensor.trade/item/${onchainId}`;

  const usdMessage = usdPrice != null ? `💵 ${formattedUsdPrice} USD\n` : "";

  const rarityClass = getRarityTier(rank, extra.stats.numMints || 10_000);
  const rarityOrb = getRarityColorOrb(rarityClass);

  const rarityMessage =
    rank != null ? `${rarityOrb} ${rarityClass} (${rank})` : "TBD";
  const floorMessage = `📈 ◎${roundToDecimal(
    parseInt(extra.stats.buyNowPriceNetFees, 10) / LAMPORTS_PER_SOL,
    2,
  )} floor\n`;

  const faction =
    transaction.mint.attributes.find((attr) => attr.trait_type === "Faction")
      ?.value || "";

  const factionMessage = faction ? `👥 ${faction}\n` : "";

  const message = `😲 ${nftName} SOLD for ◎${solanaPrice}\n${usdMessage}${floorMessage}${rarityMessage}\n${factionMessage}\n→ ${marketplaceUrl}\n\n📝 https://xray.helius.xyz/tx/${txId}`;

  let mediaIds: string[] = [];

  try {
    if (imageBuffer) {
      const mediaId = await twitterClient.v1.uploadMedia(imageBuffer.buffer, {
        mimeType: imageBuffer.fileType?.mime,
      });
      mediaIds = [mediaId];
    }
  } catch (err) {
    console.error(err);
  }

  return twitterClient.v2.tweet(message, {
    media: {
      media_ids: mediaIds,
    },
  });
}

function logTransactionToConsole(transaction: TensorTransaction,
                                 skip?: boolean) {
  const nftName = transaction.mint.name;
  const onchainId = transaction.mint.onchainId;
  const imageUri = transaction.mint.imageUri;
  const buyerId = transaction.tx.buyerId;
  const sellerId = transaction.tx.sellerId;

  const grossSaleAmount = transaction.tx.grossAmount;

  const skipMessage = !!skip ? "skipped" : "";

  console.log(`New ${skipMessage} ${transaction.tx.txType} transaction for ${nftName} (${onchainId})
        Image: ${imageUri}
        Buyer: ${buyerId}
        Seller: ${sellerId}
        Gross sale amount: ${grossSaleAmount}
        `);
}

async function main() {
  const env = cleanEnv(process.env, {
    TENSOR_API_URL: str({
      default: "https://api.tensor.so/graphql",
    }),
    TENSOR_API_KEY: nonEmptyStrValidator(),
    DISCORD_WEBHOOKS: nonEmptyStrValidator(),
    SLUGS: nonEmptyStrValidator(),
  });

  const discordWebhooks = env.DISCORD_WEBHOOKS.split(",").map(
    (hookUrl) => new WebhookClient({ url: hookUrl }),
  );

  const tensorService = new TensorService(
    env.TENSOR_API_URL,
    env.TENSOR_API_KEY,
  );

  await tensorService.connect();

  for (const slug of env.SLUGS.split(",")) {
    await tensorService.subscribeToSlug(slug);
  }

  tensorService.on("transaction", async (transaction, slug) => {
    // const allowedTxTypes = [
    //   "SALE_BUY_NOW",
    //   "SALE_ACCEPT_BID",
    //   "LIST",
    //   "DELIST",
    //   "ADJUST_PRICE",
    // ];
    //
    // if (!allowedTxTypes.includes(transaction.tx.txType)) {
    //   return;
    // }

    logTransactionToConsole(transaction);

    const skullTraitValues = [
      "Skull Mask",
      "Skull Mask - Dark",
      "Horned Skull Mask",
      "Horned Skull Mask - Dark"
    ];

    const eyeAttribute = transaction.mint.attributes
      .find(attr => attr.trait_type === "Eyes");
    if (!skullTraitValues.includes(eyeAttribute.value)) {
      logTransactionToConsole(transaction, true);
      return;
    }


    const stats = await tensorService.getCollectionStats(slug);
    const imageBuffer = await getImageBuffer(transaction.mint.imageUri);

    const { embed, attachment } = await createDiscordSaleEmbed(
      transaction,
      imageBuffer,
      {
        stats,
      },
    );

    for (const webhook of discordWebhooks) {
      try {
        let webhookPayload: WebhookMessageCreateOptions = {
          embeds: [embed],
        };

        if (attachment) {
          webhookPayload = { ...webhookPayload, files: [attachment] };
        }

        await webhook.send(webhookPayload);
      } catch (err) {
        console.error(err);
      }
    }
  });
}

main().catch(console.error);
