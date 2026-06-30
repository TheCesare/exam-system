import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { verifyPassword } from '@/lib/crypto'

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Msan@01245893610'
const SETTINGS_ID = 'a0000000-a000-a000-a000-a00000000000'

// ---- In-memory rate limiter (per IP + per username) ----
const loginAttempts: Record<string, { count: number; lockedUntil: number }> = {}
const MAX_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000 // 15 minutes

function isLocked(key: string): boolean {
  const entry = loginAttempts[key]
  if (!entry) return false
  if (Date.now() > entry.lockedUntil) {
    delete loginAttempts[key]
    return false
  }
  return true
}

function recordFailure(key: string) {
  const entry = loginAttempts[key] || { count: 0, lockedUntil: 0 }
  entry.count++
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_MS
  }
  loginAttempts[key] = entry
}

function clearAttempts(key: string) {
  delete loginAttempts[key]
}

// Periodic cleanup (every 30 min)
setInterval(() => {
  const now = Date.now()
  for (const key of Object.keys(loginAttempts)) {
    if (now > loginAttempts[key].lockedUntil) delete loginAttempts[key]
  }
}, 30 * 60 * 1000)

async function getSettings(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from('distribution_results')
    .select('data')
    .eq('id', SETTINGS_ID)
    .single()
  if (error || !data) return {}
  return data.data || {}
}

async function saveSettings(settings: Record<string, unknown>) {
  await supabase
    .from('distribution_results')
    .upsert({ id: SETTINGS_ID, data: settings }, { onConflict: 'id' })
}

export async function POST(request: NextRequest) {
  try {
    const { password, role, name } = await request.json()
    const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

    if (role === 'user') {
      // Rate limit by IP + username
      const rateKey = `${clientIP}:${(name || '').toLowerCase()}`
      if (isLocked(rateKey)) {
        return NextResponse.json({ success: false, message: 'Account locked. Try again in 15 minutes.' }, { status: 429 })
      }

      const settings = await getSettings()
      const supervisors: { id: string; name: string; password: string; permissions?: string[] }[] = (settings.supervisors as any[]) || []

      if (!name) {
        return NextResponse.json({ success: false, message: 'Please enter your username' }, { status: 400 })
      }

      const supervisor = supervisors.find(s => s.name.toLowerCase() === name.toLowerCase())
      if (!supervisor) {
        recordFailure(rateKey)
        return NextResponse.json({ success: false, message: 'User not found' }, { status: 401 })
      }

      // Verify password (supports both hashed and plain text for migration)
      const result = await verifyPassword(password, supervisor.password)
      if (!result.valid) {
        recordFailure(rateKey)
        return NextResponse.json({ success: false, message: 'Wrong password' }, { status: 401 })
      }

      // Successful login — clear rate limit
      clearAttempts(rateKey)

      // Lazy migration: if password was plain text, re-hash and save
      if (result.needsRehash) {
        const { hashPassword } = await import('@/lib/crypto')
        supervisor.password = await hashPassword(password)
        settings.supervisors = supervisors
        await saveSettings(settings)
      }

      return NextResponse.json({ success: true, role: 'user', name: supervisor.name, permissions: supervisor.permissions || [] })
    }

    // Admin login
    const adminRateKey = `${clientIP}:admin`
    if (isLocked(adminRateKey)) {
      return NextResponse.json({ success: false, message: 'Account locked. Try again in 15 minutes.' }, { status: 429 })
    }

    if (password === ADMIN_PASSWORD) {
      clearAttempts(adminRateKey)
      return NextResponse.json({ success: true, role: 'admin' })
    }
    recordFailure(adminRateKey)
    return NextResponse.json({ success: false, message: 'Wrong password' }, { status: 401 })
  } catch {
    return NextResponse.json({ success: false, message: 'Error' }, { status: 500 })
  }
}