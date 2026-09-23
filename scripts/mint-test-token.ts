// Mint test ecash proofs from the local cdk-mintd fake wallet for E2E fixtures.
// Usage: npx tsx mint-test-token.ts <mint-url> <amount> <unit>
// Prints a V3 cashu token string to stdout.

import { CashuMint, CashuWallet, getEncodedToken, Amount } from '@cashu/cashu-ts'

async function main() {
  const mintUrl = process.argv[2] || 'http://localhost:8086'
  const amount = parseInt(process.argv[3] || '10000', 10)
  const unit = process.argv[4] || 'sat'

  const mint = new CashuMint(mintUrl)
  const wallet = new CashuWallet(mint, { unit })
  await wallet.loadMint()

  const quote = await wallet.createMintQuote(Amount.from(amount))
  process.stderr.write(`quote=${quote.quote} state=${quote.state}\n`)

  let paid = await wallet.checkMintQuote(quote.quote)
  for (let i = 0; i < 20 && paid.state !== 'PAID'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    paid = await wallet.checkMintQuote(quote.quote)
  }

  if (paid.state !== 'PAID') {
    process.stderr.write(`Quote not paid after retries (state=${paid.state})\n`)
    process.exit(1)
  }

  const proofs = await wallet.mintProofs(Amount.from(amount), quote.quote)
  process.stderr.write(`minted ${proofs.length} proofs\n`)

  const token = getEncodedToken({ mint: mintUrl, proofs, unit })
  process.stdout.write(token)
}

main().catch((err) => {
  process.stderr.write(`${err}\n`)
  process.exit(1)
})
