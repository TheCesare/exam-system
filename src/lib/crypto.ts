import crypto from 'crypto'

const SCRYPT_KEYLEN = 64
const SCRYPT_COST = 16384      // N
const SCRYPT_BLOCK_SIZE = 8    // r
const SCRYPT_PARALLELISM = 1   // p

/**
 * Hash a password using Node.js scrypt KDF.
 * Output format: "$scrypt$<hex-salt>$<hex-hash>"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(32)
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELISM,
    }, (err, derivedKey) => {
      if (err) return reject(err)
      resolve(`$scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`)
    })
  })
}

/**
 * Verify a plain-text password against a stored hash.
 * If the stored value does NOT look like our hash format,
 * falls back to plain-text comparison (for migration).
 * Returns { valid, needsRehash } — caller should re-hash & save if needsRehash.
 */
export async function verifyPassword(password: string, stored: string): Promise<{ valid: boolean; needsRehash: boolean }> {
  // Already hashed?
  if (stored.startsWith('$scrypt$')) {
    const parts = stored.split('$')
    // format: ['', 'scrypt', salt_hex, hash_hex]
    const salt = Buffer.from(parts[2], 'hex')
    const expected = Buffer.from(parts[3], 'hex')
    return new Promise((resolve) => {
      crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELISM,
      }, (err, derivedKey) => {
        if (err) return resolve({ valid: false, needsRehash: false })
        resolve({ valid: crypto.timingSafeEqual(derivedKey, expected), needsRehash: false })
      })
    })
  }

  // Plain text (legacy) — compare directly and flag for re-hash
  if (password === stored) {
    return { valid: true, needsRehash: true }
  }
  return { valid: false, needsRehash: true }
}